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

const { screenPin } = require('./stick-to-bottom');
const atBottom = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
const midway = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 };

test('a screen answer page starts unpinned, even when it fits', () => {
  const pin = screenPin();
  pin.newPage(0);
  assert.equal(pin.pinned, false);
  // Our own reveal scroll lands at the bottom: still not pinned.
  pin.onScroll(atBottom, 50);
  assert.equal(pin.pinned, false);
});

test('only the reader scrolling to the bottom pins it, and scrolling up unpins', () => {
  const pin = screenPin();
  pin.newPage(0);
  pin.onScroll(atBottom, 1000);
  assert.equal(pin.pinned, true);
  // Following the bottom is our own scroll: it keeps the pin.
  pin.ownScroll(1100);
  pin.onScroll(midway, 1120);
  assert.equal(pin.pinned, true);
  pin.onScroll(midway, 2000);
  assert.equal(pin.pinned, false);
  // A new page unpins again.
  pin.onScroll(atBottom, 3000);
  pin.newPage(4000);
  assert.equal(pin.pinned, false);
});
