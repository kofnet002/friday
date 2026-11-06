import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeListbox, placeTooltip } from './overlay-position.ts';

const VIEW = { width: 800, height: 400 };
const TIP = { width: 200, height: 30 };

test('sits centered below the anchor when there is room', () => {
  const pos = placeTooltip({ left: 300, top: 100, width: 40, height: 20 }, TIP, VIEW);
  assert.deepEqual(pos, { left: 220, top: 126 });
});

test('flips above the anchor near the bottom edge', () => {
  const pos = placeTooltip({ left: 300, top: 370, width: 40, height: 20 }, TIP, VIEW);
  assert.equal(pos.top, 370 - 6 - 30);
});

test('is clamped inside the left and right edges', () => {
  assert.equal(placeTooltip({ left: 0, top: 10, width: 20, height: 20 }, TIP, VIEW).left, 4);
  assert.equal(placeTooltip({ left: 790, top: 10, width: 10, height: 20 }, TIP, VIEW).left, 596);
});

test('a window too short for either side still keeps the tip on screen', () => {
  const pos = placeTooltip({ left: 10, top: 20, width: 20, height: 20 }, TIP, {
    width: 800,
    height: 60,
  });
  assert.ok(pos.top >= 4 && pos.top + TIP.height <= 60);
});

test('a dropdown opens below when it fits', () => {
  const p = placeListbox({ left: 10, top: 50, width: 120, height: 30 }, 200, VIEW);
  assert.deepEqual(p, { left: 10, top: 82, width: 120, maxHeight: 200, above: false });
});

test('a dropdown near the bottom opens above, capped to the room there', () => {
  const p = placeListbox({ left: 10, top: 300, width: 120, height: 30 }, 500, VIEW);
  assert.equal(p.above, true);
  assert.equal(p.maxHeight, 300 - 2 - 4);
});

test('in a short window the dropdown takes the bigger side and scrolls', () => {
  const p = placeListbox({ left: 10, top: 40, width: 120, height: 30 }, 300, {
    width: 800,
    height: 120,
  });
  assert.equal(p.above, false);
  assert.equal(p.maxHeight, 120 - 72 - 4);
});
