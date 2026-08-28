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

from common import now_iso, log, tail, checkpoint, current_branch, RunLock

ROOT = Path(__file__).resolve().parent
ORCH = ROOT.parent
STATE_FILE = ROOT / "state" / "candidates.json"
REPORTS_DIR = ROOT / "reports"
RAW_FILE = ROOT / "state" / "research-raw.md"
FILTER_FILE = ROOT / "state" / "research-filter.md"
SCOUT_DIR = ROOT / "state" / "scouts"
FILTER_DIR = ROOT / "state" / "filter-batches"

MODEL = os.environ.get("AILAB_MODEL", "claude-sonnet-5")
# Only 2 claude calls total (Researcher + Filter), so this is a hang backstop,
# not a budget lever — a $100/mo plan's 5h window easily covers this either way.
RUN_WALL_SEC = int(os.environ.get("AILAB_RESEARCH_WALL_SEC", 100 * 60))
CALL_CAP = int(os.environ.get("AILAB_RESEARCH_CALL_CAP", 40 * 60))
TARGET_LEADS = 10          # leads per scout
TARGET_PASSED = 3
MAX_PARALLEL = int(os.environ.get("AILAB_RESEARCH_PARALLEL", 5))
FILTER_BATCH = int(os.environ.get("AILAB_FILTER_BATCH", 20))
# Angles rotate: a wider list gives broader coverage over a week without
# paying for every angle every night. 0 = run them all.
SCOUTS_PER_RUN = int(os.environ.get("AILAB_SCOUTS_PER_RUN", 12))
# Rejected titles are remembered so scouts stop rediscovering ideas the
# filter already killed — that rediscovery was the main wasted spend.
MAX_REMEMBERED_REJECTS = int(os.environ.get("AILAB_MAX_REJECT_MEMORY", 500))

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
    ("marketplace-reviews", "1-3 star reviews and 'feature request' threads in "
     "app marketplaces: Chrome Web Store, Shopify App Store, WordPress plugin "
     "directory, Figma/Notion/Airtable/Zapier/Slack app directories. Look for "
     "'great but it can't do X' repeated across reviews of the same or "
     "competing apps."),
    ("freelance-briefs", "Freelance marketplaces and job posts (Upwork, Fiverr, "
     "Toptal, contract listings, 'looking for a developer to build' posts): the "
     "SAME custom tool being commissioned over and over by different clients "
     "means people are paying repeatedly for something that has no product."),
    ("non-english-eu", "Non-English European markets (German, Polish, French, "
     "Spanish, Italian, Dutch): local-language forums, business associations, "
     "and trade sites describing tools that only exist in English or only for "
     "the US market. Search in those languages."),
    ("ukraine-cee", "Ukrainian and Central/Eastern European market: local "
     "business communities, Diia/e-government changes, local accounting and "
     "reporting requirements, tools everyone hacks together in spreadsheets. "
     "Search in Ukrainian, Polish and Russian as well as English."),
    ("qa-sites", "Q&A sites beyond programming: Stack Exchange network (Law, "
     "Personal Finance, Academia, Project Management, Web Apps, Super User), "
     "Quora, specialist help forums — highly-viewed questions whose accepted "
     "answer is 'there is no tool for that, do it manually'."),
    ("local-business", "Physical and local businesses (restaurants, gyms, "
     "salons, dental clinics, trades, repair shops, driving schools): "
     "scheduling, invoicing, staff rota, supplier and compliance pain "
     "described in owner communities and trade forums."),
    ("trade-press", "Industry trade publications and sector newsletters "
     "(construction, freight, agriculture, manufacturing, hospitality, "
     "recruiting) reporting operational problems and process changes — "
     "sources that never appear on Hacker News."),
    ("procurement", "Public tenders, government procurement portals, and "
     "grant/RFP listings describing software or data needs — especially "
     "small repeated requirements that no vendor productised."),
    ("video-comments", "Comment sections under tutorial videos and 'how to' "
     "content (YouTube, course platforms): repeated 'how do I do this in "
     "bulk / automatically / for 500 of them' questions under manual-process "
     "tutorials indicate an unautomated workflow."),
    ("spreadsheet-land", "Popular shared spreadsheet and Notion/Airtable "
     "templates for business processes, and communities swapping them: a "
     "widely-copied template for a business process is an unserved software "
     "need with proven usage."),
    ("dead-products", "Shut-down, acquired, or abandoned SaaS products and "
     "browser extensions whose users publicly ask 'what do I use now?' — "
     "orphaned user bases with a known previous price point."),
    ("research-education", "Academic labs, research groups, teachers and "
     "nonprofits describing manual data handling, reporting or admin work in "
     "their own communities, mailing lists and papers."),
    ("data-gaps", "Public or semi-public datasets, registries and APIs that "
     "exist but that nobody has turned into a usable tool, where people "
     "publicly describe scraping or hand-processing them."),
    ("asia-latam-africa", "Markets outside Europe and North America: Brazil, "
     "Mexico, India, Indonesia, Nigeria, Kenya, the Gulf. Local business "
     "forums, local-language complaints, tools that exist only for US/EU "
     "customers. Search in Portuguese, Spanish, Hindi and Bahasa too."),
    ("healthcare-ops", "Back-office of clinics, dental and veterinary "
     "practices, labs, pharmacies and care homes: scheduling, billing, "
     "referrals, insurance paperwork, records requests — described by staff "
     "in their own professional communities."),
    ("logistics-freight", "Freight brokers, carriers, last-mile couriers, "
     "customs brokers and warehouses: dispatch, proof of delivery, "
     "detention and demurrage, customs paperwork, load boards."),
    ("insurance-ops", "Independent insurance agencies, brokers, adjusters "
     "and claims handlers: quoting across carriers, renewals, certificates "
     "of insurance, claims documentation."),
    ("property-management", "Landlords, small property managers, HOAs and "
     "letting agents: maintenance requests, inspections, deposits, rent "
     "reconciliation, tenant screening, statutory certificates."),
    ("field-service", "Trades dispatched to sites — HVAC, electrical, "
     "plumbing, pest control, equipment servicing: scheduling, van stock, "
     "job photos, quoting on site, compliance certificates."),
    ("franchise-multiunit", "Franchisees and multi-location operators: "
     "reporting up to franchisors, comparing performance across sites, "
     "enforcing standards, and the software franchisors mandate."),
    ("energy-utilities", "Small utilities, rural co-ops, solar installers "
     "and energy brokers: metering, billing, grid paperwork, subsidy and "
     "incentive claims, outage communication."),
    ("events-hospitality", "Venues, caterers, tour operators, small hotels "
     "and event planners: bookings, deposits, staffing rotas, supplier "
     "coordination, seasonal demand swings."),
    ("audit-compliance", "Teams preparing for SOC 2, ISO 27001, HIPAA, PCI "
     "and similar audits at small companies: evidence collection, policy "
     "upkeep, vendor questionnaires, and what auditors actually ask for."),
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


