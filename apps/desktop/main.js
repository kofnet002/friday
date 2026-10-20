const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  systemPreferences,
  dialog,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { AudioSupervisor } = require('./audio');
const { CodingCapture } = require('./coding');
const stealth = require('./stealth');
const services = require('./services');

const DEV_URL = process.env.FRIDAY_WEB_URL || 'http://127.0.0.1:3333';
const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1.0;
const NUDGE_PX = 50;
const DEFAULT_STEALTH_ENABLED = true;
const DEFAULT_WINDOW_STATE = Object.freeze({
  bounds: {
    width: 1080,
    height: 620,
  },
  opacity: 1,
  preferences: {
    accessoryApp: true,
    alwaysOnTop: true,
    dockHidden: true,
    visibleOnAllWorkspaces: true,
    hideWindowControls: true,
    // Opt-in: when stealth enables, snap the cursor to a screen corner
    // so it doesn't sit over the Friday window during a screen-share.
    // Off by default because moving the cursor unprompted is disorienting
    // — flip it on in Settings if the gain is worth the surprise.
    moveCursorOnStealth: false,
  },
});

// Packaged builds keep data in ~/Library/Application Support/Friday and logs
// in ~/Library/Logs/Friday; the package name would otherwise give
// "@friday/desktop". Must run before anything reads userData.
if (app.isPackaged) {
  app.setName('Friday');
  app.setPath('userData', path.join(app.getPath('appData'), 'Friday'));
  app.setAppLogsPath(path.join(app.getPath('home'), 'Library', 'Logs', 'Friday'));
}

const audio = new AudioSupervisor();
const coding = new CodingCapture();
let mainWindow = null;
let tray = null;
let windowState = null;
let Store = null;
let stealthEnabled = DEFAULT_STEALTH_ENABLED;
let stealthStatus = stealth.statusShape({ enabled: DEFAULT_STEALTH_ENABLED });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function cloneDefaultWindowState() {
  return JSON.parse(JSON.stringify(DEFAULT_WINDOW_STATE));
}

function getDockHidden() {
  if (process.platform !== 'darwin' || !app.dock?.isVisible) return false;
  return !app.dock.isVisible();
}

function getAccessoryActive() {
  if (process.platform !== 'darwin') return false;
  return getWindowState().preferences.accessoryApp;
}

function createWindowStateStore() {
  return new Store({
    name: 'window-state',
    defaults: cloneDefaultWindowState(),
  });
}

function getWindowState() {
  if (!windowState) return cloneDefaultWindowState();
  const defaults = cloneDefaultWindowState();
  const bounds = windowState.get('bounds') ?? {};
  const preferences = windowState.get('preferences') ?? {};
  return {
    ...defaults,
    opacity: Number(windowState.get('opacity')) || defaults.opacity,
    bounds: {
      ...defaults.bounds,
      ...bounds,
    },
    preferences: {
      ...defaults.preferences,
      ...preferences,
    },
  };
}

function updateWindowState(patch) {
  if (!windowState) return getWindowState();
  const next = {
    ...getWindowState(),
    ...patch,
    bounds: {
      ...getWindowState().bounds,
      ...(patch?.bounds ?? {}),
    },
    preferences: {
      ...getWindowState().preferences,
      ...(patch?.preferences ?? {}),
    },
  };
  windowState.set(next);
  return next;
}

