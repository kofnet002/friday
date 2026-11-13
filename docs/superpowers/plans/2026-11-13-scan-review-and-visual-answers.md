# Scan Review and Visual-Aware Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user read every remembered passage in full (and remove one), transcribe tables/charts properly, and send the screenshots of pages with visuals to the answering model.

**Architecture:** The vision read step flags which scan frames hold visuals (`visual_frames`). The backend keeps only those frames in Redis (session-scoped, 2h TTL) as "current-screen" images and/or attached to a remembered passage (passages become objects with ids). `/ws/answer` attaches them to Claude answers based on a new `from_screen` flag. The Screen panel gets an expandable passage viewer backed by new REST endpoints.

**Tech Stack:** FastAPI + redis.asyncio (decode_responses=True → images stored as base64 strings), Anthropic SDK / Claude CLI, Next.js + React, react-markdown + remark-gfm (already used via `@/lib/markdown`), pytest, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-13-scan-review-and-visual-answers-design.md`

## Global Constraints

- Screenshots kept only for frames listed in `visual_frames`; text-only pages store no images.
- Image TTL = `QD_STATE_TTL_S` (2h). Deleted by Clear (`DELETE /api/vision/screen-context`), by removing their passage, and by starting a new watch (already calls Clear).
- Caps: max 4 images per reference; max 8 images per answer (current first, then newest references).
- `MAX_REFERENCE_CHARS = 12_000` stays.
- Python prompt `apps/backend/app/prompts/coding_extraction.py` and TS twin `packages/prompts/coding-extraction.ts` stay in sync; bump `CODING_EXTRACTION_VERSION` to `"1.7.0"` in both.
- Old Redis reference format (`list[str]`) must still load.
- Text-only answers keep streaming and add no image cost.
- Branch: `feat/screen-assist-polish`; never commit to `develop`; no Co-Authored-By trailer.

## Review Focus

1. **Speculative read with no visuals after one with visuals** — current images must survive; only a final (non-speculative) read with none clears them. Test in Task 3.
2. **Removing a passage whose image is also in the current set** — the image bytes must stay until no set references them. Test in Task 2.
3. **Legacy string references in Redis** mid-session after deploy — must load as objects with no images, and the viewer must list them. Test in Task 2.
4. **Provider fallback away from Claude** (or no images possible) — the answer must be told visuals were unavailable so it emits `⚠️ Check:`. Test in Task 5.
5. **`visual_frames` indices out of range / duplicated / single-frame request** — dropped/deduped; single-frame `image_base64` uses index 0. Test in Task 1 and Task 3.

---

### Task 1: `visual_frames` in extraction + transcription rules

**Files:**

- Modify: `apps/backend/app/models/coding.py` (`ExtractedProblem`)
- Modify: `apps/backend/app/prompts/coding_extraction.py`, `packages/prompts/coding-extraction.ts`
- Test: `apps/backend/tests/test_screen_context.py`

**Interfaces:**

- Produces: `ExtractedProblem.visual_frames: list[int]` (default `[]`); `ExtractedProblem.valid_visual_frames(frame_count: int) -> list[int]` (sorted, deduped, `0 <= i < frame_count`).

- [ ] **Step 1: Write failing tests**

```python
def test_visual_frames_default_empty():
    assert ExtractedProblem(is_coding_problem=False, confidence=0.9).visual_frames == []

def test_valid_visual_frames_drops_out_of_range_and_duplicates():
    p = ExtractedProblem(is_coding_problem=False, confidence=0.9, visual_frames=[3, 0, 0, -1, 7])
    assert p.valid_visual_frames(4) == [0, 3]

def test_extraction_prompt_asks_for_tables_charts_and_visual_frames():
    from app.prompts.coding_extraction import CODING_EXTRACTION_SYSTEM_PROMPT as P, CODING_EXTRACTION_VERSION
    assert '"visual_frames": number[]' in P
    assert "Markdown table" in P
    assert "[unreadable]" in P
    assert CODING_EXTRACTION_VERSION == "1.7.0"
