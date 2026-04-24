// Audio capture supervisor: spawns the Swift ScreenCaptureKit helper,
// chunks its raw 16kHz mono Int16 LE PCM stdout into ~100ms frames
// (3200 bytes), and forwards each chunk via IPC.
//
// Lifecycle (driven by `audio:start` / `audio:stop` IPC from the renderer):
//   start() -> spawn helper, begin emitting `audio:frame` events
//   stop()  -> SIGTERM helper, drop any partial buffer

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const FRAME_BYTES = 3200; // 16000 Hz * 0.1 s * 2 bytes/sample * 1 channel

const HELPER_PATH = path.join(__dirname, 'swift', '.build', 'release', 'friday-audio');

class AudioSupervisor extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.paused = false;
  }

  isRunning() {
    return this.proc !== null;
  }

  start() {
    if (this.proc) return { ok: true };
    if (!fs.existsSync(HELPER_PATH)) {
      const msg = `friday-audio binary not found at ${HELPER_PATH}. Run \`pnpm --filter @friday/desktop build:swift\`.`;
      this.emit('error', msg);
      return { ok: false, error: msg };
    }

    const proc = spawn(HELPER_PATH, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => this._onAudio(chunk));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.emit('log', text);
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.buffer = Buffer.alloc(0);
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
    if (this.paused) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= FRAME_BYTES) {
      const frame = this.buffer.subarray(0, FRAME_BYTES);
      this.buffer = this.buffer.subarray(FRAME_BYTES);
      // Pass a copy so the consumer can hold it past the next slice.
      this.emit('frame', Buffer.from(frame));
    }
  }
}

module.exports = { AudioSupervisor, FRAME_BYTES, HELPER_PATH };
