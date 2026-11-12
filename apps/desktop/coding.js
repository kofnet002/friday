// Coding-mode screen capture. Samples the primary display at 1Hz, computes a
// cheap perceptual hash, and only ships the frame to the backend when the hash
// has shifted meaningfully AND a min interval has elapsed. All coordinate and
// threshold constants mirror CODING_EXTRACTION_CONFIG from
// packages/prompts/coding-extraction.ts.

const { desktopCapturer, screen } = require('electron');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { ScanSelector, signatureDistance, autoFinishReason } = require('./scan');

// Mirrors packages/prompts/coding-extraction.ts CODING_EXTRACTION_CONFIG.
const SAMPLE_INTERVAL_MS = 1000;
const FRAME_CHANGE_THRESHOLD = 0.15;
const MIN_API_INTERVAL_MS = 2000;
const SCAN_SAMPLE_INTERVAL_MS = 400;
const SCAN_MAX_DURATION_MS = 90_000;
const SCAN_MAX_FRAMES = 12; // backend MAX_SCAN_IMAGES
// Finish on our own once the page has been still this long after scrolling.
const SCAN_IDLE_AFTER_SCROLL_MS = 4000;
// …or this long when the user never scrolled at all.
const SCAN_IDLE_WITHOUT_SCROLL_MS = 12_000;
// Mean per-pixel change (0-255) on the 32x32 signature that counts as the
// page moving. A blinking caret or hover highlight stays well below this.
const SCAN_MOTION_THRESHOLD = 2;
const SIGNATURE_SIZE = 32;
const MAX_WIDTH_PX = 1920;
const JPEG_QUALITY = 80;

// 8x8 average hash -> 64 bits. Hamming distance threshold in bits.
const HASH_BITS = 64;
const CHANGE_BIT_THRESHOLD = Math.ceil(HASH_BITS * FRAME_CHANGE_THRESHOLD); // ~10

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

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

// 32x32 grayscale downsample — a finer motion signal than the 8x8 hash, used
// to notice scrolling and when it stops.
async function computeSignature(buffer) {
  const { data } = await sharp(buffer)
    .resize(SIGNATURE_SIZE, SIGNATURE_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Uint8Array.from(data.subarray(0, SIGNATURE_SIZE * SIGNATURE_SIZE));
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

async function captureScreen(displayId) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: MAX_WIDTH_PX, height: MAX_WIDTH_PX },
    fetchWindowIcons: false,
  });
  if (!sources.length) return null;
  const primaryId = String(screen.getPrimaryDisplay().id);
  const selected = displayId
    ? sources.find((source) => source.display_id === String(displayId))
    : null;
  const primary =
    selected || sources.find((source) => source.display_id === primaryId) || sources[0];
  const img = primary.thumbnail;
  if (img.isEmpty()) return null;
  return img;
}

