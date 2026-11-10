const { spawnSync } = require('node:child_process');
const path = require('node:path');

function validateReleaseEnvironment(version, env = process.env) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Release version must be a semantic version; received ${version}.`);
  }
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required to publish a GitHub Release.');
  if (!env.CSC_LINK && !env.CSC_NAME) {
    throw new Error(
      'CSC_LINK or CSC_NAME is required to sign the macOS app for automatic updates.',
    );
  }
  if (env.CSC_NAME && !env.CSC_NAME.startsWith('Developer ID Application:')) {
    throw new Error('CSC_NAME must identify a Developer ID Application certificate.');
  }

  const apiNotarization = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
  const appleIdNotarization = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
  if (!apiNotarization && !appleIdNotarization) {
    throw new Error(
      'Notarization credentials are required: provide APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.',
    );
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function publishMacRelease() {
  const desktopDir = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  validateReleaseEnvironment(version);
  run('pnpm', ['run', 'prepare:package'], desktopDir);
  run(
    'pnpm',
    ['exec', 'electron-builder', '--mac', '--publish', 'always', '-c.mac.hardenedRuntime=true'],
    desktopDir,
  );
}

if (require.main === module) {
  try {
    publishMacRelease();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateReleaseEnvironment };
