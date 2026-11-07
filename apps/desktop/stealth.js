const path = require('node:path');

const addonPath = path.join(__dirname, 'build', 'Release', 'friday-stealth.node');

let nativeAddon = null;
let loadError = null;

try {
  nativeAddon = require(addonPath);
} catch (error) {
  loadError = error;
}

function statusShape(overrides = {}) {
  return {
    enabled: false,
    contentProtection: false,
    nativeSupported: process.platform === 'darwin',
    nativeApplied: false,
    error: loadError ? String(loadError.message || loadError) : null,
    ...overrides,
  };
}

function isAvailable() {
  return Boolean(nativeAddon?.setWindowStealth);
}

function applyToWindow(win, enabled) {
  if (!win || win.isDestroyed()) {
    return statusShape({ enabled, error: 'window unavailable' });
  }

  win.setContentProtection(Boolean(enabled));

  if (process.platform !== 'darwin') {
    return statusShape({
      enabled,
      contentProtection: Boolean(enabled),
      nativeSupported: false,
      nativeApplied: false,
      error: null,
    });
  }

  if (!isAvailable()) {
    return statusShape({
      enabled,
      contentProtection: Boolean(enabled),
      nativeApplied: false,
    });
  }

  try {
    const nativeApplied = Boolean(
      nativeAddon.setWindowStealth(win.getNativeWindowHandle(), enabled),
    );
    return statusShape({
      enabled,
      contentProtection: Boolean(enabled),
      nativeApplied,
      error: nativeApplied ? null : 'native window handle unavailable',
    });
  } catch (error) {
    return statusShape({
      enabled,
      contentProtection: Boolean(enabled),
      nativeApplied: false,
      error: String(error?.message || error),
    });
  }
}

/** Snap the OS cursor to a screen-coordinate point. Used on stealth
 *  enable (when the user has opted in) to push the cursor off the
 *  Friday overlay so its position doesn't leak the window during a
 *  screen-share. Silent no-op on non-macOS or when the native binding
 *  isn't available — calling this when stealth-enable is the wrong
 *  branch shouldn't crash the app. */
function moveCursor(x, y) {
  if (process.platform !== 'darwin') return false;
  if (!nativeAddon?.moveCursor) return false;
  try {
    return Boolean(nativeAddon.moveCursor(Number(x), Number(y)));
  } catch {
    return false;
  }
}

/** Native folder picker that honours stealth: with `hidden` it gets the
 *  same NSWindowSharingNone as the main window, so a screen share doesn't
 *  show it. Resolves to the chosen path, or null when cancelled. Returns
 *  undefined when the native binding can't do it (caller falls back to
 *  Electron's dialog). */
function chooseFolder(win, hidden, defaultPath) {
  if (process.platform !== 'darwin' || !nativeAddon?.chooseFolder) return undefined;
  const handle = win && !win.isDestroyed() ? win.getNativeWindowHandle() : null;
  return nativeAddon.chooseFolder(handle, Boolean(hidden), defaultPath ?? null);
}

module.exports = {
  applyToWindow,
  chooseFolder,
  isAvailable,
  moveCursor,
  statusShape,
};