```

- [ ] **Step 2: Run** `cd apps/backend && uv run pytest tests/test_screen_context.py -v` — Expected: the 3 new tests FAIL.
- [ ] **Step 3: Implement.** Add the field + method. In both prompt files add `"visual_frames": number[]` to the schema and these rules (exact wording free, these facts fixed): tables in `visible_context` as Markdown tables with every cell verbatim; charts/diagrams written out with type, title, axes and units, every data point/label, legend and caption; unreadable values written `[unreadable]`, never guessed; `visual_frames` = 0-based indices of the screenshots containing a chart, diagram, figure or image needed to answer a visible question or belonging to reference material; empty for text- or table-only pages. Bump version to `1.7.0` in both.
- [ ] **Step 4: Run** the same command plus `pnpm --filter @friday/prompts typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: flag frames with visuals and transcribe tables and charts in full`

### Task 2: Passage objects and screen image storage

**Files:**

- Create: `apps/backend/app/services/screen_memory.py` (pure logic)
- Modify: `apps/backend/app/api/vision.py` (remove `merge_references`, `compose_screen_context`, `reference_saved_event`, `_norm`, `MAX_REFERENCE_CHARS`, `REFERENCE_HEADER`; import them from `screen_memory`)
- Modify: `apps/backend/app/redis_client.py`
- Test: `apps/backend/tests/test_screen_context.py` (update existing reference tests to objects), create `apps/backend/tests/test_screen_memory.py`

**Interfaces:**

- Produces (`screen_memory.py`):
  - `@dataclass ScreenReference: id: str; text: str; image_keys: list[str]; saved_at: float` with `to_json() -> dict` / `from_json(obj: str | dict) -> ScreenReference` (a bare `str` → new id, `image_keys=[]`, `saved_at=0.0`).
  - `MAX_IMAGES_PER_REFERENCE = 4`, `MAX_IMAGES_PER_ANSWER = 8`, `MAX_REFERENCE_CHARS = 12_000`.
  - `merge_references(refs: list[ScreenReference], new_text: str, image_keys: list[str]) -> list[ScreenReference]` — same text rules as today; plus: if new text is contained in a saved one and that one has fewer images, the saved one's `image_keys` become the new keys (capped at 4); a longer read that replaces shorter ones takes the new keys.
  - `compose_screen_context(current: str, refs: list[ScreenReference]) -> str` (same output as today).
  - `reference_saved_event(refs, saved_text) -> dict` (unchanged shape).
  - `answer_image_keys(current: list[str], refs: list[ScreenReference], *, include_references: bool) -> list[str]` — current first, then references newest-first, deduped, capped at 8.
  - `image_key(data_b64: str) -> str` — first 32 hex chars of sha256 of the base64 text.
- Produces (`redis_client.py`):
  - `get_screen_references(sid) -> list[ScreenReference]` (accepts legacy strings), `set_screen_references(sid, refs: list[ScreenReference])`.
  - `put_screen_images(sid, images_b64: list[str]) -> list[str]` (keys; key `session:{sid}:screen_image:{key}`, TTL 2h).
  - `get_screen_image(sid, key) -> str | None`.
  - `get_current_screen_images(sid) -> list[str]`, `set_current_screen_images(sid, keys: list[str])` (key `session:{sid}:screen_images_current`, JSON list; empty list deletes it).
  - `prune_screen_images(sid, candidate_keys: list[str]) -> None` — deletes bytes for candidates not referenced by the current set or any reference.
  - `clear_screen_state(sid)` also deletes `screen_images_current` and every `session:{sid}:screen_image:*` key (use `scan_iter`).

- [ ] **Step 1: Write failing tests** in `test_screen_memory.py`:

```python
def test_legacy_string_loads_as_reference_without_images():
    ref = ScreenReference.from_json("Passage A")
    assert ref.text == "Passage A" and ref.image_keys == [] and ref.id

def test_rescan_that_adds_a_figure_attaches_images_to_saved_passage():
    refs = merge_references([], "Figure 1 sales", [])
    refs = merge_references(refs, "Figure 1 sales", ["k1"])
    assert len(refs) == 1 and refs[0].image_keys == ["k1"]

