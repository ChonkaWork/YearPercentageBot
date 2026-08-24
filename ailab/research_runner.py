#!/usr/bin/env python3
"""AI Lab — Research + Filter stage.

Runs when there's idle nightly budget. Finds real, sourced problems
worth building software for; keeps only candidates with a concrete,
code-free, one-evening kill-test. Produces NOTHING that gets built —
output is a report + candidate records for a human to read and decide on.

No scoring, no invented numbers, no code execution. Empty field beats an
invented one. State/report commit to the orchestrator's claude/* branch,
same discipline as build_runner.
"""
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from common import now_iso, log, tail, checkpoint, current_branch

ROOT = Path(__file__).resolve().parent
ORCH = ROOT.parent
STATE_FILE = ROOT / "state" / "candidates.json"
REPORTS_DIR = ROOT / "reports"
RAW_FILE = ROOT / "state" / "research-raw.md"
FILTER_FILE = ROOT / "state" / "research-filter.md"
SCOUT_DIR = ROOT / "state" / "scouts"

MODEL = os.environ.get("AILAB_MODEL", "claude-sonnet-5")
# Only 2 claude calls total (Researcher + Filter), so this is a hang backstop,
# not a budget lever — a $100/mo plan's 5h window easily covers this either way.
RUN_WALL_SEC = int(os.environ.get("AILAB_RESEARCH_WALL_SEC", 100 * 60))
CALL_CAP = int(os.environ.get("AILAB_RESEARCH_CALL_CAP", 40 * 60))
TARGET_LEADS = 10          # leads per scout
TARGET_PASSED = 3
MAX_PARALLEL = int(os.environ.get("AILAB_RESEARCH_PARALLEL", 5))

# Each scout searches a different angle so they don't converge on the same
# corner of the internet. One scout = one independent claude call.
SCOUT_ANGLES = [
    ("github-issues", "Popular GitHub repos: issues and discussions with many "
     "reactions/comments asking for something that does not exist yet, "
     "'is there a tool that...' threads, feature requests closed as wontfix "
     "that people keep re-opening."),
    ("github-abandoned", "GitHub: widely-used repos that are abandoned, "
     "archived, or unmaintained while their issue trackers still get traffic; "
     "forks that sprang up because the original died."),
    ("deprecations", "Deprecation and end-of-life announcements, platform API "
     "changes, and migration deadlines announced by major vendors/platforms "
     "that force people to change tooling by a specific date."),
    ("regulatory", "Regulatory and compliance deadlines (accessibility, data "
     "protection, reporting, e-invoicing, standards) that take effect on a "
     "known date and create concrete new obligations for small businesses or "
     "developers."),
    ("indie-pain", "IndieHackers, Hacker News, Product Hunt comments and "
     "similar builder communities: explicitly stated recurring pain points, "
     "'I built this for myself because nothing existed' posts, complaints "
     "about existing tools' pricing or missing features."),
    ("reddit-forums", "Reddit and specialist forums (via general web search, "
     "since direct crawling is blocked): recurring complaints, 'what do you "
     "use for X' threads with unsatisfying answers, workflow workarounds "
     "people describe doing by hand."),
    ("ai-tooling", "AI/LLM developer ecosystem: gaps in agent tooling, "
     "evaluation, observability, prompt/version management, cost control, "
     "and integration glue that practitioners publicly complain about."),
    ("boring-manual", "Unsexy manual workflows in specific industries "
     "(logistics, construction, clinics, education, accounting, local "
     "government) that people describe doing with spreadsheets and email; "
     "look for job ads and forum posts describing the manual process."),
    ("api-launches", "Newly launched or newly opened APIs and platform "
     "capabilities (last ~6 months) where the ecosystem of tooling around "
     "them is still thin, and people are asking for wrappers/integrations."),
    ("pricing-gaps", "Products whose users publicly complain about pricing "
     "changes, seat minimums, or enterprise-only features — where a cheaper "
     "or self-hosted alternative is being explicitly asked for."),
]

