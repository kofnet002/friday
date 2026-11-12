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
const bundledServices = require('./services');
const stealth = require('./stealth');
const { autoUpdater } = require('electron-updater');
const { setupAutoUpdates } = require('./updater');

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
    stealthEnabled: DEFAULT_STEALTH_ENABLED,
    // Opt-in: when stealth enables, snap the cursor to a screen corner
    // so it doesn't sit over the Friday window during a screen-share.
    // Off by default because moving the cursor unprompted is disorienting
    // — flip it on in Settings if the gain is worth the surprise.
    moveCursorOnStealth: false,
    codingDisplayId: null,
  },
});

const audio = new AudioSupervisor();
const coding = new CodingCapture();
let mainWindow = null;
// Click-through has two voters: the renderer (cursor over a
// [data-interactive] surface, from mousemove) and the drop-zone poller
// (cursor over a [data-drop-zone], from polling — the only signal that
// works while a file is being dragged in from Finder, since macOS sends no
// mouse moves to an ignored window during a drag). The window accepts the
// mouse when either says so.
let rendererInteractive = false;
let dropZoneInteractive = false;
let mouseInteractive = false;
let dropZones = [];
let dropZoneTimer = null;
const DROP_ZONE_POLL_MS = 50;
const MAX_DROP_ZONES = 8;
let tray = null;
let windowState = null;
let Store = null;
let stealthEnabled = DEFAULT_STEALTH_ENABLED;
let stealthStatus = stealth.statusShape({ enabled: DEFAULT_STEALTH_ENABLED });
let bundledRedisAvailable = null;
let finishingServiceShutdown = false;
let checkForUpdates = async () => null;
let updatesInitialized = false;
let screenPermissionReminderShown = false;

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
    redisAvailable: bundledRedisAvailable,
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
  applyWindowLevel(preferences);
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
    [
      'CommandOrControl+Shift+S',
      () => {
        if (coding.scanning) coding.finishGuidedScan();
        else coding.startGuidedScan(getWindowState().preferences.codingDisplayId);
      },
    ],
  ];
  for (const [accelerator, handler] of bindings) {
    globalShortcut.register(accelerator, handler);
  }
}

async function startPackagedServices() {
  try {
    const result = await bundledServices.startBundledServices({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      logsPath: app.getPath('logs'),
      electronPath: process.execPath,
      onUnexpectedExit: async (message) => {
        await dialog.showMessageBox({ type: 'error', title: 'Friday stopped working', message });
        app.quit();
      },
    });
    bundledRedisAvailable = result.redisAvailable;
    return true;
  } catch (error) {
    if (error instanceof bundledServices.ServicesStoppedError) return false;
    await bundledServices.stopBundledServices();
    await dialog.showMessageBox({
      type: 'error',
      title: 'Friday could not start',
      message: error instanceof Error ? error.message : String(error),
      detail:
        'Check that the web and backend services are not already running, then relaunch Friday.',
    });
    app.quit();
    return false;
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
        label: 'Check for Updates…',
        click: () => {
          void checkForUpdates();
        },
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]),
  );
}

audio.on('frame', (buffer, source) => {
  // ArrayBuffer transfers cleanly across IPC. Slice to drop excess capacity.
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  broadcast('audio:frame', { source, data });
});
audio.on('error', (msg) => broadcast('audio:error', msg));
audio.on('log', (msg) => broadcast('audio:log', msg));
audio.on('exit', (info) => broadcast('audio:exit', info));

