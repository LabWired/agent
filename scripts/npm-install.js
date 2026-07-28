#!/usr/bin/env node
/**
 * npm entry for @labwired/agent
 *
 *   npm i -g @labwired/agent
 *   npx @labwired/agent
 *
 * Runs the same bootstrap as curl | sh (clone/update + install.sh).
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const bootstrap = path.join(root, 'scripts', 'agent-install.sh');
const localInstall = path.join(root, 'install.sh');

const args = process.argv.slice(2).filter((a) => a !== '--postinstall');
const isPost = process.argv.includes('--postinstall');

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Prefer full product bootstrap (clone to ~/.labwired/agent) when invoked as npx/global.
// When packing from a git checkout, local install.sh is fine.
if (fs.existsSync(localInstall) && fs.existsSync(path.join(root, 'bin', 'labwired'))) {
  if (!isPost) {
    console.log('==> installing LabWired Firmware Agent from package contents');
  }
  run('bash', [localInstall, ...args]);
} else if (fs.existsSync(bootstrap)) {
  run('sh', [bootstrap, ...args]);
} else {
  console.error('labwired-agent: no installer found in package');
  process.exit(1);
}
