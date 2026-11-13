import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
	addCodeComment,
	appendCodeCommentThread,
	commentController,
	deleteCodeCommentThread,
} from "./comments.js";
import { sendLlmRequest } from "./llm.js";

const LLM_API_KEY_SECRET_NAME = "googleAiStudioApiKey";
const REVIEW_PROMPT_FILE_NAME = "scanner-prompt.txt";
const ELABORATE_PROMPT_FILE_NAME = "elaborate-prompt.txt";

let outputLog: vscode.OutputChannel;
let reviewPrompt: string;
let elaboratePrompt: string;

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
		const elaboration = await sendLlmRequest(prompt, apiKey);

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

		const numberedSelection = editor.document
			.getText(editor.selection)
			.split("\n")
			.map((line, index) => `${editor.selection.start.line + index + 1} | ${line}`)
			.join("\n");

		const prompt = `${reviewPrompt}\nSELECTED CODE TO REVIEW:\n${numberedSelection}`;
		const response = await sendLlmRequest(prompt, apiKey);
		const comments = parseReviewComments(response, editor.document.lineCount);
		
		for (const comment of comments) {
			addCodeComment(comment.message, comment.line);
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
