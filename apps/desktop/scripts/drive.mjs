// Drive the real Friday desktop app (Electron) for smoke tests.
//
// A line-per-command REPL on stdin, so an agent or a person can launch the
// app once and poke it step by step. Usage and gotchas:
// .claude/skills/run-desktop/SKILL.md
//
//   node apps/desktop/scripts/drive.mjs [--out <dir>] < commands
//
// Commands (one per line):
//   shot <name>               screenshot the Friday window to <out>/<name>.png
//   buttons                   list visible button names
//   click <exact name>        click a button by its exact accessible name
//   clickp <name start>       click the first visible button whose name starts
//                             with this (for names that change, e.g. the
//                             "Screen" tab reads "Screen, screen active")
//   select <aria-label> <v>   set a <select> by aria-label to value <v>
//   text [css]                print visible text (default: body)
//   status                    print the Screen panel's status lines
//   watch                     log status-line changes to stdout as they happen
//   testpage <file>           open <file> in a window on the primary display
//   evalPage <js>             evaluate a JS expression in the Friday window
//   evalMain <js body>        run an async function body in Electron main
//                             (`electron` is in scope)
//   wait <ms>                 sleep
//   quit                      close the app and exit

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const outFlag = process.argv.indexOf('--out');
const outDir = path.resolve(outFlag > 0 ? process.argv[outFlag + 1] : 'drive-output');
mkdirSync(outDir, { recursive: true });

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

const app = await electron.launch({
  executablePath: path.join(appDir, 'node_modules/.bin/electron'),
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'development' },
});
app.process().stderr.on('data', (data) => {
  const text = String(data).trim();
  if (text && !/debugger|DevTools/i.test(text)) log('[main]', text);
});

const page = await app.firstWindow();
page.on('console', (message) => {
  const text = message.text();
  if (/^\[drive\]|error/i.test(text)) log('[page]', text.slice(0, 400));
});
await page.waitForLoadState('domcontentloaded');

// The Next.js dev overlay sits over the app and swallows clicks.
const removeDevOverlay = () =>
  page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach((node) => node.remove()));
await removeDevOverlay().catch(() => {});
log('ready', page.url(), '→ screenshots in', outDir);

const statusText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role=status],[role=alert]')]
      .map((node) => node.innerText.trim())
      .filter(Boolean)
      .join(' | '),
  );

const commands = {
  async shot(name = 'shot') {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    log('saved', file);
  },
  async buttons() {
    const names = await page.$$eval('button', (buttons) =>
      buttons
        .filter((button) => button.offsetParent)
        .map((button) => (button.getAttribute('aria-label') || button.innerText).trim())
        .filter(Boolean),
    );
    log(JSON.stringify(names));
  },
  async click(name) {
    await removeDevOverlay();
    // exact: "Start" must not match "Restart Friday" (which relaunches the app).
    await page.getByRole('button', { name, exact: true }).first().click({ timeout: 8000 });
    log('clicked', name);
  },
  async clickp(prefix) {
    await removeDevOverlay();
    const clicked = await page.evaluate((start) => {
      const button = [...document.querySelectorAll('button')].find(
        (node) =>
          node.offsetParent &&
          (node.getAttribute('aria-label') || node.innerText).trim().startsWith(start),
      );
      if (!button) return null;
      button.click();
      return (button.getAttribute('aria-label') || button.innerText).trim();
    }, prefix);
    log(clicked ? `clicked ${JSON.stringify(clicked)}` : `ERR no button starting with ${prefix}`);
  },
  async select(args) {
    const [label, value] = args.split(' ');
    await page.locator(`select[aria-label="${label}"]`).selectOption(value);
    log('selected', label, '=', value);
  },
  async text(selector = 'body') {
    log((await page.locator(selector).first().innerText()).slice(0, 4000));
  },
  async status() {
    log('status:', await statusText());
  },
  async watch() {
    await page.evaluate(() => {
      if (window.__driveWatch) return;
      let last = '';
      window.__driveWatch = setInterval(() => {
        document.querySelectorAll('nextjs-portal').forEach((node) => node.remove());
        const text = [...document.querySelectorAll('[role=status],[role=alert]')]
          .map((node) => node.innerText.trim())
          .filter(Boolean)
          .join(' | ');
        if (text !== last) {
          last = text;
          console.log(`[drive] status: ${text}`);
        }
      }, 150);
    });
    log('watching status lines');
  },
  async testpage(file) {
    const absolute = path.resolve(file);
    const id = await app.evaluate(async ({ BrowserWindow, screen }, target) => {
      const area = screen.getPrimaryDisplay().workArea;
      // Leave the top strip free so the Friday bar stays clickable.
      const win = new BrowserWindow({
        x: area.x,
        y: area.y + 130,
        width: area.width,
        height: area.height - 130,
        show: true,
      });
      await win.loadFile(target);
      return win.id;
    }, absolute);
    log('test page window', id, absolute);
  },
  async evalPage(expression) {
    log(JSON.stringify(await page.evaluate(expression)));
  },
  async evalMain(body) {
    // eslint-disable-next-line no-new-func
    const fn = new Function('electron', `return (async () => { ${body} })()`);
    log(JSON.stringify(await app.evaluate(fn)));
  },
  async wait(ms = '1000') {
    await new Promise((resolve) => setTimeout(resolve, Number(ms)));
  },
  async quit() {
    await app.close();
    process.exit(0);
  },
};

const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const [name, ...rest] = trimmed.split(' ');
  const command = commands[name];
  if (!command) {
    log('unknown command', name);
    continue;
  }
  try {
    await command(rest.join(' ') || undefined);
  } catch (error) {
    log('ERR', name, String(error.message || error).split('\n')[0]);
  }
}
await app.close();
