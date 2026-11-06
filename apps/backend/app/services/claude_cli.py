"""Single-shot Claude via the local CLI (subscription-backed, no tools).

The normal coding "solve" path streams Claude through the Anthropic SDK, which
needs ANTHROPIC_API_KEY. When the user has only a Claude SUBSCRIPTION (a
CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) and no API key, this drives
the `claude` CLI in print mode instead — so selecting "Claude" actually runs
Claude, billed against the subscription rather than the metered API.

Unlike coding_agent (a full tool loop that writes + runs code), this is a plain
text completion: no tools, no workspace mutation. It exists so provider
selection is honored without an API key. See docs/agentic-coding.md.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

from app.logging import log
from app.services.claude_agent_auth import claude_cli_ready, resolve_agent_env
from app.services.coding_agent import _STREAM_READ_LIMIT, _drain, _kill
from app.settings import settings

# Generous cap — a single completion should never approach it, but it bounds a
# hung CLI (no tool loop here, so this is shorter than the agent's timeout).
_TIMEOUT_S = 120.0


def _text_from_line(line: str) -> str | None:
    """Extract streamed assistant text from one stream-json line.

    With --include-partial-messages the CLI emits Anthropic streaming events
    wrapped as {"type":"stream_event","event":{...}}; we want the incremental
    text_delta chunks. Returns the text, or None for lines we don't stream."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or obj.get("type") != "stream_event":
        return None
    event = obj.get("event") or {}
    if event.get("type") == "content_block_delta":
        delta = event.get("delta") or {}
        if delta.get("type") == "text_delta":
            return str(delta.get("text", ""))
    return None


def _result_text(line: str) -> str | None:
    """Terminal `result` event's full text — the fallback when no partial
    deltas were emitted (so the caller still gets the answer)."""
    try:
        obj = json.loads(line.strip())
    except json.JSONDecodeError:
        return None
    if isinstance(obj, dict) and obj.get("type") == "result":
        return str(obj.get("result") or "")
    return None


class ClaudeCliUnavailableError(RuntimeError):
    """The CLI can't be driven (missing binary or credential)."""


