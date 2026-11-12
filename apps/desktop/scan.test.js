const test = require('node:test');
const assert = require('node:assert/strict');
const { ScanSelector, hammingDistance } = require('./scan');

const hash = (n) => Uint8Array.from({ length: 8 }, (_, i) => (i === 0 ? n : 0));

test('keeps the first, novel, and final scan frames in capture order', () => {
  const selector = new ScanSelector({ maxFrames: 4, distanceThreshold: 2 });
  assert.equal(selector.add({ hash: hash(0), base64: 'first' }).kept, true);
  assert.equal(selector.add({ hash: hash(0), base64: 'duplicate' }).kept, false);
  assert.equal(selector.add({ hash: hash(15), base64: 'middle' }).kept, true);
  selector.finish({ hash: hash(30), base64: 'final' });
  assert.deepEqual(
    selector.frames.map((frame) => frame.base64),
    ['first', 'middle', 'final'],
  );
});

test('selector signals its hard frame cap without exceeding it', () => {
  const selector = new ScanSelector({ maxFrames: 2, distanceThreshold: 2 });
  selector.add({ hash: hash(0), base64: 'first' });
  const result = selector.add({ hash: hash(15), base64: 'second' });
  assert.equal(result.limitReached, true);
  assert.equal(selector.frames.length, 2);
});

test('hamming distance counts changed bits', () => {
  assert.equal(hammingDistance(hash(0), hash(3)), 2);
});

const { ScanSelector: Selector2, signatureDistance, autoFinishReason } = require('./scan');

const sig = (value) => Uint8Array.from({ length: 16 }, () => value);

test('signature distance is the mean absolute pixel difference', () => {
  assert.equal(signatureDistance(sig(10), sig(10)), 0);
  assert.equal(signatureDistance(sig(10), sig(14)), 4);
  assert.equal(signatureDistance(null, sig(1)), Infinity);
});

test('manual capture keeps a frame the coarse hash would drop, but not an identical view', () => {
  const selector = new Selector2({ maxFrames: 4, distanceThreshold: 8 });
  selector.add({ hash: hash(0), sig: sig(10), base64: 'top' });
  assert.equal(selector.add({ hash: hash(1), sig: sig(30), base64: 'coarse-dupe' }).kept, false);
  assert.equal(selector.addManual({ hash: hash(1), sig: sig(30), base64: 'settled' }).kept, true);
  assert.equal(selector.addManual({ hash: hash(1), sig: sig(30), base64: 'same' }).kept, false);
  assert.deepEqual(
    selector.frames.map((frame) => frame.base64),
    ['top', 'settled'],
  );
});

test('auto-finishes after scrolling stops, waits longer when nothing was scrolled', () => {
  const base = { startedAt: 0, idleAfterScrollMs: 4000, idleWithoutScrollMs: 12000 };
  // Scrolled, then still for 3s: keep going.
  assert.equal(autoFinishReason({ ...base, scrolled: true, lastMotionAt: 5000, now: 8000 }), null);
  // Scrolled, then still for 4s: finish.
  assert.equal(
    autoFinishReason({ ...base, scrolled: true, lastMotionAt: 5000, now: 9000 }),
    'idle',
  );
  // Never scrolled: a short pause is not the end of the scan.
  assert.equal(autoFinishReason({ ...base, scrolled: false, lastMotionAt: 0, now: 9000 }), null);
  assert.equal(autoFinishReason({ ...base, scrolled: false, lastMotionAt: 0, now: 12000 }), 'idle');
});
