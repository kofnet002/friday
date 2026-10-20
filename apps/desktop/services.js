// Bundled-service supervisor for the packaged app. In dev, `pnpm dev` runs
// the backend and web server; a packaged Friday.app has neither, so it ships
// them under Contents/Resources and this module starts them before the window
// loads:
//
//   backend/friday-backend   PyInstaller build of apps/backend   :8000
//   web/apps/web/server.js   Next.js standalone server           :3333
//
// Both ports are fixed: the web UI is built against 127.0.0.1:8000.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const BACKEND_PORT = 8000;
const WEB_PORT = 3333;
const HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 3_000;
const SHELL_PATH_TIMEOUT_MS = 5_000;
const PATH_MARKER = '__FRIDAY_PATH__';

/** @type {import('node:child_process').ChildProcess[]} */
let children = [];
// Set by stopBundledServices(); interrupts a startup that's still running.
let stopping = false;

/**
 * Pull PATH out of login-shell output, ignoring anything rc files print.
 * @param {string} output
 * @returns {string | null}
 */
function parseMarkedPath(output) {
  const start = output.indexOf(PATH_MARKER);
  const end = output.indexOf(PATH_MARKER, start + PATH_MARKER.length);
  if (start === -1 || end === -1) return null;
  const value = output.slice(start + PATH_MARKER.length, end).trim();
  return value || null;
}

/**
 * Apps launched from Finder get launchd's bare PATH (/usr/bin:/bin:…), so the
 * backend couldn't find `claude`, `node` or Homebrew's python3. Ask the
 * user's login shell for the PATH their terminal sees.
 * @returns {Promise<string | null>}
 */
function loginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${PATH_MARKER}' "$PATH" '${PATH_MARKER}'`],
      { timeout: SHELL_PATH_TIMEOUT_MS, encoding: 'utf8' },
      (_err, stdout) => resolve(parseMarkedPath(stdout || '')),
    );
  });
}

/**
 * Seed the user's .env from the bundled template on first launch.
 * @param {string} envPath
 * @param {string} templatePath
 * @returns {{ envPath: string, created: boolean }}
 */