def test_longer_read_replaces_shorter_and_takes_its_images():
    refs = merge_references([], "Case study: the team", ["old"])
    refs = merge_references(refs, "Case study: the team migrated.", ["new"])
    assert [r.image_keys for r in refs] == [["new"]]

def test_reference_images_capped_at_four():
    refs = merge_references([], "P", ["a", "b", "c", "d", "e"])
    assert refs[0].image_keys == ["a", "b", "c", "d"]

def test_answer_images_current_first_then_newest_refs_capped_at_eight():
    refs = [ScreenReference("1", "x", ["r1", "r2"], 1.0), ScreenReference("2", "y", ["r3"], 2.0)]
    keys = answer_image_keys(["c1", "r3"], refs, include_references=True)
    assert keys == ["c1", "r3", "r1", "r2"]
    assert answer_image_keys(["c1"], refs, include_references=False) == ["c1"]
    many = [ScreenReference(str(i), str(i), [f"k{i}a", f"k{i}b"], float(i)) for i in range(6)]
    assert len(answer_image_keys([], many, include_references=True)) == 8
```

And a prune test with an in-memory fake Redis (dict-backed `get/set/delete/scan_iter`, monkeypatched over `rc.get_redis`): put image `k`, set current `[k]`, save a reference with `[k]`, then remove the reference and `prune_screen_images(sid, ["k"])` → `get_screen_image(sid, "k")` is still not None; clear current, prune again → None. Update the existing `merge_references`/`compose_screen_context` tests in `test_screen_context.py` to build/compare `ScreenReference` texts.

- [ ] **Step 2: Run** `uv run pytest tests/test_screen_memory.py tests/test_screen_context.py -v` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `screen_memory.py` and the Redis helpers above; point `vision.py` at them.
- [ ] **Step 4: Run** `uv run pytest -q && uv run mypy app` — Expected: all PASS, mypy clean.
- [ ] **Step 5: Commit** `feat: store passages as objects and keep screen images per session`

### Task 3: Keep visual frames during extraction

**Files:**

- Modify: `apps/backend/app/api/vision.py` (`extract`)
- Test: `apps/backend/tests/test_vision_scan.py`

**Interfaces:**

- Consumes: Task 1 `valid_visual_frames`, Task 2 storage helpers and `merge_references`.
- Produces: `async def update_screen_images(sid: str, encoded_images: list[str], problem: ExtractedProblem, *, speculative: bool) -> list[str]` in `vision.py` — returns the stored visual keys for this read.

Rules (from spec): visual frames present → `put_screen_images` + `set_current_screen_images(keys)`; none and not speculative → `set_current_screen_images([])` then prune the old keys; none and speculative → leave current. If the read is saved as a reference, pass these keys to `merge_references`; after saving, prune keys of any reference that was dropped/replaced. Single-frame requests use `[request.image_base64]` as `encoded_images`. Strip any `data:` prefix before storing (as `decode_images` does).

- [ ] **Step 1: Write failing tests** (monkeypatch `extract_problem` to return fixed problems, fake Redis from Task 2, `session_bus.has_subscriber` → True):
  - `test_visual_frames_are_kept_as_current_images` — scan of 3 images, `visual_frames=[1]` → current keys == `[image_key(images[1])]`.
  - `test_speculative_text_read_keeps_current_images` — after the above, speculative read with `visual_frames=[]` → current unchanged.
  - `test_final_text_read_clears_current_images` — non-speculative read with `[]` → current empty and the image bytes are gone.
  - `test_reference_with_visuals_keeps_its_images` — `is_reference_material=True`, `visual_frames=[0]` → stored reference has 1 image key.
  - `test_text_only_page_stores_no_images` — no `screen_image:*` keys after a read with `[]`.
- [ ] **Step 2: Run** `uv run pytest tests/test_vision_scan.py -v` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** `update_screen_images` and call it in `extract` after extraction, before references are merged.
- [ ] **Step 4: Run** `uv run pytest -q` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: keep screenshots of pages with charts or diagrams for the session`

