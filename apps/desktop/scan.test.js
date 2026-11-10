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
