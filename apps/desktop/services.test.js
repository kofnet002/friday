const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  ServicesStoppedError,
  bundledServiceEnv,
  ensureEnvFile,
  isPortInUse,
  parseMarkedPath,
  readyOrExit,
  spawnService,
  stopBundledServices,
  waitForHttp,
  watchAfterReady,
  probeRedis,
} = require('./services');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'friday-services-'));
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

test('parseMarkedPath extracts PATH from noisy login-shell output', () => {
  const output = 'motd banner\n__FRIDAY_PATH__/opt/homebrew/bin:/usr/bin__FRIDAY_PATH__\n';
  assert.equal(parseMarkedPath(output), '/opt/homebrew/bin:/usr/bin');
});

test('parseMarkedPath returns null when the marker is missing', () => {
  assert.equal(parseMarkedPath('zsh: command not found'), null);
  assert.equal(parseMarkedPath('__FRIDAY_PATH____FRIDAY_PATH__'), null);
});

test('ensureEnvFile seeds a missing .env from the template', () => {
  const dir = tmpDir();
  const template = path.join(dir, 'env.example');
  fs.writeFileSync(template, 'DEEPGRAM_API_KEY=\n');
  const envPath = path.join(dir, 'support', '.env');

  assert.deepEqual(ensureEnvFile(envPath, template), { envPath, created: true });
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'DEEPGRAM_API_KEY=\n');
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('ensureEnvFile never overwrites an existing .env', () => {
  const dir = tmpDir();
  const template = path.join(dir, 'env.example');
  fs.writeFileSync(template, 'TEMPLATE=1\n');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'MINE=1\n');

  assert.deepEqual(ensureEnvFile(envPath, template), { envPath, created: false });
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'MINE=1\n');
});

test('bundledServiceEnv points the backend at the user data dir', () => {
  const env = bundledServiceEnv(
    { HOME: '/Users/x' },
    {
      envPath: '/support/.env',
      userDataPath: '/support',
      shellPath: '/opt/homebrew/bin:/usr/bin',
    },
  );
  assert.equal(env.FRIDAY_ENV_FILE, '/support/.env');
  assert.equal(env.SQLITE_PATH, '/support/friday.db');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin');
  assert.equal(env.HOME, '/Users/x');
  // Lets each service exit if the app dies without stopping it.
  assert.equal(env.FRIDAY_PARENT_PID, String(process.pid));
});

test('bundledServiceEnv keeps the inherited PATH when the shell lookup failed', () => {
  const env = bundledServiceEnv(
    { PATH: '/usr/bin:/bin' },
    {
      envPath: '/s/.env',
      userDataPath: '/s',
      shellPath: null,
    },
  );
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('isPortInUse detects a listening port and a free one', async () => {
  const server = http.createServer();
  const port = await listen(server);
  assert.equal(await isPortInUse(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortInUse(port), false);
});

test('waitForHttp resolves once the server answers', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 2000, intervalMs: 20 });
  } finally {
    server.close();
  }
});

test('waitForHttp rejects after the timeout', async () => {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 150, intervalMs: 20 }),
    /did not respond/,
  );
});

test('ensureEnvFile tightens an existing world-readable .env', () => {
  const dir = tmpDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'MINE=1\n', { mode: 0o644 });

  ensureEnvFile(envPath, path.join(dir, 'missing-template'));
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('waitForHttp gives up as soon as the services are stopping', async () => {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    waitForHttp(`http://127.0.0.1:${port}/`, { intervalMs: 20, shouldStop: () => true }),
    ServicesStoppedError,
  );
});

function logFile() {
  return path.join(tmpDir(), 'service.log');
}

test('readyOrExit turns a spawn failure into a readable error', async () => {
  const logPath = logFile();
  const child = spawnService('backend', '/nonexistent/friday-backend', [], {
    env: process.env,
    cwd: os.tmpdir(),
    logPath,
  });
  await assert.rejects(
    readyOrExit(child, new Promise(() => {}), logPath),
    /backend could not start/,
  );
});

test('stopBundledServices force-kills a service that ignores SIGTERM', async () => {
  const child = spawnService(
    'stubborn',
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { env: process.env, cwd: os.tmpdir(), logPath: logFile() },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await stopBundledServices({ graceMs: 200 });
  assert.equal(child.signalCode, 'SIGKILL');
});

test('watchAfterReady reports a crash but not a deliberate stop', async () => {
  const crashed = [];
  const crasher = spawnService('web server', process.execPath, ['-e', 'process.exit(3)'], {
    env: process.env,
    cwd: os.tmpdir(),
    logPath: logFile(),
  });
  watchAfterReady(crasher, 'web.log', (message) => crashed.push(message));
  await new Promise((resolve) => crasher.once('exit', resolve));
  assert.match(crashed[0], /web server stopped unexpectedly \(code 3\)/);

  const stopped = spawnService('backend', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: process.env,
    cwd: os.tmpdir(),
    logPath: logFile(),
  });
  watchAfterReady(stopped, 'backend.log', (message) => crashed.push(message));
  await stopBundledServices({ graceMs: 200 });
  assert.equal(crashed.length, 1);
});

test('probeRedis reports a degraded but usable backend when Redis is unavailable', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ checks: { redis: 'down', sqlite: 'ok' } }));
  });
  const port = await listen(server);
  try {
    assert.equal(await probeRedis(`http://127.0.0.1:${port}/health/deep`), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
