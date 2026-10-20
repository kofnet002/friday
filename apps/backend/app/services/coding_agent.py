"""Agentic coding runner — "Claude Code" in the app.

Spawns the local `claude` CLI headlessly (`-p --output-format stream-json`) in
a throwaway scratch dir, parses its stream-json events, and yields structured
AgentEvent objects the WS layer forwards to the panel as a live trace. The
final assistant message (the `result` event) is the interview-ready solution
in the standard 5-section format.

Auth + billing are handled by claude_agent_auth (subscription token, not the
metered API). See docs/agentic-coding.md.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import shutil
import signal
import tempfile
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.logging import log
from app.prompts.coding_agent import build_agent_prompt
from app.services.claude_agent_auth import (
    agent_unavailable_reason,
    resolve_agent_env,
)
from app.settings import settings

# How much of a tool input / result to surface in the trace. The panel shows a
# glanceable step list, not full logs — keep events small.
_SUMMARY_MAX = 500

# Extension for the starter-code file written into the agent workspace.
_LANG_EXTS = {
    "python": "py",
    "python3": "py",
    "javascript": "js",
    "typescript": "ts",
    "java": "java",
    "c++": "cpp",
    "cpp": "cpp",
    "go": "go",
}


def _lang_ext(language: str) -> str:
    return _LANG_EXTS.get(language.strip().lower(), "txt")

# StreamReader line-buffer cap for the CLI's stdout. asyncio defaults to 64KB,
# but a single stream-json line can be far bigger — the `system` init blob, or
# a tool_result carrying a read file / a base64 image. Without this, readline()
# raises LimitOverrunError mid-stream. Shared by all `claude` subprocess spawns.
_STREAM_READ_LIMIT = 32 * 1024 * 1024  # 32MB


class AgentUnavailableError(RuntimeError):
    """Raised before any subprocess spawn when the agent can't run (disabled,
    CLI missing, or no credentials). Carries a user-facing message."""


@dataclass(frozen=True)
class AgentEvent:
    """One trace event. `type` is one of:
    - "step"     : assistant reasoning text        → .text
    - "tool"     : the agent invoked a tool         → .tool, .summary
    - "tool_result": a tool returned                → .summary, .ok
    - "solution" : the final formatted answer       → .text
    """

    type: str
    text: str = ""
    tool: str = ""
    summary: str = ""
    ok: bool = True


def _truncate(s: str, limit: int = _SUMMARY_MAX) -> str:
    s = s.strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _tool_summary(name: str, tool_input: dict[str, Any]) -> str:
    """One-line, human-readable summary of a tool call for the trace."""
    if name == "Bash":
        return _truncate(str(tool_input.get("command", "")))
    if name in ("Write", "Edit", "Read"):
        return _truncate(str(tool_input.get("file_path", "")))
    # Fallback: compact JSON of the input.
    try:
        return _truncate(json.dumps(tool_input, ensure_ascii=False))
    except (TypeError, ValueError):
        return _truncate(str(tool_input))


def _result_content_text(content: Any) -> str:
    """Flatten a tool_result's content (string or list of blocks) to text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content)


def _events_from_line(line: str) -> list[AgentEvent]:
    """Map one stream-json line to zero or more AgentEvents.

    Claude Code emits one JSON object per line: `system` (init, ignored),
    `assistant` (text + tool_use blocks), `user` (tool_result blocks), and a
    final `result`. Unknown / malformed lines are ignored — the stream is
    best-effort telemetry, not a contract we control."""
    line = line.strip()
    if not line:
        return []
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return []
    if not isinstance(obj, dict):
        return []

    kind = obj.get("type")
    events: list[AgentEvent] = []

    if kind == "assistant":
        content = (obj.get("message") or {}).get("content") or []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                text = str(block.get("text", "")).strip()
                if text:
                    events.append(AgentEvent(type="step", text=text))
            elif btype == "tool_use":
                name = str(block.get("name", "tool"))
                events.append(
                    AgentEvent(
                        type="tool",
                        tool=name,
                        summary=_tool_summary(name, block.get("input") or {}),
                    )
                )

    elif kind == "user":
        content = (obj.get("message") or {}).get("content") or []
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            text = _result_content_text(block.get("content"))
            events.append(
                AgentEvent(
                    type="tool_result",
                    summary=_truncate(text),
                    ok=not bool(block.get("is_error")),
                )
            )

    elif kind == "result":
        # Terminal event. `result` holds the final assistant text (our
        # formatted solution) on success. On error subtype it may be absent.
        if obj.get("subtype") == "success" or obj.get("result"):
            events.append(AgentEvent(type="solution", text=str(obj.get("result") or "").strip()))
        else:
            events.append(
                AgentEvent(
                    type="tool_result",
                    ok=False,
                    summary=_truncate(f"agent ended without a solution: {obj.get('subtype')}"),
                )
            )

    return events


