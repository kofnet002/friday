# Project context ("Projects")

Give Friday the material behind a project you may be questioned on — a repo
you shipped, a PR under review, a Claude Code session — and live answers
about it come back in first person, grounded in what you actually built.

## How it works

```
Setup → Projects                       backend
  Upload / Paste / Folder / Claude Code ──▶ context_sources/*  (ingest + redact secrets)
                                              │
                                              ▼
                                        project_sources (SQLite)
  "Generate brief" ───────────────────▶ services/project_brief.py
                                          draft (Opus 5.5) → fact-check pass → projects.brief
  "Attach to this session" ───────────▶ session_projects
                                              │
Live question ──▶ ws_answer ──▶ project_context.load_project_contexts()
                                  brief always; raw sources too if they fit the budget
                                              │
                                              ▼
                              answer_system_prompt  <candidate_projects> + PROJECT QUESTIONS rules
                              (prompt-cached on Claude: identical for every question in a session)
```

- **Projects live in a library**, not inside one session: build a project
  once, attach it to the review call and any follow-up.
- **Sources** (`apps/backend/app/services/context_sources/`):
  - `files.py` — PDF, DOCX, Markdown/text/code uploads.
  - `folder.py` — a local repo: README + `docs/`, manifests, file tree,
    `git log`, optionally the diff vs the base branch. Code bodies are not
    inlined; `.env*`, keys and dependency dirs are skipped. Paths must be
    under `$HOME`.
  - `claude_code.py` — sessions from `~/.claude/projects/`. Keeps your
    prompts and Claude's prose, shrinks tool calls to one line
    (`[edited: app/db.py]`), drops tool output and thinking. A 1.9 MB
    transcript condensed to ~17k chars (this feature's own session). Optionally pulls in the repo folder
    the session ran in.
  - `redact.py` — every source is scrubbed of API keys, tokens, `KEY=value`
    secrets, bearer headers and URL credentials before it is stored.
- **The brief** is a first-person Markdown summary with fixed sections
  (what & why, architecture, decisions & tradeoffs, hard problems, numbers,
  testing, limitations, likely questions). It is written by
  `PROJECT_BRIEF_MODEL` and then **fact-checked against the sources in a
  second pass** (`PROJECT_BRIEF_VERIFY`). It is editable; hand edits are
  protected from regeneration unless you confirm the overwrite. Adding or
  removing a source marks it `stale`. Very large projects are condensed per
  source first.
- **Live answers** carry every attached project's brief, plus the raw
  sources when all attached sources fit `PROJECT_RAW_BUDGET_CHARS`. Project
  names and terms are also fed to Deepgram as key terms.

## Settings

| Setting                    | Default             | Purpose                                                         |
| -------------------------- | ------------------- | --------------------------------------------------------------- |
| `PROJECT_BRIEF_MODEL`      | `claude-opus-5-5`   | Writes and fact-checks the brief (offline, once)                |
| `PROJECT_BRIEF_EFFORT`     | `medium`            | Effort for the brief calls                                      |
| `PROJECT_BRIEF_VERIFY`     | `true`              | Second pass that checks the brief against its sources           |
| `PROJECT_RAW_BUDGET_CHARS` | `120000`            | Include raw sources in live answers when they fit (~30k tokens) |
| `ANTHROPIC_ANSWER_MODEL`   | `claude-sonnet-5-5` | Live answer model (see benchmark)                               |

## Model benchmark (2026-11-06)

`apps/backend/evals/projects/run_bench.py` uses this repo as the project
(ingested exactly like a folder source) and 12 review-style questions with
known answers in the material, including two traps (no answer exists; false
premise). Answers stream on the real answer prompt with prompt caching and
the production effort (`low`); an Opus 5.5 judge scores each against the
**raw sources** for required points and fabrication.

**Round 1** — every Claude model, 12 questions × 2 context conditions, 1 rep
(unverified brief). Highlights: Haiku 4.5 fabricated in 7/12 brief-only
answers; Sonnet 4.6 had a 6 s TTFT p90; Fable 5.1 was slowest overall
(~6 s total) with no accuracy gain. Several models repeated the same error —
traced to the brief having dropped a condition ("re-spawns the helper if it
dies" vs the source's "when the user toggles Stop/Start"). That finding is
why the brief now gets a fact-check pass.

**Round 2** — top four models, verified brief, 12 questions × 3 reps
(36 answers per cell):

| Model                   | Context   | TTFT p50 | TTFT p90 | Total p50 | Correct | Fabricated | Traps ok |
| ----------------------- | --------- | -------- | -------- | --------- | ------- | ---------- | -------- |
| **Sonnet 5.5**          | brief     | 0.85 s   | 1.06 s   | 3.39 s    | 100%    | **0/36**   | 6/6      |
| **Sonnet 5.5**          | brief+raw | 0.94 s   | 1.21 s   | 3.62 s    | 100%    | **0/36**   | 6/6      |
| Opus 5.5                | brief     | 0.98 s   | 1.30 s   | 4.97 s    | 97%     | 0/36       | 6/6      |
| Opus 5.5                | brief+raw | 0.79 s   | 1.58 s   | 5.21 s    | 100%    | 1/36       | 6/6      |
| Haiku 5.5               | brief     | 0.71 s   | 0.88 s   | 2.00 s    | 98%     | 4/36       | 6/6      |
| Haiku 5.5               | brief+raw | 0.75 s   | 0.92 s   | 2.11 s    | 100%    | 2/36       | 5/6      |
| Haiku 5.5 (no thinking) | brief     | 0.70 s   | 0.80 s   | 2.08 s    | 99%     | 2/36       | 6/6      |
| Haiku 5.5 (no thinking) | brief+raw | 0.76 s   | 0.83 s   | 2.14 s    | 100%    | 4/36       | 5/6      |

**Verdict: keep Sonnet 5.5 for live answers.** It is the only model with
zero fabrications across 72 answers and full marks on correctness, and its
first token lands within ~0.15–0.2 s of the fastest model. Haiku 5.5
finishes ~1.4 s sooner and is 20× cheaper, but embellishes in 6–11% of
answers (e.g. "the temp dir means the agent can't touch my files" — the
source says the opposite); on a call about your own project, a confident
wrong detail costs more than a second. Opus 5.5 is slower with no accuracy
gain. Brief generation stays on Opus 5.5 (offline, ~2 min including the
check pass); in the brief comparison Sonnet 5.5 also retained 100% of
required points in half the time, so it is a reasonable cheaper setting.

Re-run after prompt or model changes:

```bash
cd apps/backend
uv run python -m evals.projects.run_bench briefs
uv run python -m evals.projects.run_bench answers                       # all models, 1 rep
uv run python -m evals.projects.run_bench answers --models claude-sonnet-5-5,claude-haiku-5-5 --repeat 3
```

A full all-model run costs a few dollars (the judge is Opus with a cached
source prompt). Results land in `evals/projects/results/` (gitignored).

## Code citations (📎 Source)

Answers about a project end with the file, line range and lines of code
that back them up, e.g.:

> **📎 Source:** `apps/backend/app/services/claude_api.py:57-76`
>
> ```python
> if mode == "api":
>     return "api" if has_key else None
> ```

- **Index** (`context_sources/code_index.py`): when a folder source is added
  (directly, or as the repo of a Claude Code import), its source files are
  split into function/class-sized chunks (decorators and doc comments stay
  with their definition; long blocks become overlapping 80-line windows),
  redacted, and stored with repo-relative path + line range in a SQLite
  FTS5 table (`project_code_fts`). Friday's own repo: 1,064 chunks in
  ~0.2 s. The source shows the chunk count in its metadata.
- **Retrieval** (`services/code_search.py`), per question, no model call,
  milliseconds:
  1. _Brief-guided identifiers_ — spoken questions rarely name code ("how
     does it decide API vs subscription?"), so the attached brief/notes are
     split into sentences, scored by overlap with the question (normalised
     by length, so a precise sentence beats a transcript blob), and the
     identifiers they mention (`claude_transport`, `claude_api.py`) are
     searched first.
  2. The question's own keywords (identifiers split on `_`/camelCase).
     Tests/evals/fixtures are dropped unless the question is about testing;
     at most 4 chunks, 2 per file, ~9k chars.
- **Prompt**: chunks go into the per-question user turn as
  `<code_reference path=… lines=…>`, so the cached system prompt is
  untouched. The rules allow citing only provided references with their
  exact path and range, ≤12 verbatim lines, and omitting the section
  silently when nothing fits.
- The index is a snapshot taken when the folder was added; re-add the
  folder after large changes.

Measured on the benchmark (brief+raw, 2 reps): the right file was
retrieved for 16/18 code questions; Sonnet 5.5 cited the expected file in
16/18 answers with **0 citations to a path/range it was not given**
(Haiku 5.5: 13/18, 1 invalid range). Citations add ~0.9 s to the full
answer (writing the snippet); time to first token is unchanged (~1.0 s).
The judge sees the same retrieved code as the answer — without it, real
code details were mis-scored as fabrications.

## Drag and drop

Drop files anywhere on a project card (collapsed or expanded) to add them
as sources — several at once, uploaded one by one with progress and a
per-file error list (type and the 25 MB limit are checked first). The
Upload tab also accepts multiple files.

Folders can be dropped too:

- **Desktop app**: the real path comes from `webUtils.getPathForFile`
  (exposed by the preload as `window.friday.getPathForFile`).
- **Browser tab**: browsers hide a dropped folder's path, so the page sends
  the folder's name and its top-level entry names to
  `POST /api/folders/locate`. The local backend finds folders with that name
  under `$HOME` (Spotlight via `mdfind`, falling back to a bounded walk)
  and ranks them by how many of those entries they contain. The folder is
  added only when one candidate clearly matches (≥80% of entries, no tie);
  otherwise the error names the candidates and points to the Folder tab.

## Not built yet

- PR import via `gh pr view` and URL sources.
- Re-indexing a folder in place (today: remove and re-add it).
- Turning the resume into a regular source.
