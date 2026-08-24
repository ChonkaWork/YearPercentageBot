"""Shared helpers for AI Lab runners (build_runner and research_runner).

Pure/stateless: shell exec, git discipline, state checkpointing. No task-
specific logic lives here.
"""
import json
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

OUTPUT_TAIL_LINES = 200


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(f"[{now_iso()}] {msg}", flush=True)


def q(p):
    return shlex.quote(str(p))


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
    return "\n".join(text.splitlines()[-n:])


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(path)


# ---------- git ----------

def current_branch(repo):
    code, out = sh("git rev-parse --abbrev-ref HEAD", cwd=repo, timeout=30)
    return out.strip() if code == 0 else ""


def has_origin(repo):
    return sh("git remote get-url origin", cwd=repo, timeout=30)[0] == 0


def repo_dirty(repo):
    code, out = sh("git status --porcelain", cwd=repo, timeout=60)
    return code != 0 or bool(out.strip())


def commit_paths(repo, paths, message):
    """Stage given paths and commit if anything changed. Return short sha or None."""
    sh(f"git add -A -- {' '.join(q(p) for p in paths)}", cwd=repo, timeout=60)
    if sh("git diff --cached --quiet", cwd=repo, timeout=60)[0] == 0:
        return None
    code, out = sh(f"git commit -m {q(message)}", cwd=repo, timeout=60)
    if code != 0:
        raise RuntimeError(f"git commit failed: {out.strip()}")
    return sh("git rev-parse --short HEAD", cwd=repo, timeout=30)[1].strip()


def push_branch(repo, branch, on_fail=None):
    """Push a claude/* branch with retries. Never pushes anything else.
    on_fail(error_tail) is called if all retries are exhausted."""
    if not branch.startswith("claude/"):
        log(f"[push] REFUSING to push non-claude/* branch '{branch}'")
        return False
    if not has_origin(repo):
        log(f"[push] no origin remote in {repo}; keeping work local")
        return False
    out = ""
    for i, delay in enumerate((0, 2, 4, 8, 16)):
        if delay:
            time.sleep(delay)
        code, out = sh(f"git push -u origin {q(branch)}", cwd=repo, timeout=180)
        if code == 0:
            return True
        if i == 0 and "reject" in out:
            rc, _ = sh(f"git pull --rebase origin {q(branch)}", cwd=repo, timeout=120)
            if rc != 0:
                sh("git rebase --abort", cwd=repo, timeout=60)
    log(f"[push] FAILED for {branch} after retries: {tail(out, 5)}")
    if on_fail:
        on_fail(tail(out, 5))
    return False


def checkpoint(orch, paths, msg, on_fail=None):
    """Commit given repo-relative paths on the orchestrator branch and push.
    State survives the VM only through this, so a refusal/failure is loud."""
    branch = current_branch(orch)
    if not branch.startswith("claude/"):
        log(f"[state] orchestrator branch '{branch}' is not claude/*; "
            "NOT committing state (no-push-to-main rule). State is VM-local only!")
        return
    try:
        sha = commit_paths(orch, paths, f"ai-lab: {msg}")
    except RuntimeError as e:
        log(f"[state] {e}")
        return
    if sha:
        push_branch(orch, branch, on_fail)


def default_base(repo):
    for ref in ("refs/remotes/origin/HEAD", "refs/remotes/origin/main",
                "refs/remotes/origin/master"):
        if sh(f"git rev-parse --verify -q {ref}", cwd=repo, timeout=30)[0] == 0:
            return ref
    return "HEAD"


def ensure_worktree(repo, branch, tid, worktrees_dir):
    """Check out `branch` of `repo` in a dedicated worktree; return its path."""
    import shutil
    if current_branch(repo) == branch:
        return Path(repo)
    workdir = worktrees_dir / f"{Path(repo).name}-{tid}"
    sh("git worktree prune", cwd=repo, timeout=60)
    if workdir.exists():
        if current_branch(workdir) == branch:
            return workdir
        sh(f"git worktree remove --force {q(workdir)}", cwd=repo, timeout=60)
        shutil.rmtree(workdir, ignore_errors=True)
        sh("git worktree prune", cwd=repo, timeout=60)
    workdir.parent.mkdir(parents=True, exist_ok=True)
    if has_origin(repo):
        sh(f"git fetch origin {q(branch)}", cwd=repo, timeout=120)
    if sh(f"git rev-parse --verify -q refs/heads/{branch}", cwd=repo, timeout=30)[0] == 0:
        cmd = f"git worktree add {q(workdir)} {q(branch)}"
    elif sh(f"git rev-parse --verify -q refs/remotes/origin/{branch}",
            cwd=repo, timeout=30)[0] == 0:
        cmd = f"git worktree add --track -b {q(branch)} {q(workdir)} origin/{q(branch)}"
    else:
        cmd = f"git worktree add -b {q(branch)} {q(workdir)} {default_base(repo)}"
    code, out = sh(cmd, cwd=repo, timeout=120)
    if code != 0:
        raise RuntimeError(f"worktree setup failed: {out.strip()}")
    return workdir
