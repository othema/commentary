import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import {
	addCodeComment,
	appendCodeCommentThread,
	commentController,
	deleteCodeCommentThread,
} from "./comments.js";
import { sendLlmRequest, type LlmUsage } from "./llm.js";

const LLM_API_KEY_SECRET_NAME = "googleAiStudioApiKey";
const REVIEW_PROMPT_FILE_NAME = "scanner-prompt.txt";
const ELABORATE_PROMPT_FILE_NAME = "elaborate-prompt.txt";
const REVIEW_CONTEXT_LINES = 15;
const REVIEW_CONTEXT_CHAR_BUDGET = 18000;
const execFileAsync = promisify(execFile);

let outputLog: vscode.OutputChannel;
let reviewPrompt: string;
let elaboratePrompt: string;

function logLlmUsage(requestType: string, usage: LlmUsage): void {
	outputLog.appendLine(
		`${requestType} token usage: prompt=${usage.promptTokenCount ?? "unknown"}, `
		+ `output=${usage.candidatesTokenCount ?? "unknown"}, `
		+ `total=${usage.totalTokenCount ?? "unknown"}`
	);
}

function logLlmPrompt(requestType: string, prompt: string): void {
	outputLog.appendLine(`--- ${requestType} prompt start ---`);
	outputLog.appendLine(prompt);
	outputLog.appendLine(`--- ${requestType} prompt end ---`);
}

/*
Prompt for a Google AI Studio API key and store it in VS Code Secret Storage.
*/
async function setGoogleAiStudioApiKey(context: vscode.ExtensionContext): Promise<void> {
	const apiKey = await vscode.window.showInputBox({
		prompt: "Enter your Google AI Studio API key",
		placeHolder: "The key will be stored securely in VS Code Secret Storage",
		password: true,
		ignoreFocusOut: true,
	});

	if (!apiKey?.trim()) {
		return;
	}

	await context.secrets.store(LLM_API_KEY_SECRET_NAME, apiKey.trim());
	vscode.window.showInformationMessage("Google AI Studio API key stored securely.");
}

/*
Add a placeholder comment at the active editor's current line.
*/
function addLoremIpsumComment(): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("Open a file before adding a placeholder comment.");
		return;
	}

	addCodeComment(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Review this section.",
		editor.selection.active.line + 1
	);
}

type ReviewComment = {
	line: number;
	message: string;
	severity?: "suggestion" | "question" | "risk";
};

/*
Parse and validate up to three review comments from an LLM JSON response.
Throws: If the response is not a JSON array.
*/
function parseReviewComments(response: string, lineCount: number): ReviewComment[] {
	const json = response
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	const parsed: unknown = JSON.parse(json);

	if (!Array.isArray(parsed)) {
		throw new Error("The LLM response was not a JSON array.");
	}

	return parsed
		.slice(0, 3)
		.filter((item): item is ReviewComment => {
			if (typeof item !== "object" || item === null) {
				return false;
			}

			const candidate = item as Partial<ReviewComment>;
			return typeof candidate.line === "number"
				&& Number.isInteger(candidate.line)
				&& candidate.line >= 1
				&& candidate.line <= lineCount
				&& typeof candidate.message === "string"
				&& candidate.message.trim().length > 0;
		})
		.map((comment) => ({
			line: comment.line,
			message: comment.message.trim(),
			severity: comment.severity,
		}));
}

function formatNumberedLines(lines: string[], startLine: number): string {
	return lines
		.map((line, index) => `${startLine + index + 1} | ${line}`)
		.join("\n");
}

function truncateSection(section: string, maxCharacters: number): string {
	if (section.length <= maxCharacters) {
		return section;
	}
	return `${section.slice(0, maxCharacters)}\n[Selection truncated to stay within the review context budget.]`;
}

function getSelectedLineRange(selection: vscode.Selection): { startLine: number; endLine: number } {
	return {
		startLine: selection.start.line,
		endLine: Math.max(selection.start.line, selection.end.line - (selection.end.character === 0 ? 1 : 0)),
	};
}