### Task 4: Passage viewer endpoints

**Files:**

- Modify: `apps/backend/app/api/vision.py`
- Test: `apps/backend/tests/test_screen_context.py`

**Interfaces:**

- Produces:
  - `GET /api/vision/screen-context?session_id=` → `{"references": [{"id", "text", "images": [key], "saved_at"}]}` (oldest first).
  - `GET /api/vision/screen-image/{key}?session_id=` → `Response(content=b64decode(...), media_type=image_media_type(bytes))`; 404 if missing.
  - `DELETE /api/vision/screen-reference/{ref_id}?session_id=` → removes it, prunes its images, recomposes `screen_context` from the current screen text minus that passage (store the current-screen text separately as `session:{sid}:screen_current_text` in `extract` so it can be recomposed; add `get/set_screen_current_text` to `redis_client`), returns `{"ok": true, "count": n}`; 404 for unknown id.

- [ ] **Step 1: Write failing tests** with `TestClient` + fake Redis: list returns legacy + object refs; image endpoint returns JPEG bytes and 404 for unknown; delete removes the passage, its image, and its text from `get_screen_context`, while another passage's text stays.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `uv run pytest -q && uv run mypy app` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: list, view and remove remembered passages`

### Task 5: Attach images to answers

**Files:**

- Modify: `apps/backend/app/prompts/answer_generation.py` (+ TS twin `packages/prompts/answer-generation.ts`)
- Modify: `apps/backend/app/services/answer.py`, `apps/backend/app/api/ws_answer.py`
- Modify: `packages/shared-types/src/index.ts` (`from_screen?: boolean` on the `question` client message; doc comment: "Question read off the screen or a follow-up in such a thread.")
- Test: `apps/backend/tests/test_answer_prompt.py`, `apps/backend/tests/test_ws_answer.py`

**Interfaces:**

- Produces:
  - `AnswerContext.screen_visuals: Literal["attached", "unavailable"] | None = None`. Rendered right after `<visible_screen_context>`: `attached` → "Screenshots of the on-screen charts/diagrams are attached; treat them as the source of truth over the transcription for visual content. If a value you need is still unreadable, add `⚠️ Check:`."; `unavailable` → "The page has charts/diagrams that are NOT available to you; for any question that depends on them, add `⚠️ Check: visual not available`."
  - `stream_answer(..., images: list[bytes] | None = None)`. Only the `claude` provider uses images; for every other provider (and for fallbacks) the context is `dataclasses.replace(context, screen_visuals="unavailable")` when images were given.
  - `_stream_anthropic(..., images: list[bytes] | None = None)`: API → `stream_claude_api(image=[(b, image_media_type(b)) ...])`; CLI → Task 6's `run_claude_cli_with_images`, yielding its whole result once.
  - `ws_answer`: `from_screen = bool(request.get("from_screen"))`; when screen context is in use, `keys = answer_image_keys(current, refs, include_references=from_screen)`, load bytes, drop missing; if any, `screen_visuals="attached"` and pass `images`.

- [ ] **Step 1: Write failing tests:**
  - prompt: context with `screen_visuals="attached"` contains "source of truth"; `"unavailable"` contains "⚠️ Check: visual not available"; `None` contains neither.
  - ws: fake `stream_answer` captures kwargs. Spoken question (no `from_screen`), current images `[k1]`, reference images `[k2]` → `images` has 1 item. `from_screen=True` → 2 items. `session_context.screen_context == ""` → `images` is None. No stored images → `images` is None and `screen_visuals` None.
  - answer: `stream_answer` with provider `"gemini"` and images → the system prompt seen by the fake Gemini stream contains "visual not available".
- [ ] **Step 2: Run** `uv run pytest tests/test_answer_prompt.py tests/test_ws_answer.py -v` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `uv run pytest -q && uv run mypy app && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: send screenshots of charts and diagrams with screen answers`

### Task 6: CLI transport with several images

**Files:**

