import json
import subprocess
import sys


def send(proc, msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()


def recv(proc):
    line = proc.stdout.readline()
    if not line:
        return None
    return json.loads(line)


def main():
    server_cmd = [sys.executable, "server.py"]
    proc = subprocess.Popen(
        server_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=".",
    )

    # Initialize
    send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    print(recv(proc))

    # List tools
    send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    print(recv(proc))

    # Create repo Test (private) via GitHub API (requires GITHUB_TOKEN)
    send(
        proc,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "github_create_repo",
                "arguments": {
                    "name": "codemate-mcp-test",
                    "private": True,
                    "description": "Test repo created via CodeMate MCP",
                    "dry_run": False,
                },
            },
        },
    )
    print(recv(proc))

    proc.terminate()


if __name__ == "__main__":
    main()
