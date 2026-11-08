#!/usr/bin/env python3
"""
AI PR Reviewer — eine Engine, drei Modi.

Reviewt Pull Requests über ein OpenAI-kompatibles Endpoint
(CheapestInference, deepseek-v4.1-flash) und postet das Ergebnis
als GitHub-PR-Review. Nur Python-Stdlib (urllib), kein pip.

Modi (per Env):
  Einzelfahr (Stub/per-repo):  REPO=<owner/name> PR_NUMBER=<n> python3 ai_review.py
  Sweep (ein Repo):            REPO=<owner/name> SWEEP=1 python3 ai_review.py
  Sweep-ALL (alle Repos):      SWEEP_ALL=1 python3 ai_review.py
      — braucht einen Token mit Zugriff auf alle Repos (Secret AI_REVIEW_TOKEN).

Exit-Codes: 0 = ok oder bewusst übersprungen, 2 = Fehlkonfiguration,
            1 = unerwarteter Fehler (Sweeps fangen Fehler pro PR ab).
"""

import base64
import fnmatch
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

# ---------- Konfiguration ----------

def env_or(name: str, default: str) -> str:
    """Env-Lesung, die leere Strings wie 'nicht gesetzt' behandelt
    (Workflows reichen leere vars.X als '' durch)."""
    v = os.environ.get(name)
    return v.strip() if v and v.strip() else default

API_BASE = env_or("AI_API_BASE", "https://api.cheapestinference.com/v1").rstrip("/")
MODEL = env_or("AI_MODEL", "deepseek-v4.1-flash")
LANG = env_or("AI_LANGUAGE", "de")


def env_int(name: str, default: int) -> int:
    """Ganzzahl-Env: leer → Default; ungültig → Fehlkonfiguration (Exit 1)
    statt rohem ValueError-Traceback."""
    v = env_or(name, str(default))
    try:
        return int(v)
    except ValueError:
        raise SystemExit(f"Fehlkonfiguration: {name}={v!r} ist keine Ganzzahl.")


MAX_DIFF = env_int("AI_MAX_DIFF_CHARS", 300000)
MAX_FILES = env_int("AI_MAX_FILES", 40)
PER_FILE_CAP = 20000
INSTRUCTIONS_CAP = 16000
TIMEOUT = env_int("AI_TIMEOUT", 240)
INCLUDE_DRAFTS = env_or("AI_REVIEW_INCLUDE_DRAFTS", "false").lower() == "true"
INSTRUCTIONS_PATH = env_or("AI_INSTRUCTIONS", ".github/ai-review-instructions.md")
SWEEP_MAX_REVIEWS = env_int("AI_SWEEP_MAX_REVIEWS", 8)
SWEEP_MAX_PER_REPO = env_int("AI_SWEEP_MAX_PER_REPO", 3)
REPOS_FILTER = [p.strip() for p in env_or("AI_REPOS_FILTER", "").split(",") if p.strip()]
REPOS_EXCLUDE = [p.strip() for p in env_or("AI_REPOS_EXCLUDE", "ai-review").split(",") if p.strip()]
# Forks sind per Default ausgeschlossen (Fork-Netzwerke produzieren PR-Noise).
# Explizit gelistete Forks werden trotzdem gesweept — z.B. remote_pi, das als
# Fork lebt, aber eigene PRs und eigene CI-Pipelines hat.
REPOS_INCLUDE_FORKS = [p.strip() for p in env_or("AI_REPOS_INCLUDE_FORKS", "").split(",") if p.strip()]
EXCLUDE = [
    p.strip().replace("**", "*")
    for p in env_or(
        "AI_EXCLUDE",
        "pnpm-lock.yaml,package-lock.json,yarn.lock,*.lock,"
        "dist/*,build/*,node_modules/*,*.min.js,*.snap,*.svg,*.png,*.jpg",
    ).split(",")
    if p.strip()
]

