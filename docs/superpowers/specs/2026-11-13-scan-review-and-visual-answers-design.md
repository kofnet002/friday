# Scan review and visual-aware answers — design

Date: 2026-11-13 · Status: draft for approval

## Intent

The user relies on Friday's answers to screen questions during assessments.
To trust them, they need to (1) see exactly what Friday read from the screen,
and (2) know that content Friday can't capture as text — charts, diagrams,
images — doesn't silently degrade answers.

Today Friday works in two steps: a vision model reads the scan into text
(`visible_context`, `questions`), then a text-only model answers. Passages are
remembered in Redis (`session:{id}:screen_references`, list of strings) but the
panel only ever sees a 120-char preview. Screenshots are discarded after the
read, so anything the read step left out of a chart or diagram is lost.

## Goals

1. **Passage viewer.** The user can open every remembered passage in full,
   remove one, or clear all — and the view survives a page reload.
2. **Better transcription of visuals.** Tables come out as Markdown tables;
   charts/diagrams have every value, axis, label, legend and caption written
   out.
3. **Visuals reach the answer.** When a page holds a chart, diagram or image
   that matters, the screenshots of that page are kept for the session and
   sent with the question to the answering model.
4. **Honest uncertainty.** If a question depends on a visual Friday couldn't
   read clearly, or the images couldn't be sent, the answer carries the
   existing `⚠️ Check:` line.

## Non-goals

- Keeping screenshots of text-only pages.
- Sending images with every answer.
- A history of every scan or of past screen questions.
- Image support in the coding-solve path (unchanged).

## Anti-goals (failure even if it "works")

- Screenshots that outlive the session, or survive **Clear** / **Remove** /
  starting a new watch.
- Text-only questions becoming noticeably slower or more expensive.
- The answer-while-scrolling speedup (speculative scan reads) regressing.
- A confident answer about a visual the model never actually saw.

## Approaches considered

- **A. Send screenshots only when the page has visuals (chosen).** The read
  step flags visual frames; only those are stored and attached. Text pages
  cost nothing extra.
- B. Always send scan screenshots with answers. Most thorough, but every
  answer gets slower/costlier and speculative answering suffers.
- C. Text only, better transcription. Cheapest; leaves the diagram gap open.

For the viewer: an expandable section inside the Screen panel backed by a new
backend read (chosen) over pushing full text in the WS event (lost on reload)
or a separate pop-up window (covers the assessment).

## Design

### 1. Extraction (read step)

- `ExtractedProblem` gains `visual_frames: list[int]` — 0-based indices of the
  submitted images that contain a chart, diagram, figure or image needed to
  answer a visible question or that belongs to reference material. Empty for
  text/table-only pages (tables are transcribed, not kept as images).
- Prompt rules (`apps/backend/app/prompts/coding_extraction.py` and its TS twin
  `packages/prompts/coding-extraction.ts`, bump version):
  - Tables in `visible_context` as Markdown tables, every cell verbatim.
  - Charts/diagrams: type, title, axes and units, every data point/label,
    legend, caption; mark unreadable values `[unreadable]` rather than guess.
  - Set `visual_frames` as above.
- Indices are validated against the number of images sent; out-of-range
  dropped.

### 2. Storage (Redis, session-scoped)

- References change from `list[str]` to a list of objects:
  `{id, text, image_keys: list[str], saved_at}`. `get_screen_references`
  accepts the old string format (wraps to objects with no images) so live
  sessions don't break.
- Kept images: `session:{id}:screen_image:{sha}` (raw JPEG bytes, as the
  desktop already sends them), same TTL as other screen state
  (`QD_STATE_TTL_S`, 2h). Content-hash keys dedupe repeats.
- Two image sets:
  - **Reference images** — attached to the reference object when the read
    step saves a passage with `visual_frames`.
  - **Current-screen images** — `session:{id}:screen_images_current`: the
    visual frames of the latest read. _(Call: speculative mid-scan reads
    also set them — storing is a Redis write, so it doesn't slow the read,
    and the first answer of a scan usually starts from a speculative read.)_
    A read with visual frames replaces the set; a **non-speculative** read
    with none clears it (a stale chart attached to a new page is worse than
    none); a speculative read with none leaves it alone, so a scan that
    scrolls past a chart keeps it until the final read decides.
