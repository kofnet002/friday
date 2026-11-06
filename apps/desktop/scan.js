// Scroll-scan frame selection. While the user scrolls through a problem that
// doesn't fit on one screen, the screen is sampled a few times a second and
// we keep ONE frame per distinct scroll position: a frame is kept once the
// screen has settled (two consecutive samples nearly identical) and it differs
// meaningfully from every frame already kept. Continuous scrolling that never
// settles still yields a frame every MOTION_KEEP_MS, and finishing the scan
// takes one last frame so the final position is never lost.
//
// Frames are compared on a small grayscale "signature" (SIG_W × SIG_H) by
// SPREAD: the larger of (share of signature rows with changed cells) and
// (share of columns with changed cells). Scrolling shifts text across the
// whole scrolling pane — a side-by-side problem pane spans most ROWS (measured
// 72–90% on LeetCode / HackerRank / CoderPad / docs / ultrawide layouts, even
// for a 22px scroll), a statement-above-editor pane spans most COLUMNS. Things
// that change on their own — a caret, a ticking timer, the interviewer's video
// tile — stay in a small block (a 480×270 video tile: 19–31% of rows, less of
// the columns). Counting changed CELLS can't tell those apart: a video tile
// changes as many cells as a scroll of thin text does.

const sharp = require('sharp');

const SIG_W = 160;
const SIG_H = 100;
const SIG_CELLS = SIG_W * SIG_H;
// A cell counts as changed when its gray level moves by more than this. Thin
// monospace text on a dark editor averages to low per-cell contrast: at 24 a
// real CoderPad scroll changed only ~2.7% of cells (below NOVEL_FRACTION); at
// 12 every measured layout's scroll changes ≥7%, while a caret or ticking
// timer stays ~0.1%.
const PIXEL_DELTA = 12;
// A row/column counts as changed when at least this many of its cells changed.
const LINE_MIN_CELLS = 2;
// Spread ≥ this vs EVERY kept frame → new content worth keeping; below it vs
// the previous sample → the screen has settled (no scroll in between).
const SPREAD_THRESHOLD = 0.4;
// While the screen keeps moving without settling (impatient flings,
// continuous scrolling), keep a frame once motion has lasted this long — i.e.
// the 2nd consecutive moving sample at SCAN_SAMPLE_MS = 400. Kept frames are
// then at most one sample-interval of scrolling apart, so back-to-back flings
// with no pause leave no gap (800ms left 12% of a page unread). On an ordinary
// scroll-then-pause the 2nd sample is where the scroll landed, so it's still
// ~one frame per gesture.
const MOTION_KEEP_MS = 400;
// Backend cap is EXTRACTION_SCAN_MAX_IMAGES (10).
const MAX_SCAN_FRAMES = 10;

/** @param {Buffer} imageBuffer PNG/JPEG bytes @returns {Promise<Uint8Array>} */
async function computeSignature(imageBuffer) {
  const { data } = await sharp(imageBuffer)
    .resize(SIG_W, SIG_H, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, SIG_CELLS);
}

/**
 * max(share of rows, share of columns) with ≥ LINE_MIN_CELLS cells whose
 * gray level moved by > PIXEL_DELTA. 1 for incomparable signatures.
 */
function spread(a, b) {
  if (!a || !b || a.length !== SIG_CELLS || b.length !== SIG_CELLS) return 1;
  const rowCells = new Uint16Array(SIG_H);
  const colCells = new Uint16Array(SIG_W);
  for (let y = 0; y < SIG_H; y++) {
    for (let x = 0; x < SIG_W; x++) {
      const i = y * SIG_W + x;
      if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) {
        rowCells[y]++;
        colCells[x]++;
      }
    }
  }
  const rows = rowCells.filter((n) => n >= LINE_MIN_CELLS).length / SIG_H;
  const cols = colCells.filter((n) => n >= LINE_MIN_CELLS).length / SIG_W;
  return Math.max(rows, cols);
}

