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

let outputLog: vscode.OutputChannel;
const apiKeySecretName = "googleAiStudioApiKey";

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

	await context.secrets.store(apiKeySecretName, apiKey.trim());
	vscode.window.showInformationMessage("Google AI Studio API key stored securely.");
}

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

async function loadReviewPrompt(context: vscode.ExtensionContext): Promise<string> {
	return readFile(path.join(context.extensionPath, "prompts", "scanner-prompt.txt"), "utf8");
}

async function loadElaboratePrompt(context: vscode.ExtensionContext): Promise<string> {
	return readFile(path.join(context.extensionPath, "prompts", "elaborate-prompt.txt"), "utf8");
}

async function elaborateComment(
	context: vscode.ExtensionContext,
	thread: vscode.CommentThread
): Promise<void> {
	const apiKey = await context.secrets.get(apiKeySecretName);
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
			await loadElaboratePrompt(context),
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
		const apiKey = await context.secrets.get(apiKeySecretName);
		if (!apiKey) {
			vscode.window.showInformationMessage("Set your Google AI Studio API key before reviewing a file.");
			return;
		}

		const numberedSelection = editor.document
			.getText(editor.selection)
			.split("\n")
			.map((line, index) => `${editor.selection.start.line + index + 1} | ${line}`)
			.join("\n");

		const prompt = `${await loadReviewPrompt(context)}\nSELECTED CODE TO REVIEW:\n${numberedSelection}`;
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

export function activate(context: vscode.ExtensionContext): void {
    outputLog = vscode.window.createOutputChannel("AI Code Companion");

	context.subscriptions.push(
		vscode.commands.registerCommand("ai-code-companion.reviewSelection", () => reviewSelection(context)),
		vscode.commands.registerCommand("ai-code-companion.setApiKey", () => setGoogleAiStudioApiKey(context)),
		vscode.commands.registerCommand("ai-code-companion.addLoremIpsumComment", addLoremIpsumComment),
		vscode.commands.registerCommand(
			"ai-code-companion.elaborateComment",
			(thread: vscode.CommentThread) => elaborateComment(context, thread)
		),
		vscode.commands.registerCommand(
			"ai-code-companion.dismissComment",
			(thread: vscode.CommentThread) => deleteCodeCommentThread(thread)
		),
		outputLog,
		commentController
	);
}

export function deactivate(): void {}