def _build_command(model: str | None = None, effort: str | None = None) -> list[str]:
    """CLI argv. `model`/`effort` are the panel's selection (a Claude model
    and/or an explicit effort); unset → AGENT_MODEL / AGENT_EFFORT."""
    cmd = [
        settings.claude_cli_path,
        "-p",
        "--output-format",
        "stream-json",
        # stream-json INPUT is what makes warm starts work: in plain-text
        # stdin mode the CLI gives up after 3s with no data ("no stdin data
        # received in 3s") and exits, so a pre-spawned process is dead by the
        # time it's claimed. In stream-json input mode it waits indefinitely
        # for a JSON user message (verified: alive after 75s idle, answers
        # in ~2.5s, exits on its own after result + stdin EOF).
        "--input-format",
        "stream-json",
        # stream-json in print mode requires --verbose to emit per-turn events.
        "--verbose",
        "--allowedTools",
        settings.agent_allowed_tools,
    ]
    if settings.agent_disallowed_tools.strip():
        # Deny web tools even under skip-permissions so the agent solves
        # instead of researching (see settings).
        cmd += ["--disallowedTools", settings.agent_disallowed_tools]
    if settings.agent_skip_permissions:
        # Non-interactive tool execution. Safe: runs in a throwaway scratch dir
        # under the user's own subscription (see docs/agentic-coding.md).
        cmd.append("--dangerously-skip-permissions")
    model = model or settings.agent_model
    effort = effort or settings.agent_effort.strip()
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    return cmd


# ─── Warm start ──────────────────────────────────────────────────────────────
# The CLI pays a boot cost (node startup, config load, auth handshake) on
# every spawn. A single pre-spawned process sits blocked on stdin — fully
# booted — so the next agent run skips that cost. The slot refills in the
# background after each take. Best-effort: any mismatch or dead process falls
# back to a cold spawn.

_warm_lock = asyncio.Lock()
_warm_proc: asyncio.subprocess.Process | None = None
_warm_workspace: str | None = None
_warm_key: str | None = None
# (model, effort) of the most recent run. The warm slot is spawned with it so
# a user who picked e.g. Opus + high still gets warm starts (a slot built
# with different flags doesn't match and is discarded).
_warm_selection: tuple[str | None, str | None] = (None, None)


def _remember_selection(model: str | None, effort: str | None) -> None:
    global _warm_selection
    _warm_selection = (model, effort)


def _spawn_fingerprint(cmd: list[str], env: dict[str, str]) -> str:
    """A warm process is only reusable if it was spawned with the same command
    and credentials as the incoming request."""
    return json.dumps(
        [cmd, env.get("CLAUDE_CODE_OAUTH_TOKEN", "")[-8:], env.get("CLAUDE_CONFIG_DIR", "")]
    )


async def _spawn_cli(
    cmd: list[str], env: dict[str, str]
) -> tuple[asyncio.subprocess.Process, str]:
    workspace = tempfile.mkdtemp(prefix="friday-agent-")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=workspace,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=_STREAM_READ_LIMIT,
        # New session/process group so we can kill the whole tree (the CLI
        # spawns child processes for Bash) on cancel or timeout.
        start_new_session=True,
    )
    return proc, workspace


async def prewarm_agent() -> None:
    """Pre-spawn one CLI process so the next agent run skips boot latency.
    No-op when the agent is disabled/unconfigured or a warm slot exists."""
    global _warm_proc, _warm_workspace, _warm_key
    if agent_unavailable_reason(None) is not None:
        return
    async with _warm_lock:
        if _warm_proc is not None and _warm_proc.returncode is None:
            return
        cmd = _build_command(*_warm_selection)
        env = resolve_agent_env(None)
        try:
            _warm_proc, _warm_workspace = await _spawn_cli(cmd, env)
            _warm_key = _spawn_fingerprint(cmd, env)
            log.info("coding_agent.prewarmed", workspace=_warm_workspace)
        except Exception as exc:  # noqa: BLE001 - warm start is best-effort
            _warm_proc = _warm_workspace = _warm_key = None
            log.warning("coding_agent.prewarm_failed", error=str(exc)[:200])


async def _take_warm(
    cmd: list[str], env: dict[str, str]
) -> tuple[asyncio.subprocess.Process, str] | None:
    """Claim the warm slot if it matches this request; None → cold spawn."""
    global _warm_proc, _warm_workspace, _warm_key
    async with _warm_lock:
        proc, workspace, key = _warm_proc, _warm_workspace, _warm_key
        _warm_proc = _warm_workspace = _warm_key = None
    if proc is None or workspace is None:
        return None
    if proc.returncode is not None or key != _spawn_fingerprint(cmd, env):
        _kill(proc)
        shutil.rmtree(workspace, ignore_errors=True)
        return None
    return proc, workspace


