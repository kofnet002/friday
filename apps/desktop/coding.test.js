const test = require('node:test');
const assert = require('node:assert/strict');

let captureNumber = 0;
const electronMock = {
  desktopCapturer: {
    getSources: async () => [
      {
        display_id: 'primary',
        name: 'Built-in Display',
        thumbnail: {
          isEmpty: () => false,
          toPNG: () => Buffer.from([++captureNumber]),
        },
      },
    ],
  },
  screen: { getPrimaryDisplay: () => ({ id: 'primary' }) },
};

require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: electronMock,
};
require.cache[require.resolve('sharp')] = {
  id: require.resolve('sharp'),
  filename: require.resolve('sharp'),
  loaded: true,
  exports: (input) => ({
    resize() {
      return this;
    },
    grayscale() {
      return this;
    },
    raw() {
      return this;
    },
    jpeg() {
      return this;
    },
    async toBuffer(options) {
      if (options?.resolveWithObject) {
        const data = Buffer.alloc(64);
        for (let i = 0; i < Math.min(input[0] * 4, 64); i++) data[i] = 255;
        return { data };
      }
      return Buffer.from([input[0]]);
    },
  }),
};

const { CodingCapture } = require('./coding');

function activeCapture() {
  const capture = new CodingCapture();
  capture.active = true;
  capture.sessionId = 'session-test';
  return capture;
}

test('guided scan finish submits ordered frames and resumes normal capture', async () => {
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ problem: { completeness: 'complete' }, emitted: true }),
    };
  };
  const capture = activeCapture();
  const states = [];
  capture.on('scan_state', (state) => states.push(state));
  try {
    assert.deepEqual(await capture.startGuidedScan(), { ok: true });
    assert.equal(capture.scanning, true);
    const result = await capture.finishGuidedScan();
    assert.equal(result.ok, true);
    assert.equal(body.images_base64.length, 2);
    assert.equal(body.force, true);
    assert.equal(
      states.some((state) => state.state === 'complete'),
      true,
    );
    assert.equal(capture.scanning, false);
    assert.ok(capture.timer, 'normal watcher is scheduled again after scan submission');
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});

test('guided scan cancellation clears frames without submitting them', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    throw new Error('must not submit');
  };
  const capture = activeCapture();
  const states = [];
  capture.on('scan_state', (state) => states.push(state));
  try {
    await capture.startGuidedScan();
    assert.deepEqual(capture.cancelGuidedScan(), { ok: true });
    assert.equal(capture.scanning, false);
    assert.equal(calls, 0);
    assert.equal(states.at(-1).state, 'cancelled');
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});

test('failed scan submission reports failure and resumes the watcher', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 502, text: async () => 'provider unavailable' });
  const capture = activeCapture();
  const states = [];
  capture.on('scan_state', (state) => states.push(state));
  try {
    await capture.startGuidedScan();
    const result = await capture.finishGuidedScan();
    assert.equal(result.ok, false);
    assert.equal(states.at(-1).state, 'failed');
    assert.match(states.at(-1).error, /502/);
    assert.ok(capture.timer);
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});
