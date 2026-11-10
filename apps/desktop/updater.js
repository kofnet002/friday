/**
 * Set up updates for packaged Friday builds. Development runs never contact the
 * release feed, which keeps local iteration isolated from published versions.
 * @param {{ app: import('electron').App, autoUpdater: import('electron-updater').AppUpdater, dialog: import('electron').Dialog, logger?: Pick<Console, 'warn' | 'info'> }} deps
 * @returns {{ checkForUpdates: () => Promise<unknown> }}
 */
function setupAutoUpdates({ app, autoUpdater, dialog, logger = console }) {
  const checkForUpdates = async () => {
    if (!app.isPackaged) return null;
    try {
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      logger.warn('updates.check_failed', error);
      return null;
    }
  };

  if (!app.isPackaged) return { checkForUpdates };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => logger.warn('updates.error', error));
  autoUpdater.on('update-downloaded', async (info) => {
    try {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Friday update ready',
        message: `Friday ${info.version} is ready to install.`,
        detail:
          'Restart Friday now to finish installing the update, or choose Later to install it when you next quit.',
        buttons: ['Restart and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) autoUpdater.quitAndInstall();
    } catch (error) {
      logger.warn('updates.install_prompt_failed', error);
    }
  });

  void checkForUpdates();
  return { checkForUpdates };
}

module.exports = { setupAutoUpdates };
