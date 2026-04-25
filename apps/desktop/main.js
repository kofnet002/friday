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
const { WindowStateStore } = require('./window-state');

const DEV_URL = process.env.FRIDAY_WEB_URL || 'http://127.0.0.1:3333';
const isDev = process.env.NODE_ENV === 'development';
const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1.0;
const NUDGE_PX = 50;
const DEFAULT_STEALTH_ENABLED = true;

const audio = new AudioSupervisor();
const coding = new CodingCapture();
let mainWindow = null;
let tray = null;
let windowState = null;
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

function makeTrayIcon() {
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M13.8 5.7c0 4-2.7 7.1-6.2 7.1-1 0-1.9-.2-2.7-.7l-2.2.9.8-2.2C2.8 10 2.4 8.9 2.4 7.7c0-4 2.7-7.1 6.2-7.1 3.5 0 5.2 2.2 5.2 5.1Z"
        fill="black"
      />
      <path d="M10.2 4.8 15.6 3l-2 5.1" fill="black"/>
      <circle cx="6.2" cy="7" r="0.9" fill="white"/>
      <circle cx="9" cy="7" r="0.9" fill="white"/>
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  image.setTemplateImage(true);
  return image;
}

function buildStatusPayload() {
  const stored = windowState?.getState() ?? {
    bounds: { width: 520, height: 720 },
    opacity: 1,
    preferences: {
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      hideWindowControls: true,
    },
  };
  return {
    visible: Boolean(mainWindow && mainWindow.isVisible()),
    focused: Boolean(mainWindow && mainWindow.isFocused()),
    opacity: mainWindow ? Number(mainWindow.getOpacity().toFixed(2)) : stored.opacity,
    bounds: mainWindow ? mainWindow.getBounds() : stored.bounds,
    preferences: stored.preferences,
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
  const { preferences, opacity } = windowState.getState();
  mainWindow.setAlwaysOnTop(Boolean(preferences.alwaysOnTop), 'floating');
  mainWindow.setVisibleOnAllWorkspaces(Boolean(preferences.visibleOnAllWorkspaces), {
    visibleOnFullScreen: Boolean(preferences.visibleOnAllWorkspaces),
  });
  mainWindow.setWindowButtonVisibility(!preferences.hideWindowControls);
  mainWindow.setOpacity(clamp(opacity, MIN_OPACITY, MAX_OPACITY));
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
  windowState.update({ bounds });
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
  windowState.update({ opacity: nextOpacity });
  publishStatus();
  publishToast(`Opacity ${Math.round(nextOpacity * 100)}%`);
}

function resetWindowState() {
  if (!mainWindow || !windowState) return;
  mainWindow.setOpacity(1);
  windowState.update({ opacity: 1 });
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
  const persisted = windowState.getState();
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

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
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
  const current = windowState.getState();
  windowState.update({
    preferences: {
      ...current.preferences,
      ...(patch ?? {}),
    },
  });
  applyWindowPreferences();
  publishStatus();
  return buildStatusPayload();
});
ipcMain.handle('window:set_opacity', (_evt, value) => {
  if (!mainWindow || !windowState) return buildStatusPayload();
  const nextOpacity = clamp(Number(value) || 1, MIN_OPACITY, MAX_OPACITY);
  mainWindow.setOpacity(nextOpacity);
  windowState.update({ opacity: nextOpacity });
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
  windowState = new WindowStateStore(app.getPath('userData'));
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
