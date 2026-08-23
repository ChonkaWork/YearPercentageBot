#!/usr/bin/env python3
"""AI Lab v0.1 — autonomous build/verify loop.

Reads queue/tasks.yaml, drives each task to VERIFIED / FAILED / INVALID.
Truth is acceptance exit codes only. No push, no merge, sequential tasks.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
QUEUE = Path(os.environ.get("AILAB_QUEUE", ROOT / "queue" / "tasks.yaml"))
STATE_FILE = ROOT / "state" / "tasks.json"
LOCK_FILE = ROOT / "state" / "run.lock"
LOGS_DIR = ROOT / "logs"
REPORTS_DIR = ROOT / "reports"

MODEL = os.environ.get("AILAB_MODEL", "claude-sonnet-5")
MAX_ITER_DEFAULT = 6
TASK_WALL_SEC = int(os.environ.get("AILAB_TASK_WALL_SEC", 45 * 60))
RUN_WALL_SEC = int(os.environ.get("AILAB_RUN_WALL_SEC", 4 * 3600))
ACCEPT_TIMEOUT = int(os.environ.get("AILAB_ACCEPT_TIMEOUT", 600))
CLAUDE_CALL_CAP = int(os.environ.get("AILAB_CLAUDE_CALL_CAP", 20 * 60))
OUTPUT_TAIL_LINES = 200

TERMINAL = {"VERIFIED", "FAILED", "INVALID"}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(f"[{now_iso()}] {msg}", flush=True)


# ---------- state ----------

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"tasks": {}}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    tmp.replace(STATE_FILE)


def set_task(state, tid, **fields):
    entry = state["tasks"].setdefault(tid, {"status": "PENDING", "iterations": 0})
    entry.update(fields, updated_at=now_iso())
    save_state(state)
    return entry


# ---------- shell helpers ----------

def sh(cmd, cwd, timeout=None, capture=True):
    """Run a shell command; return (exit_code, combined_output). -1 on timeout."""
    try:
        p = subprocess.run(
            cmd, shell=True, cwd=cwd, timeout=timeout,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None, text=True,
        )
        return p.returncode, (p.stdout or "")
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        return -1, out + f"\n[ailab] TIMEOUT after {timeout}s: {cmd}"


def tail(text, n=OUTPUT_TAIL_LINES):
    lines = text.splitlines()
    return "\n".join(lines[-n:])


# ---------- git ----------

def is_git_repo(repo):
    code, _ = sh("git rev-parse --is-inside-work-tree", cwd=repo, timeout=30)
    return code == 0


def repo_dirty(repo):
    code, out = sh("git status --porcelain", cwd=repo, timeout=30)
    return code != 0 or bool(out.strip())


def ensure_branch(repo, branch):
    code, out = sh(f"git rev-parse --verify {branch}", cwd=repo, timeout=30)
    if code == 0:
        cmd = f"git checkout {branch}"
    else:
        cmd = f"git checkout -b {branch}"
    code, out = sh(cmd, cwd=repo, timeout=60)
    if code != 0:
        raise RuntimeError(f"git checkout failed: {out.strip()}")


def commit_if_changed(repo, message):
    if not repo_dirty(repo):
        return None
    sh("git add -A", cwd=repo, timeout=60)
    code, out = sh(f"git commit -m {json.dumps(message)}", cwd=repo, timeout=60)
    if code != 0:
        raise RuntimeError(f"git commit failed: {out.strip()}")
    _, sha = sh("git rev-parse --short HEAD", cwd=repo, timeout=30)
    return sha.strip()


# ---------- acceptance ----------

def run_acceptance(task, repo, log_path):
    """Run every acceptance command. Return (ok, failed_cmd, output_tail)."""
    timeout = int(task.get("acceptance_timeout", ACCEPT_TIMEOUT))
    report = []
    for cmd in task["acceptance"]:
        code, out = sh(cmd, cwd=repo, timeout=timeout)
        report.append(f"$ {cmd}\n[exit {code}]\n{out}")
        if code != 0:
            log_path.write_text("\n\n".join(report))
            return False, cmd, f"exit {code}\n{tail(out)}"
    log_path.write_text("\n\n".join(report))
    return True, None, None


# ---------- claude ----------

def build_prompt(task, repo, failure):
    acceptance = "\n".join(f"  - {c}" for c in task["acceptance"])
    p = [
        f"You are an autonomous engineer working inside the git repo at {repo} "
        f"on branch ai-lab/{task['id']}. Work ONLY inside this repo.",
        f"Goal: {task['goal']}",
    ]
    if task.get("notes"):
        p.append(f"Notes: {task['notes']}")
    p.append("Acceptance commands that must all exit 0 (run by the harness after you finish):\n" + acceptance)
    if failure:
        p.append("The last acceptance run FAILED. Real output:\n"
                 f"command: {failure['cmd']}\n{failure['output']}")
        p.append("Read the failure output above, find the root cause, fix it.")
    else:
        p.append("Plan the minimal change that achieves the goal, then implement it.")
    p.append(
        "Hard rules: make the minimal change; do NOT edit tests or the acceptance "
        "commands to make them pass; do NOT run git commit/push/merge (the harness "
        "commits); no network access except package registries; if the goal is "
        "impossible, say why and stop."
    )
    return "\n\n".join(p)


def claude_iterate(task, repo, failure, timeout, log_path):
    prompt = build_prompt(task, repo, failure)
    cmd = [
        "claude", "-p", prompt,
        "--model", task.get("model", MODEL),
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read Glob Grep Edit Write Bash",
        "--disallowedTools",
        "Bash(git push:*) Bash(git merge:*) Bash(git rebase:*) WebFetch WebSearch",
    ]
    try:
        p = subprocess.run(cmd, cwd=repo, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out, code = p.stdout or "", p.returncode
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        out += f"\n[ailab] claude call TIMEOUT after {timeout}s"
        code = -1
    log_path.write_text(f"PROMPT:\n{prompt}\n\n--- OUTPUT (exit {code}) ---\n{out}")
    return code


# ---------- task validation ----------

def validate(task):
    if not task.get("id"):
        return "missing id"
    if not task.get("repo"):
        return "missing repo"
    acc = task.get("acceptance")
    if not isinstance(acc, list) or not [c for c in acc if isinstance(c, str) and c.strip()]:
        return "no acceptance commands"
    if not task.get("goal"):
        return "missing goal"
    repo = Path(task["repo"])
    if not repo.is_dir():
        return f"repo path does not exist: {repo}"
    if not is_git_repo(repo):
        return f"not a git repo: {repo}"
    return None


# ---------- main loop ----------

def process_task(task, state, run_deadline):
    tid = task["id"]
    entry = state["tasks"].get(tid, {"status": "PENDING", "iterations": 0})
    if entry["status"] in TERMINAL:
        log(f"{tid}: {entry['status']}, skipping")
        return

    reason = validate(task)
    if reason:
        set_task(state, tid, status="INVALID", last_error=reason)
        log(f"{tid}: INVALID — {reason}")
        return

    repo = str(Path(task["repo"]).resolve())
    branch = f"ai-lab/{tid}"
    max_iter = int(task.get("max_iterations", MAX_ITER_DEFAULT))
    task_deadline = min(time.monotonic() + TASK_WALL_SEC, run_deadline)
    task_logs = LOGS_DIR / tid
    task_logs.mkdir(parents=True, exist_ok=True)

    resuming = entry["status"] == "IN_PROGRESS"
    if not resuming and repo_dirty(repo):
        set_task(state, tid, status="INVALID",
                 last_error="repo has uncommitted changes; refusing to start")
        log(f"{tid}: INVALID — dirty repo")
        return

    ensure_branch(repo, branch)
    entry = set_task(state, tid, status="IN_PROGRESS", branch=branch, repo=repo)
    iteration = entry.get("iterations", 0)
    log(f"{tid}: IN_PROGRESS on {branch} (iteration {iteration}/{max_iter})")

    ok, cmd, out = run_acceptance(task, repo, task_logs / f"iter{iteration}-acceptance.log")
    failure = None if ok else {"cmd": cmd, "output": out}

    while not ok:
        if iteration >= max_iter:
            set_task(state, tid, status="FAILED", iterations=iteration,
                     last_error=f"max_iterations ({max_iter}) exhausted; last: {cmd}: {tail(out, 15)}")
            log(f"{tid}: FAILED — max_iterations exhausted")
            return
        remaining = task_deadline - time.monotonic()
        if remaining < 60:
            which = "run" if task_deadline == run_deadline else "task"
            set_task(state, tid, status="FAILED", iterations=iteration,
                     last_error=f"{which} wall-clock limit exhausted; last: {cmd}: {tail(out, 15)}")
            log(f"{tid}: FAILED — wall-clock limit")
            return

        iteration += 1
        set_task(state, tid, iterations=iteration)
        log(f"{tid}: iteration {iteration}/{max_iter} — claude fix attempt")
        claude_timeout = int(min(CLAUDE_CALL_CAP, remaining - 30))
        code = claude_iterate(task, repo, failure, claude_timeout,
                              task_logs / f"iter{iteration}-claude.log")
        if code != 0:
            log(f"{tid}: claude call exited {code} (see logs), still verifying")

        sha = commit_if_changed(repo, f"ai-lab({tid}) iter {iteration}: {task['goal']}")
        if sha:
            set_task(state, tid, last_commit=sha)
            log(f"{tid}: committed {sha}")
        else:
            log(f"{tid}: no changes produced this iteration")

        ok, cmd, out = run_acceptance(task, repo, task_logs / f"iter{iteration}-acceptance.log")
        failure = None if ok else {"cmd": cmd, "output": out}
        if not ok:
            set_task(state, tid, last_error=f"{cmd}: {tail(out, 15)}")

    set_task(state, tid, status="VERIFIED", iterations=iteration, last_error=None)
    log(f"{tid}: VERIFIED after {iteration} iteration(s)")


def write_report(state, queue_ids, started_at, stopped_reason=None):
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    by = {"VERIFIED": [], "FAILED": [], "INVALID": [], "OTHER": []}
    for tid in queue_ids:
        e = state["tasks"].get(tid)
        if not e:
            continue
        by.get(e["status"], by["OTHER"]).append((tid, e))
    lines = [f"# AI Lab run {date}", f"Started {started_at}, model `{MODEL}`."]
    if stopped_reason:
        lines.append(f"**Stopped early: {stopped_reason}.** State saved; restart resumes.")
    for status, items in by.items():
        if not items:
            continue
        lines.append(f"\n## {status if status != 'OTHER' else 'IN PROGRESS / PENDING'}")
        for tid, e in items:
            detail = f"{e.get('iterations', 0)} iter"
            if e.get("branch"):
                detail += f", branch `{e['branch']}`"
            if e.get("last_error"):
                err = e["last_error"].strip().splitlines()
                detail += f" — {err[0][:160]}" + (" …" if len(err) > 1 else "")
            lines.append(f"- **{tid}** ({e['status']}): {detail}")
    if not any(by.values()):
        lines.append("\nQueue was empty.")
    path = REPORTS_DIR / f"{date}.md"
    path.write_text("\n".join(lines) + "\n")
    log(f"report: {path}")
    return path


def main():
    if not QUEUE.exists():
        log(f"no queue file at {QUEUE}; nothing to do")
        return 0
    if shutil.which("claude") is None:
        log("claude CLI not found; aborting")
        return 1

    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    if LOCK_FILE.exists():
        pid = LOCK_FILE.read_text().strip()
        if pid and Path(f"/proc/{pid}").exists():
            log(f"another run is active (pid {pid}); exiting")
            return 1
        log("stale lock found, removing")
    LOCK_FILE.write_text(str(os.getpid()))

    started_at = now_iso()
    run_deadline = time.monotonic() + RUN_WALL_SEC
    stopped_reason = None
    tasks = yaml.safe_load(QUEUE.read_text()) or []
    if isinstance(tasks, dict):
        tasks = tasks.get("tasks", [])
    queue_ids = [t.get("id", f"unnamed-{i}") for i, t in enumerate(tasks)]
    state = load_state()

    try:
        for i, task in enumerate(tasks):
            task.setdefault("id", f"unnamed-{i}")
            if time.monotonic() > run_deadline - 120:
                stopped_reason = "run wall-clock limit (4h) exhausted"
                log(stopped_reason)
                break
            try:
                process_task(task, state, run_deadline)
            except Exception as e:
                set_task(state, task["id"], status="FAILED",
                         last_error=f"runner error: {e}")
                log(f"{task['id']}: FAILED — runner error: {e}")
    finally:
        write_report(state, queue_ids, started_at, stopped_reason)
        LOCK_FILE.unlink(missing_ok=True)

    bad = [t for t in queue_ids
           if state["tasks"].get(t, {}).get("status") not in ("VERIFIED",)]
    return 0 if not bad else 2


if __name__ == "__main__":
    sys.exit(main())