async function toJpegBase64(image) {
  // Electron NativeImage -> PNG buffer (lossless source) -> sharp jpeg.
  const png = image.toPNG();
  const jpeg = await sharp(png)
    .resize({ width: MAX_WIDTH_PX, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
    .toBuffer();
  return { base64: jpeg.toString('base64'), bytes: jpeg.length, pngBytes: png.length };
}

class CodingCapture extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.paused = false;
    this.sessionId = null;
    this.timer = null;
    this.inflightId = 0;
    this.lastHash = null;
    this.lastExtractAt = 0;
    // Provider used for the vision/OCR step. Mirrors the Coding panel's
    // selection in the renderer; left null until the renderer pushes one,
    // in which case the backend resolves it from session.default_provider.
    this.provider = null;
    this.scan = null;
    this.scanTimer = null;
    this.scanStartedAt = 0;
    this.scanDisplayId = null;
    this.scanMotion = null;
    this.scanCapturedAt = 0;
    this.claudeModel = null;
  }

  isActive() {
    return this.active;
  }

  async listDisplays() {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
    });
    const primaryId = String(screen.getPrimaryDisplay().id);
    return sources.map((source) => ({
      displayId: source.display_id,
      label: source.name,
      isPrimary: source.display_id === primaryId,
    }));
  }

  // Claude model picked in screen mode. The backend validates it against its
  // allow-list, so an unknown value just falls back to the default.
  setClaudeModel(model) {
    this.claudeModel = typeof model === 'string' && model.startsWith('claude-') ? model : null;
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
    this.paused = false;
    this.sessionId = sessionId;
    this.lastHash = null;
    this.lastExtractAt = 0;
    this._schedule(0);
    this.emit('log', `coding capture started (session ${sessionId.slice(0, 8)})`);
    return { ok: true };
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.paused = false;
    this.sessionId = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Any in-flight extract call will see active=false and discard its result.
    this.inflightId++;
    if (this.scanning) this.cancelGuidedScan();
    this.lastHash = null;
    this.emit('log', 'coding capture stopped');
  }

  pause() {
    if (!this.active || this.paused) return { ok: true };
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.timer = null;
    this.scanTimer = null;
    this.emit('log', 'screen capture paused');
    return { ok: true };
  }

  resume() {
    if (!this.active || !this.paused) return { ok: true };
    this.paused = false;
    this.emit('log', 'screen capture resumed');
    // Time spent paused isn't "stopped scrolling" — restart the idle clock.
    if (this.scanMotion) this.scanMotion.lastMotionAt = Date.now();
    if (this.scanning) void this._scanTick();
    else this._schedule(0);
    return { ok: true };
  }

  async forceExtract() {
    if (!this.active || !this.sessionId) {
      return { ok: false, error: 'coding mode not active' };
    }
    await this._tick({ force: true });
    return { ok: true };
  }

  _schedule(delay = SAMPLE_INTERVAL_MS) {
    if (!this.active || this.paused || this.scanning) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick({ force: false }).catch(() => {}), delay);
  }

  async _tick({ force }) {
    if (!this.active || this.paused || this.scanning) return;
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

      const { base64, bytes } = await toJpegBase64(img);
      this.lastHash = hash;
      this.lastExtractAt = now;
      await this._sendExtract(base64, bytes, force);
    } catch (err) {
      this.emit('error', err && err.message ? err.message : String(err));
    } finally {
      this._schedule();
    }
  }

  get scanning() {
    return Boolean(this.scan);
  }

  async startGuidedScan(displayId) {
    if (!this.active || !this.sessionId) return { ok: false, error: 'coding mode not active' };
    if (this.paused) return { ok: false, error: 'resume Assist before starting a guided scan' };
    if (this.scanning) return { ok: false, error: 'guided scan already active' };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scan = new ScanSelector({ maxFrames: SCAN_MAX_FRAMES });
    this.scanDisplayId = displayId || null;
    this.scanStartedAt = Date.now();
    this.scanMotion = { lastSig: null, lastMotionAt: 0, moving: false, scrolled: false };
    this.scanCapturedAt = 0;
    this.scanId = randomUUID();
    this.speculation = { inflight: false, dirty: false };
    this._emitScanState('capturing');
    await this._scanTick();
    return { ok: true };
  }

  async _captureScanFrame() {
    const img = await captureScreen(this.scanDisplayId);
    if (!img) throw new Error('No screen available for guided scan');
    const png = img.toPNG();
    const [hash, sig] = await Promise.all([computeAverageHash(png), computeSignature(png)]);
    return { hash, sig, ...(await toJpegBase64(img)) };
  }

  async _scanTick() {
    if (!this.scanning || this.paused) return;
    try {
      const frame = await this._captureScanFrame();
      if (!this.scanning || this.paused) return;
      const now = Date.now();
      const motion = this.scanMotion;
      const moved =
        motion.lastSig !== null &&
        signatureDistance(motion.lastSig, frame.sig) > SCAN_MOTION_THRESHOLD;
      motion.lastSig = frame.sig;

      let result;
      if (moved) {
        motion.lastMotionAt = now;
        motion.moving = true;
        motion.scrolled = true;
        // Mid-scroll: keep only views the coarse hash sees as new.
        result = this.scan.add(frame);
      } else if (motion.moving) {
        // Scrolling just settled — the user is looking at this position, so
        // keep it even if the coarse hash calls it a near-duplicate.
        motion.moving = false;
        result = this.scan.addManual(frame);
      } else {
        result = this.scan.add(frame);
      }
      if (result.kept) {
        this._announceViewCaptured();
        // The page is at rest on a new view (first view, or scrolling just
        // settled): read what we have so far in the background.
        if (!moved) this._speculate();
      } else this._emitScanState('capturing');

      if (result.limitReached || now - this.scanStartedAt >= SCAN_MAX_DURATION_MS) {
        await this._submitGuidedScan({ partial: true, limitReached: true, finishedBy: 'limit' });
        return;
      }
      const reason = autoFinishReason({
        scrolled: motion.scrolled,
        startedAt: this.scanStartedAt,
        lastMotionAt: motion.lastMotionAt,
        now,
        idleAfterScrollMs: SCAN_IDLE_AFTER_SCROLL_MS,
        idleWithoutScrollMs: SCAN_IDLE_WITHOUT_SCROLL_MS,
      });
      if (reason) {
        this.emit('log', 'guided scan finished: scrolling stopped');
        await this._submitGuidedScan({ partial: false, limitReached: false, finishedBy: reason });
        return;
      }
      if (!this.paused)
        this.scanTimer = setTimeout(() => this._scanTick(), SCAN_SAMPLE_INTERVAL_MS);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.emit('error', message);
      this.scan = null;
      this.scanMotion = null;
      this._emitScanState('failed', { error: message });
      this._schedule(0);
    }
  }

  /** Keep the current view now — the "capture this section" shortcut. */
  async captureScanSection() {
    if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
    if (this.paused) return { ok: false, error: 'resume Assist before capturing' };
    try {
      const frame = await this._captureScanFrame();
      if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
      const result = this.scan.addManual(frame);
      // A deliberate capture counts as activity: don't auto-finish right after.
      if (this.scanMotion) this.scanMotion.lastMotionAt = Date.now();
      if (result.kept) {
        this._announceViewCaptured();
        this._speculate();
      } else this._emitScanState('capturing', { lastCapture: 'duplicate' });
      if (result.limitReached) {
        await this._submitGuidedScan({ partial: true, limitReached: true, finishedBy: 'limit' });
      }
      return { ok: true, kept: result.kept };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.emit('error', message);
      return { ok: false, error: message };
    }
  }

  async finishGuidedScan() {
    if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
    try {
      const img = this.paused ? null : await captureScreen(this.scanDisplayId);
      if (img) {
        const png = img.toPNG();
        const [hash, sig] = await Promise.all([computeAverageHash(png), computeSignature(png)]);
        this.scan.finish({ hash, sig, ...(await toJpegBase64(img)) });
      }
      return await this._submitGuidedScan({
        partial: false,
        limitReached: false,
        finishedBy: 'manual',
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.scan = null;
      this._emitScanState('failed', { error: message });
      this._schedule(0);
      return { ok: false, error: message };
    }
  }

  cancelGuidedScan() {
    if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.scan = null;
    this.scanMotion = null;
    this._emitScanState('cancelled');
    this._schedule(0);
    return { ok: true };
  }

  // Read the views captured so far while the user keeps scrolling. Fully
  // visible questions get answered early, and when the scan ends on these
  // same views the backend reuses this read instead of starting over. One
  // read at a time; views kept meanwhile queue a single follow-up read.
  _speculate() {
    if (!this.scanning || !this.sessionId) return;
    const spec = this.speculation;
    if (spec.inflight) {
      spec.dirty = true;
      return;
    }
    spec.inflight = true;
    spec.dirty = false;
    const scanId = this.scanId;
    const images = this.scan.frames.map((frame) => frame.base64);
    void fetch(`${BACKEND_URL}/api/vision/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images_base64: images,
        session_id: this.sessionId,
        force: true,
        speculative: true,
        scan_id: scanId,
        provider: this.provider || undefined,
        claude_model: this.claudeModel || undefined,
      }),
    })
      .then((response) => {
        if (!response.ok) this.emit('log', `speculative scan read failed: ${response.status}`);
      })
      .catch((error) => this.emit('log', `speculative scan read failed: ${error.message || error}`))
      .finally(() => {
        spec.inflight = false;
        if (spec.dirty && this.scanning && this.scanId === scanId) this._speculate();
      });
  }

  async _submitGuidedScan({ partial, limitReached, finishedBy = 'manual' }) {
    if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    const selector = this.scan;
    this.scan = null;
    this.scanMotion = null;
    this._emitScanState('combining', {
      limitReached,
      finishedBy,
      frames: selector.frames.length,
    });
    try {
      const response = await fetch(`${BACKEND_URL}/api/vision/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images_base64: selector.frames.map((frame) => frame.base64),
          session_id: this.sessionId,
          force: true,
          scan_incomplete: Boolean(partial),
          scan_id: this.scanId || undefined,
          provider: this.provider || undefined,
          claude_model: this.claudeModel || undefined,
        }),
      });
      if (!response.ok)
        throw new Error(`vision ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const data = await response.json();
      this.emit('extraction_result', {
        problem: data.problem,
        emitted: data.emitted,
        cached: false,
        bytes: selector.frames.reduce((sum, frame) => sum + frame.bytes, 0),
      });
      this._emitScanState(
        data.problem?.completeness === 'complete' && !partial ? 'complete' : 'partial',
        {
          frames: selector.frames.length,
          limitReached,
          finishedBy,
          partial: partial || data.problem?.completeness !== 'complete',
        },
      );
      return { ok: true, partial };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.emit('error', message);
      this._emitScanState('failed', { error: message });
      return { ok: false, error: message };
    } finally {
      this.scanDisplayId = null;
      this._schedule(0);
    }
  }

  // Tell the user this position is in the bag so they can scroll on.
  _announceViewCaptured() {
    const frames = this.scan ? this.scan.frames.length : 0;
    this.scanCapturedAt = Date.now();
    this._emitScanState('capturing', { lastCapture: 'added' });
    this.emit('scan_view_captured', { frames, maxFrames: SCAN_MAX_FRAMES });
  }

  _emitScanState(state, extra = {}) {
    this.emit('scan_state', {
      state,
      frames: this.scan ? this.scan.frames.length : extra.frames || 0,
      displayId: this.scanDisplayId || undefined,
      // Carried on every tick so the renderer's "View N captured" cue lasts
      // its full window instead of vanishing on the next 400ms update.
      capturedAt: this.scan ? this.scanCapturedAt || undefined : undefined,
      ...extra,
    });
  }

  async _sendExtract(base64, bytes, force) {
    const sessionIdAtSend = this.sessionId;
    const callId = ++this.inflightId;
    try {
      const res = await fetch(`${BACKEND_URL}/api/vision/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: base64,
          session_id: sessionIdAtSend,
          force: Boolean(force),
          provider: this.provider || undefined,
          claude_model: this.claudeModel || undefined,
        }),
      });
      if (!this.active || this.inflightId !== callId) {
        // Coding mode toggled off (or another forceExtract superseded us) while
        // the request was in flight — drop the result to avoid spurious events.
        return;
      }
      if (!res.ok) {
        const text = await res.text();
        this.emit('error', `vision ${res.status}: ${text.slice(0, 200)}`);
        return;
      }
      const data = await res.json();
      this.emit('extraction_result', {
        problem: data.problem,
        emitted: data.emitted,
        cached: data.cached,
        bytes,
      });
    } catch (err) {
      if (!this.active || this.inflightId !== callId) return;
      this.emit('error', err && err.message ? err.message : String(err));
    }
  }
}

module.exports = { CodingCapture };
