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

const { AudioSupervisor } = require('./audio');
const { CodingCapture } = require('./coding');
const stealth = require('./stealth');

const DEV_URL = process.env.FRIDAY_WEB_URL || 'http://127.0.0.1:3333';
const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1.0;
const NUDGE_PX = 50;
const DEFAULT_STEALTH_ENABLED = true;
const DEFAULT_WINDOW_STATE = Object.freeze({
  bounds: {
    width: 520,
    height: 720,
  },
  opacity: 1,
  preferences: {
    accessoryApp: true,
    alwaysOnTop: true,
    dockHidden: true,
    visibleOnAllWorkspaces: true,
    hideWindowControls: true,
  },
});

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
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <path d="M14.9 4.1c-.6 2.2-1.8 3.8-3.5 4.7l1.3 1.2c.6.6.8 1.3.6 2.1-.1.7-.5 1.3-1.1 1.7-.7.4-1.4.5-2.1.2l-3.1-1.2-2.8 1.5.8-2.9C3.5 10.4 3 9 3 7.4c0-1.8.6-3.2 1.9-4.4C6.2 1.7 7.8 1 9.7 1c2.1 0 3.8 1 5.2 3.1Z" fill="black"/>
      <path d="M10.2 5.1 16 3.2l-2.2 5.3" fill="black"/>
      <circle cx="7" cy="6.6" r="0.85" fill="white"/>
      <path d="M6.3 9.1c1 .6 2 .7 3.1.2" fill="none" stroke="white" stroke-width="1" stroke-linecap="round"/>
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
  stealthStatus = stealth.applyToWindow(mainWindow, stealthEnabled);
  publishStatus();
  return stealthStatus;
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

function createWindow() {
  const persisted = getWindowState();
  mainWindow = new BrowserWindow({
    width: persisted.bounds.width,
    height: persisted.bounds.height,
    x: persisted.bounds.x,
    y: persisted.bounds.y,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    title: 'Friday',
    backgroundColor: '#0a0a0a',
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
  mainWindow.loadURL(DEV_URL);
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
ipcMain.handle('window:status', () => buildStatusPayload());
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

app.whenReady().then(async () => {
  ({ default: Store } = await import('electron-store'));
  windowState = createWindowStateStore();
  applyShellPreferences();
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

app.on('before-quit', () => {
  audio.stop();
  coding.stop();
  globalShortcut.unregisterAll();
});