def yes_no(value):
    """True / False / None for a model's yes-no field (EN or UK wording)."""
    v = (value or "").strip().lower()
    if v.startswith(("yes", "так", "т")):
        return True
    if v.startswith(("no", "ні", "н")):
        return False
    return None


def killtest_mechanically_valid(actions, threshold=""):
    if not actions or len(actions.strip()) < 20:
        return False, "kill-test action is empty or too short (<20 chars)"
    for pat in INVALID_KILLTEST_PATTERNS:
        m = re.search(pat, actions, re.IGNORECASE)
        if m:
            return False, (f"kill-test matches a banned pattern ('{m.group(0)}') — "
                           "landing pages, prototypes, surveys, and MVPs are not "
                           "one-evening no-code checks")
    # Falsifiability: the kill-test must name a number that would KILL the idea.
    # Without it "go look around and see" passes as a kill-test, which is how a
    # filter degenerates into a rubber stamp.
    if not re.search(r"\d", actions):
        return False, ("kill-test names no concrete quantity — it must say how many "
                       "of what to count/check")
    if not threshold.strip():
        return False, "no kill threshold given (what result would prove the idea dead)"
    if not re.search(r"\d", threshold):
        return False, ("kill threshold is not falsifiable — it must name the number "
                       "below/above which the idea is dead")
    return True, None


