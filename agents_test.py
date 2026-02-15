import json
import requests

BASE_URL = "http://127.0.0.1:7001"


def main():
    repo_path = r"c:\Users\Ayush\Desktop\My coding documents\AI\CodeMate"

    print("== Smoke Test ==")
    resp = requests.post(f"{BASE_URL}/agent/smoke_test", json={"repo_path": repo_path})
    print(json.dumps(resp.json(), indent=2))

    print("\n== Git Status (RepoAgent) ==")
    resp = requests.post(
        f"{BASE_URL}/agent/run",
        json={"agent": "RepoAgent", "task": "git_status", "repo_path": repo_path},
    )
    print(json.dumps(resp.json(), indent=2))

    print("\n== Dry-Run Commit (CommitAgent) ==")
    resp = requests.post(
        f"{BASE_URL}/agent/run",
        json={
            "agent": "CommitAgent",
            "task": "git_commit",
            "repo_path": repo_path,
            "message": "chore: agent dry-run commit",
            "dry_run": True,
        },
    )
    print(json.dumps(resp.json(), indent=2))


if __name__ == "__main__":
    main()
