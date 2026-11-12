import * as vscode from 'vscode';

const commentDecoration = vscode.window.createTextEditorDecorationType({
	after: {
		contentText: '  Static comment: review this snippet.',
		color: new vscode.ThemeColor('editorHoverWidget.foreground'),
		backgroundColor: new vscode.ThemeColor('editorHoverWidget.background'),
		border: '1px solid',
		borderColor: new vscode.ThemeColor('editorHoverWidget.border'),
		margin: '0 0 0 1em',
	},
});

let previousEditor: vscode.TextEditor | undefined;

export function addStaticComment(): void {
	const editor = vscode.window.activeTextEditor;

	if (!editor) {
		vscode.window.showInformationMessage('Open a file before adding a comment.');
		return;
	}

	previousEditor?.setDecorations(commentDecoration, []);
	const line = Math.min(2, editor.document.lineCount - 1);
	const position = new vscode.Position(line, editor.document.lineAt(line).text.length);

	editor.setDecorations(commentDecoration, [new vscode.Range(position, position)]);
	previousEditor = editor;
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('ai-code-companion.addStaticComment', addStaticComment),
		commentDecoration
	);
}

export function deactivate(): void {}
