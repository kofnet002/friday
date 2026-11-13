// Opens a fixture page in its OWN Electron app, so Friday's capture shield
// (which hides every Friday window from screen captures) doesn't hide it.
// Usage: apps/desktop/node_modules/.bin/electron .claude/skills/run-desktop/fixture-viewer <page.html>
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

const page = path.resolve(process.argv[process.argv.length - 1]);

app.whenReady().then(() => {
  // Fill the primary display's work area: scans capture the primary display.
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x, y, width, height, title: 'Fixture' });
  win.loadFile(page);
  win.focus();
});
app.on('window-all-closed', () => app.quit());
