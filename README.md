# Local Copilot

## Overview

Local Copilot is a lightweight, offline AI‑powered code assistant that runs directly inside Visual Studio Code. It provides context‑aware suggestions, completions, and documentation without sending any data to external services. The extension is built with TypeScript and leverages a locally hosted language model, making it suitable for privacy‑focused developers and teams.

## Features

- **Offline operation** – All inference happens on your machine; no network traffic is required.
- **Context‑aware completions** – Generates suggestions based on the current file, open editors, and workspace symbols.
- **Inline documentation** – Quickly insert JSDoc/TSDoc blocks or Python docstrings with a single command.
- **Customizable prompts** – Tailor the model’s behavior via a simple JSON configuration.
- **Multi‑language support** – Works out of the box for JavaScript/TypeScript, Python, Go, and more (via VS Code language extensions).
- **Telemetry‑free** – No usage data is collected or transmitted.

## Quickstart

### Prerequisites

1. **Node.js** (>= 18) and **npm** installed.
2. A compatible local language model (e.g., `llama.cpp`, `ollama`, or any OpenAI‑compatible server) running on `http://localhost:11434`.
3. Visual Studio Code (>= 1.80).

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/localcopilot.git
cd localcopilot

# Install dependencies
npm install

# Build the extension
npm run compile

# Package (optional, for distribution)
npm run package
```

### Running the Extension in VS Code

1. Open the repository folder in VS Code.
2. Press **F5** to launch a new Extension Development Host.
3. The Local Copilot icon appears in the activity bar. Click it to open the control panel.

### First‑time Configuration

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Local Copilot: Open Settings**.
3. Set the `modelEndpoint` (default: `http://localhost:11434/v1/completions`) and adjust any model‑specific parameters (temperature, max tokens, etc.).
4. Save the settings – the extension will automatically test the connection and display the model name.

## Usage

| Command | Keyboard Shortcut | Description |
|---------|-------------------|-------------|
| **Local Copilot: Generate Completion** | `Ctrl+Alt+Space` | Generates an inline code suggestion at the cursor position. |
| **Local Copilot: Insert Documentation** | `Ctrl+Alt+D` | Inserts a docstring or JSDoc block based on the surrounding function/method signature. |
| **Local Copilot: Open Panel** | `Ctrl+Alt+L` | Opens the side‑panel UI where you can view recent completions, adjust settings, and view model logs. |
| **Local Copilot: Refresh Model** | — | Re‑loads the model configuration without restarting VS Code. |

### Example Workflow

1. **Start typing** a function or class.
2. Press `Ctrl+Alt+Space`.  
   The extension sends the current file context to the local model and inserts a suggestion.
3. Accept the suggestion with `Tab` or reject with `Esc`.
4. If you need documentation, place the cursor on the function name and press `Ctrl+Alt+D`.  
   A formatted docstring is generated and inserted automatically.

## Development

### Project Structure

```
localcopilot/
├─ src/                # Extension source code (TypeScript)
│   ├─ extension.ts    # Main activation file (updated with new commands)
│   └─ ...             # Helper modules
├─ package.json        # VS Code extension manifest
├─ tsconfig.json       # TypeScript configuration
└─ README.md           # This file
```

### Running Tests

```bash
npm run test
```

### Debugging

1. Set breakpoints in `src/extension.ts` (or any other source file).
2. Press **F5** to launch the Extension Development Host.
3. Interact with the extension; VS Code will pause at breakpoints allowing inspection of variables and call stacks.

### Adding New Commands

1. Define the command in `package.json` under `contributes.commands`.
2. Register the command in `src/extension.ts` using `vscode.commands.registerCommand`.
3. Implement the handler logic (e.g., call `modelClient.generate(...)`).

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/awesome‑feature`).
3. Ensure code passes linting and tests (`npm run lint && npm test`).
4. Open a Pull Request with a clear description of the change.

### Code Style

- Use **Prettier** for formatting (`npm run format`).
- Follow the existing TypeScript linting rules (`npm run lint`).

## License

This project is licensed under the **MIT License**. See the `LICENSE` file for details.