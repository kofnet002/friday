// electron-builder afterPack hook (runs before signing): copy the staged
// Next.js server into Contents/Resources/web. It can't go through
// `extraResources` — electron-builder filters node_modules there, dropping the
// pnpm store the server's relative symlinks point into.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const dest = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'web');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, '..', 'bundle', 'web'), dest, {
    recursive: true,
    verbatimSymlinks: true,
  });
};