// ─── what gets sent ──────────────────────────────────────────────────────────
// Frames are captured at native resolution. When only part of the screen
// scrolled (a problem pane beside an editor, a browser window on an ultrawide
// monitor), each frame is cropped to that region so the text reaches the model
// at full size — downscaling a 3440px-wide screen to 1920 made text unreadable.
// The first frame also goes in whole, for the title / editor / signature.

const SEND_MAX_WIDTH = 1920;
const CROP_MAX_SIDE = 2400;
// A column/row is part of a changed region when more than this share of its
// cells changed across the scan — above a blinking caret (1–2 cells), below
// the sparsest real text (the ragged right edge of a paragraph).
const PANE_MIN_SCORE = 0.03;
// Bands separated by a gap of at most this many cells are one region
// (paragraph spacing, a short line); farther apart they're separate regions
// (the problem pane vs. a video tile in the far corner).
const PANE_MERGE_GAP = 8;
// Only crop when the region is clearly smaller than the screen.
const PANE_MAX_AREA = 0.7;
const PANE_PAD_CELLS = 2;

/** Bands of indices with score > PANE_MIN_SCORE, merged across small gaps;
 *  returns the band with the most total score. */
function heaviestBand(scores) {
  const bands = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] <= PANE_MIN_SCORE) continue;
    const last = bands[bands.length - 1];
    if (last && i - last.end - 1 <= PANE_MERGE_GAP) {
      last.end = i;
      last.mass += scores[i];
    } else {
      bands.push({ start: i, end: i, mass: scores[i] });
    }
  }
  return bands.reduce((best, b) => (!best || b.mass > best.mass ? b : best), null);
}

/** Grow a band over ANY changed cells within PANE_MERGE_GAP of its edges, so
 *  sparse edge rows/columns (a partial last line) are never cropped off. */
function growBand(scores, band) {
  let { start, end } = band;
  for (let i = start - 1; i >= 0 && start - i <= PANE_MERGE_GAP; i--) {
    if (scores[i] > 0) start = i;
  }
  for (let i = end + 1; i < scores.length && i - end <= PANE_MERGE_GAP; i++) {
    if (scores[i] > 0) end = i;
  }
  return start === band.start && end === band.end ? band : growBand(scores, { start, end });
}

/**
 * The region that scrolled during the scan, as fractions of the screen
 * {left, top, width, height}, or null when it's (nearly) the whole screen or
 * nothing scrolled. It always contains every changed cell of the winning
 * region: the heaviest band of changed columns, then of rows within it — so a
 * video tile in a far corner doesn't widen the crop, but no text is cut.
 */
function paneBox(signatures) {
  if (signatures.length < 2) return null;
  const changed = new Uint8Array(SIG_CELLS);
  for (let k = 1; k < signatures.length; k++) {
    for (let i = 0; i < SIG_CELLS; i++) {
      if (Math.abs(signatures[k][i] - signatures[k - 1][i]) > PIXEL_DELTA) changed[i] = 1;
    }
  }
  const colScore = Array.from({ length: SIG_W }, (_, x) => {
    let n = 0;
    for (let y = 0; y < SIG_H; y++) n += changed[y * SIG_W + x];
    return n / SIG_H;
  });
  const heaviestCols = heaviestBand(colScore);
  if (!heaviestCols) return null;
  const cols = growBand(colScore, heaviestCols);
  const rowScore = Array.from({ length: SIG_H }, (_, y) => {
    let n = 0;
    for (let x = cols.start; x <= cols.end; x++) n += changed[y * SIG_W + x];
    return n / (cols.end - cols.start + 1);
  });
  const heaviestRows = heaviestBand(rowScore);
  if (!heaviestRows) return null;
  const rows = growBand(rowScore, heaviestRows);
  const x0 = Math.max(0, cols.start - PANE_PAD_CELLS);
  const x1 = Math.min(SIG_W, cols.end + 1 + PANE_PAD_CELLS);
  const y0 = Math.max(0, rows.start - PANE_PAD_CELLS);
  const y1 = Math.min(SIG_H, rows.end + 1 + PANE_PAD_CELLS);
  const box = {
    left: x0 / SIG_W,
    top: y0 / SIG_H,
    width: (x1 - x0) / SIG_W,
    height: (y1 - y0) / SIG_H,
  };
  return box.width * box.height > PANE_MAX_AREA ? null : box;
}

