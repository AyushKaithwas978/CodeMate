# Local Copilot

## Overview

Local Copilot is a lightweight, offline AI‑powered code assistant that runs directly inside Visual Studio Code. It provides context‑aware suggestions, completions, and documentation without sending any data to external services. The extension is built with TypeScript and leverages a locally hosted language model, making it suitable for privacy‑focused developers and teams.

### What’s New
- **Enhanced Sidebar UI** – Refactored `media/sidebar.js` adds a responsive, theme‑aware sidebar with custom icons and a collapsible “Recent Completions” panel.  
- **New Commands** – `extension.ts` now registers two additional commands:
  1. **Local Copilot: Toggle Sidebar** – Quickly show or hide the sidebar without leaving the editor.  
  2. **Local Copilot: Refresh Completions** – Clears the current suggestion cache and forces a fresh generation from the model.  
- **Improved Settings** – Added `sidebarTheme` (auto | light | dark) to let the sidebar match your VS Code theme or stay fixed.

## Features

- **Offline operation** – All inference happens on your machine; no network traffic is required.  
- **Context‑aware completions** – Generates suggestions based on the current file, open editors, and workspace symbols.  
- **Inline documentation** – Quickly insert JSDoc/TSDoc blocks or Python docstrings with a single command.  
- **Customizable prompts** – Tailor the model’s behavior via a simple JSON configuration.  
- **Multi‑language support** – Works out of the box for JavaScript/TypeScript, Python, Go, and more (via VS Code language extensions).  
- **Telemetry‑free** – No usage data is collected or transmitted.  
- **Responsive sidebar** – A modern, collapsible UI that adapts to light/dark themes and shows recent completions, model logs, and quick‑action buttons.  

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
3. The Local Copilot icon appears in the activity bar. Click it to open the control panel (or use the new **Toggle Sidebar** command).

### First‑time Configuration

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).  
2. Run **Local Copilot: Open Settings**.  
3. Set the `modelEndpoint` (default: `http://localhost:11434/v1/completions`) and adjust any model‑specific parameters (temperature, max tokens, etc.).  
4. (Optional) Choose a `sidebarTheme` – `auto` follows VS Code, `light` forces a light sidebar, `dark` forces a dark sidebar.  
5. Save the settings – the extension will automatically test the connection and display the model name.

## Usage

| Command | Keyboard Shortcut | Description |
|---------|-------------------|-------------|
| **Local Copilot: Generate Completion** | `Ctrl+Alt+Space` | Generates an inline code suggestion at the cursor position. |
| **Local Copilot: Insert Documentation** | `Ctrl+Alt+D` | Inserts a docstring or JSDoc block based on the surrounding function/method signature. |
| **Local Copilot: Open Panel** | `Ctrl+Alt+L` | Opens the side‑panel UI where you can view recent completions, adjust settings, and view model logs. |
| **Local Copilot: Toggle Sidebar** | `Ctrl+Alt+S` | Shows or hides the enhanced sidebar without leaving the editor. |
| **Local Copilot: Refresh Completions** | `Ctrl+Alt+R` | Clears the suggestion cache and forces a fresh generation from the model. |
| **Local Copilot: Refresh Model** | — | Re‑loads the model configuration without restarting VS Code. |

### Example Workflow

1. **Start typing** a function or class.  
2. Press `Ctrl+Alt+Space`. The extension sends the current file context to the local model and inserts a suggestion.  
3. Accept the suggestion with `Tab` or reject with `Esc`.  
4. Need documentation? Place the cursor on the function name and press `Ctrl+Alt+D`. A formatted docstring is generated and inserted automatically.  
5. Want a quick glance at recent completions? Press `Ctrl+Alt+S` to toggle the sidebar, then click any entry to re‑insert it or view its log.  
6. If the model seems “stuck”, hit `Ctrl+Alt+R` to refresh completions and start fresh.

## Development

### Project Structure

```
localcopilot/
├─ media/
│   └─ sidebar.js          # Updated UI logic – theme aware, collapsible panels
├─ src/
│   ├─ extension.ts        # Main activation file – new commands registered here
│   └─ …                   # Helper modules
├─ package.json            # VS Code extension manifest (commands updated)
├─ tsconfig.json           # TypeScript configuration
└─ README.md               # This file
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
3. Implement the command’s logic (you can reuse patterns from the existing commands).  
4. Add an entry to the **Usage** table in this README and optionally bind a keyboard shortcut in `package.json` under `contributes.keybindings`.

### Updating the Sidebar

The sidebar UI lives in `media/sidebar.js`. When extending it:

1. Keep the module AMD‑compatible – it is loaded via `vscode.window.createWebviewPanel`.  
2. Use the `sidebarTheme` setting to apply CSS classes (`light`, `dark`, or `auto`).  
3. Add new panels by appending to the `<div id="panels">` container and wiring click handlers in the script.  
4. Remember to update the CSP meta‑tag if you introduce external resources.

## Contributing

- Fork the repository.  
- Create a feature branch (`git checkout -b feature/awesome‑thing`).  
- Make your changes, ensuring the TypeScript compiles (`npm run compile`).  
- Run tests (`npm run test`).  
- Submit a Pull Request with a clear description of the change.

## License

Distributed under the MIT License. See `LICENSE` for more information.