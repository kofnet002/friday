const test = require('node:test');
const assert = require('node:assert/strict');

let captureNumber = 0;
function fakeWindow(name) {
  const win = { name, protectedNow: false, calls: [] };
  win.isDestroyed = () => false;
  win.setContentProtection = (on) => {
    win.protectedNow = on;
    win.calls.push(on);
  };
  return win;
}
let windows = [];
const defaultGetSources = async () => [
  {
    display_id: 'primary',
    name: 'Built-in Display',
    thumbnail: {
      isEmpty: () => false,
      toPNG: () => Buffer.from([++captureNumber]),
    },
  },
];
const electronMock = {
  BrowserWindow: { getAllWindows: () => windows },
  desktopCapturer: { getSources: defaultGetSources },
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

const { CodingCapture, getSourcesWithoutFriday, setProtectedWindowCheck } = require('./coding');

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
    const parsed = JSON.parse(options.body);
    if (!parsed.speculative) body = parsed;
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
  global.fetch = async (_url, options) => {
    // Background (speculative) reads are fine; the final submission is not.
    if (JSON.parse(options.body).speculative) return { ok: true, json: async () => ({}) };
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

test('a scan reads its first view in the background and the final read shares its scan id', async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ problem: { completeness: 'complete' }, emitted: true }),
    };
  };
  const capture = activeCapture();
  try {
    await capture.startGuidedScan();
    const speculative = bodies.filter((body) => body.speculative);
    assert.equal(speculative.length, 1);
    assert.equal(speculative[0].images_base64.length, 1);
    await capture.finishGuidedScan();
    const final = bodies.find((body) => !body.speculative);
    assert.ok(final.scan_id);
    assert.equal(final.scan_id, speculative[0].scan_id);
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});

test('captures shield every Friday window and restore it afterwards', async () => {
  const panel = fakeWindow('panel');
  windows = [panel];
  let protectedDuringCapture = null;
  electronMock.desktopCapturer.getSources = async () => {
    protectedDuringCapture = panel.protectedNow;
    return defaultGetSources();
  };
  try {
    await getSourcesWithoutFriday({ types: ['screen'] });
    assert.equal(protectedDuringCapture, true);
    assert.equal(panel.protectedNow, false);
    assert.deepEqual(panel.calls, [true, false]);
  } finally {
    electronMock.desktopCapturer.getSources = defaultGetSources;
    windows = [];
  }
});

test('a failed capture still restores window protection', async () => {
  const panel = fakeWindow('panel');
  windows = [panel];
  electronMock.desktopCapturer.getSources = async () => {
    assert.equal(panel.protectedNow, true);
    throw new Error('capture denied');
  };
  try {
    await assert.rejects(getSourcesWithoutFriday({ types: ['screen'] }), /capture denied/);
    assert.equal(panel.protectedNow, false);
  } finally {
    electronMock.desktopCapturer.getSources = defaultGetSources;
    windows = [];
  }
});

test('a window stealth already protects stays protected after a capture', async () => {
  const stealthed = fakeWindow('main');
  stealthed.protectedNow = true;
  const other = fakeWindow('other');
  windows = [stealthed, other];
  setProtectedWindowCheck((win) => win === stealthed);
  try {
    const capture = activeCapture();
    capture.active = false;
    await capture.listDisplays();
    assert.equal(stealthed.protectedNow, true);
    assert.deepEqual(stealthed.calls, [], 'a protected window is never switched off');
    assert.deepEqual(other.calls, [true, false]);
  } finally {
    setProtectedWindowCheck(null);
    windows = [];
  }
});

test('overlapping captures keep windows shielded until the last one ends', async () => {
  const panel = fakeWindow('panel');
  windows = [panel];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  electronMock.desktopCapturer.getSources = async () => {
    if (calls++ === 0) await gate;
    return defaultGetSources();
  };
  try {
    const slow = getSourcesWithoutFriday({ types: ['screen'] });
    await getSourcesWithoutFriday({ types: ['screen'] });
    assert.equal(panel.protectedNow, true, 'first capture is still running');
    release();
    await slow;
    assert.equal(panel.protectedNow, false);
  } finally {
    electronMock.desktopCapturer.getSources = defaultGetSources;
    windows = [];
  }
});

