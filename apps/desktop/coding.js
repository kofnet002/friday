// Coding-mode screen capture. Samples the primary display at 1Hz, computes a
// cheap perceptual hash, and only ships the frame to the backend when the hash
// has shifted meaningfully AND a min interval has elapsed. All coordinate and
// threshold constants mirror CODING_EXTRACTION_CONFIG from
// packages/prompts/coding-extraction.ts.

const { desktopCapturer, nativeImage, screen } = require('electron');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { ScanSelector, computeSignature, paneBox, buildScanImages } = require('./scan');

// Mirrors packages/prompts/coding-extraction.ts CODING_EXTRACTION_CONFIG.
const SAMPLE_INTERVAL_MS = 1000;
const FRAME_CHANGE_THRESHOLD = 0.15;
const MIN_API_INTERVAL_MS = 2000;
const MAX_WIDTH_PX = 1920;
const JPEG_QUALITY = 80;

// 8x8 average hash -> 64 bits. Hamming distance threshold in bits.
const HASH_BITS = 64;
const CHANGE_BIT_THRESHOLD = Math.ceil(HASH_BITS * FRAME_CHANGE_THRESHOLD); // ~10

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

// Scroll scan: sample faster than the watcher so a settled scroll position is
// caught within ~1s; give up after SCAN_MAX_MS if the user never finishes.
const SCAN_SAMPLE_MS = 400;
const SCAN_MAX_MS = 90_000;
// Scan frames are captured at the display's native resolution (capped) so a
// cropped problem pane keeps full-size text; the change signature is computed
// from a small copy so sampling stays cheap.
const SCAN_CAPTURE_MAX_PX = 3840;
const SCAN_SIGNATURE_WIDTH = 480;
const SCAN_FRAME_JPEG_QUALITY = 92;
// A multi-image vision call can take a while (and the backend may retry or
// fall back to another provider), but must never leave the scan stuck.
const SCAN_REQUEST_TIMEOUT_MS = 180_000;

async function computeAverageHash(buffer) {
  // 8x8 grayscale, then threshold against the mean -> 64 bits.
  const { data } = await sharp(buffer)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += data[i];
  const mean = sum / 64;
  const hash = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (data[i] >= mean) hash[i >> 3] |= 1 << (i & 7);
  }
  return hash;
}

