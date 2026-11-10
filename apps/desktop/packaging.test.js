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

test('packaged Electron runtime uses the locally installed ARM64 distribution', () => {
  assert.equal(pkg.build.mac.target[0].arch.includes('arm64'), true);
  assert.equal(typeof pkg.build.electronDist, 'string');
  assert.equal(fs.existsSync(path.resolve(__dirname, pkg.build.electronDist)), true);
});

test('backend packaging pins the PyInstaller build tool', () => {
  const backendPackage = require('../backend/package.json');
  const backendProject = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'backend', 'pyproject.toml'),
    'utf8',
  );
  assert.match(backendPackage.scripts['build:binary'], /uv run --group build pyinstaller/);
  assert.match(backendPackage.scripts['build:binary'], /packaging\/smoke_test\.py/);
  assert.match(backendProject, /pyinstaller==6\.22\.3/);
});

test('macOS packaging produces a DMG and updater ZIP for the GitHub release feed', () => {
  const targets = pkg.build.mac.target.map((target) => target.target);
  assert.deepEqual(targets, ['dmg', 'zip']);
  assert.deepEqual(pkg.build.publish, [
    {
      provider: 'github',
      owner: 'kofnet002',
      repo: 'friday',
      releaseType: 'release',
    },
  ]);
});

test('local packaging and publishing are separate explicit commands', () => {
  assert.match(pkg.scripts.dist, /--publish never/);
  assert.match(pkg.scripts['release:mac'], /scripts\/release-mac\.js/);
  assert.notEqual(pkg.scripts.dist, pkg.scripts['release:mac']);
  const rootPackage = require('../../package.json');
  assert.equal(rootPackage.scripts['package:mac'], 'pnpm --filter @friday/desktop dist');
  assert.equal(rootPackage.scripts['release:mac'], 'pnpm --filter @friday/desktop release:mac');
});

test('local DMG builds use an ad-hoc signature instead of auto-selecting a keychain identity', () => {
  assert.match(pkg.scripts.dist, /-c\.mac\.identity=-/);
  assert.equal(pkg.build.mac.identity, undefined);
  assert.equal(pkg.build.mac.hardenedRuntime, false);
});

test('release packaging keeps Developer ID signing enabled', () => {
  const releaseScript = fs.readFileSync(path.join(__dirname, 'scripts', 'release-mac.js'), 'utf8');
  assert.doesNotMatch(releaseScript, /-c\.mac\.identity=null/);
  assert.match(releaseScript, /-c\.mac\.hardenedRuntime=true/);
});

test('release preflight requires a version, GitHub token, signing identity, and notarization credentials', () => {
  const { validateReleaseEnvironment } = require('./scripts/release-mac');
  const validEnv = {
    GH_TOKEN: 'github-token',
    CSC_NAME: 'Developer ID Application: Friday',
    APPLE_API_KEY: '/tmp/AuthKey.p8',
    APPLE_API_KEY_ID: 'ABC123',
    APPLE_API_ISSUER: 'issuer-id',
  };
  assert.doesNotThrow(() => validateReleaseEnvironment('0.0.2', validEnv));
  assert.throws(
    () => validateReleaseEnvironment('0.0.2', { ...validEnv, GH_TOKEN: '' }),
    /GH_TOKEN/,
  );
  assert.throws(
    () => validateReleaseEnvironment('0.0.2', { ...validEnv, CSC_NAME: '' }),
    /CSC_NAME/,
  );
  assert.throws(
    () =>
      validateReleaseEnvironment('0.0.2', { ...validEnv, CSC_NAME: 'Apple Development: Friday' }),
    /Developer ID Application/,
  );
  assert.throws(
    () =>
      validateReleaseEnvironment('0.0.2', {
        GH_TOKEN: 'github-token',
        CSC_NAME: 'Developer ID Application: Friday',
      }),
    /Notarization/,
  );
  assert.throws(() => validateReleaseEnvironment('not-semver', validEnv), /semantic version/);
});