GH = "https://api.github.com"
# AI_REVIEW_TOKEN (PAT, Zugriff auf alle Repos) gewinnt — wichtig für Sweep-ALL.
# Im Einzelfahr-Modus reicht der Repo-eigene GITHUB_TOKEN.
TOKEN = os.environ.get("AI_REVIEW_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
API_KEY = os.environ.get("CHEAPESTINFERENCE_API_KEY", "").strip()
LAST_HTTP_ERR = ""  # letzter HTTPError-Body (Diagnose, z. B. 422 beim Review-POST)

SEV_ICON = {"high": "🔴", "medium": "🟠", "low": "🟡"}


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------- GitHub REST ----------

def gh_request(path: str, method: str = "GET", body: dict | None = None) -> tuple[int, object | None]:
    req = urllib.request.Request(
        GH + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "ai-review-bot",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        global LAST_HTTP_ERR
        try:
            LAST_HTTP_ERR = e.read().decode(errors="replace")[:500]
        except Exception:
            LAST_HTTP_ERR = f"(Body nicht lesbar, HTTP {e.code})"
        return e.code, None
    except urllib.error.URLError as e:
        # Netzwerkfehler (DNS, Connection Reset, Timeout): wie HTTP-Fehler
        # behandeln — (0, None) statt Crash, damit ein PR den Sweep nicht reißt.
        LAST_HTTP_ERR = f"URLError: {e.reason}"
        log(f"⚠️ gh_request {method} {path}: Netzwerkfehler — {e.reason}")
        return 0, None


def gh_paginate(path: str, max_pages: int = 5) -> list:
    out: list = []
    for page in range(1, max_pages + 1):
        sep = "&" if "?" in path else "?"
        status, data = gh_request(f"{path}{sep}per_page=100&page={page}")
        if status != 200 or not isinstance(data, list):
            break
        out.extend(data)
        if len(data) < 100:
            break
    return out


_ME: str | None = None


def me_login() -> str:
    """Login des Tokens — dient zur Erkennung eigener Reviews (Bot- UND PAT-Fall)."""
    global _ME
    if _ME is None:
        status, data = gh_request("/user")
        if status != 200 or not isinstance(data, dict):
            raise RuntimeError("Token-Login nicht ermittelbar (GET /user fehlgeschlagen).")
        _ME = data.get("login", "")
    return _ME


def parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def get_pr(repo: str, n: int) -> dict | None:
    status, data = gh_request(f"/repos/{repo}/pulls/{n}")
    return data if status == 200 else None


def get_commit(repo: str, sha: str) -> dict | None:
    status, data = gh_request(f"/repos/{repo}/commits/{sha}")
    return data if status == 200 else None


def get_instructions(repo: str, ref: str) -> str:
    """Review-Regeln aus dem ZIEL-Repo (vom PR-Head) — überschreibt die Defaults."""
    import urllib.parse
    p = urllib.parse.quote(INSTRUCTIONS_PATH)
    status, data = gh_request(f"/repos/{repo}/contents/{p}?ref={ref}")
    if status != 200 or not isinstance(data, dict) or "content" not in data:
        return ""
    return base64.b64decode(data["content"]).decode("utf-8", errors="replace")[:INSTRUCTIONS_CAP]


def last_own_review_dt(repo: str, n: int) -> datetime | None:
    status, reviews = gh_request(f"/repos/{repo}/pulls/{n}/reviews?per_page=100")
    if status != 200 or not isinstance(reviews, list):
        return None
    latest = None
    me = me_login()
    for r in reviews:
        if (r.get("user") or {}).get("login", "") != me:
            continue
        dt = parse_dt(r["submitted_at"])
        if latest is None or dt > latest:
            latest = dt
    return latest


# ---------- Diff ----------

def parse_new_lines(patch: str) -> set[int]:
    """Neu-seitige Zeilennummern aus einem Patch (für Inline-Comment-Platzierung)."""
    lines: set[int] = set()
    new = None
    for ln in patch.splitlines():
        m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", ln)
        if m:
            new = int(m.group(1))
            continue
        if new is None:
            continue
        if ln.startswith("+"):
            lines.add(new)
            new += 1
        elif ln.startswith("-") or ln.startswith("\\"):
            pass
        else:
            new += 1
    return lines


def build_diff(files: list) -> tuple[str, dict, bool]:
    """Diff-Text aus PR-Files. Returns: (diff, {pfad: gültige neue Zeilen}, war_gekürzt)."""
    parts: list[str] = []
    valid: dict = {}
    used = 0
    shown = 0
    truncated = False
    for f in files:
        path = f.get("filename", "")
        if any(fnmatch.fnmatch(path, p) for p in EXCLUDE):
            continue
        patch = f.get("patch")
        if not patch:
            continue  # binär oder zu groß (GitHub liefert dann keinen Patch)
        if shown >= MAX_FILES or used >= MAX_DIFF:
            truncated = True
            break
        p = patch
        if len(p) > PER_FILE_CAP:
            p = p[:PER_FILE_CAP]
            cut = p.rfind("\n")
            if cut > 0:
                p = p[:cut + 1]  # nie mitten in einer Zeile abschneiden
            truncated = True
        chunk = f"--- a/{path}\n+++ b/{path}\n{p}\n"
        parts.append(chunk)
        used += len(chunk)
        shown += 1
        valid[path] = parse_new_lines(p)
    return "\n".join(parts), valid, truncated


# ---------- LLM ----------

SYSTEM_PROMPT = f"""Du bist ein präziser, pragmatischer Senior-Code-Reviewer und reviewest den Diff eines Pull Requests.

Fokus: echte Probleme — Bugs, Sicherheitslücken, fehlende/rissige Fehlerbehandlung, Race Conditions, Logikfehler, verletzte API-Verträge, offensichtliche Performance-Probleme, vergessene Migrationen.
Kein Fokus: Stil/Formatting, Geschmacksfragen, Umbenennungs-Vorschläge, Lob.

Antworte AUSSCHLIESSLICH mit gültigem JSON, ohne Text davor oder danach:
{{"summary": "<2-4 Sätze Gesamtbeurteilung auf {LANG}>", "findings": [{{"file": "<pfad wie im diff>", "line": <zeile in der NEUEN dateiversion oder null>, "severity": "high"|"medium"|"low", "comment": "<problem, warum es ein problem ist, konkreter fix — auf {LANG}>", "suggestion": "<optional: exakter ersatzcode für die zeile/den block, ohne ```-marker>"}}]}}

Regeln:
- "line" nur angeben, wenn die Zeile eindeutig aus dem Diff hervorgeht; sonst null.
- "suggestion" nur, wenn der Fix exakt als Codeblock ausdrückbar ist (wird als GitHub-Suggestion gerendert).
- Nichts erfinden: wenn der Kontext fehlt, das Finding weglassen.
- Der gelieferte Diff IST vollständig: die autoritative Dateiliste des PRs aus der GitHub-Files-API. Behaupte NIEMALS, im Diff fehlten Dateien oder Code — eine Datei, die nicht im Diff steht, wurde im PR schlicht nicht geändert; schließe nicht aus dem Commit-Verlauf (Merges!) auf einen „unvollständigen" Diff. Nur wenn der Diff explizit als „gekürzt" markiert ist, darf auf fehlenden Kontext hingewiesen werden. (Eingeführt nach remote_pi#96, Runde 1: Modell behauptete trotz vollständigen 26k-Zeichen-Diffs, Produktionscode fehle.)
- Wenn es nichts Nennenswertes gibt: findings = [] und summary hält sich kurz."""


def call_llm(user_prompt: str) -> str:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 2500,
    }
    data = json.dumps(payload).encode()
    last_err = ""
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                f"{API_BASE}/chat/completions",
                data=data,
                method="POST",
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                    "User-Agent": "ai-review-bot",
                },
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                out = json.loads(r.read())
            choice = out["choices"][0]
            content = choice["message"]["content"]
            if choice.get("finish_reason") == "length":
                # Output-Cap erreicht → JSON wird mid-Stream abgeschnitten → Parse-Fallback
                # liefert Roh-JSON als Body (beobachtet in Runde 3 von ztilt#24).
                log(f"⚠️ LLM-Antwort bei max_tokens={payload['max_tokens']} abgeschnitten (finish_reason=length) — Retry mit 6000.")
                try:
                    payload["max_tokens"] = 6000
                    req = urllib.request.Request(
                        f"{API_BASE}/chat/completions",
                        data=json.dumps(payload).encode(),
                        method="POST",
                        headers={
                            "Authorization": f"Bearer {API_KEY}",
                            "Content-Type": "application/json",
                            "User-Agent": "ai-review-bot",
                        },
                    )
                    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                        out = json.loads(r.read())
                    choice2 = out["choices"][0]
                    if choice2.get("finish_reason") == "length":
                        log("⚠️ Auch der 6000er-Request ist abgeschnitten — arbeite mit der gekürzten Antwort weiter (Parse-Fallback).")
                    content = choice2["message"]["content"]
                    log(f"Retry finish_reason={choice2.get('finish_reason')}")
                except (urllib.error.HTTPError, urllib.error.URLError) as e:
                    # Der 6000er-Retry scheitert → die erste (gekürzte, aber
                    # brauchbare) Antwort nicht wegwerfen, sondern verwenden.
                    log(f"⚠️ 6000er-Retry fehlgeschlagen ({e}) — verwende die erste Antwort (Parse-Fallback).")
            return content
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode(errors="replace")[:300]
            except Exception:
                pass
            last_err = f"HTTP {e.code}: {body}"
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(20 * (attempt + 1))
                continue
            raise RuntimeError(f"Inference-API: {last_err}")
        except Exception as e:
            last_err = str(e)
            if attempt < 2:
                time.sleep(20 * (attempt + 1))
                continue
            raise RuntimeError(f"Inference-API: {last_err}")
    raise RuntimeError(f"Inference-API: {last_err}")