function scanFetch(speculativeProblem, finalProblem) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const problem = body.speculative ? speculativeProblem : finalProblem;
    return { ok: true, json: async () => ({ problem, emitted: true }) };
  };
}

const SEVEN = {
  questions: ['1', '2', '3', '4', '5', '6', '7'],
  completeness: 'complete',
  confidence: 0.9,
};
const WEAKER = { questions: ['1', '2', '3', '4'], completeness: 'partial', confidence: 0.4 };

test('a weaker final read does not turn a fully read scan into a partial one', async () => {
  const originalFetch = global.fetch;
  global.fetch = scanFetch(SEVEN, WEAKER);
  const capture = activeCapture();
  const states = [];
  capture.on('scan_state', (state) => states.push(state));
  try {
    await capture.startGuidedScan();
    await new Promise((resolve) => setImmediate(resolve));
    await capture.finishGuidedScan();
    assert.equal(states.at(-1).state, 'complete');
    assert.equal(states.at(-1).partial, false);
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});

test('reaching the capture limit still reports a partial scan', async () => {
  const originalFetch = global.fetch;
  global.fetch = scanFetch(SEVEN, SEVEN);
  const capture = activeCapture();
  const states = [];
  capture.on('scan_state', (state) => states.push(state));
  try {
    await capture.startGuidedScan();
    await new Promise((resolve) => setImmediate(resolve));
    await capture._submitGuidedScan({ partial: true, limitReached: true, finishedBy: 'limit' });
    assert.equal(states.at(-1).state, 'partial');
    assert.equal(states.at(-1).limitReached, true);
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});

test('reads from an earlier scan never vouch for the next one', async () => {
  const originalFetch = global.fetch;
  global.fetch = scanFetch(SEVEN, WEAKER);
  const capture = activeCapture();
  const states = [];
  capture.on('scan_state', (state) => states.push(state));
  try {
    await capture.startGuidedScan();
    await new Promise((resolve) => setImmediate(resolve));
    await capture.cancelGuidedScan();
    global.fetch = scanFetch(WEAKER, WEAKER);
    await capture.startGuidedScan();
    await new Promise((resolve) => setImmediate(resolve));
    await capture.finishGuidedScan();
    assert.equal(states.at(-1).state, 'partial');
  } finally {
    capture.stop();
    global.fetch = originalFetch;
  }
});

test('windows reporting isContentProtected are restored after a capture they were shielded for', async () => {
  const panel = fakeWindow('panel');
  panel.isContentProtected = () => panel.protectedNow;
  windows = [panel];
  try {
    await getSourcesWithoutFriday({ types: ['screen'] });
    assert.deepEqual(panel.calls, [true, false]);
    assert.equal(panel.protectedNow, false);
    // Already protected (e.g. by stealth) before the capture: left alone.
    panel.protectedNow = true;
    panel.calls = [];
    await getSourcesWithoutFriday({ types: ['screen'] });
    assert.deepEqual(panel.calls, []);
    assert.equal(panel.protectedNow, true);
  } finally {
    windows = [];
  }
});

test('a window that refuses protection does not break the capture or the others', async () => {
  const broken = fakeWindow('broken');
  broken.setContentProtection = () => {
    throw new Error('window gone');
  };
  const panel = fakeWindow('panel');
  windows = [broken, panel];
  let protectedDuringCapture = null;
  electronMock.desktopCapturer.getSources = async () => {
    protectedDuringCapture = panel.protectedNow;
    return defaultGetSources();
  };
  try {
    const sources = await getSourcesWithoutFriday({ types: ['screen'] });
    assert.equal(sources.length, 1);
    assert.equal(protectedDuringCapture, true);
    assert.equal(panel.protectedNow, false);
    // The shield depth went back to zero: the next capture shields again.
    panel.calls = [];
    windows = [panel];
    await getSourcesWithoutFriday({ types: ['screen'] });
    assert.deepEqual(panel.calls, [true, false]);
  } finally {
    electronMock.desktopCapturer.getSources = defaultGetSources;
    windows = [];
  }
});
