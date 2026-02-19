from __future__ import annotations

import json
import os
import shlex
import subprocess
import urllib.request
import urllib.error
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException

try:
    from langchain_core.runnables import Runnable  # type: ignore
except Exception:
    Runnable = None  # Optional dependency for later


app = FastAPI(title="CodeMate Agent Service", version="0.1.0")


@dataclass
class AgentResult:
    agent: str
    task: str
    status: str  # "success" | "failed"
    details: str
    artifacts: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class BaseAgent:
    name = "BaseAgent"

    def run(self, task: str, payload: Dict[str, Any]) -> AgentResult:
        return AgentResult(
            agent=self.name,
            task=task,
            status="failed",
            details="Not implemented",
        )


class RepoAgent(BaseAgent):
    name = "RepoAgent"

    def run(self, task: str, payload: Dict[str, Any]) -> AgentResult:
        repo_path = payload.get("repo_path")
        if not repo_path:
            return AgentResult(self.name, task, "failed", "Missing repo_path")

        if task == "git_status":
            return self._git_status(repo_path)

        if task == "git_init":
            return self._git_init(repo_path, payload.get("dry_run", True))

        return AgentResult(self.name, task, "failed", f"Unknown task: {task}")

    def _git_status(self, repo_path: str) -> AgentResult:
        if not os.path.exists(repo_path):
            return AgentResult(self.name, "git_status", "failed", "Repo path not found")

        cmd = ["git", "-C", repo_path, "status", "--short"]
        return run_command(self.name, "git_status", cmd)

    def _git_init(self, repo_path: str, dry_run: bool) -> AgentResult:
        if not os.path.exists(repo_path):
            return AgentResult(self.name, "git_init", "failed", "Repo path not found")

        if dry_run:
            return AgentResult(
                self.name,
                "git_init",
                "success",
                "Dry-run: git init skipped",
                artifacts={"dry_run": True},
            )

        cmd = ["git", "-C", repo_path, "init"]
        return run_command(self.name, "git_init", cmd)


class CommitAgent(BaseAgent):
    name = "CommitAgent"

    def run(self, task: str, payload: Dict[str, Any]) -> AgentResult:
        repo_path = payload.get("repo_path")
        if not repo_path:
            return AgentResult(self.name, task, "failed", "Missing repo_path")

        if task == "git_commit":
            return self._git_commit(repo_path, payload.get("message"), payload.get("dry_run", True))

        return AgentResult(self.name, task, "failed", f"Unknown task: {task}")

    def _git_commit(self, repo_path: str, message: Optional[str], dry_run: bool) -> AgentResult:
        if not message:
            return AgentResult(self.name, "git_commit", "failed", "Missing commit message")

        if dry_run:
            return AgentResult(
                self.name,
                "git_commit",
                "success",
                "Dry-run: git add/commit skipped",
                artifacts={"dry_run": True, "message": message},
            )

        add_cmd = ["git", "-C", repo_path, "add", "-A"]
        add_result = run_command(self.name, "git_add", add_cmd)
        if add_result.status != "success":
            return add_result

        commit_cmd = ["git", "-C", repo_path, "commit", "-m", message]
        return run_command(self.name, "git_commit", commit_cmd)



class StatusAgent(BaseAgent):
    name = "StatusAgent"

    def run(self, task: str, payload: Dict[str, Any]) -> AgentResult:
        repo_path = payload.get("repo_path")
        if not repo_path:
            return AgentResult(self.name, task, "failed", "Missing repo_path")

        if task == "git_status":
            cmd = ["git", "-C", repo_path, "status", "--short"]
            return run_command(self.name, "git_status", cmd)

        return AgentResult(self.name, task, "failed", f"Unknown task: {task}")