def parse_review(text: str) -> tuple[str, list]:
    t = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    js = None
    m = re.search(r"\{.*\}", t, flags=re.S)
    for cand in (t, m.group(0) if m else None):
        if not cand:
            continue
        try:
            js = json.loads(cand)
            break
        except json.JSONDecodeError:
            continue
    # Doppelte Kodierung (2026-11-03, ztilt#24 R17): Das Modell kann die
    # eigentliche Review als JSON-STRING liefern — ganz außen oder in
    # `summary` verpackt. Symptom damals: findings=[], Rohtext-JSON im
    # Body, der leere Review wirkte "clean" und befeuerte den Loop. Bis zu
    # drei Ebenen entpacken: str → json.loads; dict ohne findings mit
    # JSON-verdächtiger summary → summary parsen.
    for _ in range(3):
        if isinstance(js, str):
            try:
                js = json.loads(js)
                continue
            except json.JSONDecodeError:
                break
        if isinstance(js, dict) and not js.get("findings"):
            s = str(js.get("summary") or "")
            if s.lstrip().startswith("{"):
                try:
                    inner = json.loads(s)
                except json.JSONDecodeError:
                    break
                if isinstance(inner, dict):
                    js = inner
                    continue
        break
    if not isinstance(js, dict):
        unbalanced = t.count("{") != t.count("}")
        log(f"⚠️ Review-Output nicht als JSON parsebar ({'vermutlich trunciert — unbalancierte Klammern' if unbalanced else 'kein JSON gefunden'}) — poste Rohtext als Summary.")
        return t[:4000], []
    summary = str(js.get("summary") or "").strip() or "Review abgeschlossen."
    findings = []
    for f in js.get("findings") or []:
        if not isinstance(f, dict):
            continue
        line = f.get("line")
        findings.append({
            "file": str(f.get("file") or "").strip(),
            "line": line if isinstance(line, int) else None,
            "severity": str(f.get("severity") or "medium").lower(),
            "comment": str(f.get("comment") or "").strip(),
            "suggestion": str(f.get("suggestion") or "").strip(),
        })
    return summary, findings