function hammingDistance(a, b) {
  if (!a || !b) return HASH_BITS;
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    let x = (a[i] ^ b[i]) & 0xff;
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

function nativeCaptureSize() {
  const { size, scaleFactor } = screen.getPrimaryDisplay();
  const width = Math.round(size.width * scaleFactor);
  const height = Math.round(size.height * scaleFactor);
  const scale = Math.min(1, SCAN_CAPTURE_MAX_PX / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function captureScreen(thumbnailSize = { width: MAX_WIDTH_PX, height: MAX_WIDTH_PX }) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  if (!sources.length) return null;
  // Primary display is the first entry.
  const primary = sources[0];
  const img = primary.thumbnail;
  if (img.isEmpty()) return null;
  return img;
}

async function scanSignature(img) {
  const small = img.resize({ width: SCAN_SIGNATURE_WIDTH, quality: 'good' });
  return computeSignature(small.toPNG());
}

async function toJpegBase64(image) {
  // Electron NativeImage -> PNG buffer (lossless source) -> sharp jpeg.
  const png = image.toPNG();
  const out = await pngToJpegBase64(png);
  return { ...out, pngBytes: png.length };
}

async function pngToJpegBase64(png) {
  const jpeg = await sharp(png)
    .resize({ width: MAX_WIDTH_PX, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
    .toBuffer();
  return { base64: jpeg.toString('base64'), bytes: jpeg.length };
}

class CodingCapture extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.sessionId = null;
    this.timer = null;
    this.inflightId = 0;
    this.lastHash = null;
    this.lastExtractAt = 0;
    // Provider used for the vision/OCR step. Mirrors the Coding panel's
    // selection in the renderer; left null until the renderer pushes one,
    // in which case the backend resolves it from session.default_provider.
    this.provider = null;
    // Active scroll scan, or null. While set, the background watcher pauses.
    this.scan = null;
    this.scanSeq = 0;
    this.scanRequestTimeoutMs = SCAN_REQUEST_TIMEOUT_MS;
  }

  isActive() {
    return this.active;
  }

  setProvider(provider) {
    if (
      provider === 'gemini' ||
      provider === 'openai' ||
      provider === 'deepseek' ||
      provider === 'claude'
    ) {
      this.provider = provider;
    } else {
      this.provider = null;
    }
  }

  start(sessionId) {
    if (this.active) return { ok: true };
    if (!sessionId) return { ok: false, error: 'missing session_id' };
    this.active = true;
    this.sessionId = sessionId;
    this.lastHash = null;
    this.lastExtractAt = 0;
    this._schedule(0);
    this.emit('log', `coding capture started (session ${sessionId.slice(0, 8)})`);
    return { ok: true };
  }

  stop() {
    if (!this.active) return;
    this._abortScan('coding mode stopped');
    this.active = false;
    this.sessionId = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Any in-flight extract call will see active=false and discard its result.
    this.inflightId++;
    this.lastHash = null;
    this.emit('log', 'coding capture stopped');
  }

  async forceExtract() {
    if (!this.active || !this.sessionId) {
      return { ok: false, error: 'coding mode not active' };
    }
    if (this.scan) return { ok: false, error: 'a scan is in progress' };
    await this._tick({ force: true });
    return { ok: true };
  }

  _schedule(delay = SAMPLE_INTERVAL_MS) {
    if (!this.active || this.scan) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick({ force: false }).catch(() => {}), delay);
  }

  async _tick({ force }) {
    if (!this.active || this.scan) return;
    try {
      const img = await captureScreen();
      if (!img) {
        this._schedule();
        return;
      }
      const png = img.toPNG();
      const hash = await computeAverageHash(png);
      const changedBits = hammingDistance(this.lastHash, hash);
      const now = Date.now();
      const sinceLastApi = now - this.lastExtractAt;

      const changed = this.lastHash === null || changedBits > CHANGE_BIT_THRESHOLD;
      const intervalOk = sinceLastApi >= MIN_API_INTERVAL_MS;

      this.emit('frame_processed', {
        changed_bits: changedBits,
        changed,
        interval_ms: sinceLastApi,
      });

      if (!force && (!changed || !intervalOk)) {
        this._schedule();
        return;
      }

      // A scan may have started while this frame was being captured.
      if (this.scan || !this.active) return;
      const { base64, bytes } = await toJpegBase64(img);
      if (this.scan || !this.active) return;
      this.lastHash = hash;
      this.lastExtractAt = now;
      await this._sendExtract(base64, bytes, force);
    } catch (err) {
      this.emit('error', err && err.message ? err.message : String(err));
    } finally {
      this._schedule();
    }
  }

  // ─── scroll scan ──────────────────────────────────────────────────────────
  // Start → the user scrolls through the problem → finish (toggle again, frame
  // cap, or timeout). All kept frames go to the backend in ONE request and are
  // merged into a single problem.

  isScanning() {
    return Boolean(this.scan && this.scan.phase === 'scanning');
  }

  scanStatus() {
    if (!this.scan) return { state: 'idle', frames: 0 };
    return { state: this.scan.phase, frames: this.scan.frames.length };
  }

  toggleScan() {
    if (!this.active || !this.sessionId) {
      return { ok: false, error: 'coding mode not active' };
    }
    if (!this.scan) return this.startScan();
    if (this.scan.phase === 'scanning') {
      void this.finishScan();
      return { ok: true, state: 'processing' };
    }
    return { ok: false, error: 'scan is still being processed' };
  }

  startScan() {
    if (!this.active || !this.sessionId) {
      return { ok: false, error: 'coding mode not active' };
    }
    if (this.scan) return { ok: false, error: 'a scan is already running' };
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Drop any in-flight watcher result so it can't land mid-scan.
    this.inflightId++;
    this.scan = {
      id: ++this.scanSeq,
      sessionId: this.sessionId,
      phase: 'scanning',
      selector: new ScanSelector(),
      frames: [],
      startedAt: Date.now(),
      timer: null,
    };
    this._emitScan();
    this._scheduleScan(0);
    this.emit('log', 'scan started');
    return { ok: true, state: 'scanning' };
  }

  async finishScan() {
    const scan = this.scan;
    if (!scan || scan.phase !== 'scanning') return { ok: false, error: 'no scan running' };
    scan.phase = 'processing';
    if (scan.timer) clearTimeout(scan.timer);
    scan.timer = null;
    this._emitScan();
    // A sample may still be mid-capture; let it land before reading frames.
    let result;
    try {
      result = await this._processScan(scan);
    } catch (err) {
      result = {
        ok: false,
        error: `scan processing failed: ${err && err.message ? err.message : err}`,
      };
    }
    // No-op if the scan was already cancelled (stop / new session).
    this._endScan(scan, result.ok ? null : result.error);
    return result;
  }

  async _processScan(scan) {
    await scan.pendingTick;
    // Where the user stopped is the end of the problem — keep it even if the
    // screen hadn't settled yet (they pressed Finish right after scrolling).
    await this._captureFinal(scan);
    if (this.scan !== scan) return { ok: false, error: 'scan cancelled' };
    this._emitScan();
    if (!scan.frames.length) {
      return { ok: false, error: 'no frames captured — is screen recording allowed?' };
    }
    // Crop to the region that scrolled when it's clearly smaller than the
    // screen (problem pane, a window on an ultrawide monitor).
    const box = paneBox(scan.selector.kept);
    const { images, cropped } = await buildScanImages(scan.frames, box);
    if (this.scan !== scan) return { ok: false, error: 'scan cancelled' };
    const bytes = images.reduce((n, b64) => n + Math.round((b64.length * 3) / 4), 0);
    this.emit('log', `scan finished: ${scan.frames.length} frame(s), cropped=${cropped}`);
    return this._postExtract({ images_base64: images, scan_cropped: cropped }, bytes, { scan });
  }

  async _captureFinal(scan) {
    try {
      const img = await captureScreen(nativeCaptureSize());
      if (!img || this.scan !== scan) return;
      const decision = scan.selector.considerFinal(await scanSignature(img), Date.now());
      if (decision === 'kept') scan.frames.push(img.toJPEG(SCAN_FRAME_JPEG_QUALITY));
    } catch (err) {
      this.emit('log', `scan final capture failed: ${err && err.message ? err.message : err}`);
    }
  }

  _abortScan(reason) {
    if (!this.scan) return;
    this.emit('log', `scan aborted: ${reason}`);
    this._endScan(this.scan, null);
  }

  _endScan(scan, error) {
    if (this.scan !== scan) return;
    if (scan.timer) clearTimeout(scan.timer);
    this.scan = null;
    this.emit('scan_state', { state: 'idle', frames: scan.frames.length, error: error || null });
    if (error) this.emit('log', `scan failed: ${error}`);
    // The watcher resumes on the current (partial) screen; the backend's
    // cooldown + fragment suppression keep it from re-opening a slice.
    this.lastHash = null;
    this.lastExtractAt = Date.now();
    this._schedule();
  }

  _emitScan() {
    this.emit('scan_state', this.scanStatus());
  }

  _scheduleScan(delay = SCAN_SAMPLE_MS) {
    const scan = this.scan;
    if (!scan || scan.phase !== 'scanning') return;
    scan.timer = setTimeout(() => {
      scan.pendingTick = this._scanTick(scan);
    }, delay);
  }

  async _scanTick(scan) {
    if (this.scan !== scan || scan.phase !== 'scanning') return;
    try {
      const img = await captureScreen(nativeCaptureSize());
      if (img && this.scan === scan) {
        const decision = scan.selector.consider(await scanSignature(img), Date.now());
        if (decision === 'kept') {
          scan.frames.push(img.toJPEG(SCAN_FRAME_JPEG_QUALITY));
          this._emitScan();
        }
      }
    } catch (err) {
      this.emit('error', err && err.message ? err.message : String(err));
    }
    if (this.scan !== scan || scan.phase !== 'scanning') return;
    if (scan.selector.isFull || Date.now() - scan.startedAt >= SCAN_MAX_MS) {
      void this.finishScan();
      return;
    }
    this._scheduleScan();
  }

  async _sendExtract(base64, bytes, force) {
    await this._postExtract({ image_base64: base64, force: Boolean(force) }, bytes, {});
  }

  /** POST to /api/vision/extract. Resolves {ok, error?}; never throws. */
  async _postExtract(body, bytes, { scan = null }) {
    const scanId = scan ? scan.id : null;
    // A scan belongs to the session it started in, whatever happens later.
    const sessionIdAtSend = scan ? scan.sessionId : this.sessionId;
    const callId = ++this.inflightId;
    // Watcher calls are superseded by any newer call; a scan's request is
    // only invalidated by the scan itself ending (stop / new session).
    const stale = () =>
      !this.active || (scanId ? !this.scan || this.scan.id !== scanId : this.inflightId !== callId);
    try {
      const res = await fetch(`${BACKEND_URL}/api/vision/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: scan ? AbortSignal.timeout(this.scanRequestTimeoutMs) : undefined,
        body: JSON.stringify({
          ...body,
          session_id: sessionIdAtSend,
          provider: this.provider || undefined,
        }),
      });
      if (stale()) {
        // Coding mode toggled off (or another forceExtract superseded us) while
        // the request was in flight — drop the result to avoid spurious events.
        return { ok: false, error: 'superseded' };
      }
      if (!res.ok) {
        const text = await res.text();
        const error = `vision ${res.status}: ${text.slice(0, 200)}`;
        if (!scanId) this.emit('error', error);
        return { ok: false, error };
      }
      const data = await res.json();
      this.emit('extraction_result', {
        problem: data.problem,
        emitted: data.emitted,
        cached: data.cached,
        bytes,
        scan: Boolean(scanId),
      });
      if (scanId && !data.emitted) {
        // Nothing usable (no problem, or too unsure to show) — say so, or the
        // user is left waiting for a tab that never appears.
        return { ok: false, error: 'no problem found in the scanned screens — try again' };
      }
      return { ok: true };
    } catch (err) {
      const error =
        err && err.name === 'TimeoutError'
          ? `vision request timed out after ${Math.round(this.scanRequestTimeoutMs / 1000)}s`
          : err && err.message
            ? err.message
            : String(err);
      if (stale()) return { ok: false, error: 'superseded' };
      if (!scanId) this.emit('error', error);
      return { ok: false, error };
    }
  }
}

module.exports = { CodingCapture };