function findEnclosingSignature(lines: string[], startLine: number): string | undefined {
	const signaturePattern = /\b(class|function|interface|type)\b|(?:^|\s)(?:public|private|protected|static|async)?\s*\w+\s*\([^)]*\)/;
	for (let line = startLine; line >= Math.max(0, startLine - 80); line--) {
		if (signaturePattern.test(lines[line])) {
			return `${line + 1} | ${lines[line].trim()}`;
		}
	}
	return undefined;
}

function getImportBlocks(lines: string[]): string[] {
	const blocks: string[] = [];
	for (let line = 0; line < lines.length; line++) {
		if (!/^\s*import\b/.test(lines[line])) {
			continue;
		}

		const block = [lines[line]];
		while (!block[block.length - 1].includes(";") && line + 1 < lines.length) {
			line++;
			block.push(lines[line]);
		}
		blocks.push(formatNumberedLines(block, line - block.length + 1));
	}
	return blocks;
}

function getRelevantDefinitions(lines: string[], selectedCode: string): string[] {
	const selectedSymbols = new Set(
		selectedCode.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []
	);
	const definitionPattern = /^\s*(?:export\s+)?(?:type|interface|class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;
	return lines.flatMap((line, index) => {
		const match = line.match(definitionPattern);
		return match && selectedSymbols.has(match[1])
			? [`${index + 1} | ${line.trim()}`]
			: [];
	});
}

async function getRelevantGitDiff(
	document: vscode.TextDocument,
	startLine: number,
	endLine: number
): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["diff", "--unified=20", "--", document.uri.fsPath]);
		const hunks = stdout.split(/(?=^@@ )/m).filter((hunk) => hunk.startsWith("@@ "));
		const relevantHunk = hunks.find((hunk) => {
			const match = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
			if (!match) {
				return false;
			}
			const hunkStart = Number(match[1]) - 1;
			const hunkEnd = hunkStart + Number(match[2] ?? 1) - 1;
			return hunkStart <= endLine && hunkEnd >= startLine;
		});
		return relevantHunk?.trim();
	} catch {
		return undefined;
	}
}

async function buildReviewContext(
	document: vscode.TextDocument,
	selection: vscode.Selection
): Promise<string> {
	const lines = document.getText().split("\n");
	const { startLine, endLine } = getSelectedLineRange(selection);
	const selectedLines = document.getText(selection).split("\n");
	const contextStart = Math.max(0, startLine - REVIEW_CONTEXT_LINES);
	const contextEnd = Math.min(lines.length - 1, endLine + REVIEW_CONTEXT_LINES);
	const surroundingLines = lines.slice(contextStart, contextEnd + 1);
	const selectedSection = truncateSection(
		[
			"SELECTED CODE TO REVIEW (the only code to comment on):",
			formatNumberedLines(selectedLines, startLine),
		].join("\n"),
		REVIEW_CONTEXT_CHAR_BUDGET
	);
	const sections = [
		selectedSection,
		"SURROUNDING CODE FOR CONTEXT ONLY:",
		formatNumberedLines(surroundingLines, contextStart),
	];
	const signature = findEnclosingSignature(lines, startLine);
	if (signature) {
		sections.push("ENCLOSING FUNCTION OR CLASS SIGNATURE:", signature);
	}

	const imports = getImportBlocks(lines);
	if (imports.length > 0) {
		sections.push("RELEVANT IMPORTS:", imports.join("\n"));
	}

	const definitions = getRelevantDefinitions(lines, selectedLines.join("\n"));
	if (definitions.length > 0) {
		sections.push("DIRECTLY RELATED SAME-FILE DEFINITIONS:", definitions.join("\n"));
	}

	const diff = await getRelevantGitDiff(document, startLine, endLine);
	if (diff) {
		sections.push("RELEVANT GIT DIFF CONTEXT:", diff);
	}

	const context = sections.join("\n");
	if (context.length <= REVIEW_CONTEXT_CHAR_BUDGET) {
		return context;
	}

	return `${selectedSection}\nADDITIONAL CONTEXT TRUNCATED TO KEEP THIS REQUEST BOUNDED.`;
}

async function loadPrompt(context: vscode.ExtensionContext, filename: string): Promise<string> {
	return readFile(path.join(context.extensionPath, "prompts", filename), "utf-8");
}