# ---------- Review posten ----------

def render_finding(f: dict) -> str:
    line = f":{f['line']}" if f.get("line") else ""
    s = f"{SEV_ICON.get(f['severity'], '🟠')} **{f['severity'].upper()}** `{f['file']}`{line}\n\n{f['comment']}"
    if f.get("suggestion"):
        s += f"\n\n```suggestion\n{f['suggestion']}\n```"
    return s


def build_review_body(summary: str, findings: list, truncated: bool, head_sha: str, inline_count: int) -> str:
    parts = ["## 🤖 AI Review", "", summary, ""]
    if truncated:
        parts.append("> ⚠️ Der Diff war zu groß — Teile wurden gekürzt oder ausgelassen.")
    if inline_count:
        parts.append(f"_{inline_count} Finding(s) sind als Inline-Kommentar an der jeweiligen Zeile gepostet._")
    if findings:
        parts += ["### Weitere Hinweise", ""]
        parts += [render_finding(f) for f in findings]
    parts += [
        "",
        f"<sub> Modell `{MODEL}` via CheapestInference · head `{head_sha[:8]}` · Re-Review: Actions → „AI PR Review“ → Run workflow </sub>",
    ]
    return "\n".join(parts)


def post_review(repo: str, n: int, summary: str, findings: list, valid: dict, truncated: bool, head_sha: str) -> None:
    """Postet Review-Body (ohne comments[]) + JEDE Inline-Anmerkung einzeln.

    GitHub-Schema-Drift (2026-11-02, ztilt#24 Debug): Der Batch-Endpoint
    (POST /reviews mit comments[]) verwirft Kommentare mit line+side SEIT
    NEUSTEM STILL (201, comments_server=0) — commit_id pro Kommentar ist
    dort GraphQL-seitig nicht definiert (422 „Field is not defined on
    DraftPullRequestReviewThread"). Die Einzel-Route (POST /pulls/comments)
    VERLANGT dagegen commit_id+line+side (422-Schema-listet genau diesen
    Zweig). Also: Body via /reviews, Inline via /pulls/comments einzeln.
    """
    inline, rest = [], []
    for f in findings:
        ok = (
            f.get("file") in valid
            and f.get("line") is not None
            and f["line"] in valid[f["file"]]
            and f["comment"]
        )
        (inline if ok else rest).append(f)

    body = build_review_body(summary, rest, truncated, head_sha, len(inline))

    global LAST_HTTP_ERR
    status, data = gh_request(
        f"/repos/{repo}/pulls/{n}/reviews",
        "POST",
        {"body": body, "event": "COMMENT", "commit_id": head_sha, "comments": []},
    )
    if status not in (200, 201):
        raise RuntimeError(f"Review-Post fehlgeschlagen (HTTP {status}): {LAST_HTTP_ERR}")
    review_id = data.get("id") if isinstance(data, dict) else None

    posted, failed = 0, 0
    for f in inline:
        s2, _d2 = gh_request(
            f"/repos/{repo}/pulls/{n}/comments",
            "POST",
            {
                "path": f["file"],
                "line": f["line"],
                "side": "RIGHT",
                "commit_id": head_sha,
                "body": render_finding(f),
            },
        )
        if s2 in (200, 201):
            posted += 1
        else:
            failed += 1
            log(f"Inline-Einzelpost fehlgeschlagen ({f['file']}:{f['line']}, HTTP {s2}): {LAST_HTTP_ERR}")
            LAST_HTTP_ERR = ""
    log(f"Review-POST ok: id={review_id} inline_einzeln={posted}/{len(inline)} (Body-only-Reviews, keine Batch-Comments)")
    if failed:
        log(f"⚠️ {failed} Inline-Finding(s) nicht platzierbar — Details stehen oben im Log, Zusammenfassung im Review-Body.")
    log(f"{repo}#{n}: Review gepostet ({posted} inline, {len(rest)} im Body).")