function ensureEnvFile(envPath, templatePath) {
  // API keys live here — readable by the user only, from the first byte.
  if (fs.existsSync(envPath)) {
    fs.chmodSync(envPath, 0o600);
    return { envPath, created: false };
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  try {
    fs.writeFileSync(envPath, fs.readFileSync(templatePath), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { envPath, created: false };
  }
  return { envPath, created: true };
}

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {{ envPath: string, userDataPath: string, shellPath: string | null }} opts
 * @returns {NodeJS.ProcessEnv}
 */
function bundledServiceEnv(baseEnv, { envPath, userDataPath, shellPath }) {
  return {
    ...baseEnv,
    ...(shellPath ? { PATH: shellPath } : {}),
    FRIDAY_ENV_FILE: envPath,
    SQLITE_PATH: path.join(userDataPath, 'friday.db'),
    FRIDAY_PARENT_PID: String(process.pid),
  };
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Thrown when startup is interrupted by a quit — not a failure to report. */
class ServicesStoppedError extends Error {
  constructor() {
    super('Friday is quitting');
    this.name = 'ServicesStoppedError';
  }
}

function throwIfStopping() {
  if (stopping) throw new ServicesStoppedError();
}

/**
 * Resolve once `url` answers with any HTTP status.
 * @param {string} url
 * @param {{ timeoutMs?: number, intervalMs?: number, shouldStop?: () => boolean }} [opts]
 * @returns {Promise<void>}
 */
function waitForHttp(
  url,
  {
    timeoutMs = STARTUP_TIMEOUT_MS,
    intervalMs = POLL_INTERVAL_MS,
    shouldStop = () => stopping,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (shouldStop()) {
        reject(new ServicesStoppedError());
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.setTimeout(intervalMs * 4, () => req.destroy());
      req.once('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`${url} did not respond within ${Math.round(timeoutMs / 1000)}s`));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}

/**
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, logPath: string }} opts
 */
function spawnService(name, command, args, { env, cwd, logPath }) {
  const log = fs.openSync(logPath, 'a');
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.serviceName = name;
  children = [...children, child];
  const untrack = () => {
    children = children.filter((c) => c !== child);
  };
  child.once('exit', untrack);
  // A missing/non-executable binary emits 'error' (and no 'exit'); without a
  // listener that's an uncaught exception in the main process.
  child.once('error', untrack);
  return child;
}

/**
 * Reject if the child fails to spawn or exits before `ready` settles, so a
 * crash on boot surfaces immediately instead of after the startup timeout.
 * @param {import('node:child_process').ChildProcess} child
 * @param {Promise<void>} ready
 * @param {string} logPath
 */
function readyOrExit(child, ready, logPath) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      if (child.stopRequested) reject(new ServicesStoppedError());
      else
        reject(
          new Error(
            `${child.serviceName} exited during startup (${signal || `code ${code}`}). See ${logPath}`,
          ),
        );
    };
    const onError = (err) => {
      cleanup();
      reject(new Error(`${child.serviceName} could not start: ${err.message}`));
    };
    child.once('exit', onExit);
    child.once('error', onError);
    ready.then(
      () => {
        cleanup();
        resolve();
      },
      (err) => {
        cleanup();
        reject(
          err instanceof ServicesStoppedError ? err : new Error(`${err.message}. See ${logPath}`),
        );
      },
    );
  });
}

/**
 * After startup, report a service dying on its own (not via stopBundledServices).
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} logPath
 * @param {(message: string) => void} onUnexpectedExit
 */
function watchAfterReady(child, logPath, onUnexpectedExit) {
  child.once('exit', (code, signal) => {
    if (child.stopRequested) return;
    onUnexpectedExit(
      `The ${child.serviceName} stopped unexpectedly (${signal || `code ${code}`}). See ${logPath}`,
    );
  });
}

/**
 * Start the bundled backend + web server and wait until both answer. Rejects
 * with ServicesStoppedError if stopBundledServices() is called meanwhile.
 * @param {{ resourcesPath: string, userDataPath: string, logsPath: string, electronPath: string, onUnexpectedExit: (message: string) => void }} opts
 * @returns {Promise<{ envPath: string, createdEnv: boolean }>}
 */
async function startBundledServices({
  resourcesPath,
  userDataPath,
  logsPath,
  electronPath,
  onUnexpectedExit,
}) {
  stopping = false;
  for (const port of [BACKEND_PORT, WEB_PORT]) {
    if (await isPortInUse(port)) {
      throw new Error(
        `Port ${port} is already in use — stop the dev stack (pnpm dev), then relaunch Friday.`,
      );
    }
  }

  const { envPath, created } = ensureEnvFile(
    path.join(userDataPath, '.env'),
    path.join(resourcesPath, 'env.example'),
  );
  fs.mkdirSync(logsPath, { recursive: true });
  const shellPath = await loginShellPath();
  throwIfStopping();
  const env = bundledServiceEnv(process.env, { envPath, userDataPath, shellPath });

  const backendLog = path.join(logsPath, 'backend-stdout.log');
  const backend = spawnService(
    'backend',
    path.join(resourcesPath, 'backend', 'friday-backend'),
    [],
    { env, cwd: userDataPath, logPath: backendLog },
  );

  const webDir = path.join(resourcesPath, 'web', 'apps', 'web');
  const webLog = path.join(logsPath, 'web.log');
  const watchdog = path.join(__dirname, 'parent-watchdog.js');
  const web = spawnService(
    'web server',
    electronPath,
    ['--require', watchdog, path.join(webDir, 'server.js')],
    {
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: String(WEB_PORT),
        HOSTNAME: HOST,
      },
      cwd: webDir,
      logPath: webLog,
    },
  );

  await Promise.all([
    readyOrExit(backend, waitForHttp(`http://${HOST}:${BACKEND_PORT}/healthz`), backendLog),
    readyOrExit(web, waitForHttp(`http://${HOST}:${WEB_PORT}/`), webLog),
  ]);
  watchAfterReady(backend, backendLog, onUnexpectedExit);
  watchAfterReady(web, webLog, onUnexpectedExit);
  return { envPath, createdEnv: created };
}

/** True while any bundled service process is still alive. */
function hasRunningServices() {
  return children.length > 0;
}

/**
 * Stop the services (and any startup in progress): SIGTERM, then SIGKILL
 * whatever is still alive after the grace period. Resolves once all exited.
 * @param {{ graceMs?: number }} [opts]
 * @returns {Promise<void>}
 */
function stopBundledServices({ graceMs = STOP_GRACE_MS } = {}) {
  stopping = true;
  const running = children;
  return Promise.all(
    running.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.stopRequested = true;
          const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
          child.once('exit', () => {
            clearTimeout(kill);
            resolve();
          });
          child.kill('SIGTERM');
        }),
    ),
  ).then(() => undefined);
}

module.exports = {
  ServicesStoppedError,
  bundledServiceEnv,
  ensureEnvFile,
  hasRunningServices,
  isPortInUse,
  parseMarkedPath,
  readyOrExit,
  spawnService,
  startBundledServices,
  stopBundledServices,
  waitForHttp,
  watchAfterReady,
};
