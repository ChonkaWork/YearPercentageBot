#!/usr/bin/env python3
"""AI Lab v0.1 (cloud) — autonomous build/verify loop for ephemeral VMs.

Truth is acceptance exit codes only. The VM is reclaimed after the session,
so everything that matters is committed and pushed:
  - state/tasks.json + reports/  -> the claude/* branch this runner runs from
  - task work                    -> branch claude/ai-lab-<task-id>, via git worktree
Never pushes main or any non-claude/* branch. Preflight (registry access)
runs before anything else; if it fails, the run stops and says what is down.
"""
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

from common import (
    now_iso, log, q, sh, tail,
    current_branch, has_origin, repo_dirty, commit_paths, push_branch,
    checkpoint as _checkpoint, ensure_worktree as _ensure_worktree,
)

ROOT = Path(__file__).resolve().parent      # <repo>/ailab
ORCH = ROOT.parent                          # orchestrator repo (state lives here)
QUEUE = Path(os.environ.get("AILAB_QUEUE", ROOT / "queue" / "tasks.yaml"))
CONFIG_FILE = ROOT / "config.yaml"
STATE_FILE = ROOT / "state" / "tasks.json"
STATE_LOGS = ROOT / "state" / "last-logs"   # committed error tails, survive the VM
LOCK_FILE = ROOT / "state" / "run.lock"
LOGS_DIR = ROOT / "logs"
REPORTS_DIR = ROOT / "reports"
WORKTREES = ORCH.parent / ".ailab-worktrees"

BRANCH_PREFIX = "claude/ai-lab-"
MAX_ITER_DEFAULT = 6
OUTPUT_TAIL_LINES = 200
TERMINAL = {"VERIFIED", "FAILED", "INVALID"}

# Files matching these repo-relative globs at task start are protected: the
# agent must make acceptance pass without touching them. Modifications and
# deletions are reverted; a second violating iteration fails the task.
# A task can override with its own `protected_paths` list ([] disables).
PROTECTED_GLOBS_DEFAULT = [
    "src/test/**", "**/src/test/**", "test/**", "tests/**", "**/tests/**",
    "test_*.py", "**/test_*.py", "*_test.py", "**/*_test.py",
    "*Test.java", "**/*Test.java", "*Tests.java", "**/*Tests.java",
    "*.spec.js", "**/*.spec.js", "*.spec.ts", "**/*.spec.ts",
]

CONFIG = {}
if CONFIG_FILE.exists():
    CONFIG = yaml.safe_load(CONFIG_FILE.read_text()) or {}


def cfg(env_key, cfg_key, default, cast=int):
    if os.environ.get(env_key):
        return cast(os.environ[env_key])
    if cfg_key in CONFIG:
        return cast(CONFIG[cfg_key])
    return default


MODEL = cfg("AILAB_MODEL", "model", "claude-sonnet-5", str)
TASK_WALL_SEC = cfg("AILAB_TASK_WALL_SEC", "task_wall_sec", 45 * 60)
RUN_WALL_SEC = cfg("AILAB_RUN_WALL_SEC", "run_wall_sec", 60 * 60)
ACCEPT_TIMEOUT = cfg("AILAB_ACCEPT_TIMEOUT", "acceptance_timeout", 600)
CLAUDE_CALL_CAP = cfg("AILAB_CLAUDE_CALL_CAP", "claude_call_cap", 20 * 60)
PREFLIGHT = CONFIG.get("preflight") or [
    "curl -fsSI --max-time 20 https://repo.maven.apache.org/maven2/",
    "curl -fsSI --max-time 20 https://registry.npmjs.org/",
]


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


def ensure_worktree(repo, branch, tid):
    return _ensure_worktree(repo, branch, tid, WORKTREES)


def checkpoint(state, msg):
    def on_fail(err):
        state.setdefault("push_failures", []).append(
            {"branch": current_branch(ORCH), "at": now_iso(), "error": err})
        save_state(state)
    _checkpoint(ORCH, ["ailab/state", "ailab/reports"], msg, on_fail)


def push_task_branch(workdir, branch, state):
    def on_fail(err):
        state.setdefault("push_failures", []).append(
            {"branch": branch, "at": now_iso(), "error": err})
        save_state(state)
    return push_branch(workdir, branch, on_fail)


# ---------- protected files ----------

def tracked_files(workdir):
    code, out = sh("git ls-files", cwd=workdir, timeout=60)
    return out.splitlines() if code == 0 else []


