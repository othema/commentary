# Commentary Plan

## Goal

Show AI-generated questions and suggestions beside code in VS Code, similar to
Google Docs comments. The extension must never edit, refactor, or generate code.

## MVP

1. **Define the user flow**
   - Add a command to review the current file or selected code.
   - Send only the relevant code and context to the configured AI provider.
   - Display each response as a gutter marker attached to a line.
   - Let users open, dismiss, refresh, or mark a suggestion as resolved.

2. **Build the extension foundation**
   - Replace the starter command with review commands and keyboard shortcuts.
   - Add settings for provider, model, API key handling, and review preferences.
   - Keep review state per workspace and clean it up when documents close.

3. **Implement AI review**
   - Define a strict response schema: line/range, type, message, and confidence.
   - Validate and sanitize model responses before displaying them.
   - Prompt the model to ask questions or suggest improvements only; explicitly
     prohibit code changes and refactors.
   - Show clear errors for unavailable providers, invalid responses, and limits.

4. **Create the comment UI**
   - Use diagnostics/decorations or CodeLens for gutter indicators.
   - Use a lightweight hover or webview panel for the full comment and actions.
   - Make markers stable when the document changes and avoid overwhelming users.

5. **Privacy and safety**
   - Ask for confirmation before sending code externally.
   - Clearly show what data is sent and support disabling remote AI.
   - Never log source code, API keys, or full model responses.

6. **Test and release**
   - Unit-test parsing, validation, line mapping, state, and error handling.
   - Add VS Code integration tests for commands and comment interactions.
   - Test large files, unsaved edits, multiple languages, offline mode, and
     rejected requests.
   - Document setup, supported providers, privacy behavior, and known limits in
     `README.md`, then package a small pilot release.

## Success Criteria

- A user can request a review and see useful, line-specific questions.
- Suggestions never modify the workspace.
- Users can understand, dismiss, and revisit comments without losing work.
- Code and credentials are handled transparently and safely.
