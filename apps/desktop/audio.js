// Audio capture supervisor: spawns the Swift helper (system audio via
// ScreenCaptureKit, plus the echo-cancelled microphone when started with
// `{ mic: true }`), demuxes its tagged stdout, chunks each source's 16kHz
// mono Int16 LE PCM into ~100ms frames (3200 bytes), and emits them.
//
// Helper stdout framing (see swift/Sources/friday-audio/main.swift):
//   [1 byte source: 0 = system, 1 = mic][UInt32 LE payload length][payload]
//
// Events: `frame` (buffer, source) where source is 'system' | 'mic'.
//
// Lifecycle (driven by `audio:start` / `audio:stop` IPC from the renderer):
//   start(opts) -> spawn helper, begin emitting `frame` events
//   stop()      -> SIGTERM helper, drop any partial buffers

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const FRAME_BYTES = 3200; // 16000 Hz * 0.1 s * 2 bytes/sample * 1 channel

const HEADER_BYTES = 5; // 1 byte source + 4 byte UInt32 LE length
const SOURCES = { 0: 'system', 1: 'mic' };

const HELPER_PATH = path.join(__dirname, 'swift', '.build', 'release', 'friday-audio');

class AudioSupervisor extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.paused = false;
    this._resetBuffers();
  }

  _resetBuffers() {
    // Undemuxed helper stdout (may end mid-header or mid-payload).
    this.stream = Buffer.alloc(0);
    // Per-source rolling PCM buffers awaiting a full FRAME_BYTES chunk.
    this.buffers = { system: Buffer.alloc(0), mic: Buffer.alloc(0) };
  }

  isRunning() {
    return this.proc !== null;
  }

  start(opts = {}) {
    if (this.proc) return { ok: true };
    if (!fs.existsSync(HELPER_PATH)) {
      const msg = `friday-audio binary not found at ${HELPER_PATH}. Run \`pnpm --filter @friday/desktop build:swift\`.`;
      this.emit('error', msg);
      return { ok: false, error: msg };
    }

    const args = opts && opts.mic ? ['--mic'] : [];
    this._resetBuffers();
    const proc = spawn(HELPER_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => this._onAudio(chunk));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.emit('log', text);
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this._resetBuffers();
      this.emit('exit', { code, signal });
    });
    proc.on('error', (err) => {
      this.emit('error', err.message);
    });

    this.proc = proc;
    return { ok: true };
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGTERM');
    } catch (_e) {
      // ignore
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  _onAudio(chunk) {
    // Always demux (even while paused) so the framing stays in sync; paused
    // payloads are dropped for both sources.
    this.stream = this.stream.length === 0 ? chunk : Buffer.concat([this.stream, chunk]);
    let offset = 0;
    while (this.stream.length - offset >= HEADER_BYTES) {
      const tag = this.stream[offset];
      const len = this.stream.readUInt32LE(offset + 1);
      if (this.stream.length - offset - HEADER_BYTES < len) break;
      const payload = this.stream.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + len);
      offset += HEADER_BYTES + len;
      const source = SOURCES[tag];
      if (!source) {
        this.emit('log', `[audio] dropping frame with unknown source tag ${tag}`);
        continue;
      }
      if (!this.paused) this._push(source, payload);
    }
    // Copy the remainder so we don't pin the whole stdout chunk.
    this.stream = offset === 0 ? this.stream : Buffer.from(this.stream.subarray(offset));
  }

  _push(source, payload) {
    let buf = this.buffers[source];
    buf = buf.length === 0 ? payload : Buffer.concat([buf, payload]);
    while (buf.length >= FRAME_BYTES) {
      // Pass a copy so the consumer can hold it past the next slice.
      this.emit('frame', Buffer.from(buf.subarray(0, FRAME_BYTES)), source);
      buf = buf.subarray(FRAME_BYTES);
    }
    this.buffers[source] = Buffer.from(buf);
  }
}

module.exports = { AudioSupervisor, FRAME_BYTES, HELPER_PATH };