# ---------- Ablauf ----------

def review_pr(repo: str, n: int) -> str:
    pr = get_pr(repo, n)
    if not pr:
        return f"{repo}#{n}: PR nicht gefunden — übersprungen."
    if pr.get("state") != "open":
        return f"{repo}#{n}: nicht offen — übersprungen."
    if pr.get("draft") and not INCLUDE_DRAFTS:
        return f"{repo}#{n}: Draft — übersprungen."

    head_sha = pr["head"]["sha"]
    commit = get_commit(repo, head_sha)
    msg = ((commit or {}).get("commit") or {}).get("message", "")
    # Skip-Marker nur als EIGENE Zeile (2026-11-02, ztilt#23): Substring-
    # Matching ueber die ganze Message feuerte false positives, sobald die
    # Beschreibung den Marker erwaehnt (z.B. Doku-Commits ueber das Feature).
    if any(l.strip().lower() in ("[skip review]", "[skip-review]") for l in msg.splitlines()):
        return f"{repo}#{n}: [skip review] im Head-Commit — übersprungen."

    files = gh_paginate(f"/repos/{repo}/pulls/{n}/files", max_pages=5)
    diff, valid, truncated = build_diff(files)
    if not diff.strip():
        return f"{repo}#{n}: kein reviewbarer Diff (nur ausgeschlossene/binäre Dateien) — übersprungen."

    instructions = get_instructions(repo, head_sha)
    meta = f"# PR #{n}: {pr.get('title', '')}\n\n{pr.get('body') or ''}"[:1500]
    # Truncation-Marker sichtbar machen — die System-Prompt-Regel "Diff ist
    # vollständig" darf nur greifen, wenn GEKÜRZT wirklich ausgeschlossen
    # werden kann; sonst muss das Modell den Marker sehen können.
    diff_hdr = "# Diff (GEKÜRZT — Zusammenfassung/Zeilen fehlen, nur die ersten Dateien)" if truncated else "# Diff"
    user_prompt = (
        f"{('# Projekt-Review-Regeln\n' + instructions) if instructions else ''}\n\n"
        f"{meta}\n\n{diff_hdr}\n```diff\n{diff}\n```"
    )

    log(f"{repo}#{n}: Rufe {MODEL} auf ({len(diff)} Zeichen Diff) ...")
    raw = call_llm(user_prompt)
    summary, findings = parse_review(raw)
    log(f"{repo}#{n}: {len(findings)} Finding(s).")

    post_review(repo, n, summary, findings, valid, truncated, head_sha)
    return f"{repo}#{n}: Review gepostet ({len(findings)} Findings)."