def _image_ext(image_bytes: bytes) -> str:
    """Sniff a sensible extension so Claude Code's Read tool treats the file
    as an image. Defaults to jpg (what the desktop capture emits)."""
    if image_bytes[:8].startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if image_bytes[:3] == b"\xff\xd8\xff":
        return "jpg"
    if image_bytes[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "webp"
    return "jpg"


async def run_claude_cli_vision(
    *,
    images: list[bytes],
    prompt: str,
    system: str,
    model: str | None = None,
    session_id: str | None = None,
) -> str:
    """One-shot vision call: write the screenshot(s) to a scratch dir, let the
    CLI read them (Read tool) in order, and return the final answer text.

    Used for coding-problem extraction when Claude is the selected provider but
    there's no ANTHROPIC_API_KEY — the subscription CLI does the OCR. `system`
    is APPENDED to Claude Code's default prompt (so its image-reading behavior
    stays intact); `prompt` must tell it to read the file we wrote and reply
    with JSON only. Returns the raw result text (caller parses/validates).
    """
    reason = claude_cli_ready(session_id)
    if reason:
        raise ClaudeCliUnavailableError(reason)

    env = resolve_agent_env(session_id)
    workspace = tempfile.mkdtemp(prefix="friday-vision-")
    # Zero-padded so the files sort in capture order for the model too.
    image_names = [
        f"screen-{i + 1:02d}.{_image_ext(img)}" if len(images) > 1 else f"screen.{_image_ext(img)}"
        for i, img in enumerate(images)
    ]
    proc: asyncio.subprocess.Process | None = None
    try:
        # Blocking writes off the event loop (ASYNC230).
        for name, img in zip(image_names, images, strict=True):
            await asyncio.to_thread(Path(workspace, name).write_bytes, img)

        cmd = [
            settings.claude_cli_path,
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            # Read is all it needs — load the screenshot. Skip permissions so
            # the read isn't blocked in non-interactive mode (scratch dir only).
            "--allowedTools",
            "Read",
            "--dangerously-skip-permissions",
            "--append-system-prompt",
            system,
        ]
        if model:
            cmd += ["--model", model]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workspace,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_STREAM_READ_LIMIT,
            start_new_session=True,
        )
        assert proc.stdin is not None
        if len(image_names) == 1:
            read_hint = f"Read the image file {image_names[0]} in the current directory."
        else:
            read_hint = (
                f"Read ALL {len(image_names)} image files in the current directory, in this"
                f" order: {', '.join(image_names)}."
            )
        stdin_text = f"{read_hint} {prompt}"
        proc.stdin.write(stdin_text.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        assert proc.stderr is not None
        stderr_chunks: list[bytes] = []
        stderr_task = asyncio.create_task(_drain(proc.stderr, stderr_chunks))

        assert proc.stdout is not None
        result = ""
        try:
            async with asyncio.timeout(_TIMEOUT_S):
                async for raw in proc.stdout:
                    text = _result_text(raw.decode("utf-8", errors="replace"))
                    if text is not None:
                        result = text
        except TimeoutError:
            _kill(proc)
            stderr_task.cancel()
            raise RuntimeError(f"Claude CLI vision timed out after {_TIMEOUT_S}s") from None

        await proc.wait()
        await stderr_task
        if not result and proc.returncode != 0:
            detail = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()[:300]
            raise RuntimeError(f"claude CLI exited {proc.returncode}: {detail or 'no output'}")
        log.info("claude_cli.vision_done", session_id=session_id, model=model, chars=len(result))
        return result
    except asyncio.CancelledError:
        if proc is not None:
            _kill(proc)
        raise
    finally:
        import shutil

        shutil.rmtree(workspace, ignore_errors=True)


async def stream_claude_cli_text(
    *,
    prompt: str,
    system: str | None = None,
    model: str | None = None,
    effort: str | None = None,
    session_id: str | None = None,
) -> AsyncIterator[str]:
    """Stream a plain text completion from `claude -p` (no tools).

    `prompt` is the user turn (piped via stdin); `system`, when given, REPLACES
    Claude Code's default agent system prompt (via --system-prompt) so strict
    output-format instructions aren't fought by the built-in agent framing.
    Yields text as it arrives; falls back to the terminal result if the CLI
    didn't stream partials. Raises ClaudeCliUnavailableError if the
    CLI/credential is missing.
    """
    reason = claude_cli_ready(session_id)
    if reason:
        raise ClaudeCliUnavailableError(reason)

    cmd = [
        settings.claude_cli_path,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    if system:
        cmd += ["--system-prompt", system]
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    # No --allowedTools / --dangerously-skip-permissions: in non-interactive
    # print mode the CLI can't prompt for tool approval, so it just answers in
    # text — exactly what a solve wants.

    env = resolve_agent_env(session_id)
    # Empty cwd so the CLI doesn't pull in the repo's CLAUDE.md / files.
    workspace = tempfile.mkdtemp(prefix="friday-claude-")
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workspace,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_STREAM_READ_LIMIT,
            start_new_session=True,
        )
        assert proc.stdin is not None
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        assert proc.stderr is not None
        stderr_chunks: list[bytes] = []
        stderr_task = asyncio.create_task(_drain(proc.stderr, stderr_chunks))

        assert proc.stdout is not None
        streamed_any = False
        last_result = ""
        try:
            async with asyncio.timeout(_TIMEOUT_S):
                async for raw in proc.stdout:
                    line = raw.decode("utf-8", errors="replace")
                    text = _text_from_line(line)
                    if text:
                        streamed_any = True
                        yield text
                        continue
                    result = _result_text(line)
                    if result is not None:
                        last_result = result
        except TimeoutError:
            _kill(proc)
            stderr_task.cancel()
            raise RuntimeError(f"Claude CLI timed out after {_TIMEOUT_S}s") from None

        # No partial deltas came through (older CLI / buffering) — emit the
        # whole answer from the result event so the caller isn't left empty.
        if not streamed_any and last_result:
            yield last_result

        await proc.wait()
        await stderr_task
        if proc.returncode != 0 and not streamed_any and not last_result:
            detail = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()[:300]
            raise RuntimeError(f"claude CLI exited {proc.returncode}: {detail or 'no output'}")
    except asyncio.CancelledError:
        if proc is not None:
            _kill(proc)
        raise
    finally:
        import shutil

        shutil.rmtree(workspace, ignore_errors=True)
        log.info("claude_cli.done", session_id=session_id, model=model)
