// Rasterize build/icon.svg into all sizes macOS needs, then pack into an
// .icns via `iconutil`. Run with `pnpm --filter=@friday/desktop build:icon`.
//
// Why this exists: macOS app icons (.icns) are a multi-resolution container.
// `iconutil -c icns <dir>.iconset` expects PNGs named by size+@x convention.
// sharp handles the SVG→PNG rasterization; iconutil bundles them.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon.svg');
const ICONSET = path.join(ROOT, 'build', 'icon.iconset');
const OUT = path.join(ROOT, 'build', 'icon.icns');

// macOS iconutil naming convention. Each base size emits a @1x and @2x file
// at the appropriate pixel dimensions.
const SIZES = [
  { name: 'icon_16x16.png', px: 16 },
  { name: 'icon_16x16@2x.png', px: 32 },
  { name: 'icon_32x32.png', px: 32 },
  { name: 'icon_32x32@2x.png', px: 64 },
  { name: 'icon_128x128.png', px: 128 },
  { name: 'icon_128x128@2x.png', px: 256 },
  { name: 'icon_256x256.png', px: 256 },
  { name: 'icon_256x256@2x.png', px: 512 },
  { name: 'icon_512x512.png', px: 512 },
  { name: 'icon_512x512@2x.png', px: 1024 },
];

async function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`source SVG not found: ${SRC}`);
  }

  // Fresh iconset directory every run so stale files don't sneak into .icns.
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });

  const svg = fs.readFileSync(SRC);
  for (const { name, px } of SIZES) {
    await sharp(svg, { density: 384 })
      .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(path.join(ICONSET, name));
    process.stdout.write(`  ${name} (${px}px)\n`);
  }

  // iconutil ships with macOS — fails clearly on other platforms.
  execFileSync('iconutil', ['-c', 'icns', '-o', OUT, ICONSET], { stdio: 'inherit' });
  process.stdout.write(`\nicon.icns → ${path.relative(process.cwd(), OUT)}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-icon failed: ${err.message}\n`);
  process.exit(1);
});
