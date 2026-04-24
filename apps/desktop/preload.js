const { contextBridge, ipcRenderer } = require('electron');

const audioListeners = {
  frame: new Set(),
  error: new Set(),
  log: new Set(),
  exit: new Set(),
};

ipcRenderer.on('audio:frame', (_evt, arrayBuffer) => {
  for (const cb of audioListeners.frame) cb(arrayBuffer);
});
ipcRenderer.on('audio:error', (_evt, msg) => {
  for (const cb of audioListeners.error) cb(msg);
});
ipcRenderer.on('audio:log', (_evt, msg) => {
  for (const cb of audioListeners.log) cb(msg);
});
ipcRenderer.on('audio:exit', (_evt, info) => {
  for (const cb of audioListeners.exit) cb(info);
});

contextBridge.exposeInMainWorld('friday', {
  platform: process.platform,
  versions: process.versions,
  audio: {
    start: () => ipcRenderer.invoke('audio:start'),
    stop: () => ipcRenderer.invoke('audio:stop'),
    pause: () => ipcRenderer.invoke('audio:pause'),
    resume: () => ipcRenderer.invoke('audio:resume'),
    isRunning: () => ipcRenderer.invoke('audio:isRunning'),
    onFrame: (cb) => {
      audioListeners.frame.add(cb);
      return () => audioListeners.frame.delete(cb);
    },
    onError: (cb) => {
      audioListeners.error.add(cb);
      return () => audioListeners.error.delete(cb);
    },
    onLog: (cb) => {
      audioListeners.log.add(cb);
      return () => audioListeners.log.delete(cb);
    },
    onExit: (cb) => {
      audioListeners.exit.add(cb);
      return () => audioListeners.exit.delete(cb);
    },
  },
});
