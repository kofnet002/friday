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
