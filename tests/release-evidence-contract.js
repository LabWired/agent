#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL release evidence contract: ${message}\n`);
  failed = true;
}

function read(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    fail(`missing ${relative}`);
    return '';
  }
  return fs.readFileSync(absolute, 'utf8').replace(/^\s*#.*$/gm, '');
}

function jobs(workflow, relative) {
  const start = workflow.search(/^jobs:\s*$/m);
  if (start < 0) { fail(`${relative} has no jobs mapping`); return new Map(); }
  const tail = workflow.slice(start);
  const matches = [...tail.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  const result = new Map();
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1];
    if (result.has(key)) fail(`${relative} duplicates job ${key}`);
    const begin = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : tail.length;
    result.set(key, tail.slice(begin, end));
  }
  return result;
}

function requireText(text, needle, context) {
  if (!text.includes(needle)) fail(`${context} missing ${needle}`);
}

const harnessPath = '.github/workflows/harness.yml';
const harness = read(harnessPath);
const harnessJobs = jobs(harness, harnessPath);
for (const [key, runner, command, artifact] of [
  ['release-evidence-ubuntu', 'runs-on: ubuntu-latest', 'tests/install-smoke.sh', 'labwired-agent-source-ubuntu'],
  ['release-evidence-macos', 'runs-on: macos-14', 'tests/install-smoke.sh', 'labwired-agent-source-macos'],
  ['release-evidence-windows', 'runs-on: windows-latest', 'tests/windows-install-smoke.ps1', 'labwired-agent-source-windows'],
]) {
  const job = harnessJobs.get(key);
  if (!job) { fail(`${harnessPath} missing job ${key}`); continue; }
  requireText(job, runner, key);
  requireText(job, command, key);
  requireText(job, 'actions/upload-artifact@v4', key);
  requireText(job, 'if: always()', key);
  requireText(job, 'if-no-files-found: error', key);
  requireText(job, artifact, key);
}
const windows = harnessJobs.get('release-evidence-windows') || '';
requireText(windows, 'shell: powershell', 'release-evidence-windows');
requireText(windows, 'shell: pwsh', 'release-evidence-windows');

const deployedPath = '.github/workflows/deployed-install.yml';
const deployed = read(deployedPath);
requireText(deployed, 'workflow_dispatch:', deployedPath);
requireText(deployed, 'expected_version:', deployedPath);
const deployedJobs = jobs(deployed, deployedPath);
for (const [key, runner, endpoint, artifact] of [
  ['deployed-ubuntu', 'runs-on: ubuntu-latest', 'https://labwired.com/install', 'labwired-agent-deployed-ubuntu'],
  ['deployed-macos', 'runs-on: macos-14', 'https://labwired.com/install', 'labwired-agent-deployed-macos'],
  ['deployed-windows', 'runs-on: windows-latest', 'https://labwired.com/install.ps1', 'labwired-agent-deployed-windows'],
]) {
  const job = deployedJobs.get(key);
  if (!job) { fail(`${deployedPath} missing job ${key}`); continue; }
  requireText(job, runner, key);
  requireText(job, endpoint, key);
  requireText(job, 'expected_version', key);
  requireText(job, 'actions/upload-artifact@v4', key);
  requireText(job, 'if: always()', key);
  requireText(job, artifact, key);
}
requireText(deployedJobs.get('deployed-windows') || '', 'powershell.exe', 'deployed-windows');

const installDocs = read('docs/INSTALL.md');
requireText(installDocs, 'Native Agent support', 'docs/INSTALL.md');
requireText(installDocs, 'hosted verification or WSL', 'docs/INSTALL.md');
const testingDocs = read('docs/TESTING.md');
requireText(testingDocs, 'Source-install evidence', 'docs/TESTING.md');
requireText(testingDocs, 'Deployed-endpoint evidence', 'docs/TESTING.md');
requireText(testingDocs, 'platform.txt', 'docs/TESTING.md');

if (failed) process.exit(1);
process.stdout.write('ok   release-evidence-contract PASS\n');
