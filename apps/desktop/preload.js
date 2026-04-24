const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('friday', {
  platform: process.platform,
  versions: process.versions,
});
