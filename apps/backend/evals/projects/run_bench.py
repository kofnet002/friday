# ruff: noqa: E501 — judge prompt prose and usage examples are long lines
"""Project-context benchmark: which Claude model answers project questions
fastest AND correctly?

The project under test is this repository itself, ingested exactly as the
app ingests a folder source (README, docs, manifests, file tree, git log),
redacted the same way. Questions in cases.json have known answers in that
material, plus traps (no answer exists / false premise) that a model must
NOT fabricate an answer to.

Two benchmarks:

  briefs   — generate the project brief with each model; time it and judge
             how many of the cases' required facts the brief retained.
  answers  — stream live answers on the REAL answer prompt
             (answer_system_prompt + project context, prompt-cached, the
             production effort) with each model, under two context
             conditions: "brief" (sources over the raw budget) and
             "brief+raw" (sources fit — what this repo gets by default).
             Measures time-to-first-token and total time; an Opus judge
             scores each answer against the raw source material.

Live model calls — this spends money (roughly $3-6 for a full answers run).

    cd apps/backend
    uv run python -m evals.projects.run_bench briefs
    uv run python -m evals.projects.run_bench answers
    uv run python -m evals.projects.run_bench answers --models claude-sonnet-5-5,claude-haiku-5-5 --repeat 3
    uv run python -m evals.projects.run_bench answers --conditions brief --case sonnet-for-answers
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import statistics
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.prompts.answer_generation import (
    AnswerContext,
    CodeRef,
    ProjectContext,
    answer_system_prompt,
    answer_user_prompt,
)
from app.prompts.project_brief import (
    BRIEF_VERIFY_SYSTEM,
    PROJECT_BRIEF_SYSTEM,
    brief_user_prompt,
    verify_user_prompt,
)
from app.services.claude_api import complete_claude_api, stream_claude_api
from app.services.code_search import find_code_refs
from app.services.context_sources.folder import ingest_folder
from app.services.context_sources.redact import redact
from app.services.usage import PRICING
from app.settings import settings

HERE = Path(__file__).parent
CASES_PATH = HERE / "cases.json"
CACHE = HERE / ".cache"
RESULTS = HERE / "results"

ALL_MODELS = [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-haiku-5-5:nothink",  # Haiku 5.5 is the one 5.x model that can disable thinking
    "claude-fable-5-1",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
]
BRIEF_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]
JUDGE_MODEL = "claude-opus-5-5"
ANSWER_MAX_TOKENS = 1500  # same as services/answer.py


def _load() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(CASES_PATH.read_text())
    return data


def _source_text(spec: dict[str, Any]) -> str:
    folder = (HERE / spec["folder"]).resolve()
    return redact(ingest_folder(str(folder)).text)


def _split(variant: str) -> tuple[str, bool]:
    model, _, flag = variant.partition(":")
    return model, flag != "nothink"


# ------------------------------------------------------------------ judge

JUDGE_SYSTEM = """\
You grade answers a candidate would say aloud on a call about a software project they built. You get the project's SOURCE MATERIAL (ground truth), the question, the list of REQUIRED POINTS, the ANSWER, and possibly <retrieved_code>: real code blocks from the repository that the answer was given. Retrieved code is ground truth too — details that appear in it are NOT fabrications.

For each required point decide whether the answer conveys it (paraphrase is fine; numbers must match the source). Then decide whether the answer FABRICATES: states a concrete fact (number, feature, technology, file, reason) that contradicts the source material or does not appear in it. Generic interview framing, hedges ("I'd need to check") and reasonable opinions are NOT fabrication.

Reply with ONLY a JSON object:
{"points": [true|false, ...], "fabricated": true|false, "fabrication": "<the fabricated claim, or empty>"}

