// Answers live in one list, but AI Help shows only answers to spoken/typed
// questions and the Screen tab only answers to on-screen questions. Each view
// keeps its own selected index into the shared list; these helpers keep those
// indices inside their own view.

/**
 * @typedef {{ fromScreen?: boolean }} ListEntry
 */

/** @param {ListEntry | undefined} entry @param {boolean} fromScreen */
function inList(entry, fromScreen) {
  return Boolean(entry) && Boolean(entry && entry.fromScreen) === fromScreen;
}

/** The index when it points at an entry of this list, else -1.
 * @param {ListEntry[]} entries @param {number} index @param {boolean} fromScreen */
function resolveIndex(entries, index, fromScreen) {
  return index >= 0 && index < entries.length && inList(entries[index], fromScreen) ? index : -1;
}

/** @param {ListEntry[]} entries @param {boolean} fromScreen */
function latestIndex(entries, fromScreen) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (inList(entries[i], fromScreen)) return i;
  }
  return -1;
}

/** True when nothing in this list is selected or the newest one is.
 * @param {ListEntry[]} entries @param {number} index @param {boolean} fromScreen */
function isAtLatest(entries, index, fromScreen) {
  const current = resolveIndex(entries, index, fromScreen);
  return current < 0 || current === latestIndex(entries, fromScreen);
}

/** The previous (-1) or next (1) entry of the same list; stays put at the ends.
 * @param {ListEntry[]} entries @param {number} index @param {-1 | 1} direction @param {boolean} fromScreen */
function stepIndex(entries, index, direction, fromScreen) {
  for (let i = index + direction; i >= 0 && i < entries.length; i += direction) {
    if (inList(entries[i], fromScreen)) return i;
  }
  return index;
}

/** 1-based position of the selected entry within its list, and the list size.
 * @param {ListEntry[]} entries @param {number} index @param {boolean} fromScreen */
function listPosition(entries, index, fromScreen) {
  let count = 0;
  let position = 0;
  entries.forEach((entry, i) => {
    if (!inList(entry, fromScreen)) return;
    count += 1;
    if (i === index) position = count;
  });
  return { position, count };
}

/**
 * Where a list's selection lands after the entry at `removed` is deleted.
 * Viewing the removed entry moves to its previous neighbor in the same list
 * (else the next one, else nothing); other selections just shift.
 * @param {ListEntry[]} entries the list before removal
 * @param {number} index @param {number} removed @param {boolean} fromScreen
 */
function indexAfterRemoval(entries, index, removed, fromScreen) {
  if (index < 0) return index;
  if (index < removed) return index;
  if (index > removed) return index - 1;
  const before = stepIndex(entries, removed, -1, fromScreen);
  if (before !== removed) return before;
  const after = stepIndex(entries, removed, 1, fromScreen);
  return after !== removed ? after - 1 : -1;
}

module.exports = {
  inList,
  resolveIndex,
  latestIndex,
  isAtLatest,
  stepIndex,
  listPosition,
  indexAfterRemoval,
};
