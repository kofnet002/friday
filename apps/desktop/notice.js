// Friday's replacement for dialog.showMessageBox / showErrorBox. Native
// dialogs are separate macOS windows that screen capture and meeting screen
// share can see. A notice is a small BrowserWindow that gets the same capture
// protection as the main window before it is ever shown.

const { BrowserWindow } = require('electron');

const stealth = require('./stealth');
const { noticeHtml, NOTICE_SCHEME } = require('./notice-html');

const WIDTH = 440;
const HEIGHT = 190;

/**
 * Show a capture-protected notice. Resolves with the id of the pressed
 * button, or 'closed' if the window was closed another way.
 * @param {{ title: string, message: string, detail?: string,
 *           buttons?: { id: string, label: string }[] }} notice
 * @returns {Promise<string>}
 */
function showNotice({ title, message, detail, buttons = [{ id: 'ok', label: 'OK' }] }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT + (detail ? 40 : 0),
      title,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    });
    // Before the first frame: never visible to capture, not even briefly.
    stealth.applyToWindow(win, true);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url.startsWith(NOTICE_SCHEME))
        finish(decodeURIComponent(url.slice(NOTICE_SCHEME.length)));
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish('closed'));
    win.once('ready-to-show', () => win.show());
    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(noticeHtml({ title, message, detail, buttons }))}`,
    );
  });
}

module.exports = { showNotice };
