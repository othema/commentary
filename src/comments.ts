import * as vscode from "vscode";

type CodeComment = {
	id: string;
	thread: vscode.CommentThread;
};

const commentsByDocument = new Map<string, CodeComment[]>();
let nextCommentId = 1;

export const commentController = vscode.comments.createCommentController(
	"commentary",
	"Commentary"
);

/*
Add an AI-generated comment thread to the active editor at the requested line.
Returns: The comment ID, or undefined if no editor is open.
*/
export function addCodeComment(
	message: string,
	lineNumber: number,
	targetEditor = vscode.window.activeTextEditor
): string | undefined {
	const editor = targetEditor;

	if (!editor) {
		vscode.window.showInformationMessage("Open a file before adding a comment.");
		return undefined;
	}

	const line = Math.min(Math.max(1, Math.floor(lineNumber)) - 1, editor.document.lineCount - 1);
	const documentComments = commentsByDocument.get(editor.document.uri.toString()) ?? [];
	const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);
	const thread = commentController.createCommentThread(editor.document.uri, range, [{
		body: message,
		mode: vscode.CommentMode.Preview,
		author: { name: "Commentary" },
		label: "AI suggestion",
	}]);
	thread.contextValue = "aiCodeComment";
	thread.canReply = false;
	const comment: CodeComment = {
		id: `comment-${nextCommentId++}`,
		thread,
	};

	documentComments.push(comment);
	commentsByDocument.set(editor.document.uri.toString(), documentComments);

	return comment.id;
}

/*
Dismiss a tracked comment thread and remove it from the document's comment list.
Returns: Whether the thread was found and removed.
*/
export function deleteCodeCommentThread(thread: vscode.CommentThread): boolean {
	for (const [documentUri, documentComments] of commentsByDocument) {
		const comment = documentComments.find(({ thread: storedThread }) => storedThread === thread);
		if (!comment) {
			continue;
		}

		thread.dispose();
		commentsByDocument.set(
			documentUri,
			documentComments.filter(({ id }) => id !== comment.id)
		);
		return true;
	}

	return false;
}

/*
Append a response to a tracked comment thread
Returns: Whether the response was added.
*/
export function appendCodeCommentThread(thread: vscode.CommentThread, message: string): boolean {
	for (const [documentUri, documentComments] of commentsByDocument) {
		const storedComment = documentComments.find(({ thread: storedThread }) => storedThread === thread);
		if (!storedComment || !thread.range) {
			continue;
		}

		const replacementThread = commentController.createCommentThread(
			thread.uri,
			thread.range,
			[
				...thread.comments,
				{
					body: message,
					mode: vscode.CommentMode.Preview,
					author: { name: "Commentary" },
					label: "AI elaboration",
				},
			]
		);
		replacementThread.contextValue = "aiCodeComment";
		replacementThread.canReply = false;
		thread.dispose();

		const replacementComment = { ...storedComment, thread: replacementThread };
		commentsByDocument.set(
			 documentUri,
			documentComments.map((comment) => comment.id === storedComment.id ? replacementComment : comment)
		);
		return true;
	}

	return false;
}

/*
Delete a tracked comment by ID and dispose its thread.
Returns: Whether the comment was found and deleted.
*/
export function deleteCodeComment(commentId: string): boolean {
	for (const [documentUri, documentComments] of commentsByDocument) {
		const remainingComments = documentComments.filter(({ id }) => id !== commentId);
		if (remainingComments.length === documentComments.length) {
			continue;
		}

		documentComments.find(({ id }) => id === commentId)?.thread.dispose();
		commentsByDocument.set(documentUri, remainingComments);
		return true;
	}

	return false;
}
