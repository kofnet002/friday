const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'native', 'stealth.mm');
const outputDir = path.join(projectRoot, 'build', 'Release');
const outputPath = path.join(outputDir, 'friday-stealth.node');
const nodePrefix = process.config.variables.node_prefix;
const includeDir = path.join(nodePrefix, 'include', 'node');

if (process.platform !== 'darwin') {
  console.log('Skipping friday-stealth build on non-macOS platform');
  process.exit(0);
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Missing source file: ${sourcePath}`);
}

if (!fs.existsSync(includeDir)) {
  throw new Error(`Missing Node headers: ${includeDir}`);
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