/**
 * JPEG frames (native resolution) → base64 images for /api/vision/extract.
 * @param {Buffer[]} frames
 * @param {{left:number, top:number, width:number, height:number} | null} box
 * @returns {Promise<{images: string[], cropped: boolean}>}
 */
async function buildScanImages(frames, box) {
  const whole = (buf) =>
    sharp(buf)
      .resize({ width: SEND_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  if (!box) {
    const images = await Promise.all(frames.map(whole));
    return { images: images.map((b) => b.toString('base64')), cropped: false };
  }
  const crop = async (buf) => {
    const { width, height } = await sharp(buf).metadata();
    const left = Math.floor(box.left * width);
    const top = Math.floor(box.top * height);
    return sharp(buf)
      .extract({
        left,
        top,
        width: Math.min(width - left, Math.ceil(box.width * width)),
        height: Math.min(height - top, Math.ceil(box.height * height)),
      })
      .resize({
        width: CROP_MAX_SIDE,
        height: CROP_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  };
  const images = [await whole(frames[0]), ...(await Promise.all(frames.map(crop)))];
  return { images: images.map((b) => b.toString('base64')), cropped: true };
}

/**
 * Decides which samples of a scan to keep. Pure: feed it signatures and
 * timestamps; it never touches the screen.
 *
 * consider() returns one of:
 *  - 'kept'      keep this frame (caller stores the image)
 *  - 'moving'    new content, but the screen is still in motion
 *  - 'duplicate' nothing new vs the frames already kept
 *  - 'full'      the frame cap was already reached
 */
class ScanSelector {
  constructor({ maxFrames = MAX_SCAN_FRAMES, motionKeepMs = MOTION_KEEP_MS } = {}) {
    this.maxFrames = maxFrames;
    this.motionKeepMs = motionKeepMs;
    this.kept = [];
    this.prev = null;
    // When the current run of unsettled, new-content samples began.
    this.movingSince = null;
  }

  get count() {
    return this.kept.length;
  }

  get isFull() {
    return this.kept.length >= this.maxFrames;
  }

  consider(signature, now) {
    if (this.isFull) return 'full';
    const prev = this.prev;
    this.prev = signature;
    if (this.kept.length === 0) return this._keep(signature);

    if (!this._isNovel(signature)) {
      this.movingSince = null;
      return 'duplicate';
    }
    const settled = prev !== null && spread(signature, prev) < SPREAD_THRESHOLD;
    if (settled) return this._keep(signature);
    if (this.movingSince === null) this.movingSince = now;
    if (now - this.movingSince >= this.motionKeepMs) return this._keep(signature);
    return 'moving';
  }

  /** The user just finished: keep the final screen if it's new, settled or
   *  not — it's where they stopped, so it's the last part of the problem. */
  considerFinal(signature, now) {
    if (this.isFull) return 'full';
    if (this.kept.length && !this._isNovel(signature)) return 'duplicate';
    return this._keep(signature);
  }

  _isNovel(signature) {
    return this.kept.every((k) => spread(signature, k) >= SPREAD_THRESHOLD);
  }

  _keep(signature) {
    this.kept.push(signature);
    // Any motion after this frame is a fresh run, timed from its first sample.
    this.movingSince = null;
    return 'kept';
  }
}

module.exports = {
  ScanSelector,
  paneBox,
  buildScanImages,
  computeSignature,
  spread,
  MAX_SCAN_FRAMES,
  SPREAD_THRESHOLD,
  MOTION_KEEP_MS,
};
