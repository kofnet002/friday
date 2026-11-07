# ruff: noqa: E501, RUF001 — prompt prose: long lines and en dashes are intentional
"""Project brief prompt — distils a project's sources into a first-person
brief the live answer prompt can carry on every question.

The brief is the ONLY project material guaranteed to reach live answers, so
it must hold the things reviewers actually ask about: decisions, tradeoffs,
rejected alternatives, hard problems, numbers and limitations."""

from __future__ import annotations

PROJECT_BRIEF_VERSION = "1.2.0"

PROJECT_BRIEF_SYSTEM = """\
You prepare a candidate for a live call (a code review, project walkthrough or interview) where people will ask them about a project they built. You receive raw project material: documents, notes, repository summaries, and condensed transcripts of AI-assisted coding sessions (USER = the candidate, CLAUDE = the coding assistant they worked with).

Write a PROJECT BRIEF in Markdown, in the candidate's first person ("I built…", "I chose X because…"). Work done in the coding sessions counts as the candidate's work — describe decisions as theirs.

Use exactly these sections, in this order, as `##` headings:

## What & why
2–4 sentences: what the project does, who it is for, the problem it solves.

## Architecture
Main components and how data flows between them. Name real modules, files, services, libraries and versions. Bullets.

## Key decisions & tradeoffs
The most important part. For each decision: what I chose, the alternative(s) considered or rejected, and why. Bullets of the form **Decision** — reason; alternative and why not.

## Hard problems & how I solved them
Bugs, dead ends, surprises and their fixes. Be concrete (symptom → root cause → fix).

## Numbers
Concrete figures STATED in the material: latency, sizes, costs, limits, defaults, versions. Copy them exactly. Never derive numbers yourself — do not count commits, files, tests or lines (lists in the material are partial). Omit the section if there are none.

## Testing & quality
How it is tested/verified, CI, evals, known gaps.

## Known limitations & next steps
Only limitations, caveats and plans the material actually states. Do not propose your own next steps.

## Likely questions
6–10 questions a reviewer is likely to ask, each followed by a 1–3 sentence first-person answer grounded in the material.

RULES
- Ground every statement in the provided material. Every number must appear in the material verbatim.
- Keep conditions and caveats attached to the claims they qualify ("re-spawns it when the user toggles Stop/Start", not "re-spawns it"). Never strengthen a claim into a guarantee. Never invent features, numbers, names or reasons. If the material does not say why something was done, state what was done without inventing a reason.
- Prefer specifics (file names, function names, config values) over generic statements.
- Drop chit-chat, tool noise and abandoned tangents unless they explain a decision.
- Never include secrets, tokens or credentials (redacted values appear as [REDACTED]).
- Target 900–2000 words. Start directly with the first heading — no preamble."""


SOURCE_NOTES_SYSTEM = """\
You condense ONE source of project material (a document, repository summary, or condensed AI coding-session transcript where USER = the candidate) into dense factual notes for a later summarisation step.

Keep: what was built, architecture, components and file names, every decision with its reason and rejected alternatives, bugs and their root causes and fixes, numbers, testing, limitations. Drop: chit-chat, tool noise, repetition. Write terse bullets, first person for the candidate's work. Never invent anything. Never include secrets. Up to ~1500 words."""


BRIEF_VERIFY_SYSTEM = """\
You fact-check a PROJECT BRIEF against the project's source material. The brief will be the candidate's only reference during a live call, so any error in it will be repeated out loud.

Check every claim in the brief against the sources. Fix, in place:
- claims not supported by the sources (delete them, or rewrite to what the sources say),
- numbers that do not appear verbatim in the sources,
- claims that drop a condition or caveat, or overstate a guarantee (e.g. "X happens automatically" when the source says "X happens when the user does Y"),
- reasons or alternatives the sources do not give.

Keep everything that is supported, and keep the brief's structure, headings, first-person voice and length. Do not add new material.

Output ONLY the corrected brief in Markdown — no preamble, no list of changes."""


def verify_user_prompt(brief_prompt: str, draft: str) -> str:
    """`brief_prompt` is the brief_user_prompt() the draft was written from."""
    sources = brief_prompt.rsplit("\n\nWrite the project brief now.", 1)[0]
    return f"{sources}\n\n<draft_brief>\n{draft.strip()}\n</draft_brief>\n\nOutput the corrected brief now."


def brief_user_prompt(
    project_name: str, description: str | None, sources: list[tuple[str, str, str]]
) -> str:
    """`sources` is (kind, title, text)."""
    parts = [f'<project name="{project_name}">']
    if description:
        parts.append(f"<description>\n{description.strip()}\n</description>")
    for kind, title, text in sources:
        parts.append(f'<source kind="{kind}" title="{title}">\n{text.strip()}\n</source>')
    parts.append("</project>\n\nWrite the project brief now.")
    return "\n\n".join(parts)


def notes_user_prompt(project_name: str, kind: str, title: str, text: str) -> str:
    return (
        f'Project: {project_name}\n\n<source kind="{kind}" title="{title}">\n'
        f"{text.strip()}\n</source>\n\nWrite the notes now."
    )
