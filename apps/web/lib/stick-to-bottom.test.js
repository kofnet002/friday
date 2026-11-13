const test = require('node:test');
const assert = require('node:assert/strict');
const { isNearBottom, STICK_THRESHOLD_PX } = require('./stick-to-bottom');

test('at or within the threshold of the bottom counts as at the bottom', () => {
  assert.equal(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(
    isNearBottom({ scrollTop: 600 - STICK_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 }),
    true,
  );
});

test('scrolled up past the threshold does not', () => {
  assert.equal(
    isNearBottom({ scrollTop: 599 - STICK_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 }),
    false,
  );
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }), false);
});

test('content that fits without scrolling is at the bottom', () => {
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }), true);
});

test('a custom threshold is honoured', () => {
  assert.equal(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }, 100), true);
  assert.equal(isNearBottom({ scrollTop: 499, scrollHeight: 1000, clientHeight: 400 }, 100), false);
});
