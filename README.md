# CodeMate

CodeMate is a workspace for **LocalCopilot**, a local-first VS Code coding assistant powered by Ollama. It provides inline completions and a chat-based workflow with apply/reject code changes.

## Repository Structure
- `localcopilot/` — the VS Code extension (TypeScript + Webview UI).
- `server.py` — optional FastAPI sidecar that exposes a `/complete` endpoint backed by Ollama (useful for experiments or external tooling).
- `LICENSE` — MIT license.

## Requirements
- VS Code `^1.109.0`
- Node.js (for extension build tooling)
- Ollama running locally at `http://localhost:11434`
- Python 3.10+ (only if you want to run `server.py`)

## Getting Started (Extension)
1. `cd localcopilot`
2. `npm install`
3. Open the folder in VS Code and run the extension:
   - Press `F5` to launch the Extension Development Host.
4. Open the **LocalCopilot** view from the Activity Bar.
5. Select a model and start using inline completions or chat.

## Settings
- `localcopilot.inlineModel` — Ollama model for inline completions. Leave empty to use the first available model.

## Optional: Run the Sidecar Server
If you want the `server.py` sidecar (not required for the extension):
1. `pip install fastapi uvicorn requests`
2. `python server.py`
3. The server listens on `http://127.0.0.1:5000` with `POST /complete`.

## Publishing the Extension (Summary)
1. Create a **publisher** in the Visual Studio Marketplace.
2. Add the `publisher` field in `localcopilot/package.json`.
3. Use `vsce` to package/publish the extension.

## License
MIT