<source_material>
{source}
</source_material>"""


def _judge_user(question: str, must: list[str], answer: str, refs: tuple[CodeRef, ...] = ()) -> str:
    points = "\n".join(f"{i + 1}. {m}" for i, m in enumerate(must))
    code = "".join(
        f'<code path="{r.path}" lines="{r.start_line}-{r.end_line}">\n{r.code}\n</code>\n'
        for r in refs
    )
    code_block = f"<retrieved_code>\n{code}</retrieved_code>\n\n" if refs else ""
    return (
        f"{code_block}<question>\n{question}\n</question>\n\n<required_points>\n{points}\n"
        f"</required_points>\n\n<answer>\n{answer}\n</answer>"
    )


def _parse_json(text: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"judge returned no JSON: {text[:200]}")
    parsed: dict[str, Any] = json.loads(match.group(0))
    return parsed


async def judge(
    source: str,
    question: str,
    must: list[str],
    answer: str,
    refs: tuple[CodeRef, ...] = (),
) -> dict[str, Any]:
    text, _, _ = await _judge_call(
        JUDGE_SYSTEM.replace("{source}", source), _judge_user(question, must, answer, refs)
    )
    verdict = _parse_json(text)
    points = [bool(p) for p in verdict.get("points", [])][: len(must)]
    points += [False] * (len(must) - len(points))
    return {
        "points": points,
        "score": sum(points) / len(must),
        "fabricated": bool(verdict.get("fabricated")),
        "fabrication": verdict.get("fabrication") or "",
    }


async def _judge_call(system: str, user: str) -> tuple[str, int, int]:
    # The judge's system prompt carries the whole source and repeats on every
    # call — the API caches it, but complete_claude_api doesn't expose that,
    # so go through the streaming helper with caching on.
    chunks = [
        t
        async for t in stream_claude_api(
            system=system,
            user=user,
            model=JUDGE_MODEL,
            max_tokens=600,
            effort="medium",
            cache_system=True,
        )
    ]
    return "".join(chunks), 0, 0


# ----------------------------------------------------------------- briefs


async def make_brief(model: str, spec: dict[str, Any], source: str) -> tuple[str, float]:
    """Draft + fact-check pass, mirroring services/project_brief.py."""
    t0 = time.perf_counter()
    user = brief_user_prompt(
        spec["name"], spec.get("description"), [("folder", spec["name"], source)]
    )

    async def call(system: str, prompt: str) -> str:
        text, _, _ = await complete_claude_api(
            system=system,
            user=prompt,
            model=model,
            max_tokens=6000,
            effort=settings.project_brief_effort,
        )
        return text.strip()

    brief = await call(PROJECT_BRIEF_SYSTEM, user)
    if settings.project_brief_verify:
        brief = await call(BRIEF_VERIFY_SYSTEM, verify_user_prompt(user, brief)) or brief
    return brief, time.perf_counter() - t0


async def cached_brief(model: str, spec: dict[str, Any], source: str) -> str:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"brief-{model}.md"
    if path.exists():
        return path.read_text()
    brief, secs = await make_brief(model, spec, source)
    path.write_text(brief)
    print(f"  generated brief with {model} in {secs:.1f}s ({len(brief)} chars)")
    return brief


async def bench_briefs(models: list[str], data: dict[str, Any]) -> None:
    spec, cases = data["project"], data["cases"]
    source = _source_text(spec)
    covered = [c for c in cases if c["kind"] == "covered"]
    all_points = [m for c in covered for m in c["must"]]
    print(f"Source: {len(source):,} chars. Judging coverage of {len(all_points)} required points.")

    async def one(model: str) -> dict[str, Any]:
        try:
            brief, secs = await make_brief(model, spec, source)
        except Exception as exc:  # report and keep going
            return {"model": model, "error": str(exc)[:200]}
        CACHE.mkdir(exist_ok=True)
        (CACHE / f"brief-{model}.md").write_text(brief)
        verdict = await judge(source, "(Brief coverage check)", all_points, brief)
        return {
            "model": model,
            "seconds": secs,
            "chars": len(brief),
            "coverage": verdict["score"],
            "fabricated": verdict["fabricated"],
            "fabrication": verdict["fabrication"],
        }

    rows = await asyncio.gather(*(one(m) for m in models))
    print(f"\n{'model':<22}{'time':>8}{'chars':>8}{'coverage':>10}  fabricated")
    for r in rows:
        if "error" in r:
            print(f"{r['model']:<22}  ERROR {r['error']}")
            continue
        fab = f"YES — {r['fabrication'][:60]}" if r["fabricated"] else "no"
        print(f"{r['model']:<22}{r['seconds']:>7.1f}s{r['chars']:>8}{r['coverage']:>9.0%}  {fab}")
    _save("briefs", rows)


# ---------------------------------------------------------------- answers


@dataclass
class AnswerRun:
    variant: str
    condition: str
    case: str
    kind: str
    rep: int
    ttft: float | None = None
    total: float | None = None
    chars: int = 0
    format_ok: bool = False
    error: str | None = None
    score: float | None = None
    fabricated: bool | None = None
    fabrication: str = ""
    # Code citations (cases with "cite": expected path substrings).
    retrieval_hit: bool | None = None  # an expected file was among the refs
    cited_ok: bool | None = None  # the answer's 📎 Source names an expected file
    bad_cites: list[str] = field(default_factory=list)  # cited path:range not provided
    answer: str = field(default="", repr=False)


_CITE_RE = re.compile(r"`([\w./\-]+\.\w+):(\d+)-(\d+)`")


def _check_citations(r: AnswerRun, case: dict[str, Any], refs: tuple[CodeRef, ...]) -> None:
    provided = {(x.path, x.start_line, x.end_line) for x in refs}
    cites = []
    if "📎" in r.answer:
        tail = r.answer[r.answer.index("📎") :]
        cites = [(m[0], int(m[1]), int(m[2])) for m in _CITE_RE.findall(tail)]
    r.bad_cites = [f"{p}:{a}-{b}" for p, a, b in cites if (p, a, b) not in provided]
    expected = case.get("cite")
    if expected:
        r.retrieval_hit = any(any(e in x.path for e in expected) for x in refs)
        r.cited_ok = any(any(e in p for e in expected) for p, _, _ in cites)


async def _index_repo(spec: dict[str, Any]) -> str:
    """Index the repo's code into a throwaway DB exactly as a folder source
    would be, so retrieval matches production. Returns the project id."""
    import tempfile

    from app.db import add_code_chunks, init_db
    from app.services.context_sources.code_index import chunk_repo

    settings.sqlite_path = str(Path(tempfile.mkdtemp()) / "bench.db")
    await init_db()
    folder = (HERE / spec["folder"]).resolve()
    chunks = await asyncio.to_thread(chunk_repo, folder)
    await add_code_chunks(project_id="bench", source_id="bench", root=str(folder), chunks=chunks)
    print(f"Indexed {len(chunks):,} code chunks.")
    return "bench"


async def stream_once(variant: str, system: str, user: str) -> tuple[str, float, float]:
    model, thinking = _split(variant)
    t0 = time.perf_counter()
    ttft: float | None = None
    parts: list[str] = []
    async for text in stream_claude_api(
        system=system,
        user=user,
        model=model,
        max_tokens=ANSWER_MAX_TOKENS,
        effort=settings.anthropic_effort,
        cache_system=True,
        thinking=thinking,
    ):
        if ttft is None:
            ttft = time.perf_counter() - t0
        parts.append(text)
    total = time.perf_counter() - t0
    return "".join(parts), ttft if ttft is not None else total, total


async def bench_answers(args: argparse.Namespace, data: dict[str, Any]) -> None:
    spec = data["project"]
    cases = [c for c in data["cases"] if not args.case or c["id"] in args.case]
    source = _source_text(spec)
    brief = await cached_brief(args.brief_model, spec, source)
    systems = {
        "brief": answer_system_prompt(
            AnswerContext(projects=(ProjectContext(name=spec["name"], brief=brief),))
        ),
        "brief+raw": answer_system_prompt(
            AnswerContext(
                projects=(ProjectContext(name=spec["name"], brief=brief, raw_text=source),)
            )
        ),
    }
    conditions = [c for c in args.conditions if c in systems]
    refs_by_case: dict[str, tuple[CodeRef, ...]] = {}
    if args.code:
        pid = await _index_repo(spec)
        for c in cases:
            refs_by_case[c["id"]] = await find_code_refs(
                [pid], c["question"], hints=f"{brief}\n{source}"
            )
    print(
        f"Brief by {args.brief_model} ({len(brief):,} chars); source {len(source):,} chars. "
        f"{len(args.models)} models x {len(conditions)} conditions x {len(cases)} cases x "
        f"{args.repeat} reps."
    )

    # Warm the prompt cache per (model, condition) so timings reflect a live
    # session after its first question (the system prompt is identical for
    # every question in a session).
    print("Warming prompt caches…")

    async def warm(variant: str, cond: str) -> None:
        try:
            await stream_once(variant, systems[cond], answer_user_prompt("Introduce yourself."))
        except Exception as exc:  # surfaced again per run below
            print(f"  warm-up failed for {variant}/{cond}: {str(exc)[:120]}")

    await asyncio.gather(*(warm(v, c) for v in args.models for c in conditions))

    runs = [
        AnswerRun(variant=v, condition=cond, case=c["id"], kind=c["kind"], rep=r)
        for v in args.models
        for cond in conditions
        for c in cases
        for r in range(args.repeat)
    ]
    random.Random(7).shuffle(runs)  # noqa: S311 — interleave models so load/time-of-day hits all evenly
    by_id = {c["id"]: c for c in cases}
    sem = asyncio.Semaphore(args.concurrency)
    done = 0

    async def run(r: AnswerRun) -> None:
        nonlocal done
        case = by_id[r.case]
        async with sem:
            try:
                refs = refs_by_case.get(r.case, ())
                text, r.ttft, r.total = await stream_once(
                    r.variant,
                    systems[r.condition],
                    answer_user_prompt(case["question"], code_refs=refs),
                )
                r.answer, r.chars = text, len(text)
                r.format_ok = text.lstrip().startswith("**💬 Question")
                _check_citations(r, case, refs)
            except Exception as exc:  # keep the benchmark going
                r.error = str(exc)[:200]
        if r.error is None:
            try:
                v = await judge(
                    source, case["question"], case["must"], r.answer, refs_by_case.get(r.case, ())
                )
                r.score, r.fabricated, r.fabrication = v["score"], v["fabricated"], v["fabrication"]
            except Exception as exc:
                r.error = f"judge: {str(exc)[:180]}"
        done += 1
        if done % 10 == 0 or done == len(runs):
            print(f"  {done}/{len(runs)}")

    await asyncio.gather(*(run(r) for r in runs))
    report(runs, args.models, conditions)
    _save("answers", [asdict(r) for r in runs])


def _p(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=100, method="inclusive")[int(q) - 1]


def report(runs: list[AnswerRun], models: list[str], conditions: list[str]) -> None:
    header = (
        f"\n{'model':<26}{'context':<11}{'TTFT p50':>9}{'p90':>7}{'total p50':>10}"
        f"{'correct':>9}{'fabric.':>8}{'traps ok':>9}{'fmt':>6}{'err':>5}"
        f"{'retrieved':>10}{'cited':>7}{'bad cite':>9}{'$/M in·out':>14}"
    )
    print(header)
    print("-" * len(header))
    for cond in conditions:
        for v in models:
            rs = [r for r in runs if r.variant == v and r.condition == cond]
            ok = [r for r in rs if r.error is None and r.score is not None]
            ttft = [r.ttft for r in ok if r.ttft is not None]
            total = [r.total for r in ok if r.total is not None]
            covered = [r.score for r in ok if r.kind == "covered" and r.score is not None]
            traps = [r for r in ok if r.kind == "uncovered"]
            traps_ok = sum(1 for r in traps if r.score == 1.0 and not r.fabricated)
            fabricated = sum(1 for r in ok if r.fabricated)
            fmt = sum(1 for r in ok if r.format_ok)
            cite_runs = [r for r in ok if r.cited_ok is not None]
            retrieved = sum(1 for r in cite_runs if r.retrieval_hit)
            cited = sum(1 for r in cite_runs if r.cited_ok)
            bad = sum(1 for r in ok if r.bad_cites)
            price = PRICING.get(_split(v)[0])
            price_s = f"{price[0]:.2f}·{price[1]:.2f}" if price else "?"
            print(
                f"{v:<26}{cond:<11}{_p(ttft, 50):>8.2f}s{_p(ttft, 90):>6.2f}s"
                f"{_p(total, 50):>9.2f}s"
                f"{(statistics.mean(covered) if covered else float('nan')):>9.0%}"
                f"{fabricated:>5}/{len(ok):<2}{traps_ok:>6}/{len(traps):<2}"
                f"{fmt:>3}/{len(ok):<2}{len(rs) - len(ok):>4}"
                f"{retrieved:>6}/{len(cite_runs):<3}{cited:>3}/{len(cite_runs):<3}"
                f"{bad:>5}/{len(ok):<3}{price_s:>11}"
            )
        print()
    errors = [r for r in runs if r.error]
    for r in errors[:10]:
        print(f"  error {r.variant}/{r.condition}/{r.case}: {r.error}")
    for r in [r for r in runs if r.bad_cites][:10]:
        print(f"  bad cite {r.variant}/{r.condition}/{r.case}: {', '.join(r.bad_cites)}")
    for r in [r for r in runs if r.fabricated][:15]:
        print(f"  fabricated {r.variant}/{r.condition}/{r.case}: {r.fabrication[:110]}")


def _save(kind: str, rows: list[dict[str, Any]]) -> None:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    print(f"\nSaved {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("briefs", help="compare models for brief generation")
    b.add_argument("--models", type=lambda s: s.split(","), default=BRIEF_MODELS)
    a = sub.add_parser("answers", help="compare models for live answers")
    a.add_argument("--models", type=lambda s: s.split(","), default=ALL_MODELS)
    a.add_argument("--conditions", type=lambda s: s.split(","), default=["brief", "brief+raw"])
    a.add_argument("--brief-model", default=settings.project_brief_model)
    a.add_argument("--case", action="append", help="only this case id (repeatable)")
    a.add_argument("--repeat", type=int, default=1)
    a.add_argument("--concurrency", type=int, default=4)
    a.add_argument(
        "--no-code",
        dest="code",
        action="store_false",
        help="skip code indexing/retrieval (answers without 📎 Source)",
    )
    args = parser.parse_args()
    data = _load()
    if args.cmd == "briefs":
        asyncio.run(bench_briefs(args.models, data))
    else:
        asyncio.run(bench_answers(args, data))


if __name__ == "__main__":
    main()