def sweep_one_pr(repo: str, n: int, posted_counter: list) -> None:
    pr = get_pr(repo, n)
    if not pr:
        log(f"{repo}#{n}: PR nicht (mehr) verfügbar — übersprungen.")
        return
    # Trigger-Politik 2026-11-03 (Issue pungggi/ai-review#2): Der Sweep ist
    # NUR First-Review-Catch-up — PRs, die NOCH NIE einen AI-Review haben
    # (deren opened-Trigger z. B. außerhalb des Slots ins Leere lief). Die
    # alte Bedingung "Head neuer als letztes Review" hätte den synchronize-
    # Loop (ztilt#24, 17+ Runden) nur verlangsamt wieder eingeführt:
    # Fix-Push → Head neuer → Sweep reviewt → nächster Fix-Push ...
    # Re-Review nach Fixes ist bewusst manuell (workflow_dispatch bzw.
    # re-review.ps1) — KEINE automatischen Re-Reviews, auch nicht bei neuem Head.
    last = last_own_review_dt(repo, n)
    if last is not None:
        log(f"{repo}#{n}: hat bereits einen AI-Review — Re-Review bewusst manuell — übersprungen.")
        return
    log(f"{repo}#{n}: noch nie gereviewed — First-Review-Catch-up ...")
    result = review_pr(repo, n)
    log(result)
    if "gepostet" in result:
        posted_counter[0] += 1
    time.sleep(5)  # Fair use: 1 Request gleichzeitig pro Key — leicht entzerrt