coding.on('frame_processed', (info) => broadcast('coding:frame_processed', info));
coding.on('extraction_result', (payload) => broadcast('coding:extraction_result', payload));
// "Capture this section" is only bound while a scan runs, so the shortcut
// isn't stolen from other apps the rest of the time.
const SCAN_CAPTURE_ACCELERATOR = 'CommandOrControl+Shift+Enter';
let scanCaptureBound = false;
function syncScanCaptureShortcut(capturing) {
  if (capturing && !scanCaptureBound) {
    scanCaptureBound = globalShortcut.register(SCAN_CAPTURE_ACCELERATOR, () => {
      void coding.captureScanSection().then((result) => {
        // A kept view is announced via scan_view_captured below.
        if (result.ok && !result.kept) publishToast('This view is already captured');
      });
    });
  } else if (!capturing && scanCaptureBound) {
    globalShortcut.unregister(SCAN_CAPTURE_ACCELERATOR);
    scanCaptureBound = false;
  }
}
coding.on('scan_view_captured', ({ frames, maxFrames }) => {
  const remaining = maxFrames - frames;
  publishToast(
    remaining > 0
      ? `View ${frames} captured — scroll to the next part`
      : `View ${frames} captured — capture limit reached`,
  );
});
coding.on('scan_state', (payload) => {
  syncScanCaptureShortcut(payload.state === 'capturing');
  broadcast('coding:scan_state', payload);
});
coding.on('error', (msg) => broadcast('coding:error', msg));
coding.on('log', (msg) => broadcast('coding:log', msg));

// Returns true when microphone access is granted, prompting if needed.
async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') return true;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_e) {
    // ignore — user can grant later in System Settings
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  }
}

async function remindAboutScreenPermissionOnCaptureStart() {
  if (process.platform !== 'darwin' || screenPermissionReminderShown) return;
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  if (screenStatus === 'granted') return;

  screenPermissionReminderShown = true;
  await dialog.showMessageBox({
    type: 'info',
    title: 'Screen & System Audio Permission',
    message: 'Friday needs Screen & System Audio Recording permission to transcribe app audio.',
    detail:
      'Open System Settings → Privacy & Security → Screen & System Audio Recording, then enable Friday. Friday will now try to start audio capture.',
    buttons: ['Continue'],
  });
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
  rendererInteractive = false;
  dropZoneInteractive = false;
  mouseInteractive = false;
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
    if (!updatesInitialized) {
      updatesInitialized = true;
      ({ checkForUpdates } = setupAutoUpdates({ app, autoUpdater, dialog }));
    }
  });
}

ipcMain.handle('audio:start', async (_e, opts) => {
  await remindAboutScreenPermissionOnCaptureStart();
  const startOpts = { mic: Boolean(opts && opts.mic) };
  if (startOpts.mic && !(await ensureMicrophoneAccess())) {
    startOpts.mic = false;
    broadcast(
      'audio:log',
      '[friday] microphone access not granted — capturing system audio only. Enable Friday under System Settings → Privacy & Security → Microphone.',
    );
  }
  return audio.start(startOpts);
});
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
ipcMain.handle('coding:pause', () => coding.pause());
ipcMain.handle('coding:resume', () => coding.resume());
ipcMain.handle('coding:force_extract', () => coding.forceExtract());
ipcMain.handle('coding:isActive', () => coding.isActive());
ipcMain.handle('coding:set_provider', (_evt, provider) => {
  coding.setProvider(provider);
  return { ok: true, provider: coding.provider };
});
ipcMain.handle('coding:set_claude_model', (_evt, model) => {
  coding.setClaudeModel(model);
  return { ok: true, model: coding.claudeModel };
});
ipcMain.handle('coding:scan:start', (_evt, displayId) =>
  coding.startGuidedScan(displayId || getWindowState().preferences.codingDisplayId),
);
ipcMain.handle('coding:scan:finish', () => coding.finishGuidedScan());
ipcMain.handle('coding:scan:cancel', () => coding.cancelGuidedScan());
ipcMain.handle('coding:scan:capture', () => coding.captureScanSection());
ipcMain.handle('coding:scan:displays', () => coding.listDisplays());
ipcMain.handle('coding:scan:display', (_evt, displayId) => {
  if (windowState) windowState.set('preferences.codingDisplayId', displayId || null);
  return { ok: true };
});
ipcMain.handle(
  'coding:scan:get_display',
  () => getWindowState().preferences.codingDisplayId || null,
);
ipcMain.handle('window:status', () => buildStatusPayload());
ipcMain.handle('window:toggle_visibility', () => {
  toggleWindowVisibility();
  return buildStatusPayload();
});
ipcMain.handle('app:quit', () => {
  app.quit();
  return { ok: true };
});
ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.quit();
  return { ok: true };
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
// macOS does not deliver drags from other apps (Finder) to a window at the
// screen-saver level, even when it accepts the mouse, so while the cursor
// is over a drop zone the window steps down to the floating level (still
// above regular app windows) and returns to screen-saver when it leaves.
const DROP_ZONE_LEVEL = 'floating';

