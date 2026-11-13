// Opens a fixture page in its OWN Electron app, so Friday's capture shield
// (which hides every Friday window from screen captures) doesn't hide it.
// Usage: apps/desktop/node_modules/.bin/electron .claude/skills/run-desktop/fixture-viewer <page.html>
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, screen } = require('electron');

const arg = process.argv.slice(2).find((a) => a.endsWith('.html'));
if (!arg) {
  console.error(
    'usage: electron .claude/skills/run-desktop/fixture-viewer <page.html>\n' +
      'Opens one local fixture page full-screen on the primary display.',
  );
  process.exit(2);
}
const page = path.resolve(arg);
const pageUrl = pathToFileURL(page).href;

app.whenReady().then(() => {
  // Fill the primary display's work area: scans capture the primary display.
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x, y, width, height, title: 'Fixture' });
  // Stay on the fixture: no pop-ups, no navigating anywhere else.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== pageUrl) event.preventDefault();
  });
  win.loadFile(page);
  win.focus();
});
app.on('window-all-closed', () => app.quit());
