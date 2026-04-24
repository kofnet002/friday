const { app, BrowserWindow, ipcMain, shell, systemPreferences, dialog } = require('electron');
const path = require('node:path');

const { AudioSupervisor } = require('./audio');

const DEV_URL = process.env.FRIDAY_WEB_URL || 'http://127.0.0.1:3333';
const isDev = process.env.NODE_ENV === 'development';

const audio = new AudioSupervisor();
let mainWindow = null;

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

audio.on('frame', (buffer) => {
  // ArrayBuffer transfers cleanly across IPC. Slice to drop excess capacity.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  broadcast('audio:frame', ab);
});
audio.on('error', (msg) => broadcast('audio:error', msg));
audio.on('log', (msg) => broadcast('audio:log', msg));
audio.on('exit', (info) => broadcast('audio:exit', info));

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Friday',
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
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

  mainWindow.loadURL(DEV_URL);

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

app.whenReady().then(async () => {
  await ensurePermissions();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  audio.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  audio.stop();
});