function applyWindowLevel(preferences = getWindowState().preferences) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(
    Boolean(preferences.alwaysOnTop),
    dropZoneInteractive ? DROP_ZONE_LEVEL : 'screen-saver',
  );
}

function applyMouseMode() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = rendererInteractive || dropZoneInteractive;
  if (next === mouseInteractive) return;
  mouseInteractive = next;
  if (next) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function pollDropZones() {
  let inside = false;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && dropZones.length) {
    const point = screen.getCursorScreenPoint();
    const bounds = mainWindow.getContentBounds();
    const zoom = mainWindow.webContents.getZoomFactor() || 1;
    // Zones are in CSS pixels relative to the page viewport.
    const x = (point.x - bounds.x) / zoom;
    const y = (point.y - bounds.y) / zoom;
    inside = dropZones.some(
      (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
    );
  }
  if (inside !== dropZoneInteractive) {
    dropZoneInteractive = inside;
    applyMouseMode();
    applyWindowLevel();
  }
}

function setDropZones(rects) {
  dropZones = (Array.isArray(rects) ? rects : [])
    .slice(0, MAX_DROP_ZONES)
    .map((r) => ({
      x: Number(r?.x),
      y: Number(r?.y),
      width: Number(r?.width),
      height: Number(r?.height),
    }))
    .filter(
      (r) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
  if (dropZones.length && dropZoneTimer === null) {
    dropZoneTimer = setInterval(pollDropZones, DROP_ZONE_POLL_MS);
  } else if (!dropZones.length && dropZoneTimer !== null) {
    clearInterval(dropZoneTimer);
    dropZoneTimer = null;
  }
  pollDropZones();
}

ipcMain.handle('window:set_interactive', (_evt, interactive) => {
  if (!mainWindow) return { ok: false };
  rendererInteractive = Boolean(interactive);
  applyMouseMode();
  return { ok: true, interactive: Boolean(interactive) };
});
ipcMain.handle('window:set_drop_zones', (_evt, rects) => {
  setDropZones(rects);
  return { ok: true, zones: dropZones.length };
});
ipcMain.handle('dialog:choose_folder', async () => {
  // Stealth-aware native picker when available; Electron's dialog otherwise.
  const native = stealth.chooseFolder(mainWindow, stealthEnabled, app.getPath('home'));
  if (native !== undefined) {
    return { path: (await native) || null, hidden: Boolean(stealthEnabled) };
  }
  // Attached to the overlay so it isn't hidden behind it (screen-saver level).
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: app.getPath('home'),
    buttonLabel: 'Add folder',
  });
  return { path: result.canceled ? null : result.filePaths[0] || null, hidden: false };
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
  windowState?.set('preferences.stealthEnabled', true);
  return applyStealthProtection();
});
ipcMain.handle('stealth:disable', () => {
  stealthEnabled = false;
  windowState?.set('preferences.stealthEnabled', false);
  return applyStealthProtection();
});
ipcMain.handle('stealth:status', () => stealthStatus);

app.whenReady().then(async () => {
  ({ default: Store } = await import('electron-store'));
  windowState = createWindowStateStore();
  stealthEnabled = getWindowState().preferences.stealthEnabled;
  stealthStatus = stealth.statusShape({ enabled: stealthEnabled });
  if (app.isPackaged && !(await startPackagedServices())) return;
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

app.on('before-quit', (event) => {
  audio.stop();
  coding.stop();
  globalShortcut.unregisterAll();
  if (app.isPackaged && !finishingServiceShutdown && bundledServices.hasRunningServices()) {
    event.preventDefault();
    finishingServiceShutdown = true;
    void bundledServices.stopBundledServices().finally(() => app.quit());
  }
});

if (app.isPackaged) {
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());
}