class ReadmeAgent(BaseAgent):
    name = "ReadmeAgent"

    def run(self, task: str, payload: Dict[str, Any]) -> AgentResult:
        if task == "generate_readme":
            return self._generate_readme(payload)
        if task == "write_readme":
            return self._write_readme(payload)
        return AgentResult(self.name, task, "failed", f"Unknown task: {task}")

    def _write_readme(self, payload: Dict[str, Any]) -> AgentResult:
        repo_path = payload.get("repo_path")
        content = payload.get("content")
        if not repo_path or content is None:
            return AgentResult(self.name, "write_readme", "failed", "Missing repo_path or content")

        readme_path = os.path.join(repo_path, "README.md")
        try:
            with open(readme_path, "w", encoding="utf-8") as f:
                f.write(content)
            return AgentResult(self.name, "write_readme", "success", "README.md written", {"path": readme_path})
        except Exception as exc:
            return AgentResult(self.name, "write_readme", "failed", "Failed to write README.md", error=str(exc))

    def _generate_readme(self, payload: Dict[str, Any]) -> AgentResult:
        project_name = payload.get("project_name", "Project")
        summary = payload.get("summary", "")
        bullets = payload.get("bullets", [])
        instructions = payload.get("instructions") or payload.get("request") or ""
        repo_path = payload.get("repo_path")
        write_file = bool(payload.get("write", False))

        model = payload.get("model") or os.getenv("OLLAMA_README_MODEL") or "qwen2.5-coder:1.5b"
        prompt = build_readme_prompt(project_name, summary, bullets, instructions)

        try:
            content = ollama_generate(model, prompt)
        except Exception as exc:
            return AgentResult(self.name, "generate_readme", "failed", "Ollama request failed", error=str(exc))

        artifacts: Dict[str, Any] = {"model": model}
        if write_file and repo_path:
            readme_path = os.path.join(repo_path, "README.md")
            try:
                with open(readme_path, "w", encoding="utf-8") as f:
                    f.write(content)
                artifacts["path"] = readme_path
                return AgentResult(self.name, "generate_readme", "success", "README generated and written", artifacts)
            except Exception as exc:
                return AgentResult(self.name, "generate_readme", "failed", "Failed to write README.md", error=str(exc))

        return AgentResult(self.name, "generate_readme", "success", "README generated", {"content": content, **artifacts})


AGENTS: Dict[str, BaseAgent] = {
    "RepoAgent": RepoAgent(),
    "CommitAgent": CommitAgent(),
    "ReadmeAgent": ReadmeAgent(),
    "StatusAgent": StatusAgent(),
}


@app.post("/agent/run")
def run_agent(payload: Dict[str, Any]) -> Dict[str, Any]:
    agent_name = payload.get("agent")
    task = payload.get("task")
    if not agent_name or not task:
        raise HTTPException(status_code=400, detail="Missing agent or task")

    agent = AGENTS.get(agent_name)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")

    result = agent.run(task, payload)
    return asdict(result)


@app.post("/agent/smoke_test")
def smoke_test(payload: Dict[str, Any]) -> Dict[str, Any]:
    repo_path = payload.get("repo_path")
    if not repo_path:
        raise HTTPException(status_code=400, detail="Missing repo_path")

    tool_status = {
        "git": shutil_which("git"),
        "gh": shutil_which("gh"),
        "ollama": shutil_which("ollama"),
    }
    status_result = RepoAgent().run("git_status", {"repo_path": repo_path})

    return {
        "tools": tool_status,
        "git_status": asdict(status_result),
    }


def run_command(agent: str, task: str, cmd: List[str]) -> AgentResult:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return AgentResult(
                agent=agent,
                task=task,
                status="failed",
                details=proc.stderr.strip() or "Command failed",
                artifacts={"command": shlex.join(cmd), "stdout": proc.stdout.strip()},
            )
        return AgentResult(
            agent=agent,
            task=task,
            status="success",
            details=proc.stdout.strip() or "Command completed",
            artifacts={"command": shlex.join(cmd)},
        )
    except Exception as exc:
        return AgentResult(
            agent=agent,
            task=task,
            status="failed",
            details="Command execution error",
            error=str(exc),
            artifacts={"command": shlex.join(cmd)},
        )


def shutil_which(name: str) -> bool:
    try:
        import shutil
        return shutil.which(name) is not None
    except Exception:
        return False


def build_readme_prompt(project_name: str, summary: str, bullets: list[str], instructions: str = "") -> str:
    bullet_text = "\n".join(f"- {b}" for b in bullets if b)
    instruction_text = f"User request: {instructions}\n" if instructions else ""
    return (
        "Write a concise, professional GitHub README.\n"
        f"Project name: {project_name}\n"
        f"Summary: {summary}\n"
        f"{instruction_text}"
        "Requirements:\n"
        "- Use Markdown headers\n"
        "- Include sections: Overview, Highlights, Quickstart, License\n"
        "- Keep it short and resume-friendly\n"
        f"- Highlights to include:\n{bullet_text}\n"
    )


def ollama_generate(model: str, prompt: str) -> str:
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 800},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode("utf-8")
        data = json.loads(body) if body else {}
        return (data.get("response") or "").strip()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7001)

