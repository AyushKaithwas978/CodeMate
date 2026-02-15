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
    repo_path = r"c:\Users\Ayush\Desktop\My coding documents\AI\codemate-mcp-test"
    owner = "AyushKaithwas978"
    repo = "codemate-mcp-test"
    description = "Random test repo updated via CodeMate MCP"

    proc = subprocess.Popen(
        [sys.executable, "server.py"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=".",
    )

    send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    print(recv(proc))

    send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": "git_push",
        "arguments": {
            "repo_path": repo_path,
            "remote": "origin",
            "branch": "main"
        }
    }})
    print(recv(proc))

    send(proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "github_update_description",
        "arguments": {
            "owner": owner,
            "repo": repo,
            "description": description,
            "dry_run": False
        }
    }})
    print(recv(proc))

    proc.terminate()


if __name__ == "__main__":
    main()
