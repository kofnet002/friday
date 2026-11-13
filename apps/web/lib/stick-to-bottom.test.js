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

test('only the reader scrolling to the bottom pins it; a new page unpins', () => {
  const pin = screenPin();
  pin.newPage(0);
  pin.onScroll(atBottom, 1000);
  assert.equal(pin.pinned, true);
  pin.newPage(2000);
  assert.equal(pin.pinned, false);
});

test('our own scroll to the bottom keeps the pin while streaming', () => {
  const pin = screenPin();
  pin.newPage(0);
  pin.onScroll(atBottom, 1000);
  // A token grew the content and we followed it to the new bottom.
  pin.ownScroll(1100, 700);
  pin.onScroll({ scrollTop: 700, scrollHeight: 1100, clientHeight: 400 }, 1110);
  assert.equal(pin.pinned, true);
});

test('a pinned reader scrolling up between tokens unpins, even right after our scroll', () => {
  const pin = screenPin();
  pin.newPage(0);
  pin.onScroll(atBottom, 1000);
  for (let t = 1100; t < 1500; t += 50) {
    // Streaming: every token follows the bottom.
    pin.ownScroll(t, 600);
    pin.onScroll(atBottom, t + 5);
  }
  assert.equal(pin.pinned, true);
  // The reader scrolls up 20 ms after a token's scroll.
  pin.ownScroll(1500, 600);
  pin.onScroll({ scrollTop: 540, scrollHeight: 1000, clientHeight: 400 }, 1520);
  assert.equal(pin.pinned, false);
  // The next token does not follow (the panel only follows while pinned), and
  // a later scroll event at the reader's position keeps it unpinned.
  pin.onScroll(midway, 1600);
  assert.equal(pin.pinned, false);
});