FORBIDDEN_TERM_PATTERNS = [
    r"willingness to pay", r"готовніст[ьи] платити",
    r"market size", r"розмір ринку", r"обсяг ринку", r"обʼєм ринку",
    r"\bconfidence\b", r"впевненіст[ьи]",
    r"\bscore\b", r"\bбал(и|ів)?\b",
    r"великий потенціал", r"great potential", r"\bпотенціал\b",
    r"\bTAM\b", r"\bSAM\b",
]
INVALID_KILLTEST_PATTERNS = [
    r"landing page", r"лендінг", r"посадков\w* сторінк\w*",
    r"prototype", r"прототип",
    r"\bsurvey\b", r"опитуванн\w*", r"\bопитати\b",
    r"\bmvp\b",
    r"conversion rate", r"конверсі\w*",
    r"побудувати (сайт|застосунок|додаток|бота)",
    r"написати (код|скрипт|програм)",
]


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"candidates": {}}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    tmp.replace(STATE_FILE)


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:60] or "candidate"


def lint_forbidden(text):
    hits = []
    for pat in FORBIDDEN_TERM_PATTERNS:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            hits.append(m.group(0))
    return hits


def killtest_mechanically_valid(actions):
    if not actions or len(actions.strip()) < 20:
        return False, "kill-test action is empty or too short (<20 chars)"
    for pat in INVALID_KILLTEST_PATTERNS:
        m = re.search(pat, actions, re.IGNORECASE)
        if m:
            return False, f"kill-test matches a banned pattern ('{m.group(0)}') — landing pages, prototypes, surveys, and MVPs are not one-evening no-code checks"
    return True, None


