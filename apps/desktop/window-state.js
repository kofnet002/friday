const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STATE = Object.freeze({
  bounds: {
    width: 520,
    height: 720,
  },
  opacity: 1,
  preferences: {
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    hideWindowControls: true,
  },
});

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

class WindowStateStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'window-state.json');
    this.state = cloneDefaultState();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        ...cloneDefaultState(),
        ...parsed,
        bounds: {
          ...cloneDefaultState().bounds,
          ...(parsed?.bounds ?? {}),
        },
        preferences: {
          ...cloneDefaultState().preferences,
          ...(parsed?.preferences ?? {}),
        },
      };
    } catch (_error) {
      this.state = cloneDefaultState();
    }
  }

  getState() {
    return {
      bounds: { ...this.state.bounds },
      opacity: this.state.opacity,
      preferences: { ...this.state.preferences },
    };
  }

  update(patch) {
    this.state = {
      ...this.state,
      ...patch,
      bounds: {
        ...this.state.bounds,
        ...(patch.bounds ?? {}),
      },
      preferences: {
        ...this.state.preferences,
        ...(patch.preferences ?? {}),
      },
    };
    this._save();
    return this.getState();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (_error) {
      // Best effort only; the app still works without persistence.
    }
  }
}

module.exports = {
  WindowStateStore,
  DEFAULT_STATE,
};
