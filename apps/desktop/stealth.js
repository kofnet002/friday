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

module.exports = {
  applyToWindow,
  isAvailable,
  statusShape,
};