def call_claude(prompt, allowed_tools, timeout, log_path, extra_disallowed=""):
    cmd = [
        "claude", "-p", prompt,
        "--model", MODEL,
        "--permission-mode", "acceptEdits",
        "--allowedTools", allowed_tools,
    ]
    if extra_disallowed:
        cmd += ["--disallowedTools", extra_disallowed]
    try:
        p = subprocess.run(cmd, cwd=ROOT, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out, code = p.stdout or "", p.returncode
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        out += f"\n[ailab] claude call TIMEOUT after {timeout}s"
        code = -1
    log_path.write_text(f"PROMPT:\n{prompt}\n\n--- OUTPUT (exit {code}) ---\n{out}")
    return code


# ---------- Researcher ----------

def researcher_prompt(known, angle_name, angle_desc, out_file):
    known_block = ""
    if known:
        lines = "\n".join(f"  - {t} ({u})" for t, u in known[:40])
        known_block = ("Problems already surfaced in earlier runs — do NOT resurface these, "
                       f"find different ones:\n{lines}\n\n")
    return f"""Today's date: {now_iso()[:10]}.

You are Scout "{angle_name}", one of {len(SCOUT_ANGLES)} scouts searching in
parallel tonight. Your ONLY job: find real, verifiable problems that could
become a small software product or tool, and write them to the file
{out_file} in the exact format below. You are not building anything, not
evaluating anything, not deciding anything — just finding and citing.

YOUR ASSIGNED SEARCH ANGLE — stay in this lane, other scouts cover the rest:
{angle_desc}

{known_block}Run MANY different searches within your angle (at least 8-10
distinct queries with different wording, different niches, different
industries). Do not stop at the first promising thing you find and do not let
one interesting lead swallow your whole search — breadth first, then depth on
what looks real.

Note: reddit.com and x.com cannot be fetched directly from this machine
(blocked). Search for them normally — you will get search-result snippets and
secondary articles quoting those threads, which is fine to cite.

Aim for about {TARGET_LEADS} raw leads. Fewer honest leads beat padding to hit
the number. Different problems, not 10 variations of one problem.

STRICT RULES — read twice:
- Every factual claim needs a URL, a date, and what exactly that source says.
  If you cannot find a URL for something, leave that field EMPTY. An empty
  field is correct and expected sometimes. A fabricated URL or number is a
  serious failure — never do this.
- NEVER write: willingness to pay, market size, "confidence", a numeric score,
  "great potential", TAM/SAM, or any other invented number or vibe judgment.
  You do not have this data. Just don't write it.
- For "existing solutions", list what you actually found, including if you
  found NONE (write "none found" rather than skip the field).
- For "why this niche might be empty on purpose" — this is a hypothesis, label
  it as one; it is not a fact needing a citation, but say clearly it's a guess.

Write EACH candidate as this exact block (repeat for each), then STOP —
nothing else, no summary, no recommendation:

### CANDIDATE: <short descriptive title>
PROBLEM: <one paragraph>
PROBLEM_SOURCE_URL: <url>
PROBLEM_SOURCE_DATE: <date the source was published, or "unknown">
PROBLEM_SOURCE_QUOTE: <short direct quote or close paraphrase>
INDEPENDENT_SOURCES:
- url: <url> | date: <date> | quote: <what it says>
- url: <url> | date: <date> | quote: <what it says>
EXISTING_SOLUTIONS:
- name: <name> | url: <url> | monetization: <how it makes money, or "unknown">
DEADLINE_EVENT: <yes/no>
DEADLINE_EVENT_DESCRIPTION: <text, empty if no>
DEADLINE_EVENT_DATE: <date, empty if no>
DEADLINE_EVENT_URL: <url, empty if no>
WHY_NICHE_MIGHT_BE_EMPTY: <your hypothesis, labeled as a guess>
### END CANDIDATE
"""


def run_one_scout(known, angle, timeout):
    name, desc = angle
    out_file = SCOUT_DIR / f"{name}.md"
    out_file.write_text("")
    code = call_claude(
        researcher_prompt(known, name, desc, out_file),
        allowed_tools="WebSearch WebFetch Write",
        timeout=timeout,
        log_path=SCOUT_DIR / f"{name}.log",
    )
    text = out_file.read_text() if out_file.exists() else ""
    n = text.count("### CANDIDATE:")
    log(f"scout {name}: exit={code}, {n} lead(s)")
    return name, text, n


def dedupe_candidates(text):
    """Drop candidate blocks whose primary source URL was already seen."""
    blocks = re.findall(r"###\s*CANDIDATE:.*?###\s*END CANDIDATE",
                        text, re.DOTALL)
    seen_urls, seen_titles, kept, dupes = set(), set(), [], 0
    for b in blocks:
        url_m = re.search(r"PROBLEM_SOURCE_URL:\s*(\S+)", b)
        title_m = re.search(r"###\s*CANDIDATE:\s*(.+)", b)
        url = (url_m.group(1).strip().rstrip("/").lower() if url_m else "")
        title = (title_m.group(1).strip().lower() if title_m else "")
        if (url and url in seen_urls) or (title and title in seen_titles):
            dupes += 1
            continue
        if url:
            seen_urls.add(url)
        if title:
            seen_titles.add(title)
        kept.append(b)
    return "\n\n".join(kept), len(kept), dupes


def run_scouts(known, deadline):
    """Fan out independent scouts, each on its own search angle."""
    remaining = deadline - time.monotonic()
    timeout = int(min(CALL_CAP, remaining - 120))
    if timeout < 120:
        return False, 0, 0
    SCOUT_DIR.mkdir(parents=True, exist_ok=True)
    log(f"scouts: launching {len(SCOUT_ANGLES)} in parallel "
        f"(max {MAX_PARALLEL} at a time, timeout {timeout}s each)")
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        futures = [pool.submit(run_one_scout, known, a, timeout) for a in SCOUT_ANGLES]
        for f in concurrent.futures.as_completed(futures):
            try:
                results.append(f.result())
            except Exception as e:
                log(f"scout failed: {e}")
    merged = "\n\n".join(t for _, t, n in results if n)
    deduped, kept, dupes = dedupe_candidates(merged)
    RAW_FILE.write_text(deduped)
    total = sum(n for _, _, n in results)
    live = sum(1 for _, _, n in results if n)
    log(f"scouts: {live}/{len(SCOUT_ANGLES)} produced leads, "
        f"{total} raw, {dupes} duplicates dropped, {kept} unique")
    return kept > 0, kept, dupes


# ---------- Filter ----------

def filter_prompt(raw_text):
    return f"""Today's date: {now_iso()[:10]}.

You are an adversarial Filter. A Researcher found the candidates below. You do
NOT get to add new problems or invent facts. Your job: independently check
each candidate against 3 binary questions, using WebSearch/WebFetch to verify
claims where useful (e.g. confirm claim 1 by actually searching for existing
products).

RAW CANDIDATES:
---
{raw_text}
---

For EACH candidate above, answer exactly these 3 binary questions:

1. Is there already a product/tool that does this? yes/no + url if yes.
2. Is there a real date by which the problem gets worse/more urgent? yes/no +
   which date, from the candidate's DEADLINE_EVENT fields (do not invent one).
3. KILL-TEST: can the user personally verify real demand for this in ONE
   evening, writing ZERO code? yes/no + EXACTLY which concrete actions.

A kill-test is valid ONLY if it is something like: "open N websites/profiles
and count how many lack X", "find a competitor's public pricing/reviews and
check if they have real customers", "read the last N issues/threads in a
repo/forum and count how many repeat this ask", "check a public directory/
marketplace for how many existing options there are and their review counts".

A kill-test is INVALID if it involves: building a landing page and measuring
conversion, running a user survey, building a prototype or MVP, writing any
code at all. If the only kill-test you can think of is one of these, answer
question 3 "no" — do not stretch a bad kill-test into a technically-yes answer.

VERDICT: a candidate PASSES only if answer 3 is yes AND the actions are
genuinely concrete (specific counts, specific places to look, specific numbers
to compare) — not vague ("look around", "research the market"). If in doubt,
REJECT — a vague kill-test is worse than an honest rejection.

Do not write willingness-to-pay, market-size, confidence, or score language —
same rule as the Researcher.

Write your verdict for EACH candidate to {FILTER_FILE} in exactly this format
(one block per candidate, same title as the raw candidate), then STOP:

### FILTER: <exact title from raw candidate>
Q1_EXISTING_PRODUCT: yes/no
Q1_URL:
Q2_DEADLINE: yes/no
Q2_WHICH:
Q3_KILLTEST_POSSIBLE: yes/no
KILLTEST_ACTIONS: <concrete steps if yes, empty if no>
VERDICT: PASS/REJECT
VERDICT_REASON: <one sentence>
### END FILTER
"""


def run_filter(raw_text, deadline):
    remaining = deadline - time.monotonic()
    timeout = int(min(CALL_CAP, remaining - 30))
    if timeout < 60:
        return False
    log(f"filter: applying binary gates (timeout {timeout}s)")
    FILTER_FILE.write_text("")
    code = call_claude(
        filter_prompt(raw_text),
        allowed_tools="WebSearch WebFetch Write Read",
        timeout=timeout,
        log_path=ROOT / "state" / "filter-call.log",
    )
    ok = FILTER_FILE.exists() and FILTER_FILE.read_text().strip()
    log(f"filter: claude exit={code}, verdict output {'present' if ok else 'EMPTY'}")
    return bool(ok)


# ---------- parsing ----------

def parse_blocks(text, start_marker, end_marker):
    """Split text into blocks delimited by '### <start_marker>: <title>' ...
    '### <end_marker>'. Return list of (title, {KEY: value_or_list}) tuples."""
    blocks = []
    pattern = re.compile(
        rf"###\s*{start_marker}:\s*(.+?)\n(.*?)###\s*{end_marker}\b",
        re.DOTALL,
    )
    for m in pattern.finditer(text):
        title = m.group(1).strip()
        body = m.group(2)
        fields = {}
        current_key = None
        for line in body.splitlines():
            kv = re.match(r"^([A-Z_][A-Z0-9_]*):\s?(.*)$", line)
            if kv:
                current_key = kv.group(1)
                fields[current_key] = kv.group(2).strip()
            elif line.strip().startswith("-") and current_key:
                fields.setdefault(current_key + "_LIST", []).append(line.strip(" -"))
        blocks.append((title, fields))
    return blocks


def render_candidate_md(title, raw_fields, filter_fields, warnings):
    lines = [f"## {title}"]
    if warnings:
        for w in warnings:
            lines.append(f"> ⚠️ {w}")
    lines.append(f"\n**Проблема:** {raw_fields.get('PROBLEM', '')}")
    lines.append(f"- Джерело: {raw_fields.get('PROBLEM_SOURCE_URL', '(немає)')} "
                 f"({raw_fields.get('PROBLEM_SOURCE_DATE', '?')}) — "
                 f"«{raw_fields.get('PROBLEM_SOURCE_QUOTE', '')}»")
    indep = raw_fields.get("INDEPENDENT_SOURCES_LIST", [])
    lines.append(f"- Незалежних джерел: {len(indep)}")
    for s in indep:
        lines.append(f"  - {s}")
    sol = raw_fields.get("EXISTING_SOLUTIONS_LIST", [])
    lines.append(f"- Існуючі рішення: {'; '.join(sol) if sol else 'не знайдено'}")
    if raw_fields.get("DEADLINE_EVENT", "").lower().startswith("y") or \
       raw_fields.get("DEADLINE_EVENT", "").lower().startswith("т"):
        lines.append(f"- Дедлайн-подія: {raw_fields.get('DEADLINE_EVENT_DESCRIPTION','')} "
                     f"({raw_fields.get('DEADLINE_EVENT_DATE','')}) "
                     f"{raw_fields.get('DEADLINE_EVENT_URL','')}")
    else:
        lines.append("- Дедлайн-подія: немає")
    lines.append(f"- Чому ніша може бути порожня (гіпотеза): "
                 f"{raw_fields.get('WHY_NICHE_MIGHT_BE_EMPTY', '')}")
    lines.append(f"\n**Filter:**")
    lines.append(f"1. Є вже продукт? {filter_fields.get('Q1_EXISTING_PRODUCT','?')} "
                 f"{filter_fields.get('Q1_URL','')}")
    lines.append(f"2. Є дедлайн? {filter_fields.get('Q2_DEADLINE','?')} "
                 f"{filter_fields.get('Q2_WHICH','')}")
    lines.append(f"3. Kill-test за вечір без коду? "
                 f"{filter_fields.get('Q3_KILLTEST_POSSIBLE','?')}")
    lines.append(f"\n**Kill-test (зроби це сьогодні ввечері):** "
                 f"{filter_fields.get('KILLTEST_ACTIONS', '')}")
    return "\n".join(lines)


def process(state, raw_text, filter_text):
    raw_blocks = dict(parse_blocks(raw_text, "CANDIDATE", "END CANDIDATE"))
    filter_blocks = dict(parse_blocks(filter_text, "FILTER", "END FILTER"))

    passed, rejected, dropped = [], [], []
    for title, raw_fields in raw_blocks.items():
        ffields = filter_blocks.get(title)
        if ffields is None:
            rejected.append((title, "filter produced no verdict for this candidate — "
                             "treated as rejected, not silently dropped"))
            continue

        warnings = []
        full_text = raw_text + "\n" + filter_text
        hits = lint_forbidden(full_text)
        if hits:
            warnings.append(f"містить заборонену лексику (скоринг/вигадані числа): {', '.join(set(hits))}")

        killtest_ok, reason = killtest_mechanically_valid(ffields.get("KILLTEST_ACTIONS", ""))
        model_verdict = ffields.get("VERDICT", "").upper().startswith("PASS")
        model_q3_yes = ffields.get("Q3_KILLTEST_POSSIBLE", "").lower().startswith(("y", "т"))

        if not (model_verdict and model_q3_yes and killtest_ok):
            why = reason or ffields.get("VERDICT_REASON", "filter rejected")
            rejected.append((title, why))
            continue

        slug = slugify(title)
        entry = state["candidates"].setdefault(slug, {"first_seen": now_iso()})
        entry.update(status="PASSED_FILTER", title=title, last_seen=now_iso(),
                     top_source_url=raw_fields.get("PROBLEM_SOURCE_URL", ""))
        passed.append((slug, title, raw_fields, ffields, warnings))

    if len(passed) > TARGET_PASSED:
        dropped = passed[TARGET_PASSED:]
        passed = passed[:TARGET_PASSED]
        for slug, title, *_ in dropped:
            state["candidates"][slug]["status"] = "DEFERRED"

    return passed, rejected, dropped


def write_report(passed, rejected, dropped, n_leads, n_dupes):
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = [f"# AI Lab Research {date}",
             f"{len(SCOUT_ANGLES)} скаутів у паралель. Унікальних лідів: "
             f"{n_leads} (дублікатів відкинуто: {n_dupes}). "
             f"Пройшли Filter: {len(passed)}. Відхилено: {len(rejected)}."]
    if dropped:
        lines.append(f"\n**{len(dropped)} кандидат(и) пройшли Filter, але відкладені** "
                     f"(ліміт {TARGET_PASSED}/ніч): "
                     + ", ".join(t for _, t, *_ in dropped) + ". Підуть наступного разу.")
    if passed:
        lines.append("\n# Кандидати — потребують твого kill-test сьогодні ввечері\n")
        for slug, title, raw_fields, ffields, warnings in passed:
            lines.append(render_candidate_md(title, raw_fields, ffields, warnings))
            lines.append("")
    else:
        lines.append("\nЖоден кандидат не пройшов Filter цієї ночі. Це нормальний результат.")
    if rejected:
        lines.append("\n## Розглянуто й відхилено")
        for title, why in rejected:
            lines.append(f"- **{title}** — {why}")
    path = REPORTS_DIR / f"research-{date}.md"
    path.write_text("\n".join(lines) + "\n")
    log(f"report: {path}")
    return path


def main():
    started_at = now_iso()
    deadline = time.monotonic() + RUN_WALL_SEC
    state = load_state()
    known = [(v.get("title", k), v.get("top_source_url", "")) for k, v in
             state["candidates"].items()]

    ok, n_leads, n_dupes = run_scouts(known, deadline)
    if not ok:
        log("research: no raw output produced by any scout, stopping")
        state["last_research_run"] = {"started_at": started_at, "finished_at": now_iso(),
                                      "result": "scouts produced nothing"}
        save_state(state)
        checkpoint(ORCH, ["ailab/state"], "research run: scouts produced nothing")
        return 1

    raw_text = RAW_FILE.read_text()
    if not run_filter(raw_text, deadline):
        log("research: filter produced no output, stopping — nothing surfaced unverified")
        state["last_research_run"] = {"started_at": started_at, "finished_at": now_iso(),
                                      "result": "filter produced nothing"}
        save_state(state)
        checkpoint(ORCH, ["ailab/state"], "research run: filter produced nothing")
        return 1

    filter_text = FILTER_FILE.read_text()
    passed, rejected, dropped = process(state, raw_text, filter_text)
    write_report(passed, rejected, dropped, n_leads, n_dupes)

    state["last_research_run"] = {"started_at": started_at, "finished_at": now_iso(),
                                  "passed": len(passed), "rejected": len(rejected)}
    save_state(state)
    checkpoint(ORCH, ["ailab/state", "ailab/reports"],
              f"research run: {len(passed)} passed, {len(rejected)} rejected")
    log(f"research run done: {len(passed)} passed filter, {len(rejected)} rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
