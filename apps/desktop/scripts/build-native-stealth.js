const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'native', 'stealth.mm');
const outputDir = path.join(projectRoot, 'build', 'Release');
const outputPath = path.join(outputDir, 'friday-stealth.node');
// node_prefix is empty for some installs (nvm); the headers then sit next to
// the running binary (<prefix>/bin/node -> <prefix>/include/node).
const includeDir = [
  process.config.variables.node_prefix,
  path.resolve(process.execPath, '..', '..'),
]
  .filter(Boolean)
  .map((prefix) => path.join(prefix, 'include', 'node'))
  .find((dir) => fs.existsSync(path.join(dir, 'node_api.h')));

if (process.platform !== 'darwin') {
  console.log('Skipping friday-stealth build on non-macOS platform');
  process.exit(0);
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Missing source file: ${sourcePath}`);
}

if (!includeDir) {
  throw new Error(`Missing Node headers (node_api.h) for ${process.execPath}`);
}

fs.mkdirSync(outputDir, { recursive: true });

const sdkPath = execFileSync('xcrun', ['--show-sdk-path'], {
  encoding: 'utf8',
}).trim();

const args = [
  '-std=c++17',
  '-fobjc-arc',
  '-I',
  includeDir,
  '-isysroot',
  sdkPath,
  '-framework',
  'AppKit',
  '-framework',
  'Foundation',
  '-framework',
  'CoreGraphics',
  '-dynamiclib',
  '-undefined',
  'dynamic_lookup',
  sourcePath,
  '-o',
  outputPath,
];

execFileSync('clang++', args, {
  stdio: 'inherit',
});

console.log(`Built ${path.relative(projectRoot, outputPath)}`);
