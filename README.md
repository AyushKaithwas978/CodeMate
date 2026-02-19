# 🤖 LocalCopilot

**LocalCopilot** is a local‑first VS Code coding assistant powered by Ollama. It provides inline completions and a chat‑based workflow, letting you apply or reject AI‑generated code changes directly in the editor.

---

## 🗂️ Repository Structure

```
localcopilot/
├─ src/                # VS Code extension source (TypeScript)
│   └─ extension.ts    # Main activation code
├─ media/              # Webview assets (HTML/CSS/JS)
│   └─ sidebar.js      # Sidebar UI logic
├─ agents_service.py   # Optional Python side‑car exposing a /complete endpoint
├─ package.json        # VS Code extension manifest
├─ tsconfig.json
├─ README.md
└─ LICENSE
```

---

## ✅ Prerequisites

| Tool | Minimum Version |
|------|-----------------|
| **VS Code** | `^1.109.0` |
| **Node.js** | `>= 18` (for extension build tooling) |
| **Ollama** | Running locally, e.g. `http://localhost:11434` |
| **Python** | `3.10+` (only if you want to run the side‑car) |
| **npm** | Comes with Node.js |

---

## 🚀 Getting Started (Development)

1. **Clone the repo**  
   ```bash
   git clone <repo‑url>
   cd localcopilot
   ```

2. **Install Node dependencies**  
   ```bash
   npm install
   ```

3. **Open the folder in VS Code**  
   *Press `F5`* – this launches an Extension Development Host with the extension loaded.

4. **Select a model**  
   Open the **LocalCopilot** view from the Activity Bar, pick an Ollama model (e.g. `llama3.1`), and start using inline completions or the chat sidebar.

---

## 📦 Install from a VSIX

1. **Package the extension**  
   ```bash
   npx @vscode/vsce package
   ```

2. **Install the generated VSIX**  
   ```bash
   code --install-extension localcopilot-<version>.vsix
   ```

3. **Run Ollama** and ensure at least one model is pulled (`ollama pull llama3.1`).  
   Then open the **LocalCopilot** view and select the model you want to use.

---

## ⚙️ Configuration (Settings)

| Setting | Description | Default |
|---------|-------------|---------|
| `localcopilot.inlineModel` | Ollama model used for inline completions. If empty, the first available model is used. | *(empty)* |
| `localcopilot.chatModel` | Model used for the chat sidebar. | Same as `inlineModel` |
| `localcopilot.maxTokens` | Maximum number of tokens to request from Ollama. | `1024` |
| `localcopilot.sidecarUrl` | URL of the optional Python side‑car (`/complete` endpoint). | `http://127.0.0.1:5000` |

Settings can be edited via **File → Preferences → Settings** → search for “LocalCopilot”.

---

## 🧪 Optional: Run the Python Side‑Car

The side‑car provides a simple FastAPI wrapper around Ollama’s `/api/generate` endpoint. It’s useful if you want a stable HTTP interface for other tools.

```bash
# Install dependencies
pip install fastapi uvicorn requests

# Run the server
python agents_service.py
```

The server listens on `http://127.0.0.1:5000` and exposes:

- `POST /complete` – body `{ "model": "...", "prompt": "...", "max_tokens": 1024 }`

You can point the extension to this URL via the `localcopilot.sidecarUrl` setting.

---

## 🧑‍💻 Contributing

1. **Fork** the repository.  
2. Create a feature branch: `git checkout -b feat/your-feature`.  
3. Make your changes and ensure the extension still builds: `npm run compile`.  
4. Open a **Pull Request** with a clear description of the change.

Please follow the existing code style (TypeScript for the extension, Python 3.10+ for the side‑car) and include unit tests where applicable.

---

## 📜 License

This project is licensed under the **MIT License** – see the `LICENSE` file for details.