function makeTrayIcon() {
  // Owl silhouette — tray icons must be template images (single-color, macOS
  // recolors to match the menu bar). Body is one filled path with two
  // eye-shaped subpaths punched out via fill-rule="evenodd"; ear tufts are
  // separate filled triangles outside the body.
  const svg = `
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 7 L8 4 L8 10 Z" fill="black"/>
      <path d="M19 7 L16 4 L16 10 Z" fill="black"/>
      <path fill-rule="evenodd" d="M3 13 C3 6 21 6 21 13 L21 19 Q12 24 3 19 Z M8 12 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0 M16 12 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0" fill="black"/>
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  image.setTemplateImage(true);
  return image;
}

function buildStatusPayload() {
  const stored = getWindowState();
  return {
    visible: Boolean(mainWindow && mainWindow.isVisible()),
    focused: Boolean(mainWindow && mainWindow.isFocused()),
    opacity: mainWindow ? Number(mainWindow.getOpacity().toFixed(2)) : stored.opacity,
    bounds: mainWindow ? mainWindow.getBounds() : stored.bounds,
    preferences: stored.preferences,
    dockHidden: getDockHidden(),
    accessoryApp: getAccessoryActive(),
    stealth: stealthStatus,
  };
}

function publishStatus() {
  broadcast('window:status', buildStatusPayload());
}

function publishToast(message) {
  broadcast('window:toast', { message, timestamp: Date.now() });
}

function applyWindowPreferences() {
  if (!mainWindow || !windowState) return;
  const { preferences, opacity } = getWindowState();
  mainWindow.setAlwaysOnTop(Boolean(preferences.alwaysOnTop), 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(Boolean(preferences.visibleOnAllWorkspaces), {
    visibleOnFullScreen: Boolean(preferences.visibleOnAllWorkspaces),
  });
  mainWindow.setWindowButtonVisibility(!preferences.hideWindowControls);
  mainWindow.setOpacity(clamp(opacity, MIN_OPACITY, MAX_OPACITY));
}

function applyShellPreferences() {
  if (process.platform !== 'darwin') return;
  const { preferences } = getWindowState();
  app.setActivationPolicy(preferences.accessoryApp ? 'accessory' : 'regular');
  if (preferences.dockHidden || preferences.accessoryApp) {
    app.dock?.hide?.();
  } else {
    app.dock?.show?.();
  }
}

function applyStealthProtection() {
  const prev = stealthStatus?.enabled === true;
  stealthStatus = stealth.applyToWindow(mainWindow, stealthEnabled);
  publishStatus();
  // Cursor masking — only fires on the OFF→ON transition (so a no-op
  // re-apply during preference changes doesn't keep snapping the cursor
  // every time), and only when the user has opted in via the
  // moveCursorOnStealth preference.
  if (stealthEnabled && !prev && getWindowState().preferences.moveCursorOnStealth) {
    snapCursorToCorner();
  }
  return stealthStatus;
}

function snapCursorToCorner() {
  if (process.platform !== 'darwin') return;
  // Bottom-right of the display the Friday window is on, inset 8px so
  // the cursor isn't literally at (W, H) which some macOS versions snap
  // into menu bar gestures. screen.getCursorScreenPoint gives us the
  // current monitor; getDisplayNearestPoint resolves bounds.
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const x = display.bounds.x + display.bounds.width - 8;
    const y = display.bounds.y + display.bounds.height - 8;
    stealth.moveCursor(x, y);
  } catch (err) {
    console.warn('stealth.move_cursor_failed', err);
  }
}

function persistWindowBounds() {
  if (!mainWindow || !windowState) return;
  if (mainWindow.isMinimized() || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  updateWindowState({ bounds });
  publishStatus();
}

function centerWindow() {
  if (!mainWindow) return;
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const workArea = display.workArea;
  const { width, height } = mainWindow.getBounds();
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  mainWindow.setBounds({ x, y, width, height });
  persistWindowBounds();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  applyStealthProtection();
  mainWindow.focus();
  publishStatus();
}

function hideWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
  publishStatus();
}

function toggleWindowVisibility() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) hideWindow();
  else showWindow();
}

function adjustOpacity(delta) {
  if (!mainWindow || !windowState) return;
  const nextOpacity = clamp(mainWindow.getOpacity() + delta, MIN_OPACITY, MAX_OPACITY);
  mainWindow.setOpacity(nextOpacity);
  updateWindowState({ opacity: nextOpacity });
  publishStatus();
  publishToast(`Opacity ${Math.round(nextOpacity * 100)}%`);
}

function resetWindowState() {
  if (!mainWindow || !windowState) return;
  mainWindow.setOpacity(1);
  updateWindowState({ opacity: 1 });
  centerWindow();
  publishStatus();
  publishToast('Opacity reset and window centered');
}

function nudgeWindow(deltaX) {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({ ...bounds, x: bounds.x + deltaX });
  persistWindowBounds();
  publishToast(`Window moved ${deltaX < 0 ? 'left' : 'right'}`);
}

function registerGlobalHotkeys() {
  const bindings = [
    ['CommandOrControl+Shift+\\', toggleWindowVisibility],
    ['CommandOrControl+Shift+[', () => nudgeWindow(-NUDGE_PX)],
    ['CommandOrControl+Shift+]', () => nudgeWindow(NUDGE_PX)],
    ['CommandOrControl+Shift+-', () => adjustOpacity(-OPACITY_STEP)],
    ['CommandOrControl+Shift+=', () => adjustOpacity(OPACITY_STEP)],
    ['CommandOrControl+Shift+0', resetWindowState],
    // ⌘Q only reaches a focused app; the overlay usually isn't. ⌘⇧Q and
    // ⌘⌥⇧Q are macOS Log Out, so quit lives on ⌘⌥Q.
    ['CommandOrControl+Alt+Q', () => app.quit()],
  ];
  for (const [accelerator, handler] of bindings) {
    globalShortcut.register(accelerator, handler);
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Friday');
  tray.on('click', () => toggleWindowVisibility());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show / Hide Friday',
        click: () => toggleWindowVisibility(),
      },
      {
        label: 'Center Window',
        click: () => {
          showWindow();
          centerWindow();
        },
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]),
  );
}

audio.on('frame', (buffer) => {
  // ArrayBuffer transfers cleanly across IPC. Slice to drop excess capacity.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  broadcast('audio:frame', ab);
});
audio.on('error', (msg) => broadcast('audio:error', msg));
audio.on('log', (msg) => broadcast('audio:log', msg));
audio.on('exit', (info) => broadcast('audio:exit', info));

coding.on('frame_processed', (info) => broadcast('coding:frame_processed', info));
coding.on('extraction_result', (payload) => broadcast('coding:extraction_result', payload));
coding.on('error', (msg) => broadcast('coding:error', msg));
coding.on('log', (msg) => broadcast('coding:log', msg));

async function ensurePermissions() {
  // Microphone (separate TCC bucket from screen recording)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch (_e) {
      // ignore — user can grant later in System Settings
    }
  }
  // Screen capture access status (covers system audio via ScreenCaptureKit)
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  if (screenStatus !== 'granted') {
    dialog.showMessageBox({
      type: 'info',
      title: 'Screen & System Audio Permission',
      message: 'Friday needs Screen & System Audio Recording permission to transcribe app audio.',
      detail:
        'Open System Settings → Privacy & Security → Screen & System Audio Recording, then enable Friday. The first audio:start call will also trigger the system prompt.',
      buttons: ['OK'],
    });
  }
}

// Packaged app only: boot the bundled backend + web server (dev uses
// `pnpm dev`). Returns false after telling the user why it couldn't start.
async function startBundledServices() {
  try {
    const { envPath, createdEnv } = await services.startBundledServices({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      logsPath: app.getPath('logs'),
      electronPath: process.execPath,
      onUnexpectedExit: (message) => {
        dialog.showErrorBox(
          'Friday stopped working',
          `${message}\n\nRelaunch Friday to restart it.`,
        );
        app.quit();
      },
    });
    if (createdEnv) {
      // Not awaited: the window still opens behind the prompt.
      dialog
        .showMessageBox({
          type: 'info',
          title: 'Add your API keys',
          message: 'Friday created a settings file for your API keys.',
          detail: `Fill in ${envPath} (at least DEEPGRAM_API_KEY plus one LLM key), save it, then quit and relaunch Friday from the menu bar.`,
          buttons: ['Open settings file', 'Later'],
          defaultId: 0,
        })
        .then(({ response }) => {
          if (response === 0) shell.openPath(envPath);
        });
    }
    return true;
  } catch (err) {
    // Interrupted by a quit — nothing went wrong.
    if (err instanceof services.ServicesStoppedError) return false;
    await services.stopBundledServices();
    dialog.showErrorBox('Friday could not start', err instanceof Error ? err.message : String(err));
    app.quit();
    return false;
  }
}

function createWindow() {
  const persisted = getWindowState();
  mainWindow = new BrowserWindow({
    width: persisted.bounds.width,
    height: persisted.bounds.height,
    x: persisted.bounds.x,
    y: persisted.bounds.y,
    minWidth: 720,
    minHeight: 120,
    resizable: true,
    title: 'Friday',
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  applyWindowPreferences();
  applyStealthProtection();
  // Default to click-through so only explicit interactive regions (the
  // control bar, popovers, modals) capture mouse events. The renderer
  // toggles this on hover over its data-interactive surfaces.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  // Launch directly into the floating control bar.
  mainWindow.loadURL(`${DEV_URL}/session`);
  mainWindow.on('move', persistWindowBounds);
  mainWindow.on('resize', persistWindowBounds);
  mainWindow.on('show', () => {
    applyStealthProtection();
    publishStatus();
  });
  mainWindow.on('hide', publishStatus);
  mainWindow.on('restore', () => {
    applyStealthProtection();
    publishStatus();
  });
  mainWindow.on('focus', publishStatus);
  mainWindow.on('blur', publishStatus);
  mainWindow.webContents.on('did-finish-load', () => {
    applyStealthProtection();
    publishStatus();
  });
}

ipcMain.handle('audio:start', () => audio.start());
ipcMain.handle('audio:stop', () => {
  audio.stop();
  return { ok: true };
});
ipcMain.handle('audio:pause', () => {
  audio.pause();
  return { ok: true };
});
ipcMain.handle('audio:resume', () => {
  audio.resume();
  return { ok: true };
});
ipcMain.handle('audio:isRunning', () => audio.isRunning());

ipcMain.handle('coding:start', (_evt, sessionId) => coding.start(sessionId));
ipcMain.handle('coding:stop', () => {
  coding.stop();
  return { ok: true };
});
ipcMain.handle('coding:force_extract', () => coding.forceExtract());
ipcMain.handle('coding:isActive', () => coding.isActive());
ipcMain.handle('coding:set_provider', (_evt, provider) => {
  coding.setProvider(provider);
  return { ok: true, provider: coding.provider };
});
ipcMain.handle('window:status', () => buildStatusPayload());
ipcMain.handle('window:quit_app', () => app.quit());
ipcMain.handle('window:toggle_visibility', () => {
  toggleWindowVisibility();
  return buildStatusPayload();
});
ipcMain.handle('window:center', () => {
  showWindow();
  centerWindow();
  return buildStatusPayload();
});
ipcMain.handle('window:update_preferences', (_evt, patch) => {
  const current = getWindowState();
  updateWindowState({
    preferences: {
      ...current.preferences,
      ...(patch ?? {}),
    },
  });
  applyShellPreferences();
  applyWindowPreferences();
  publishStatus();
  return buildStatusPayload();
});
ipcMain.handle('window:set_interactive', (_evt, interactive) => {
  if (!mainWindow) return { ok: false };
  if (interactive) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
  return { ok: true, interactive: Boolean(interactive) };
});
ipcMain.handle('window:set_opacity', (_evt, value) => {
  if (!mainWindow || !windowState) return buildStatusPayload();
  const nextOpacity = clamp(Number(value) || 1, MIN_OPACITY, MAX_OPACITY);
  mainWindow.setOpacity(nextOpacity);
  updateWindowState({ opacity: nextOpacity });
  publishStatus();
  return buildStatusPayload();
});
ipcMain.handle('stealth:enable', () => {
  stealthEnabled = true;
  return applyStealthProtection();
});
ipcMain.handle('stealth:disable', () => {
  stealthEnabled = false;
  return applyStealthProtection();
});
ipcMain.handle('stealth:status', () => stealthStatus);

// A second launch would find the first one's ports taken; focus it instead.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) showWindow();
  });
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  ({ default: Store } = await import('electron-store'));
  windowState = createWindowStateStore();
  applyShellPreferences();
  // Dev dock icon — packaged builds use build/icon.icns via the bundle, but
  // `electron .` falls back to the default Electron icon unless we set it.
  // Accessory mode (LSUIElement=true) hides the dock entirely in production,
  // so this only matters while developing with the dock visible.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, 'build', 'icon.icns');
    if (fs.existsSync(iconPath)) {
      try {
        app.dock.setIcon(iconPath);
      } catch {
        // setIcon throws if Electron can't read the .icns — non-fatal in dev.
      }
    }
  }
  if (app.isPackaged && !(await startBundledServices())) return;
  await ensurePermissions();
  createWindow();
  createTray();
  registerGlobalHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  audio.stop();
  coding.stop();
  if (process.platform !== 'darwin') app.quit();
});

// `kill`/logout send SIGTERM, which skips before-quit unless we route it
// through app.quit() — otherwise the bundled services outlive the app.
if (app.isPackaged) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => app.quit());
  }
}

app.on('before-quit', (event) => {
  audio.stop();
  coding.stop();
  globalShortcut.unregisterAll();
  // Hold the quit until the services have exited (SIGKILL after a grace
  // period) so none outlives the app holding its port; then quit again.
  // Also cancels a startup still in progress.
  const mustWait = services.hasRunningServices();
  const stopped = services.stopBundledServices();
  if (mustWait) {
    event.preventDefault();
    stopped.then(() => app.quit());
  }
});
