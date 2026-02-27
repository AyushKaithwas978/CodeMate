from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

TASK_STATES = {"queued", "planning", "running", "waiting_approval", "completed", "failed", "cancelled"}
TOOL_RISK = {
    "git_status": "low",
    "run_tests": "low",
    "summarize_task": "low",
    "write_file": "medium",
    "generate_readme": "medium",
    "git_commit": "medium",
    "git_push": "high",
    "github_create_repo": "high",
    "github_update_description": "high",
}


class TaskCreateRequest(BaseModel):
    goal: str = Field(..., min_length=3)
    context: Dict[str, Any] = Field(default_factory=dict)
    max_steps: int = Field(default=8, ge=2, le=30)
    time_budget_sec: int = Field(default=300, ge=30, le=3600)
    token_budget: int = Field(default=12000, ge=1000, le=250000)


class DenyRequest(BaseModel):
    reason: str = Field(default="Denied by user")


class EventHub:
    def __init__(self) -> None:
        self._queues: Dict[str, List[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, task_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        async with self._lock:
            self._queues.setdefault(task_id, []).append(q)
        return q

    async def unsubscribe(self, task_id: str, q: asyncio.Queue) -> None:
        async with self._lock:
            arr = self._queues.get(task_id, [])
            if q in arr:
                arr.remove(q)
            if not arr:
                self._queues.pop(task_id, None)

    async def publish(self, task_id: str, event: Dict[str, Any]) -> None:
        async with self._lock:
            arr = list(self._queues.get(task_id, []))
        for q in arr:
            try:
                q.put_nowait(event)
            except Exception:
                pass


class Store:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        ddl = """
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL, context_json TEXT NOT NULL,
          current_step_id TEXT, error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
          max_steps INTEGER NOT NULL, time_budget_sec INTEGER NOT NULL, token_budget INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_steps (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_index INTEGER NOT NULL, role TEXT NOT NULL,
          action TEXT NOT NULL, tool_name TEXT NOT NULL, risk_level TEXT NOT NULL, idempotent INTEGER NOT NULL,
          status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tool_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL, result_json TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          score REAL NOT NULL, created_at REAL NOT NULL
        );
        """
        with closing(self._conn()) as c:
            c.executescript(ddl)
            c.commit()

    def create_task(self, req: TaskCreateRequest) -> str:
        now = time.time()
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        with self._lock:
            with closing(self._conn()) as c:
                c.execute(
                    """INSERT INTO tasks(id,goal,status,context_json,current_step_id,error,created_at,updated_at,max_steps,time_budget_sec,token_budget)
                    VALUES(?,?,?,?,NULL,NULL,?,?,?,?,?)""",
                    (task_id, req.goal.strip(), "queued", json.dumps(req.context or {}), now, now, req.max_steps, req.time_budget_sec, req.token_budget),
                )
                c.commit()
        return task_id

    def add_steps(self, task_id: str, steps: List[Dict[str, Any]]) -> None:
        now = time.time()
        with self._lock:
            with closing(self._conn()) as c:
                for s in steps:
                    c.execute(
                        """INSERT INTO task_steps(id,task_id,step_index,role,action,tool_name,risk_level,idempotent,status,input_json,output_json,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)""",
                        (s["id"], task_id, s["step_index"], s["role"], s["action"], s["tool_name"], s["risk_level"], 1 if s.get("idempotent", True) else 0, "pending", json.dumps(s.get("input", {})), now, now),
                    )
                c.commit()

    def set_task(self, task_id: str, status: str, current_step_id: Optional[str] = None, error: Optional[str] = None) -> None:
        if status not in TASK_STATES:
            raise ValueError(status)
        with self._lock:
            with closing(self._conn()) as c:
                c.execute("UPDATE tasks SET status=?, current_step_id=?, error=?, updated_at=? WHERE id=?", (status, current_step_id, error, time.time(), task_id))
                c.commit()

    def set_step(self, step_id: str, status: str, output: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            with closing(self._conn()) as c:
                c.execute("UPDATE task_steps SET status=?, output_json=?, updated_at=? WHERE id=?", (status, json.dumps(output) if output is not None else None, time.time(), step_id))
                c.commit()

    def event(self, task_id: str, event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        now = time.time()
        with self._lock:
            with closing(self._conn()) as c:
                cur = c.execute("INSERT INTO task_events(task_id,event_type,payload_json,created_at) VALUES(?,?,?,?)", (task_id, event_type, json.dumps(payload), now))
                c.commit()
                event_id = int(cur.lastrowid or 0)
        return {"id": event_id, "task_id": task_id, "event_type": event_type, "payload": payload, "created_at": now}

    def tool_run(self, task_id: str, step_id: str, tool_name: str, args: Dict[str, Any], result: Dict[str, Any]) -> None:
        with self._lock:
            with closing(self._conn()) as c:
                c.execute(
                    """INSERT INTO tool_runs(id,task_id,step_id,tool_name,args_json,result_json,duration_ms,created_at)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (f"run_{uuid.uuid4().hex[:12]}", task_id, step_id, tool_name, json.dumps(args), json.dumps(result), int(result.get("duration_ms", 0)), time.time()),
                )
                c.commit()

    def memory(self, task_id: str, key: str, value: str, score: float) -> None:
        with self._lock:
            with closing(self._conn()) as c:
                c.execute("INSERT INTO memory_items(id,task_id,key,value,score,created_at) VALUES(?,?,?,?,?,?)", (f"mem_{uuid.uuid4().hex[:12]}", task_id, key, value, score, time.time()))
                c.commit()

    def list_tasks(self, limit: int = 20) -> List[Dict[str, Any]]:
        with closing(self._conn()) as c:
            rows = c.execute("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?", (max(1, min(limit, 100)),)).fetchall()
        return [self._task_dict(r) for r in rows]

    def snapshot(self, task_id: str) -> Dict[str, Any]:
        with closing(self._conn()) as c:
            t = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not t:
                raise KeyError(task_id)
            steps = c.execute("SELECT * FROM task_steps WHERE task_id=? ORDER BY step_index ASC", (task_id,)).fetchall()
            events = c.execute("SELECT * FROM task_events WHERE task_id=? ORDER BY id ASC", (task_id,)).fetchall()
        return {
            "task": self._task_dict(t),
            "steps": [self._step_dict(r) for r in steps],
            "events": [self._event_dict(r) for r in events],
        }

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        with closing(self._conn()) as c:
            t = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return self._task_dict(t) if t else None

    @staticmethod
    def _j(raw: Optional[str]) -> Dict[str, Any]:
        if not raw:
            return {}
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}

    def _task_dict(self, r: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": r["id"], "goal": r["goal"], "status": r["status"], "context": self._j(r["context_json"]),
            "current_step_id": r["current_step_id"], "error": r["error"], "created_at": r["created_at"], "updated_at": r["updated_at"],
            "max_steps": r["max_steps"], "time_budget_sec": r["time_budget_sec"], "token_budget": r["token_budget"],
        }

    def _step_dict(self, r: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": r["id"], "step_index": r["step_index"], "role": r["role"], "action": r["action"], "tool_name": r["tool_name"],
            "risk_level": r["risk_level"], "idempotent": bool(r["idempotent"]), "status": r["status"],
            "input": self._j(r["input_json"]), "output": self._j(r["output_json"]) if r["output_json"] else None,
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        }

    def _event_dict(self, r: sqlite3.Row) -> Dict[str, Any]:
        return {"id": r["id"], "task_id": r["task_id"], "event_type": r["event_type"], "payload": self._j(r["payload_json"]), "created_at": r["created_at"]}


class Planner:
    def plan(self, task_id: str, goal: str, context: Dict[str, Any], max_steps: int) -> List[Dict[str, Any]]:
        g = goal.lower()
        repo_path = str(context.get("repo_path") or ".")
        steps: List[Dict[str, Any]] = []
        i = 1

        def add(role: str, action: str, tool_name: str, step_input: Dict[str, Any], idempotent: bool = True) -> None:
            nonlocal i
            steps.append(
                {
                    "id": f"{task_id}_step_{i:02d}",
                    "step_index": i,
                    "role": role,
                    "action": action,
                    "tool_name": tool_name,
                    "risk_level": TOOL_RISK.get(tool_name, "medium"),
                    "idempotent": idempotent,
                    "input": step_input,
                }
            )
            i += 1

        add("planner", "Inspect git status", "git_status", {"repo_path": repo_path})

        if "readme" in g:
            add("coder", "Generate README", "generate_readme", {"repo_path": repo_path, "goal": goal})

        path_match = re.search(r"\b([\w\-./\\]+\.[a-zA-Z0-9]{1,8})\b", goal)
        if path_match and any(k in g for k in ("create", "write", "generate", "make")):
            add(
                "coder",
                f"Write file {path_match.group(1)}",
                "write_file",
                {"repo_path": repo_path, "relative_path": path_match.group(1).replace("\\", "/"), "goal": goal},
            )

        if any(k in g for k in ("test", "pytest", "unit test")):
            add("executor", "Run tests", "run_tests", {"repo_path": repo_path, "command": "pytest -q"})

        if "commit" in g:
            add("git_agent", "Commit changes", "git_commit", {"repo_path": repo_path, "message": self._commit_msg(goal)}, idempotent=False)
        if any(k in g for k in ("push", "publish")):
            add("git_agent", "Push changes", "git_push", {"repo_path": repo_path, "remote": "origin", "branch": "main"}, idempotent=False)
        if "create repo" in g or "create repository" in g:
            add("git_agent", "Create GitHub repository", "github_create_repo", {"name": Path(repo_path).name}, idempotent=False)

        add("reviewer", "Summarize outcome", "summarize_task", {"goal": goal})
        return steps[:max_steps]

    @staticmethod
    def _commit_msg(goal: str) -> str:
        short = re.sub(r"\s+", " ", goal).strip()
        short = short[:72] if short else "update project"
        return f"feat: {short[0].lower() + short[1:]}" if len(short) > 1 else f"feat: {short}"


class ToolRunner:
    def run(self, tool_name: str, args: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
        start = time.time()
        transient = False
        try:
            if tool_name == "git_status":
                result = self._cmd(["git", "-C", str(args.get("repo_path") or "."), "status", "--short"], 30)
            elif tool_name == "git_commit":
                result = self._git_commit(args)
            elif tool_name == "git_push":
                result = self._cmd(["git", "-C", str(args.get("repo_path") or "."), "push", str(args.get("remote") or "origin"), str(args.get("branch") or "main")], 90)
            elif tool_name == "run_tests":
                result = self._run_tests(args)
            elif tool_name == "generate_readme":
                result = self._generate_readme(args)
            elif tool_name == "write_file":
                result = self._write_file(args)
            elif tool_name == "github_create_repo":
                result = self._github_create_repo(args)
            elif tool_name == "github_update_description":
                result = self._github_update_description(args)
            elif tool_name == "summarize_task":
                result = {"ok": True, "output": "Task complete. Review step timeline.", "error": "", "artifacts": {}}
            else:
                result = {"ok": False, "output": "", "error": f"Unknown tool: {tool_name}", "artifacts": {}}
        except TimeoutError as exc:
            result = {"ok": False, "output": "", "error": str(exc), "artifacts": {}}
            transient = True
        except urllib.error.URLError as exc:
            result = {"ok": False, "output": "", "error": str(exc), "artifacts": {}}
            transient = True
        except Exception as exc:
            result = {"ok": False, "output": "", "error": str(exc), "artifacts": {}}
        result["duration_ms"] = int((time.time() - start) * 1000)
        return result, transient

    def _git_commit(self, args: Dict[str, Any]) -> Dict[str, Any]:
        repo_path = str(args.get("repo_path") or ".")
        message = str(args.get("message") or "").strip()
        if not message:
            return {"ok": False, "output": "", "error": "Missing commit message", "artifacts": {}}
        add = self._cmd(["git", "-C", repo_path, "add", "-A"], 40)
        if not add.get("ok"):
            return add
        return self._cmd(["git", "-C", repo_path, "commit", "-m", message], 60)

    def _run_tests(self, args: Dict[str, Any]) -> Dict[str, Any]:
        repo_path = str(args.get("repo_path") or ".")
        command = str(args.get("command") or "pytest -q")
        proc = subprocess.run(command, cwd=repo_path, shell=True, capture_output=True, text=True, timeout=180, check=False)
        return {
            "ok": proc.returncode == 0,
            "output": (proc.stdout or "").strip(),
            "error": (proc.stderr or "").strip() if proc.returncode != 0 else "",
            "artifacts": {"command": command, "returncode": proc.returncode},
        }

    def _generate_readme(self, args: Dict[str, Any]) -> Dict[str, Any]:
        repo_path = Path(str(args.get("repo_path") or "."))
        goal = str(args.get("goal") or "")
        prompt = (
            "Write a concise README markdown with sections Overview, Features, Quickstart, License.\n"
            f"Project: {repo_path.name}\nGoal: {goal}\nReturn only markdown."
        )
        content = self._ollama(prompt)
        if not content.strip():
            content = f"# {repo_path.name}\n\n## Overview\n\nGenerated by CodeMate autonomy.\n\n## Features\n\n- Autonomous workflow\n\n## Quickstart\n\nRun project setup commands.\n\n## License\n\nMIT\n"
        target = repo_path / "README.md"
        target.write_text(content, encoding="utf-8")
        return {"ok": True, "output": f"Wrote {target}", "error": "", "artifacts": {"path": str(target)}}

    def _write_file(self, args: Dict[str, Any]) -> Dict[str, Any]:
        repo = Path(str(args.get("repo_path") or ".")).resolve()
        rel = str(args.get("relative_path") or "").strip()
        if not rel:
            return {"ok": False, "output": "", "error": "relative_path is required", "artifacts": {}}
        target = (repo / rel).resolve()
        if repo not in target.parents and repo != target:
            return {"ok": False, "output": "", "error": "Path escapes repo root", "artifacts": {}}
        target.parent.mkdir(parents=True, exist_ok=True)
        body = self._ollama(f"Generate useful starter content for file {rel}.\nRequest: {args.get('goal') or ''}\nReturn only file contents.")
        if not body.strip():
            body = f"# Generated by CodeMate\n# {args.get('goal') or ''}\n"
        target.write_text(body, encoding="utf-8")
        return {"ok": True, "output": f"Wrote {target}", "error": "", "artifacts": {"path": str(target)}}

    def _github_create_repo(self, args: Dict[str, Any]) -> Dict[str, Any]:
        token = os.getenv("GITHUB_TOKEN", "").strip()
        name = str(args.get("name") or "").strip()
        if not token:
            return {"ok": False, "output": "", "error": "Missing GITHUB_TOKEN", "artifacts": {}}
        if not name:
            return {"ok": False, "output": "", "error": "Repository name is required", "artifacts": {}}
        payload = {"name": name, "private": bool(args.get("private", False)), "description": str(args.get("description") or "")}
        req = urllib.request.Request(
            "https://api.github.com/user/repos",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "codemate-gateway", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = json.loads((resp.read() or b"{}").decode("utf-8"))
                return {"ok": True, "output": "Repository created", "error": "", "artifacts": {"full_name": body.get("full_name"), "html_url": body.get("html_url")}}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "output": "", "error": f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='ignore')}", "artifacts": {}}

    def _github_update_description(self, args: Dict[str, Any]) -> Dict[str, Any]:
        token = os.getenv("GITHUB_TOKEN", "").strip()
        owner = str(args.get("owner") or "").strip()
        repo = str(args.get("repo") or "").strip()
        description = str(args.get("description") or "").strip()
        if not token or not owner or not repo:
            return {"ok": False, "output": "", "error": "Missing GITHUB_TOKEN or owner/repo", "artifacts": {}}
        req = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}",
            data=json.dumps({"description": description}).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "codemate-gateway", "Content-Type": "application/json"},
            method="PATCH",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = json.loads((resp.read() or b"{}").decode("utf-8"))
                return {"ok": True, "output": "Description updated", "error": "", "artifacts": {"full_name": body.get("full_name")}}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "output": "", "error": f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='ignore')}", "artifacts": {}}

    def _cmd(self, cmd: List[str], timeout_sec: int) -> Dict[str, Any]:
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec, check=False)
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(f"Command timeout after {timeout_sec}s: {' '.join(cmd)}") from exc
        return {
            "ok": proc.returncode == 0,
            "output": (proc.stdout or "").strip(),
            "error": (proc.stderr or "").strip() if proc.returncode != 0 else "",
            "artifacts": {"command": " ".join(cmd), "returncode": proc.returncode},
        }

    def _ollama(self, prompt: str) -> str:
        model = os.getenv("OLLAMA_AUTONOMY_MODEL", "qwen2.5-coder:1.5b")
        req = urllib.request.Request(
            "http://localhost:11434/api/generate",
            data=json.dumps({"model": model, "prompt": prompt, "stream": False, "options": {"temperature": 0.2, "num_predict": 1000}}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads((resp.read() or b"{}").decode("utf-8"))
                return str(body.get("response") or "").strip()
        except Exception:
            return ""


class Engine:
    def __init__(self, store: Store, hub: EventHub) -> None:
        self.store = store
        self.hub = hub
        self.planner = Planner()
        self.runner = ToolRunner()
        self.pending_approval: Dict[str, str] = {}
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.Lock()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def create_task(self, req: TaskCreateRequest) -> Dict[str, Any]:
        task_id = self.store.create_task(req)
        self._emit(task_id, "task_updated", {"status": "queued"})
        threading.Thread(target=self._plan_and_run, args=(task_id,), daemon=True).start()
        return self.store.snapshot(task_id)

    def approve(self, task_id: str) -> Dict[str, Any]:
        step_id = self.pending_approval.pop(task_id, None)
        if not step_id:
            raise HTTPException(status_code=409, detail="No step awaiting approval")
        self.store.set_step(step_id, "pending")
        self.store.set_task(task_id, "running", current_step_id=step_id, error=None)
        self._emit(task_id, "task_updated", {"status": "running", "approved_step_id": step_id})
        threading.Thread(target=self._run, args=(task_id,), daemon=True).start()
        return self.store.snapshot(task_id)

    def deny(self, task_id: str, reason: str) -> Dict[str, Any]:
        step_id = self.pending_approval.pop(task_id, None)
        if step_id:
            self.store.set_step(step_id, "denied", output={"reason": reason})
        self.store.set_task(task_id, "failed", current_step_id=step_id, error=reason)
        self._emit(task_id, "task_failed", {"reason": reason, "step_id": step_id})
        return self.store.snapshot(task_id)

    def cancel(self, task_id: str) -> Dict[str, Any]:
        task = self.store.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        self.pending_approval.pop(task_id, None)
        self.store.set_task(task_id, "cancelled", current_step_id=task.get("current_step_id"))
        self._emit(task_id, "task_updated", {"status": "cancelled"})
        return self.store.snapshot(task_id)

    def _plan_and_run(self, task_id: str) -> None:
        task = self.store.get_task(task_id)
        if not task:
            return
        self.store.set_task(task_id, "planning")
        self._emit(task_id, "task_updated", {"status": "planning"})
        try:
            steps = self.planner.plan(task_id, task["goal"], task.get("context", {}), int(task.get("max_steps", 8)))
            if not steps:
                raise ValueError("Planner returned zero steps")
            if len(steps) > int(task.get("max_steps", 8)):
                raise ValueError("Planner exceeded max steps")
            for s in steps:
                if not s.get("tool_name"):
                    raise ValueError("Step missing tool intent")
            self.store.add_steps(task_id, steps)
            self.store.set_task(task_id, "running")
            self._emit(task_id, "task_updated", {"status": "running", "planned_steps": len(steps)})
            self._run(task_id)
        except Exception as exc:
            self.store.set_task(task_id, "failed", error=str(exc))
            self._emit(task_id, "task_failed", {"reason": str(exc)})

    def _run(self, task_id: str) -> None:
        snap = self.store.snapshot(task_id)
        task = snap["task"]
        started = task["created_at"]
        for step in snap["steps"]:
            current = self.store.get_task(task_id)
            if not current:
                return
            if current["status"] == "cancelled":
                self._emit(task_id, "task_updated", {"status": "cancelled"})
                return
            if current["status"] not in {"running", "waiting_approval"}:
                return
            if time.time() - started > int(task.get("time_budget_sec", 300)):
                reason = "Time budget exceeded"
                self.store.set_step(step["id"], "failed", output={"error": reason})
                self.store.set_task(task_id, "failed", current_step_id=step["id"], error=reason)
                self._emit(task_id, "task_failed", {"reason": reason, "step_id": step["id"]})
                return
            if step["status"] in {"completed", "denied"}:
                continue

            self.store.set_step(step["id"], "in_progress")
            self.store.set_task(task_id, "running", current_step_id=step["id"], error=None)
            self._emit(task_id, "task_updated", {"status": "running", "current_step_id": step["id"], "tool_name": step["tool_name"], "step_action": step["action"]})

            if step["risk_level"] == "high":
                self.store.set_step(step["id"], "waiting_approval")
                self.store.set_task(task_id, "waiting_approval", current_step_id=step["id"])
                with self._lock:
                    self.pending_approval[task_id] = step["id"]
                self._emit(task_id, "approval_requested", {"task_id": task_id, "step_id": step["id"], "tool_name": step["tool_name"], "action": step["action"], "risk_level": step["risk_level"]})
                return

            result = self._run_with_retry(task_id, step)
            if not result.get("ok"):
                reason = result.get("error") or "Step failed"
                self.store.set_step(step["id"], "failed", output=result)
                self.store.set_task(task_id, "failed", current_step_id=step["id"], error=reason)
                self._emit(task_id, "task_failed", {"reason": reason, "step_id": step["id"], "result": result})
                self.store.memory(task_id, "failure", reason, 0.2)
                return

            self.store.set_step(step["id"], "completed", output=result)
            self._emit(task_id, "task_updated", {"status": "running", "completed_step_id": step["id"]})

        self.store.set_task(task_id, "completed", current_step_id=None, error=None)
        self._emit(task_id, "task_completed", {"task_id": task_id})
        self.store.memory(task_id, "goal", task["goal"], 1.0)
        self.store.memory(task_id, "outcome", "completed", 0.9)

    def _run_with_retry(self, task_id: str, step: Dict[str, Any]) -> Dict[str, Any]:
        last = {"ok": False, "error": "Unknown failure", "output": "", "artifacts": {}}
        for attempt in range(2):
            result, transient = self.runner.run(step["tool_name"], step.get("input", {}))
            self.store.tool_run(task_id, step["id"], step["tool_name"], step.get("input", {}), result)
            last = result
            if result.get("ok"):
                return result
            if not transient or attempt == 1:
                break
            time.sleep(0.75)
        return last

    def _emit(self, task_id: str, event_type: str, payload: Dict[str, Any]) -> None:
        event = self.store.event(task_id, event_type, payload)
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.hub.publish(task_id, event), self.loop)


def create_app(db_path: str) -> FastAPI:
    app = FastAPI(title="CodeMate Gateway", version="0.1.0")
    store = Store(db_path)
    hub = EventHub()
    engine = Engine(store, hub)

    @app.on_event("startup")
    async def startup() -> None:
        engine.set_loop(asyncio.get_running_loop())

    @app.get("/v1/health")
    def health() -> Dict[str, Any]:
        return {"ok": True, "service": "codemate_gateway", "time": time.time()}

    @app.get("/v1/tasks")
    def list_tasks(limit: int = Query(default=20, ge=1, le=100)) -> Dict[str, Any]:
        return {"tasks": store.list_tasks(limit)}

    @app.post("/v1/tasks")
    def create_task(req: TaskCreateRequest) -> Dict[str, Any]:
        return engine.create_task(req)

    @app.get("/v1/tasks/{task_id}")
    def get_task(task_id: str) -> Dict[str, Any]:
        try:
            return store.snapshot(task_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Task not found")

    @app.post("/v1/tasks/{task_id}/approve")
    def approve(task_id: str) -> Dict[str, Any]:
        return engine.approve(task_id)

    @app.post("/v1/tasks/{task_id}/deny")
    def deny(task_id: str, req: DenyRequest) -> Dict[str, Any]:
        return engine.deny(task_id, req.reason.strip() or "Denied by user")

    @app.post("/v1/tasks/{task_id}/cancel")
    def cancel(task_id: str) -> Dict[str, Any]:
        return engine.cancel(task_id)

    @app.get("/v1/tasks/{task_id}/events")
    async def events(task_id: str) -> StreamingResponse:
        if not store.get_task(task_id):
            raise HTTPException(status_code=404, detail="Task not found")
        q = await hub.subscribe(task_id)

        async def gen() -> Any:
            yield f"data: {json.dumps({'event_type': 'snapshot', 'payload': store.snapshot(task_id)})}\n\n"
            try:
                while True:
                    event = await q.get()
                    yield f"data: {json.dumps(event)}\n\n"
            except asyncio.CancelledError:
                return
            finally:
                await hub.unsubscribe(task_id, q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="CodeMate autonomy gateway")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7011)
    parser.add_argument("--db", default=os.path.join(os.getcwd(), ".codemate", "codemate_gateway.db"))
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(create_app(args.db), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
