# CodeMate

CodeMate is a local-first coding assistant for VS Code that uses Ollama to provide inline completions and a chat-based coding workflow.

## Features
- Inline code completions powered by your local Ollama model.
- Chat sidebar with model picker and chat history.
- Code change proposals with Apply/Reject actions and optional diff view.
- Error-aware fixes that request corrected code blocks when errors are detected.
- File context awareness for the active editor or selection.

## Requirements
- Ollama installed and running at http://localhost:11434
- At least one model pulled, for example: `ollama pull llama3.1`

## Install (VSIX)
1. Package the extension:
   - `npx @vscode/vsce package`
2. Install the VSIX in VS Code:
   - Extensions view → `...` → `Install from VSIX...`
   - Or run: `code --install-extension "<path>\\codemate-<version>.vsix"`

## Getting Started
1. Start Ollama.
2. Open VS Code and install CodeMate.
3. Open the CodeMate view from the Activity Bar.
4. Pick a model from the dropdown.
5. Ask for changes or explanations, or just start typing to trigger inline completions.

## Extension Settings
- `localcopilot.inlineModel`: Ollama model for inline completions. Leave empty to use the first available model.

## Notes
- All requests go to your local Ollama instance; nothing is sent to external services.

## License
MIT
