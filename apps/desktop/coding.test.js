// Scroll-scan state machine in CodingCapture. Electron and fetch are stubbed;
// sharp and scan.js are real.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const sharp = require('sharp');

// ─── electron stub ──────────────────────────────────────────────────────────
let sourcesGate = null; // when set, getSources waits for it
let nextImage = null;
const electronStub = {
  desktopCapturer: {
    async getSources() {
      if (sourcesGate) await sourcesGate;
      return nextImage ? [{ thumbnail: nextImage }] : [];
    },
  },
  nativeImage: {},
  screen: { getPrimaryDisplay: () => ({ size: { width: 320, height: 200 }, scaleFactor: 1 }) },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electronStub;
  return realLoad.call(this, request, ...rest);
};
const { CodingCapture } = require('./coding');

async function fakeImage({ jpeg } = {}) {
  const png = await sharp({
    create: { width: 320, height: 200, channels: 3, background: '#e8e8e8' },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="320" height="200"><rect x="20" y="30" width="200" height="12" fill="#222"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  const realJpeg = await sharp(png).jpeg().toBuffer();
  const img = {
    isEmpty: () => false,
    toPNG: () => png,
    toJPEG: () => jpeg || realJpeg,
    resize: () => img,
  };
  return img;
}

// ─── fetch stub ─────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let posts;
let respond;
beforeEach(async () => {
  posts = [];
  sourcesGate = null;
  nextImage = await fakeImage();
  respond = () => ({ problem: { title: 'x' }, emitted: true, cached: false });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push(body);
    const data = await respond(body, init);
    return { ok: true, status: 200, json: async () => data, text: async () => '' };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function nextScanState(capture, predicate = () => true) {
  return new Promise((resolve) => {
    const on = (s) => {
      if (!predicate(s)) return;
      capture.off('scan_state', on);
      resolve(s);
    };
    capture.on('scan_state', on);
  });
}

async function scanningCapture() {
  const capture = new CodingCapture();
  capture.on('error', () => {});
  capture.start('session-a');
  capture.startScan();
  await nextScanState(capture, (s) => s.state === 'scanning' && s.frames >= 1);
  return capture;
}

test('scan: a successful finish posts every frame and returns to idle', async () => {
  const capture = await scanningCapture();
  const idle = nextScanState(capture, (s) => s.state === 'idle');
  capture.toggleScan();
  const s = await idle;
  assert.equal(s.error, null);
  const scanPosts = posts.filter((p) => p.images_base64);
  assert.equal(scanPosts.length, 1);
  assert.equal(scanPosts[0].session_id, 'session-a');
  assert.equal(capture.scan, null);
  capture.stop();
});

test('scan: an image-processing failure ends the scan with an error instead of hanging', async () => {
  const capture = await scanningCapture();
  nextImage = await fakeImage({ jpeg: Buffer.from('not a jpeg') });
  capture.scan.frames = capture.scan.frames.map(() => Buffer.from('not a jpeg'));
  const idle = nextScanState(capture, (s) => s.state === 'idle');
  capture.toggleScan();
  const s = await idle;
  assert.ok(s.error, 'expected an error on the idle state');
  assert.equal(capture.scan, null);
  assert.equal(capture.toggleScan().state, 'scanning', 'a new scan can start');
  capture.stop();
});

test('scan: a result with nothing readable is reported, not silent', async () => {
  respond = () => ({ problem: null, emitted: false, cached: false });
  const capture = await scanningCapture();
  const idle = nextScanState(capture, (s) => s.state === 'idle');
  capture.toggleScan();
  const s = await idle;
  assert.match(s.error || '', /no problem/i);
  capture.stop();
});

test('scan: stopping coding mid-processing never posts to the next session', async () => {
  const capture = await scanningCapture();
  let processing = 0;
  capture.on('scan_state', (s) => {
    // 2nd 'processing' event fires after the final capture, before encoding.
    if (s.state === 'processing' && ++processing === 2) {
      capture.stop();
      capture.start('session-b');
    }
  });
  await capture.finishScan();
  assert.deepEqual(
    posts.filter((p) => p.images_base64),
    [],
  );
  capture.stop();
});

test('scan: a hung backend times out and frees the scan', async () => {
  respond = (_body, init) =>
    new Promise((_resolve, reject) => {
      // A real socket keeps the event loop alive; AbortSignal.timeout doesn't.
      const socket = setTimeout(() => reject(new Error('no timeout fired')), 2000);
      if (!init.signal) return; // no timeout → only the 2s guard rejects
      init.signal.addEventListener('abort', () => {
        clearTimeout(socket);
        reject(init.signal.reason);
      });
    });
  const capture = await scanningCapture();
  capture.scanRequestTimeoutMs = 50;
  const idle = nextScanState(capture, (s) => s.state === 'idle');
  capture.toggleScan();
  const s = await idle;
  assert.ok(s.error, 'expected a timeout error');
  assert.equal(capture.scan, null);
  capture.stop();
});

test('watcher: a tick already capturing when a scan starts does not extract', async () => {
  let release;
  sourcesGate = new Promise((r) => {
    release = r;
  });
  const capture = new CodingCapture();
  capture.on('error', () => {});
  capture.start('session-a'); // first watcher tick blocks inside getSources
  await new Promise((r) => setTimeout(r, 10));
  capture.startScan();
  release();
  sourcesGate = null;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    posts.filter((p) => p.image_base64),
    [],
  );
  capture.stop();
});