def call_claude(prompt, allowed_tools, timeout, log_path, extra_disallowed=""):
    # Prompt goes on stdin, never argv: a batch of candidates blows past
    # ARG_MAX and execve fails with "Argument list too long".
    cmd = [
        "claude", "-p",
        "--model", MODEL,
        "--permission-mode", "acceptEdits",
        "--allowedTools", allowed_tools,
    ]
    if extra_disallowed:
        cmd += ["--disallowedTools", extra_disallowed]
    try:
        p = subprocess.run(cmd, cwd=ROOT, timeout=timeout, input=prompt,
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

YOUR STARTING POINT — this is your centre of gravity, not a cage:
{angle_desc}

Start there, but you have the WHOLE web. If a search leads you somewhere
better — a different industry, a different country, a different kind of
source — FOLLOW IT. Other scouts cover other starting points; overlap is
cheap, a missed opportunity is not. Do not artificially stay inside your
angle if the trail goes elsewhere.

{known_block}HOW TO SEARCH — this matters as much as where:
- Run MANY searches (at least 10-15 distinct queries), varying the wording,
  the industry, the country, and the vocabulary a non-technical person would
  actually use ("how do I", "is there an app that", "we still do this by
  hand", "spreadsheet nightmare", "wasting hours every week").
- Search in OTHER LANGUAGES too where it makes sense — Ukrainian, Polish,
  German, Spanish, French, Portuguese. Whole markets are invisible in
  English-only searches.
- Do NOT limit yourself to software developers or the tech industry. Most
  unsolved, paid-for problems live in trades, clinics, schools, logistics,
  agriculture, local government, small retail — people who never post on
  Hacker News.
- You have WebFetch: actually OPEN the promising pages and read them. A
  search-result snippet is a lead; the opened page is the evidence. Quote
  from what you actually read.
- Breadth first, then depth. Do not let one interesting lead swallow the
  whole search, and do not stop at the first promising thing.
- reddit.com and x.com cannot be fetched directly from this machine (network
  block). Search for them normally — snippets and secondary articles quoting
  those threads are fine to cite; just don't claim you read the thread itself.

Aim for about {TARGET_LEADS} raw leads. Fewer honest leads beat padding to hit
the number. Different problems, not {TARGET_LEADS} variations of one problem.

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


def pick_angles(state):
    """Rotate through the angle list so a wide list costs no more per night."""
    if SCOUTS_PER_RUN <= 0 or SCOUTS_PER_RUN >= len(SCOUT_ANGLES):
        return SCOUT_ANGLES, 0
    start = int(state.get("angle_cursor", 0)) % len(SCOUT_ANGLES)
    doubled = SCOUT_ANGLES + SCOUT_ANGLES
    chosen = doubled[start:start + SCOUTS_PER_RUN]
    state["angle_cursor"] = (start + SCOUTS_PER_RUN) % len(SCOUT_ANGLES)
    return chosen, start


def run_scouts(known, deadline, angles=None):
    """Fan out independent scouts, each on its own search angle."""
    angles = angles if angles is not None else SCOUT_ANGLES
    remaining = deadline - time.monotonic()
    timeout = int(min(CALL_CAP, remaining - 120))
    if timeout < 120:
        return False, 0, 0
    SCOUT_DIR.mkdir(parents=True, exist_ok=True)
    log(f"scouts: launching {len(angles)} of {len(SCOUT_ANGLES)} angles "
        f"(max {MAX_PARALLEL} at a time, timeout {timeout}s each): "
        + ", ".join(n for n, _ in angles))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        futures = [pool.submit(run_one_scout, known, a, timeout) for a in angles]
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

def filter_prompt(raw_text, out_file=None):
    out_file = out_file or FILTER_FILE
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

For EACH candidate above, answer exactly these 5 binary questions:

1. Is there already a product/tool that does this? yes/no + url if yes.
2. Is there a real date by which the problem gets worse/more urgent? yes/no +
   which date, from the candidate's DEADLINE_EVENT fields (do not invent one).
3. KILL-TEST: can the user personally verify real demand for this in ONE
   evening, writing ZERO code? yes/no + EXACTLY which concrete actions.
4. SPREADSHEET TEST: could the affected person solve this well enough with a
   spreadsheet they build in about an hour? yes/no + one sentence why. Answer
   YES whenever the core of the "product" is a list, a tracker, a checklist,
   a set of dates, or a status table — even if a real product would be nicer.
   People who already work in spreadsheets all day do not buy a spreadsheet.
5. SURVIVES THE DEADLINE: if the driver is a deadline, migration, sunset, or
   one-off rollout, will anyone still need this 12 months AFTER that date
   passes? yes/no + one sentence why. Answer NO for anything that is purely a
   migration helper, a "get ready for X" tracker, or a countdown: the need
   evaporates once everyone has migrated. Answer YES only if the work recurs
   (annual filings, ongoing reporting, continuous monitoring) or the deadline
   merely exposed a permanent problem. If there is no deadline at all,
   answer yes.

A kill-test is valid ONLY if it is something like: "open N websites/profiles
and count how many lack X", "find a competitor's public pricing/reviews and
check if they have real customers", "read the last N issues/threads in a
repo/forum and count how many repeat this ask", "check a public directory/
marketplace for how many existing options there are and their review counts".

A kill-test is INVALID if it involves: building a landing page and measuring
conversion, running a user survey, building a prototype or MVP, writing any
code at all. If the only kill-test you can think of is one of these, answer
question 3 "no" — do not stretch a bad kill-test into a technically-yes answer.

FALSIFIABILITY IS MANDATORY. A kill-test only counts if it can come back
NEGATIVE and kill the idea. You must state KILLTEST_THRESHOLD: the specific
number that, if not met, means the user drops this idea tonight. For example:
"dead if fewer than 8 of the last 30 issues repeat this ask", "dead if fewer
than 5 of the 20 firms lack the feature", "dead if the competitor has under
50 reviews". If you cannot state a number that would kill it, the kill-test
is invalid — answer question 3 "no".

CALIBRATION — read this carefully. In a typical batch MOST candidates do NOT
survive. A previous run of this filter passed 92 of 96 candidates, which made
it worthless: a filter that approves everything is not a filter. Expect to
REJECT the clear majority. Common honest reasons to reject: the problem is
real but already well served (Q1 yes with a mature product), the only
verification anyone could do requires talking to people or building
something, the "problem" is a feature request inside someone else's free
product rather than something anyone would buy, or the evidence is a single
source. When you catch yourself writing a kill-test that is really just
"go read some threads and see if it feels common", that is a REJECT.

VERDICT: a candidate PASSES only if ALL of these hold — answer 3 is yes AND
the actions are genuinely concrete (specific counts, specific places to look,
specific numbers to compare) AND KILLTEST_THRESHOLD names a real number AND
answer 4 is no (a spreadsheet does not already solve it) AND answer 5 is yes
(the need outlives the deadline). If in doubt, REJECT — a vague kill-test is
worse than an honest rejection.

Questions 4 and 5 exist because a real candidate died on them. It looked
perfect: a genuine gap, no vendor had built it, a hard legal deadline, and
buyers with budget. But what was missing was a table of clients and their
migration status — an hour of spreadsheet work for people who live in
spreadsheets — and the need would have vanished once the migration wave
finished. Both answers must clear before anything else matters.

Do not write willingness-to-pay, market-size, confidence, or score language —
same rule as the Researcher.

Write your verdict for EACH candidate to {out_file} in exactly this format
(one block per candidate, same title as the raw candidate), then STOP:

### FILTER: <exact title from raw candidate>
Q1_EXISTING_PRODUCT: yes/no
Q1_URL:
Q2_DEADLINE: yes/no
Q2_WHICH:
Q3_KILLTEST_POSSIBLE: yes/no
KILLTEST_ACTIONS: <concrete steps with specific numbers if yes, empty if no>
KILLTEST_THRESHOLD: <the number that kills the idea, e.g. "dead if fewer than 8 of 30", empty if no>
Q4_SPREADSHEET_SOLVES_IT: yes/no
Q4_WHY: <one sentence>
Q5_SURVIVES_DEADLINE: yes/no
Q5_WHY: <one sentence>
VERDICT: PASS/REJECT
VERDICT_REASON: <one sentence>
### END FILTER
"""


def chunk_candidates(text, per_chunk=FILTER_BATCH):
    blocks = re.findall(r"###\s*CANDIDATE:.*?###\s*END CANDIDATE", text, re.DOTALL)
    return ["\n\n".join(blocks[i:i + per_chunk])
            for i in range(0, len(blocks), per_chunk)]


def run_one_filter(idx, chunk, timeout):
    out_file = FILTER_DIR / f"batch{idx}.md"
    out_file.write_text("")
    code = call_claude(
        filter_prompt(chunk, out_file),
        allowed_tools="WebSearch WebFetch Write Read",
        timeout=timeout,
        log_path=FILTER_DIR / f"batch{idx}.log",
    )
    text = out_file.read_text() if out_file.exists() else ""
    n = text.count("### FILTER:")
    log(f"filter batch {idx}: exit={code}, {n} verdict(s)")
    return text


def run_filter(raw_text, deadline):
    """Filter in parallel batches — one prompt can't hold 200+ candidates."""
    remaining = deadline - time.monotonic()
    timeout = int(min(CALL_CAP, remaining - 60))
    if timeout < 60:
        return False
    chunks = chunk_candidates(raw_text)
    if not chunks:
        return False
    FILTER_DIR.mkdir(parents=True, exist_ok=True)
    log(f"filter: {len(chunks)} batch(es) of up to {FILTER_BATCH} candidates "
        f"(max {MAX_PARALLEL} at a time, timeout {timeout}s each)")
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        futures = [pool.submit(run_one_filter, i, c, timeout)
                   for i, c in enumerate(chunks)]
        for f in concurrent.futures.as_completed(futures):
            try:
                results.append(f.result())
            except Exception as e:
                log(f"filter batch failed: {e}")
    merged = "\n\n".join(t for t in results if t.strip())
    FILTER_FILE.write_text(merged)
    n = merged.count("### FILTER:")
    log(f"filter: {n} verdict(s) total")
    return n > 0


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
    lines.append(f"4. Вирішується таблицею за годину? "
                 f"{filter_fields.get('Q4_SPREADSHEET_SOLVES_IT','?')} "
                 f"— {filter_fields.get('Q4_WHY','')}")
    lines.append(f"5. Потреба переживе дедлайн? "
                 f"{filter_fields.get('Q5_SURVIVES_DEADLINE','?')} "
                 f"— {filter_fields.get('Q5_WHY','')}")
    lines.append(f"\n**Kill-test (зроби це сьогодні ввечері):** "
                 f"{filter_fields.get('KILLTEST_ACTIONS', '')}")
    lines.append(f"**Ідея мертва, якщо:** {filter_fields.get('KILLTEST_THRESHOLD', '')}")
    return "\n".join(lines)


def process(state, raw_text, filter_text):
    raw_blocks = dict(parse_blocks(raw_text, "CANDIDATE", "END CANDIDATE"))
    filter_blocks = dict(parse_blocks(filter_text, "FILTER", "END FILTER"))

    passed, rejected, dropped, carry_over = [], [], [], []
    for title, raw_fields in raw_blocks.items():
        ffields = filter_blocks.get(title)
        if ffields is None:
            rejected.append((title, "filter produced no verdict for this candidate — "
                             "treated as rejected, not silently dropped"))
            continue

        # Lint THIS candidate's own text only — linting the merged document
        # tagged every candidate with every other candidate's vocabulary.
        own_text = "\n".join(str(v) for v in raw_fields.values()) + "\n" + \
                   "\n".join(str(v) for v in ffields.values())
        warnings = []
        hits = lint_forbidden(own_text)
        if hits:
            warnings.append("містить заборонену лексику (скоринг/вигадані числа): "
                            + ", ".join(sorted(set(hits))))

        killtest_ok, reason = killtest_mechanically_valid(
            ffields.get("KILLTEST_ACTIONS", ""), ffields.get("KILLTEST_THRESHOLD", ""))
        model_verdict = ffields.get("VERDICT", "").upper().startswith("PASS")
        model_q3_yes = yes_no(ffields.get("Q3_KILLTEST_POSSIBLE", "")) is True

        # Q4/Q5 gate mechanically too: the filter has already been caught
        # rubber-stamping, so a stated "spreadsheet solves it" or "need dies
        # with the deadline" kills the candidate regardless of its VERDICT.
        if reason is None:
            if yes_no(ffields.get("Q4_SPREADSHEET_SOLVES_IT", "")) is True:
                reason = ("a spreadsheet built in an hour already solves this"
                          + (f" — {ffields['Q4_WHY']}" if ffields.get("Q4_WHY") else ""))
            elif yes_no(ffields.get("Q5_SURVIVES_DEADLINE", "")) is False:
                reason = ("the need does not outlive its deadline"
                          + (f" — {ffields['Q5_WHY']}" if ffields.get("Q5_WHY") else ""))
            killtest_ok = killtest_ok and reason is None

        if not (model_verdict and model_q3_yes and killtest_ok):
            # The filter's own reason is the useful one (it names competitors it
            # actually found). The mechanical message only matters when Python
            # overrode a model PASS — otherwise it just hides the real finding.
            model_reason = ffields.get("VERDICT_REASON", "").strip()
            if model_verdict and reason:
                why = f"{reason} [gate overrode filter PASS]"
            else:
                why = model_reason or reason or "filter rejected"
            rejected.append((title, why))
            continue

        slug = slugify(title)
        entry = state["candidates"].setdefault(slug, {"first_seen": now_iso()})
        entry.update(status="PASSED_FILTER", title=title, last_seen=now_iso(),
                     top_source_url=raw_fields.get("PROBLEM_SOURCE_URL", ""))
        passed.append((slug, title, raw_fields, ffields, warnings))

    # Candidates deferred on an earlier night go first: they already cleared
    # the filter and have waited. Without this they were never surfaced again
    # — "deferred" silently meant "buried", while still suppressing scouts
    # from rediscovering the topic.
    carried = []
    for slug, entry in state["candidates"].items():
        if entry.get("status") == "DEFERRED" and entry.get("rendered"):
            carried.append((entry.get("deferred_at", ""), slug, entry))
    for _, slug, entry in sorted(carried, key=lambda c: (c[0], c[1])):
        if len(carry_over) >= TARGET_PASSED:
            break
        carry_over.append((slug, entry))
        entry["status"] = "PASSED_FILTER"
        entry["last_seen"] = now_iso()

    room = max(0, TARGET_PASSED - len(carry_over))
    if len(passed) > room:
        dropped = passed[room:]
        passed = passed[:room]
        for slug, title, raw_fields, ffields, warnings in dropped:
            e = state["candidates"][slug]
            e["status"] = "DEFERRED"
            e["deferred_at"] = now_iso()
            # Store the rendered block so a later night can surface it without
            # re-running scouts or the filter for it.
            e["rendered"] = render_candidate_md(title, raw_fields, ffields, warnings)

    return passed, rejected, dropped, carry_over


def write_report(passed, rejected, dropped, n_leads, n_dupes, carry_over=()):
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total = len(passed) + len(carry_over)
    lines = [f"# AI Lab Research {date}",
             f"{len(SCOUT_ANGLES)} скаутів у паралель. Унікальних лідів: "
             f"{n_leads} (дублікатів відкинуто: {n_dupes}). "
             f"Кандидатів: {total} (нових {len(passed)}"
             + (f", перенесених {len(carry_over)}" if carry_over else "")
             + f"). Відхилено: {len(rejected)}."]
    if dropped:
        lines.append(f"\n<details><summary>Ще {len(dropped)} пройшли Filter, "
                     f"відкладені на наступні ночі (ліміт {TARGET_PASSED}/ніч)"
                     "</summary>\n")
        for _, t, *_ in dropped:
            lines.append(f"- {t}")
        lines.append("\n</details>")
    if passed or carry_over:
        lines.append("\n# Кандидати — потребують твого kill-test сьогодні ввечері\n")
        for slug, entry in carry_over:
            lines.append(entry["rendered"])
            lines.append(f"\n> ↩︎ перенесено з рану {entry.get('deferred_at','')[:10]} "
                         "(тієї ночі не влізло в ліміт)\n")
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
    try:
        lock = RunLock(ROOT / "state" / "research.lock").__enter__()
    except RuntimeError as e:
        log(str(e))
        return 1
    try:
        return _run()
    finally:
        lock.__exit__()


def _run():
    started_at = now_iso()
    deadline = time.monotonic() + RUN_WALL_SEC
    state = load_state()
    known = [(v.get("title", k), v.get("top_source_url", "")) for k, v in
             state["candidates"].items()]
    known += [(t, "rejected earlier") for t in state.get("rejected_titles", [])]

    # Resume: reuse an existing raw lead file instead of re-running scouts.
    # Scouts are the expensive half; a filter-stage crash shouldn't burn them.
    if os.environ.get("AILAB_SKIP_SCOUTS") and RAW_FILE.exists() and RAW_FILE.read_text().strip():
        n_leads = RAW_FILE.read_text().count("### CANDIDATE:")
        n_dupes, ok = 0, True
        log(f"scouts: SKIPPED (AILAB_SKIP_SCOUTS), reusing {n_leads} lead(s) from {RAW_FILE}")
    else:
        angles, start = pick_angles(state)
        ok, n_leads, n_dupes = run_scouts(known, deadline, angles)
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
    passed, rejected, dropped, carry_over = process(state, raw_text, filter_text)
    write_report(passed, rejected, dropped, n_leads, n_dupes, carry_over)

    # Remember what was rejected so scouts stop rediscovering it. Titles only
    # — the evidence is in the report; this list exists to steer searching.
    seen = state.get("rejected_titles", [])
    seen += [t for t, _ in rejected if t not in seen]
    state["rejected_titles"] = seen[-MAX_REMEMBERED_REJECTS:]

    state["last_research_run"] = {"started_at": started_at, "finished_at": now_iso(),
                                  "passed": len(passed), "rejected": len(rejected)}
    save_state(state)
    checkpoint(ORCH, ["ailab/state", "ailab/reports"],
              f"research run: {len(passed)} passed, {len(rejected)} rejected")
    log(f"research run done: {len(passed)} passed filter, {len(rejected)} rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
