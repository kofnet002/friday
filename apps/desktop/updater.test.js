const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { setupAutoUpdates } = require('./updater');

function setup({ isPackaged = true, checkForUpdates = async () => ({}) } = {}) {
  const events = new EventEmitter();
  events.checkForUpdates = checkForUpdates;
  const dialogs = [];
  const dialog = {
    showMessageBox: async (options) => {
      dialogs.push(options);
      return { response: 1 };
    },
  };
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  const app = { isPackaged };
  return {
    ...setupAutoUpdates({ app, autoUpdater: events, dialog, logger }),
    app,
    autoUpdater: events,
    dialog,
    dialogs,
    warnings,
  };
}

test('development builds never contact GitHub releases', async () => {
  let calls = 0;
  const state = setup({
    isPackaged: false,
    checkForUpdates: async () => {
      calls += 1;
    },
  });
  await state.checkForUpdates();
  assert.equal(calls, 0);
});

test('packaged builds check for updates and enable automatic downloads', () => {
  let calls = 0;
  const state = setup({
    checkForUpdates: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 1);
  assert.equal(state.autoUpdater.autoDownload, true);
  assert.equal(state.autoUpdater.autoInstallOnAppQuit, true);
});

test('an update check failure is logged without rejecting', async () => {
  const state = setup({
    checkForUpdates: async () => {
      throw new Error('offline');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.warnings.length, 1);
  await assert.doesNotReject(state.checkForUpdates());
});

test('downloaded updates ask before restarting to install', async () => {
  const state = setup();
  let installed = 0;
  state.autoUpdater.quitAndInstall = () => {
    installed += 1;
  };
  const listener = state.autoUpdater.listeners('update-downloaded')[0];
  await listener({ version: '0.0.2' });
  assert.equal(state.dialogs[0].buttons.includes('Restart and Install'), true);
  assert.equal(installed, 0);
});

test('accepting the downloaded update restarts into the new version', async () => {
  const state = setup();
  let installed = 0;
  state.dialog.showMessageBox = async () => ({ response: 0 });
  state.autoUpdater.quitAndInstall = () => {
    installed += 1;
  };
  const listener = state.autoUpdater.listeners('update-downloaded')[0];
  await listener({ version: '0.0.2' });
  assert.equal(installed, 1);
});

test('manual checks use the same packaged release provider', async () => {
  let calls = 0;
  const state = setup({
    checkForUpdates: async () => {
      calls += 1;
      return { isUpdateAvailable: false };
    },
  });
  const result = await state.checkForUpdates();
  assert.equal(calls, 2);
  assert.equal(result.isUpdateAvailable, false);
});
