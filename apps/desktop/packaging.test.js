// Every local module the main process loads must be listed in
// build.files, or the packaged app dies on startup behind an error dialog
// (this happened when scan.js was added without updating the list).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('./package.json');

function localRequires(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return [...src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map((m) => {
    const rel = path.normalize(m[1]);
    return rel.endsWith('.js') || rel.endsWith('.json') || rel.endsWith('.node')
      ? rel
      : `${rel}.js`;
  });
}

test('every module reachable from main.js is packaged', () => {
  const packaged = new Set(pkg.build.files.filter((f) => !f.includes('*')));
  const seen = new Set();
  const queue = [pkg.main || 'main.js', 'preload.js'];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.js')) continue;
    for (const dep of localRequires(file)) queue.push(dep);
  }
  const missing = [...seen].filter((f) => f.endsWith('.js') && !packaged.has(f));
  assert.deepEqual(missing, [], `add to build.files in package.json: ${missing.join(', ')}`);
});
