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
        "name": "git_commit",
        "arguments": {
            "repo_path": repo_path,
            "message": "docs: add README via ReadmeAgent"
        }
    }})
    print(recv(proc))

    proc.terminate()


if __name__ == "__main__":
    main()
