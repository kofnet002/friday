const { contextBridge, ipcRenderer, webUtils } = require('electron');

const audioListeners = {
  frame: new Set(),
  error: new Set(),
  log: new Set(),
  exit: new Set(),
};

const codingListeners = {
  frame_processed: new Set(),
  extraction_result: new Set(),
  error: new Set(),
  log: new Set(),
};

const windowListeners = {
  status: new Set(),
  toast: new Set(),
};

// Payload: { source: 'system' | 'mic', data: ArrayBuffer }. Listeners get
// (arrayBuffer, source) so single-argument callers keep working unchanged.
ipcRenderer.on('audio:frame', (_evt, payload) => {
  const source = payload && payload.source === 'mic' ? 'mic' : 'system';
  const data = payload && payload.data instanceof ArrayBuffer ? payload.data : payload;
  for (const cb of audioListeners.frame) cb(data, source);
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

ipcRenderer.on('coding:frame_processed', (_evt, info) => {
  for (const cb of codingListeners.frame_processed) cb(info);
});
ipcRenderer.on('coding:extraction_result', (_evt, payload) => {
  for (const cb of codingListeners.extraction_result) cb(payload);
});
ipcRenderer.on('coding:error', (_evt, msg) => {
  for (const cb of codingListeners.error) cb(msg);
});
ipcRenderer.on('coding:log', (_evt, msg) => {
  for (const cb of codingListeners.log) cb(msg);
});
ipcRenderer.on('window:status', (_evt, payload) => {
  for (const cb of windowListeners.status) cb(payload);
});
ipcRenderer.on('window:toast', (_evt, payload) => {
  for (const cb of windowListeners.toast) cb(payload);
});

contextBridge.exposeInMainWorld('friday', {
  platform: process.platform,
  versions: process.versions,
  // Absolute path of a dropped File (File.path was removed in Electron 32).
  // Returns '' for files that don't live on disk.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  audio: {
    start: (opts) => ipcRenderer.invoke('audio:start', opts || {}),
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
  coding: {
    start: (sessionId) => ipcRenderer.invoke('coding:start', sessionId),
    stop: () => ipcRenderer.invoke('coding:stop'),
    forceExtract: () => ipcRenderer.invoke('coding:force_extract'),
    isActive: () => ipcRenderer.invoke('coding:isActive'),
    setProvider: (provider) => ipcRenderer.invoke('coding:set_provider', provider),
    onFrameProcessed: (cb) => {
      codingListeners.frame_processed.add(cb);
      return () => codingListeners.frame_processed.delete(cb);
    },
    onExtractionResult: (cb) => {
      codingListeners.extraction_result.add(cb);
      return () => codingListeners.extraction_result.delete(cb);
    },
    onError: (cb) => {
      codingListeners.error.add(cb);
      return () => codingListeners.error.delete(cb);
    },
    onLog: (cb) => {
      codingListeners.log.add(cb);
      return () => codingListeners.log.delete(cb);
    },
  },
  appWindow: {
    status: () => ipcRenderer.invoke('window:status'),
    toggleVisibility: () => ipcRenderer.invoke('window:toggle_visibility'),
    center: () => ipcRenderer.invoke('window:center'),
    updatePreferences: (patch) => ipcRenderer.invoke('window:update_preferences', patch),
    setOpacity: (value) => ipcRenderer.invoke('window:set_opacity', value),
    setInteractive: (value) => ipcRenderer.invoke('window:set_interactive', Boolean(value)),
    onStatus: (cb) => {
      windowListeners.status.add(cb);
      return () => windowListeners.status.delete(cb);
    },
    onToast: (cb) => {
      windowListeners.toast.add(cb);
      return () => windowListeners.toast.delete(cb);
    },
  },
  stealth: {
    enable: () => ipcRenderer.invoke('stealth:enable'),
    disable: () => ipcRenderer.invoke('stealth:disable'),
    status: () => ipcRenderer.invoke('stealth:status'),
  },
});