def sweep(repo: str) -> None:
    prs = gh_paginate(f"/repos/{repo}/pulls?state=open&sort=updated&direction=asc", max_pages=3)
    log(f"Sweep {repo}: {len(prs)} offene PR(s).")
    posted = [0]
    for pr in prs:
        if posted[0] >= SWEEP_MAX_PER_REPO:
            log(f"{repo}: Limit {SWEEP_MAX_PER_REPO} Reviews/Repo erreicht.")
            break
        try:
            sweep_one_pr(repo, pr["number"], posted)
        except Exception as e:
            log(f"{repo}#{pr['number']}: FEHLER — {e}")
    log(f"Sweep {repo} fertig: {posted[0]} Review(s) gepostet.")


def sweep_all() -> None:
    repos = gh_paginate("/user/repos?affiliation=owner&sort=updated&direction=desc", max_pages=10)
    candidates = []
    for r in repos:
        full = r.get("full_name", "")
        if r.get("archived") or r.get("fork"):
            if r.get("fork") and any(full == x or x in full for x in REPOS_INCLUDE_FORKS):
                pass  # explizit erlaubter Fork
            else:
                continue
        if any(full == x or x in full for x in REPOS_EXCLUDE):
            continue
        if REPOS_FILTER and not any(x in full for x in REPOS_FILTER):
            continue
        candidates.append(full)
    log(f"Sweep-ALL: {len(candidates)} Kandidaten-Repo(s): {', '.join(candidates) or '(keine)'}")
    total = [0]
    for repo in candidates:
        if total[0] >= SWEEP_MAX_REVIEWS:
            log(f"Gesamt-Limit {SWEEP_MAX_REVIEWS} Reviews/Lauf erreicht — Rest beim nächsten Sweep.")
            break
        try:
            prs = gh_paginate(f"/repos/{repo}/pulls?state=open&sort=updated&direction=asc", max_pages=3)
            in_repo = [0]
            for pr in prs:
                if total[0] >= SWEEP_MAX_REVIEWS or in_repo[0] >= SWEEP_MAX_PER_REPO:
                    break
                before = total[0]
                try:
                    sweep_one_pr(repo, pr["number"], total)
                    in_repo[0] += total[0] - before
                except Exception as e:
                    log(f"{repo}#{pr['number']}: FEHLER — {e}")
        except Exception as e:
            log(f"{repo}: FEHLER beim Repo-Zugriff — {e}")
    log(f"Sweep-ALL fertig: {total[0]} Review(s) gepostet.")


def main() -> None:
    if not TOKEN:
        sys.exit("Fehlkonfiguration: weder AI_REVIEW_TOKEN noch GITHUB_TOKEN gesetzt.")
    if not API_KEY:
        sys.exit("Fehlkonfiguration: Secret CHEAPESTINFERENCE_API_KEY fehlt.")
    try:
        if env_or("SWEEP_ALL", "") == "1":
            sweep_all()
        elif env_or("SWEEP", "") == "1":
            repo = os.environ.get("REPO", "")
            if not repo:
                sys.exit("Fehlkonfiguration: REPO fehlt (Sweep-Modus).")
            sweep(repo)
        else:
            repo = os.environ.get("REPO", "")
            n = os.environ.get("PR_NUMBER", "")
            if not repo or not n.isdigit():
                sys.exit("Fehlkonfiguration: REPO / PR_NUMBER fehlen (Einzelfahr-Modus).")
            log(review_pr(repo, int(n)))
    except RuntimeError as e:
        # API außerhalb des Zeitblocks / transient: grün bleiben, Sweep holt es nach
        log(f"⚠️ Review nicht möglich: {e}")
        log("Der nächste Sweep im Zeitfenster holt diesen PR automatisch nach.")
        sys.exit(0)


if __name__ == "__main__":
    main()
