// Coding-mode screen capture. Samples the primary display at 1Hz, computes a
// cheap perceptual hash, and only ships the frame to the backend when the hash
// has shifted meaningfully AND a min interval has elapsed. All coordinate and
// threshold constants mirror CODING_EXTRACTION_CONFIG from
// packages/prompts/coding-extraction.ts.

const { desktopCapturer, screen } = require('electron');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { ScanSelector } = require('./scan');

// Mirrors packages/prompts/coding-extraction.ts CODING_EXTRACTION_CONFIG.
const SAMPLE_INTERVAL_MS = 1000;
const FRAME_CHANGE_THRESHOLD = 0.15;
const MIN_API_INTERVAL_MS = 2000;
const SCAN_SAMPLE_INTERVAL_MS = 400;
const SCAN_MAX_DURATION_MS = 90_000;
const SCAN_MAX_FRAMES = 10;
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
    this.active = false;
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

  async forceExtract() {
    if (!this.active || !this.sessionId) {
      return { ok: false, error: 'coding mode not active' };
    }
    await this._tick({ force: true });
    return { ok: true };
  }

  _schedule(delay = SAMPLE_INTERVAL_MS) {
    if (!this.active || this.scanning) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick({ force: false }).catch(() => {}), delay);
  }

  async _tick({ force }) {
    if (!this.active || this.scanning) return;
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
    if (this.scanning) return { ok: false, error: 'guided scan already active' };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scan = new ScanSelector({ maxFrames: SCAN_MAX_FRAMES });
    this.scanDisplayId = displayId || null;
    this.scanStartedAt = Date.now();
    this._emitScanState('capturing');
    await this._scanTick();
    return { ok: true };
  }

  async _scanTick() {
    if (!this.scanning) return;
    try {
      const img = await captureScreen(this.scanDisplayId);
      if (!img) throw new Error('No screen available for guided scan');
      const png = img.toPNG();
      const hash = await computeAverageHash(png);
      const frame = { hash, ...(await toJpegBase64(img)) };
      const result = this.scan.add(frame);
      this._emitScanState('capturing');
      if (result.limitReached) {
        await this._submitGuidedScan({ partial: true, limitReached: true });
        return;
      }
      if (Date.now() - this.scanStartedAt >= SCAN_MAX_DURATION_MS) {
        await this._submitGuidedScan({ partial: true, limitReached: true });
        return;
      }
      this.scanTimer = setTimeout(() => this._scanTick(), SCAN_SAMPLE_INTERVAL_MS);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.emit('error', message);
      this.scan = null;
      this._emitScanState('failed', { error: message });
      this._schedule(0);
    }
  }

  async finishGuidedScan() {
    if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
    try {
      const img = await captureScreen(this.scanDisplayId);
      if (img) {
        const hash = await computeAverageHash(img.toPNG());
        this.scan.finish({ hash, ...(await toJpegBase64(img)) });
      }
      return await this._submitGuidedScan({ partial: false, limitReached: false });
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
    this._emitScanState('cancelled');
    this._schedule(0);
    return { ok: true };
  }

  async _submitGuidedScan({ partial, limitReached }) {
    if (!this.scanning) return { ok: false, error: 'guided scan is not active' };
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    const selector = this.scan;
    this.scan = null;
    this._emitScanState('combining', { limitReached, frames: selector.frames.length });
    try {
      const response = await fetch(`${BACKEND_URL}/api/vision/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images_base64: selector.frames.map((frame) => frame.base64),
          session_id: this.sessionId,
          force: true,
          scan_incomplete: Boolean(partial),
          provider: this.provider || undefined,
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

  _emitScanState(state, extra = {}) {
    this.emit('scan_state', {
      state,
      frames: this.scan ? this.scan.frames.length : extra.frames || 0,
      displayId: this.scanDisplayId || undefined,
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
