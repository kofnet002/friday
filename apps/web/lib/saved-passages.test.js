const test = require('node:test');
const assert = require('node:assert/strict');
const { passagePreview } = require('./saved-passages');

test('passagePreview collapses whitespace', () => {
  assert.equal(passagePreview('a   b\nc'), 'a b c');
});

test('passagePreview cuts long text to max with an ellipsis', () => {
  const out = passagePreview('x'.repeat(200));
  assert.equal(out.length, 120);
  assert.ok(out.endsWith('…'));
});

test('passagePreview leaves short text alone', () => {
  assert.equal(passagePreview('short'), 'short');
});

test('saved screenshots open in the in-panel lightbox, never a new window', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../app/session/saved-passages.tsx'), 'utf8');
  assert.doesNotMatch(source, /window\.open/);
  assert.match(source, /aria-label="Close screenshot"/);
});