def _cleanup_warm() -> None:
    """atexit: don't orphan the idle warm process on backend shutdown/reload."""
    if _warm_proc is not None:
        _kill(_warm_proc)
    if _warm_workspace is not None:
        shutil.rmtree(_warm_workspace, ignore_errors=True)


atexit.register(_cleanup_warm)


async def stream_coding_agent(
    *,
    problem: dict[str, Any],
    language: str,
    session_id: str | None = None,
    extra_instructions: str | None = None,
    prior_solution: str | None = None,
    feedback: str | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run the agent on a problem, yielding trace events then a final solution.

    `prior_solution` + `feedback` flip the prompt into refine framing (a prior
    attempt failed — diagnose it rather than solve from scratch). Raises
    AgentUnavailableError up front if the agent can't run. Streams events as
    the CLI works; guarantees the process is killed on cancel or timeout."""
    reason = agent_unavailable_reason(session_id)
    if reason:
        raise AgentUnavailableError(reason)

    env = resolve_agent_env(session_id)
    cmd = _build_command(model, effort)
    _remember_selection(model, effort)

    # Starter code as a real file: the agent handles files more reliably than
    # inline snippets, and the exact signature matters (mismatch = graded
    # wrong). Written into the workspace below; the prompt references it.
    starter = (problem.get("function_signature") or "").strip()
    starter_file = f"starter.{_lang_ext(language)}" if starter else None

    prompt = build_agent_prompt(
        problem,
        language=language,
        extra_instructions=extra_instructions,
        prior_solution=prior_solution,
        feedback=feedback,
        starter_file=starter_file,
    )

    # Prefer the pre-warmed process (already booted, blocked on stdin);
    # cold-spawn when the slot is empty or doesn't match this request.
    warm = await _take_warm(cmd, env)
    if warm is not None:
        proc, workspace = warm
    else:
        proc, workspace = await _spawn_cli(cmd, env)
    # Refill the slot in the background for the NEXT run.
    refill = asyncio.get_running_loop().create_task(prewarm_agent())
    refill.add_done_callback(lambda t: t.exception())  # never unobserved

    log.info(
        "coding_agent.start",
        session_id=session_id,
        workspace=workspace,
        warm=warm is not None,
        timeout_s=settings.agent_timeout_s,
    )
    try:
        if starter and starter_file:
            await asyncio.to_thread(
                Path(workspace, starter_file).write_text, starter + "\n", "utf-8"
            )
        # Feed the prompt via stdin as a stream-json user message (see
        # _build_command for why not plain text). Closing stdin after the one
        # message tells the CLI no more turns are coming; it exits after the
        # final result on its own.
        assert proc.stdin is not None
        stdin_msg = json.dumps(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}],
                },
            }
        )
        proc.stdin.write((stdin_msg + "\n").encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        # Drain stderr concurrently. If we only read it at the end, a chatty
        # stderr could fill its 64KB pipe buffer mid-run, block the CLI's next
        # write, and deadlock against our stdout read.
        assert proc.stderr is not None
        stderr_chunks: list[bytes] = []
        stderr_task = asyncio.create_task(_drain(proc.stderr, stderr_chunks))

        assert proc.stdout is not None
        got_solution = False
        try:
            async with asyncio.timeout(settings.agent_timeout_s):
                async for raw in proc.stdout:
                    for event in _events_from_line(raw.decode("utf-8", errors="replace")):
                        if event.type == "solution":
                            got_solution = True
                        yield event
        except TimeoutError:
            _kill(proc)
            stderr_task.cancel()
            raise RuntimeError(
                f"agent timed out after {settings.agent_timeout_s}s"
            ) from None

        await proc.wait()
        await stderr_task
        if proc.returncode != 0 and not got_solution:
            detail = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()[:300]
            raise RuntimeError(f"claude CLI exited {proc.returncode}: {detail or 'no output'}")
        log.info("coding_agent.done", session_id=session_id, got_solution=got_solution)
    except asyncio.CancelledError:
        if proc is not None:
            _kill(proc)
        raise
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


async def _drain(stream: asyncio.StreamReader, into: list[bytes]) -> None:
    """Read a stream to EOF, collecting chunks. Best-effort — a read error
    (e.g. the process was killed) just ends the drain."""
    try:
        async for chunk in stream:
            into.append(chunk)
    except (ValueError, OSError):
        pass


def _kill(proc: asyncio.subprocess.Process) -> None:
    """Best-effort kill of the CLI process group (it spawns Bash children)."""
    if proc.returncode is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