def build_protected_set(task, workdir):
    """Snapshot at task start: tracked files matching protected globs, plus
    existing files referenced by acceptance commands (test scripts etc.)."""
    import fnmatch
    globs = task.get("protected_paths")
    if globs is None:
        globs = PROTECTED_GLOBS_DEFAULT
    protected = set()
    for f in tracked_files(workdir):
        if any(fnmatch.fnmatch(f, g) for g in globs):
            protected.add(f)
    for cmd in task["acceptance"]:
        try:
            tokens = shlex.split(cmd)
        except ValueError:
            tokens = cmd.split()
        for t in tokens:
            if t.startswith("/") or ".." in t:
                continue
            rel = t[2:] if t.startswith("./") else t
            if (Path(workdir) / rel).is_file():
                protected.add(rel)
    return protected


def enforce_protection(workdir, protected):
    """Revert modifications/deletions of protected files (new files are fine).
    Return the list of violated paths."""
    if not protected:
        return []
    code, out = sh("git status --porcelain", cwd=workdir, timeout=60)
    if code != 0:
        return []
    violated = []
    for line in out.splitlines():
        status, path = line[:2], line[3:].strip()
        if " -> " in path:  # rename: take the source side
            path = path.split(" -> ")[0]
        if path in protected and status.strip() and "?" not in status:
            violated.append(path)
    for path in violated:
        sh(f"git checkout -- {q(path)}", cwd=workdir, timeout=60)
    return violated


# ---------- acceptance ----------

def run_acceptance(task, workdir, log_path):
    timeout = int(task.get("acceptance_timeout", ACCEPT_TIMEOUT))
    report = []
    for cmd in task["acceptance"]:
        code, out = sh(cmd, cwd=workdir, timeout=timeout)
        report.append(f"$ {cmd}\n[exit {code}]\n{out}")
        if code != 0:
            log_path.write_text("\n\n".join(report))
            return False, cmd, f"exit {code}\n{tail(out)}"
    log_path.write_text("\n\n".join(report))
    return True, None, None


def write_last_log(tid, text):
    """Persist the latest failure tail into the committed state dir, so the
    morning read does not depend on the reclaimed VM's local logs."""
    STATE_LOGS.mkdir(parents=True, exist_ok=True)
    (STATE_LOGS / f"{tid}.log").write_text(text)


# ---------- claude ----------

def build_prompt(task, workdir, branch, failure):
    acceptance = "\n".join(f"  - {c}" for c in task["acceptance"])
    p = [
        f"You are an autonomous engineer working inside the git repo at {workdir} "
        f"on branch {branch}. Work ONLY inside this directory.",
        f"Goal: {task['goal']}",
    ]
    if task.get("notes"):
        p.append(f"Notes: {task['notes']}")
    p.append("Acceptance commands that must all exit 0 (run by the harness after "
             "you finish):\n" + acceptance)
    if failure:
        p.append("The last acceptance run FAILED. Real output:\n"
                 f"command: {failure['cmd']}\n{failure['output']}")
        p.append("Read the failure output above, find the root cause, fix it.")
        if failure.get("warning"):
            p.append(f"WARNING: {failure['warning']}")
    else:
        p.append("Plan the minimal change that achieves the goal, then implement it.")
    p.append(
        "Hard rules: make the minimal change; do NOT edit tests or the acceptance "
        "commands to make them pass; do NOT run git commit/push/merge (the harness "
        "commits and pushes); no network access except package registries; if the "
        "goal is impossible, say why and stop."
    )
    return "\n\n".join(p)


