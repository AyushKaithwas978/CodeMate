from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class ToolResult:
    ok: bool
    message: str
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


def load_env_file() -> None:
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                raw = line.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                key, val = raw.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception:
        # Ignore .env load errors to avoid breaking server startup
        pass


def run_cmd(cmd: list[str]) -> ToolResult:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            return ToolResult(
                ok=False,
                message="Command failed",
                error=proc.stderr.strip() or "unknown error",
                data={"command": shlex.join(cmd), "stdout": proc.stdout.strip()},
            )
        return ToolResult(
            ok=True,
            message="Command completed",
            data={"command": shlex.join(cmd), "stdout": proc.stdout.strip()},
        )
    except Exception as exc:
        return ToolResult(
            ok=False,
            message="Command exception",
            error=str(exc),
            data={"command": shlex.join(cmd)},
        )


def github_create_repo(
    name: str,
    private: bool = False,
    dry_run: bool = False,
    description: Optional[str] = None,
) -> ToolResult:
    if dry_run:
        return ToolResult(
            ok=True,
            message="Dry-run: GitHub API create repo skipped",
            data={"name": name, "private": private, "description": description},
        )

    token = os.getenv("GITHUB_TOKEN")
    if not token:
        return ToolResult(
            ok=False,
            message="Missing GITHUB_TOKEN env var",
            error="Set GITHUB_TOKEN with repo scope to use GitHub API.",
        )

    payload: Dict[str, Any] = {"name": name, "private": private}
    if description:
        payload["description"] = description

    req = urllib.request.Request(
        "https://api.github.com/user/repos",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "codemate-mcp",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
            return ToolResult(
                ok=True,
                message="Repo created via GitHub API",
                data={
                    "name": data.get("name"),
                    "full_name": data.get("full_name"),
                    "html_url": data.get("html_url"),
                },
            )
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="ignore")
        return ToolResult(
            ok=False,
            message="GitHub API error",
            error=f"HTTP {exc.code}: {err_body}",
        )
    except Exception as exc:
        return ToolResult(ok=False, message="GitHub API exception", error=str(exc))


def git_status(repo_path: str) -> ToolResult:
    cmd = ["git", "-C", repo_path, "status", "--short"]
    return run_cmd(cmd)


def git_commit(repo_path: str, message: str, dry_run: bool = False) -> ToolResult:
    if dry_run:
        return ToolResult(ok=True, message="Dry-run: git add/commit skipped", data={"message": message})
    add_cmd = ["git", "-C", repo_path, "add", "-A"]
    add_res = run_cmd(add_cmd)
    if not add_res.ok:
        return add_res
    commit_cmd = ["git", "-C", repo_path, "commit", "-m", message]
    return run_cmd(commit_cmd)


def git_push(repo_path: str, remote: str = "origin", branch: str = "main") -> ToolResult:
    cmd = ["git", "-C", repo_path, "push", remote, branch]
    return run_cmd(cmd)


def github_update_description(owner: str, repo: str, description: str, dry_run: bool = False) -> ToolResult:
    if dry_run:
        return ToolResult(
            ok=True,
            message="Dry-run: GitHub API update description skipped",
            data={"owner": owner, "repo": repo, "description": description},
        )

    token = os.getenv("GITHUB_TOKEN")
    if not token:
        return ToolResult(
            ok=False,
            message="Missing GITHUB_TOKEN env var",
            error="Set GITHUB_TOKEN with repo scope to use GitHub API.",
        )

    payload = {"description": description}
    req = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "codemate-mcp",
        },
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
            return ToolResult(
                ok=True,
                message="Repo description updated",
                data={
                    "full_name": data.get("full_name"),
                    "description": data.get("description"),
                    "html_url": data.get("html_url"),
                },
            )
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="ignore")
        return ToolResult(
            ok=False,
            message="GitHub API error",
            error=f"HTTP {exc.code}: {err_body}",
        )
    except Exception as exc:
        return ToolResult(ok=False, message="GitHub API exception", error=str(exc))


TOOLS = [
    {
        "name": "github_create_repo",
        "description": "Create a GitHub repo using GitHub API (requires GITHUB_TOKEN).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "private": {"type": "boolean", "default": False},
                "dry_run": {"type": "boolean", "default": False},
                "description": {"type": "string"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "git_status",
        "description": "Get git status --short for a local repo path.",
        "inputSchema": {
            "type": "object",
            "properties": {"repo_path": {"type": "string"}},
            "required": ["repo_path"],
        },
    },
    {
        "name": "git_commit",
        "description": "Stage all changes and create a git commit.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo_path": {"type": "string"},
                "message": {"type": "string"},
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["repo_path", "message"],
        },
    },
    {
        "name": "git_push",
        "description": "Push to a remote branch.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo_path": {"type": "string"},
                "remote": {"type": "string", "default": "origin"},
                "branch": {"type": "string", "default": "main"},
            },
            "required": ["repo_path"],
        },
    },
    {
        "name": "github_update_description",
        "description": "Update GitHub repo description using API (requires GITHUB_TOKEN).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "description": {"type": "string"},
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["owner", "repo", "description"],
        },
    },
]


def send_response(msg_id: Any, result: Any) -> None:
    payload = {"jsonrpc": "2.0", "id": msg_id, "result": result}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def send_error(msg_id: Any, code: int, message: str) -> None:
    payload = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle_initialize(msg_id: Any) -> None:
    result = {
        "protocolVersion": "2024-11-05",
        "serverInfo": {"name": "codemate-mcp", "version": "0.1.0"},
        "capabilities": {"tools": {"list": True, "call": True}},
    }
    send_response(msg_id, result)


def handle_tools_list(msg_id: Any) -> None:
    send_response(msg_id, {"tools": TOOLS})


def handle_tools_call(msg_id: Any, params: Dict[str, Any]) -> None:
    tool_name = params.get("name")
    args = params.get("arguments") or {}

    if tool_name == "github_create_repo":
        res = github_create_repo(
            name=args.get("name", ""),
            private=bool(args.get("private", False)),
            dry_run=bool(args.get("dry_run", False)),
        )
    elif tool_name == "git_status":
        res = git_status(repo_path=args.get("repo_path", ""))
    elif tool_name == "git_commit":
        res = git_commit(
            repo_path=args.get("repo_path", ""),
            message=args.get("message", ""),
            dry_run=bool(args.get("dry_run", False)),
        )
    elif tool_name == "git_push":
        res = git_push(
            repo_path=args.get("repo_path", ""),
            remote=args.get("remote", "origin"),
            branch=args.get("branch", "main"),
        )
    elif tool_name == "github_update_description":
        res = github_update_description(
            owner=args.get("owner", ""),
            repo=args.get("repo", ""),
            description=args.get("description", ""),
            dry_run=bool(args.get("dry_run", False)),
        )
    else:
        send_error(msg_id, -32601, f"Unknown tool: {tool_name}")
        return

    content = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "ok": res.ok,
                        "message": res.message,
                        "data": res.data,
                        "error": res.error,
                    },
                    indent=2,
                ),
            }
        ]
    }
    send_response(msg_id, content)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            send_error(None, -32700, "Parse error")
            continue

        msg_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        if method == "initialize":
            handle_initialize(msg_id)
        elif method == "tools/list":
            handle_tools_list(msg_id)
        elif method == "tools/call":
            handle_tools_call(msg_id, params)
        else:
            send_error(msg_id, -32601, f"Method not found: {method}")


if __name__ == "__main__":
    load_env_file()
    main()
