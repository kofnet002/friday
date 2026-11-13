const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inList,
  resolveIndex,
  latestIndex,
  isAtLatest,
  stepIndex,
  listPosition,
  indexAfterRemoval,
} = require('./answer-lists');

// a = spoken, s = screen
const entries = [
  { id: 'a1' },
  { id: 's1', fromScreen: true },
  { id: 'a2', fromScreen: false },
  { id: 's2', fromScreen: true },
  { id: 's3', fromScreen: true },
];

test('inList splits spoken and screen entries', () => {
  assert.deepEqual(
    entries.filter((e) => inList(e, false)).map((e) => e.id),
    ['a1', 'a2'],
  );
  assert.deepEqual(
    entries.filter((e) => inList(e, true)).map((e) => e.id),
    ['s1', 's2', 's3'],
  );
});

test('resolveIndex keeps an index only when it points into the list', () => {
  assert.equal(resolveIndex(entries, 2, false), 2);
  assert.equal(resolveIndex(entries, 1, false), -1);
  assert.equal(resolveIndex(entries, 1, true), 1);
  assert.equal(resolveIndex(entries, -1, true), -1);
  assert.equal(resolveIndex(entries, 9, true), -1);
});

test('latestIndex finds the newest entry of a list', () => {
  assert.equal(latestIndex(entries, false), 2);
  assert.equal(latestIndex(entries, true), 4);
  assert.equal(latestIndex([{ id: 'a' }], true), -1);
});

test('isAtLatest ignores the other list', () => {
  assert.equal(isAtLatest(entries, 2, false), true);
  assert.equal(isAtLatest(entries, 0, false), false);
  assert.equal(isAtLatest(entries, 3, true), false);
  assert.equal(isAtLatest(entries, 4, true), true);
  assert.equal(isAtLatest(entries, -1, true), true);
  // An index into the other list counts as nothing selected.
  assert.equal(isAtLatest(entries, 1, false), true);
});

test('stepIndex moves to the neighbor in the same list and stops at the ends', () => {
  assert.equal(stepIndex(entries, 0, 1, false), 2);
  assert.equal(stepIndex(entries, 2, 1, false), 2);
  assert.equal(stepIndex(entries, 2, -1, false), 0);
  assert.equal(stepIndex(entries, 0, -1, false), 0);
  assert.equal(stepIndex(entries, 1, 1, true), 3);
  assert.equal(stepIndex(entries, 4, -1, true), 3);
});

test('listPosition counts within the list only', () => {
  assert.deepEqual(listPosition(entries, 2, false), { position: 2, count: 2 });
  assert.deepEqual(listPosition(entries, 3, true), { position: 2, count: 3 });
  assert.deepEqual(listPosition(entries, -1, true), { position: 0, count: 3 });
  assert.deepEqual(listPosition([], -1, false), { position: 0, count: 0 });
});

test('indexAfterRemoval keeps each list on the right entry', () => {
  // Removing a2 (index 2): the spoken view falls back to a1; the screen view
  // on s2 (index 3) shifts down to index 2.
  assert.equal(indexAfterRemoval(entries, 2, 2, false), 0);
  assert.equal(indexAfterRemoval(entries, 3, 2, true), 2);
  // Removing s1 (index 1) while viewing it: the next screen entry, s2, is now at 2.
  assert.equal(indexAfterRemoval(entries, 1, 1, true), 2);
  // An index before the removed one is unchanged.
  assert.equal(indexAfterRemoval(entries, 0, 3, false), 0);
  // Removing the only entry of a list leaves nothing selected.
  assert.equal(indexAfterRemoval([{ id: 'a' }, { id: 's', fromScreen: true }], 1, 1, true), -1);
});