def claude_iterate(task, workdir, branch, failure, timeout, log_path):
    prompt = build_prompt(task, workdir, branch, failure)
    cmd = [
        "claude", "-p", prompt,
        "--model", task.get("model", MODEL),
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read Glob Grep Edit Write Bash",
        "--disallowedTools",
        "Bash(git push:*) Bash(git merge:*) Bash(git rebase:*) WebFetch WebSearch",
    ]
    try:
        p = subprocess.run(cmd, cwd=workdir, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out, code = p.stdout or "", p.returncode
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        out += f"\n[ailab] claude call TIMEOUT after {timeout}s"
        code = -1
    log_path.write_text(f"PROMPT:\n{prompt}\n\n--- OUTPUT (exit {code}) ---\n{out}")
    return code


# ---------- validation ----------

def resolve_repo(task):
    p = Path(task["repo"])
    return p if p.is_absolute() else (ORCH / p).resolve()


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
    repo = resolve_repo(task)
    if not repo.is_dir():
        return f"repo path does not exist: {repo}"
    if sh("git rev-parse --is-inside-work-tree", cwd=repo, timeout=30)[0] != 0:
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
        checkpoint(state, f"{tid} INVALID")
        log(f"{tid}: INVALID — {reason}")
        return

    repo = resolve_repo(task)
    branch = f"{BRANCH_PREFIX}{tid}"
    max_iter = int(task.get("max_iterations", MAX_ITER_DEFAULT))
    task_deadline = min(time.monotonic() + TASK_WALL_SEC, run_deadline)
    task_logs = LOGS_DIR / tid
    task_logs.mkdir(parents=True, exist_ok=True)

    workdir = ensure_worktree(repo, branch, tid)
    if repo_dirty(workdir):
        sha = commit_paths(workdir, ["."], f"ai-lab({tid}): wip carried over on resume")
        if sha:
            push_task_branch(workdir, branch, state)
            log(f"{tid}: committed carried-over changes {sha}")

    protected = build_protected_set(task, workdir)
    entry = set_task(state, tid, status="IN_PROGRESS", branch=branch, repo=str(repo))
    checkpoint(state, f"{tid} IN_PROGRESS")
    iteration = entry.get("iterations", 0)
    violations = entry.get("protected_violations", 0)
    log(f"{tid}: IN_PROGRESS on {branch} (iteration {iteration}/{max_iter}, "
        f"{len(protected)} protected file(s))")

    ok, cmd, out = run_acceptance(task, workdir, task_logs / f"iter{iteration}-acceptance.log")
    failure = None if ok else {"cmd": cmd, "output": out}
    no_change_streak = 0
    prev_fail_tail = None

    while not ok:
        if iteration >= max_iter:
            set_task(state, tid, status="FAILED", iterations=iteration,
                     last_error=f"max_iterations ({max_iter}) exhausted; last: {cmd}: {tail(out, 15)}")
            write_last_log(tid, f"FAILED (max_iterations), command: {cmd}\n{tail(out, 120)}")
            checkpoint(state, f"{tid} FAILED (max_iterations)")
            log(f"{tid}: FAILED — max_iterations exhausted")
            return
        remaining = task_deadline - time.monotonic()
        if remaining < 60:
            which = "run" if task_deadline == run_deadline else "task"
            set_task(state, tid, status="FAILED", iterations=iteration,
                     last_error=f"{which} wall-clock limit exhausted; last: {cmd}: {tail(out, 15)}")
            write_last_log(tid, f"FAILED ({which} wall-clock), command: {cmd}\n{tail(out, 120)}")
            checkpoint(state, f"{tid} FAILED (wall-clock)")
            log(f"{tid}: FAILED — wall-clock limit")
            return

        iteration += 1
        set_task(state, tid, iterations=iteration)
        log(f"{tid}: iteration {iteration}/{max_iter} — claude fix attempt")
        claude_timeout = int(min(CLAUDE_CALL_CAP, remaining - 30))
        code = claude_iterate(task, workdir, branch, failure, claude_timeout,
                              task_logs / f"iter{iteration}-claude.log")
        if code != 0:
            log(f"{tid}: claude call exited {code} (see logs), still verifying")

        violated = enforce_protection(workdir, protected)
        warning = None
        if violated:
            violations += 1
            set_task(state, tid, protected_violations=violations,
                     violated_files=violated)
            log(f"{tid}: PROTECTED files modified and reverted: {violated}")
            if violations >= 2:
                msg = (f"modified protected files in {violations} iterations "
                       f"({', '.join(violated)}); changes reverted. The test/"
                       "acceptance files look wrong to the agent — owner decision needed.")
                set_task(state, tid, status="FAILED", iterations=iteration, last_error=msg)
                write_last_log(tid, f"FAILED: {msg}")
                checkpoint(state, f"{tid} FAILED (protected files)")
                log(f"{tid}: FAILED — protected files modified twice")
                return
            warning = (f"you modified protected files ({', '.join(violated)}); "
                       "those changes were REVERTED. Do not touch them — fix the "
                       "code under test instead. A second violation fails the task.")

        sha = commit_paths(workdir, ["."], f"ai-lab({tid}) iter {iteration}: {task['goal']}")
        if sha:
            push_task_branch(workdir, branch, state)
            set_task(state, tid, last_commit=sha)
            log(f"{tid}: committed {sha}")
            no_change_streak = 0
        else:
            log(f"{tid}: no changes produced this iteration")
            no_change_streak += 1
            if no_change_streak >= 2:
                msg = ("no progress: agent produced no changes in 2 consecutive "
                       f"iterations; last: {cmd}: {tail(out, 15)}")
                set_task(state, tid, status="FAILED", iterations=iteration, last_error=msg)
                write_last_log(tid, f"FAILED (no progress), command: {cmd}\n{tail(out, 120)}")
                checkpoint(state, f"{tid} FAILED (no progress)")
                log(f"{tid}: FAILED — no progress, stopping early to save budget")
                return

        ok, cmd, out = run_acceptance(task, workdir, task_logs / f"iter{iteration}-acceptance.log")
        if not ok and prev_fail_tail == tail(out, 30):
            extra = ("the acceptance output is IDENTICAL to the previous iteration — "
                     "your change did not affect the failure; try a different approach.")
            warning = f"{warning} {extra}" if warning else extra
        prev_fail_tail = None if ok else tail(out, 30)
        failure = None if ok else {"cmd": cmd, "output": out, "warning": warning}
        if not ok:
            set_task(state, tid, last_error=f"{cmd}: {tail(out, 15)}")
            write_last_log(tid, f"iteration {iteration}, command: {cmd}\n{tail(out, 120)}")
        checkpoint(state, f"{tid} iter {iteration} ({'green' if ok else 'red'})")

    set_task(state, tid, status="VERIFIED", iterations=iteration, last_error=None)
    write_last_log(tid, f"VERIFIED after {iteration} iteration(s)")
    checkpoint(state, f"{tid} VERIFIED")
    log(f"{tid}: VERIFIED after {iteration} iteration(s)")


def run_preflight(state):
    """Registry/network reachability. On failure: report what is down and stop."""
    failures = []
    for cmd in PREFLIGHT:
        code, out = sh(cmd, cwd=ORCH, timeout=60)
        if code != 0:
            failures.append(f"$ {cmd}\n[exit {code}]\n{tail(out, 10)}")
    if failures:
        state["last_run"] = {"started_at": now_iso(), "stopped_reason": "preflight failed",
                             "preflight": failures}
        save_state(state)
        log("PREFLIGHT FAILED — stopping, not working around it:")
        for f in failures:
            log(f)
        return False
    log(f"preflight OK ({len(PREFLIGHT)} checks)")
    return True


def write_report(state, queue_ids, started_at, stopped_reason=None):
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    by = {"VERIFIED": [], "FAILED": [], "INVALID": [], "OTHER": []}
    for tid in queue_ids:
        e = state["tasks"].get(tid)
        if e:
            by.get(e["status"], by["OTHER"]).append((tid, e))
    lines = [f"# AI Lab run {date}", f"Started {started_at}, model `{MODEL}`."]
    if stopped_reason:
        lines.append(f"**Stopped early: {stopped_reason}.** State saved; restart resumes.")
    if state.get("push_failures"):
        lines.append(f"**WARNING: {len(state['push_failures'])} push failure(s)** — "
                     "some work may exist only on the reclaimed VM. See state/tasks.json.")
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
    (REPORTS_DIR / f"{date}.md").write_text("\n".join(lines) + "\n")
    log(f"report: {REPORTS_DIR / f'{date}.md'}")


def main():
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
    state = load_state()

    try:
        if not run_preflight(state):
            down = "; ".join(f.splitlines()[0] for f in state["last_run"]["preflight"])
            write_report(state, [], started_at, f"preflight failed — unavailable: {down}")
            checkpoint(state, "run BLOCKED: preflight failed")
            return 1

        if not QUEUE.exists():
            log(f"no queue file at {QUEUE}; nothing to do")
            write_report(state, [], started_at)
            checkpoint(state, "run finished: empty queue")
            return 0

        tasks = yaml.safe_load(QUEUE.read_text()) or []
        if isinstance(tasks, dict):
            tasks = tasks.get("tasks", [])
        queue_ids = [t.get("id", f"unnamed-{i}") for i, t in enumerate(tasks)]

        for i, task in enumerate(tasks):
            task.setdefault("id", f"unnamed-{i}")
            if time.monotonic() > run_deadline - 120:
                stopped_reason = f"run wall-clock limit ({RUN_WALL_SEC}s) exhausted"
                log(stopped_reason)
                break
            try:
                process_task(task, state, run_deadline)
            except Exception as e:
                set_task(state, task["id"], status="FAILED", last_error=f"runner error: {e}")
                checkpoint(state, f"{task['id']} FAILED (runner error)")
                log(f"{task['id']}: FAILED — runner error: {e}")

        state["last_run"] = {"started_at": started_at, "finished_at": now_iso(),
                             "stopped_reason": stopped_reason}
        save_state(state)
        write_report(state, queue_ids, started_at, stopped_reason)
        checkpoint(state, "run finished")
        bad = [t for t in queue_ids
               if state["tasks"].get(t, {}).get("status") != "VERIFIED"]
        return 0 if not bad else 2
    finally:
        LOCK_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