- Caps: at most 4 images per reference, at most 8 images attached to one
  answer (current first, then newest references). Oldest references are
  already dropped by `merge_references`; their images are deleted with them.
- When `merge_references` replaces a shorter earlier read with a longer one,
  the new object's images replace the old one's. _(Call:)_ when a new read's
  text is already contained in a saved passage (so the text is ignored) but
  the new read has visual frames and the saved one has none or fewer, the new
  images are added to the saved passage (respecting the per-reference cap).
- Image keys may be shared by the current set and a passage; deleting from
  one set only deletes the bytes when no other set references them.
- `clear_screen_state` deletes all image keys too. Removing one reference
  deletes its images.

### 3. Answering

- _(Call:)_ the `/ws/answer` request gains `from_screen: bool`, set by the web
  client for questions read off the screen and for follow-ups in those
  threads (`sendScreenFollowUp`). Which images go along:
  - `from_screen` → current-screen images + reference images (capped).
  - Spoken question with screen context on → current-screen images only,
    and only when they exist. Text-only pages therefore add no cost to
    spoken answers; reference images are not attached to spoken questions.
  - Screen context off → no images.
- `stream_answer` / `_stream_anthropic` gain an `images` argument:
  - **API transport:** pass through `stream_claude_api(image=[...])`, which
    already supports image blocks.
  - **CLI (subscription) transport:** _(Call:)_ when images are attached,
    use a non-streaming path modelled on `run_claude_cli_vision` (images
    written to the temp workspace, extended to several) and emit the answer
    in one piece. Correct over fast; text-only answers keep streaming. This
    project's `.env` uses `CLAUDE_TRANSPORT=auto` with an API key set, so the
    API path is the one in daily use.
  - **Other providers / fallback:** answer text-only and add to the prompt
    that the page's visuals were not available, so the model emits
    `⚠️ Check:` for questions depending on them.
- Answer prompt adds: when screenshots are attached, treat them as the source
  of truth over the transcription for visual content; if a needed value is
  still unreadable, emit `⚠️ Check:`.

### 4. Viewer (web)

- Backend:
  - `GET /api/vision/screen-context?session_id=` →
    `{references: [{id, text, images: [image_id], saved_at}]}`.
  - `GET /api/vision/screen-image/{image_id}?session_id=` → JPEG.
  - `DELETE /api/vision/screen-reference/{id}?session_id=` → removes one
    passage and its images; recomposes `screen_context`.
  - Existing `DELETE /api/vision/screen-context` clears everything.
- `screen_reference_saved` event keeps its shape; the panel uses it as a
  signal to refetch.
- Screen panel (`coding-panel.tsx`): the "Saved passage as reference (N)"
  line gains **Show/Hide**. Expanded: numbered list, each passage full text
  in a scrollable box rendered as Markdown (tables as tables), its kept
  screenshots as clickable thumbnails (open full size), a **Remove** button
  per passage, and **Clear all**. Fetches on expand, on
  `screen_reference_saved`, and on mount if the session has references.

```
Saved passages (2)                              Hide · Clear all
 1. "The Industrial Revolution began in Britain…"     [Remove]
    full text, scrollable
 2. Figure 1: Monthly sales (bar chart) …             [Remove]
    | Month | Units | …          [thumb][thumb]
```

## Constraints

- Works on both Claude transports (API and subscription CLI).
- No screenshots on disk outside the existing CLI temp workspace, which is
  deleted after each call.
- Python and TS prompt files stay in sync.

## Left to the builder

- Markdown rendering library for the viewer (reuse whatever the answer panel
  uses).
- Exact cap numbers if testing shows token cost is too high.
- Thumbnail sizing and the full-size view (lightbox vs new window).
- Test layout, following existing `apps/backend/tests` and `*.test.js`
  patterns.
