// Assemble bundle/ — the services electron-builder copies into
// Friday.app/Contents/Resources (see `extraResources` in package.json).
// Run by `pnpm dist` after the web, backend and Swift builds.

const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const bundleDir = path.join(desktopRoot, 'bundle');
const webRoot = path.join(repoRoot, 'apps', 'web');

function requireSource(source, hint) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing ${source} — run \`${hint}\` first.`);
  }
  return source;
}

function copy(source, dest, options = {}) {
  fs.cpSync(source, dest, { recursive: true, ...options });
  console.log(`staged ${path.relative(desktopRoot, dest)}`);
}

fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });

copy(
  requireSource(
    path.join(repoRoot, 'apps', 'backend', 'dist', 'friday-backend'),
    'pnpm --filter @friday/backend build:binary',
  ),
  path.join(bundleDir, 'backend'),
  { verbatimSymlinks: true },
);

// The standalone server's node_modules are pnpm's relative symlinks into its
// own .pnpm store. Keep them as links: dereferencing copies a package away
// from the siblings it resolves (e.g. next → styled-jsx).
copy(
  requireSource(path.join(webRoot, '.next', 'standalone'), 'pnpm --filter @friday/web build'),
  path.join(bundleDir, 'web'),
  { verbatimSymlinks: true },
);
// Next leaves static assets out of standalone output; the server expects
// them beside server.js.
copy(
  path.join(webRoot, '.next', 'static'),
  path.join(bundleDir, 'web', 'apps', 'web', '.next', 'static'),
);
if (fs.existsSync(path.join(webRoot, 'public'))) {
  copy(path.join(webRoot, 'public'), path.join(bundleDir, 'web', 'apps', 'web', 'public'));
}

copy(
  requireSource(
    path.join(desktopRoot, 'swift', '.build', 'release', 'friday-audio'),
    'pnpm --filter @friday/desktop build:swift',
  ),
  path.join(bundleDir, 'friday-audio'),
);
copy(path.join(repoRoot, '.env.example'), path.join(bundleDir, 'env.example'));