/*
Generate an elaboration for a comment thread and append it to that thread.
Failures are reported through the output channel and an error notification.
*/
async function elaborateComment(
	context: vscode.ExtensionContext,
	thread: vscode.CommentThread
): Promise<void> {
	const apiKey = await context.secrets.get(LLM_API_KEY_SECRET_NAME);
	if (!apiKey) {
		vscode.window.showInformationMessage("Set your Google AI Studio API key before elaborating a comment.");
		return;
	}

	const range = thread.range;
	if (!range) {
		return;
	}

	try {
		const document = await vscode.workspace.openTextDocument(thread.uri);
		const lineNumber = range.start.line + 1;
		const sourceLine = document.lineAt(range.start.line).text;
		const originalComment = thread.comments[0]?.body.toString() ?? "";
		const prompt = [
			elaboratePrompt,
			`Code line ${lineNumber}: ${sourceLine}`,
			`Original comment: ${originalComment}`,
		].join("\n");
		logLlmPrompt("Elaboration", prompt);
		const elaboration = await sendLlmRequest(
			prompt,
			apiKey,
			undefined,
			(usage) => logLlmUsage("Elaboration", usage)
		);

		if (!appendCodeCommentThread(thread, elaboration)) {
			throw new Error("The comment thread is no longer available.");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error.";
		outputLog.appendLine(`Elaboration failed: ${message}`);
		vscode.window.showErrorMessage(`Could not elaborate comment: ${message}`);
	}
}

/*
Review the active editor's selected code and add the returned comments.
Failures are reported through the output channel and an error notification.
*/
async function reviewSelection(context: vscode.ExtensionContext): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("Select code before reviewing it.");
		return;
	}
	if (editor.selection.isEmpty) {
		vscode.window.showInformationMessage("Select code before reviewing it.");
		return;
	}

	outputLog.show(true);
		outputLog.appendLine(`Reviewing selection in ${editor.document.fileName}...`);
	try {
		const apiKey = await context.secrets.get(LLM_API_KEY_SECRET_NAME);
		if (!apiKey) {
			vscode.window.showInformationMessage("Set your Google AI Studio API key before reviewing a file.");
			return;
		}

		const reviewContext = await buildReviewContext(editor.document, editor.selection);
		const prompt = [
			reviewPrompt,
			"Review only the selected code. Use all other supplied code only to understand it.",
			"Preserve the absolute document line numbers in returned comments.",
			"Return no comment when the available context is insufficient to identify a specific issue.",
			reviewContext,
		].join("\n\n");
		logLlmPrompt("Review", prompt);
		const response = await sendLlmRequest(
			prompt,
			apiKey,
			undefined,
			(usage) => logLlmUsage("Review", usage)
		);
		const comments = parseReviewComments(response, editor.document.lineCount);
		
		for (const comment of comments) {
			addCodeComment(comment.message, comment.line, editor);
		}
		outputLog.appendLine(`Added ${comments.length} code comment(s).`);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error.";
		outputLog.appendLine(`Request failed: ${message}`);
		vscode.window.showErrorMessage(`Google AI Studio request failed: ${message}`);
	}
}

/*
 * Load prompts once and register the extension's commands, output channel, and comment controller.
*/
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputLog = vscode.window.createOutputChannel("Commentary");

	// Load system prompts for comments and elaborations
	[reviewPrompt, elaboratePrompt] = await Promise.all([
		loadPrompt(context, REVIEW_PROMPT_FILE_NAME),
		loadPrompt(context, ELABORATE_PROMPT_FILE_NAME),
	]);

	context.subscriptions.push(
		vscode.commands.registerCommand("commentary.reviewSelection", () => reviewSelection(context)),
		vscode.commands.registerCommand("commentary.setApiKey", () => setGoogleAiStudioApiKey(context)),
		vscode.commands.registerCommand("commentary.addLoremIpsumComment", addLoremIpsumComment),
		vscode.commands.registerCommand(
			"commentary.elaborateComment",
			(thread: vscode.CommentThread) => elaborateComment(context, thread)
		),
		vscode.commands.registerCommand(
			"commentary.dismissComment",
			(thread: vscode.CommentThread) => deleteCodeCommentThread(thread)
		),
		outputLog,
		commentController
	);
}

/*
Run extension shutdown cleanup.
*/
export function deactivate(): void {}