- Modify: `apps/backend/app/services/claude_cli.py`
- Test: `apps/backend/tests/test_claude_api.py` (or a new `test_claude_cli.py`)

**Interfaces:**

- Produces: `run_claude_cli_with_images(*, images: list[bytes], prompt: str, system: str, model: str | None, session_id: str | None) -> str` — writes `screen-1.jpg … screen-N.<ext>`, prompt prefix `Read the image files screen-1.jpg, …, screen-N.jpg in the current directory. `. `run_claude_cli_vision` becomes a thin wrapper calling it with `[image_bytes]` (behavior unchanged).

- [ ] **Step 1: Write failing test:** monkeypatch `asyncio.create_subprocess_exec` with a fake process capturing cwd + stdin and emitting one `result` stream-json line; assert both files exist in cwd at call time, stdin names both, the return value is the result text, and the workspace is deleted afterwards.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `uv run pytest -q` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: let subscription Claude answers read several screenshots`

### Task 7: Web — send `from_screen`

**Files:**

- Modify: `apps/web/app/session/session-client.tsx` (both `ws.send({type:'question', ...})` sites, ~L1491 and ~L1576)

**Interfaces:**

- Consumes: Task 5 `from_screen` field.
- Set `from_screen: screenThreadIdsRef.current.has(threadId)` (follow-up site: `current.threadId`).

- [ ] **Step 1:** Add the field at both sites.
- [ ] **Step 2: Run** `pnpm --filter @friday/web typecheck` — Expected: PASS.
- [ ] **Step 3: Commit** `feat: mark screen questions on answer requests`

### Task 8: Web — saved passages viewer

**Files:**

- Create: `apps/web/app/session/saved-passages.tsx`
- Create: `apps/web/lib/saved-passages.js` + `apps/web/lib/saved-passages.test.js`
- Modify: `apps/web/lib/session-context.ts`, `apps/web/app/session/coding-panel.tsx` (replace the one-line saved-passage block, L389-411), `apps/web/app/session/session-client.tsx`, `apps/web/package.json` (`test` script runs all `lib/*.test.js`)

**Interfaces:**

- Produces (`session-context.ts`): `type SavedPassage = { id: string; text: string; images: string[]; saved_at: number }`; `fetchSavedPassages(sid): Promise<SavedPassage[] | null>`; `removeSavedPassage(sid, id): Promise<boolean>`; `screenImageUrl(sid, key): string`.
- Produces (`saved-passages.js`): `passagePreview(text, max = 120): string` (whitespace-collapsed, `…` when cut — same rule as the backend).
- `<SavedPassages sessionId refreshKey onClearAll />`: collapsed row `Saved passages (N): “preview of newest”` with **Show** and **Clear all**; expanded: numbered list, each passage `<Markdown text>` in a `max-h-64 overflow-y-auto` box, thumbnails (`h-16`, click opens the full image in a new window via `window.open(screenImageUrl(...))`), **Remove** (`aria-label="Remove passage N"`). Fetches on mount, when `refreshKey` changes, and after Remove. Renders nothing when the list is empty.
- `session-client.tsx`: replace `savedReference` state with `passagesRefreshKey: number`, bumped on `screen_reference_saved` and after Clear; `coding-panel.tsx` props `savedReference` → `passagesRefreshKey`, `sessionId`.

- [ ] **Step 1: Write failing tests** in `saved-passages.test.js`: `passagePreview('a   b\nc') === 'a b c'`; 200-char input → length 120 ending in `…`.
- [ ] **Step 2: Run** `pnpm --filter @friday/web test` — Expected: FAIL.
- [ ] **Step 3: Implement** helpers, component, wiring.
- [ ] **Step 4: Run** `pnpm --filter @friday/web test && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Smoke test** with the `run-desktop` skill against `.claude/skills/run-desktop/fixtures/assessment-scan.html`: scan, open **Show**, confirm full passage text and that Remove/Clear all work. Screenshot the expanded viewer.
- [ ] **Step 6: Commit** `feat: show saved passages in full with per-passage remove`
