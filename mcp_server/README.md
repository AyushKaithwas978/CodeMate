# CodeMate MCP Server (GitHub Tools)

This MCP server exposes deterministic GitHub tooling for the CodeMate manager.

## Scope
- Create test repos with `gh` CLI
- Commit + push
- (Later) GitHub Pages deploy helpers

## Requirements
- `gh` CLI installed and authenticated (`gh auth login`)
- `git` installed

## Run
```bash
python server.py
```

## Tools (initial)
- `github_create_repo`
- `git_status`
- `git_commit`

These are intentionally minimal for the first test repo flow.
