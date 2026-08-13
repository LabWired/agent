#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { validateActionRuntimePins } = require('./lib/action-runtime-pins');
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

function requireCurrentActionMajors() {
  const workflowDirectory = path.join(root, '.github', 'workflows');
  for (const entry of fs.readdirSync(workflowDirectory)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const relative = path.join('.github', 'workflows', entry);
    const workflow = read(relative);
    for (const violation of validateActionRuntimePins(workflow, relative)) fail(violation);
  }
}

requireCurrentActionMajors();

const harnessPath = '.github/workflows/harness.yml';
const harness = read(harnessPath);
const harnessJobs = jobs(harness, harnessPath);
const unitJob = harnessJobs.get('unit') || '';
requireText(unitJob, 'npm ci --ignore-scripts', 'unit');
requireText(unitJob, 'node tests/release-evidence-contract.js', 'unit');
for (const [key, runner, command, artifact] of [
  ['release-evidence-ubuntu', 'runs-on: ubuntu-latest', 'tests/install-smoke.sh', 'labwired-agent-source-ubuntu'],
  ['release-evidence-macos', 'runs-on: macos-14', 'tests/install-smoke.sh', 'labwired-agent-source-macos'],
  ['release-evidence-windows', 'runs-on: windows-latest', 'tests/windows-install-smoke.ps1', 'labwired-agent-source-windows'],
]) {
  const job = harnessJobs.get(key);
  if (!job) { fail(`${harnessPath} missing job ${key}`); continue; }
  requireText(job, runner, key);
  requireText(job, command, key);
  requireText(job, 'actions/upload-artifact@v7', key);
  requireText(job, 'if: always()', key);
  requireText(job, 'if-no-files-found: error', key);
  requireText(job, artifact, key);
}
const windows = harnessJobs.get('release-evidence-windows') || '';
requireText(windows, 'shell: powershell', 'release-evidence-windows');
requireText(windows, 'shell: pwsh', 'release-evidence-windows');
if ((windows.match(/if: always\(\)/g) || []).length < 2)
  fail('release-evidence-windows must run the second engine and upload on failure');

const windowsContract = read('tests/windows-contract.ps1');
const compressionAssembly = windowsContract.indexOf('Add-Type -AssemblyName System.IO.Compression');
const zipArchiveMode = windowsContract.indexOf('[IO.Compression.ZipArchiveMode]');
if (compressionAssembly < 0 || zipArchiveMode < 0 || compressionAssembly > zipArchiveMode)
  fail('Windows PowerShell 5.1 must load System.IO.Compression before using ZipArchiveMode');
const createWindowsTemp = windowsContract.indexOf('New-Item -ItemType Directory -Path $TempRoot');
const openWindowsFixture = windowsContract.indexOf('[IO.Compression.ZipFile]::Open');
if (createWindowsTemp < 0 || openWindowsFixture < 0)
  fail('Windows contract must create its temp root for archive fixtures');

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
  requireText(job, 'actions/upload-artifact@v7', key);
  requireText(job, 'if: always()', key);
  requireText(job, artifact, key);
}
requireText(deployedJobs.get('deployed-windows') || '', 'powershell.exe', 'deployed-windows');
requireText(deployedJobs.get('deployed-windows') || '', 'pwsh.exe', 'deployed-windows');
requireText(deployedJobs.get('deployed-windows') || '', '-cne $env:EXPECTED_VERSION', 'deployed-windows');
requireText(deployedJobs.get('deployed-ubuntu') || '', 'actual_version', 'deployed-ubuntu');
requireText(deployedJobs.get('deployed-macos') || '', 'actual_version', 'deployed-macos');

const installDocs = read('docs/INSTALL.md');
requireText(installDocs, 'Native Agent support', 'docs/INSTALL.md');
requireText(installDocs, 'hosted verification or WSL', 'docs/INSTALL.md');
const testingDocs = read('docs/TESTING.md');
requireText(testingDocs, 'Source-install evidence', 'docs/TESTING.md');
requireText(testingDocs, 'Deployed-endpoint evidence', 'docs/TESTING.md');
requireText(testingDocs, 'platform.txt', 'docs/TESTING.md');

const actionRuntimeContract = childProcess.spawnSync(
  process.execPath,
  [path.join(root, 'tests/action-runtime-pins-contract.js')],
  { encoding: 'utf8' },
);
if (actionRuntimeContract.stdout) process.stdout.write(actionRuntimeContract.stdout);
if (actionRuntimeContract.stderr) process.stderr.write(actionRuntimeContract.stderr);
if (actionRuntimeContract.status !== 0) fail('action runtime pins contract failed');

const hostedContract = childProcess.spawnSync(
  process.execPath,
  [path.join(root, 'tests/hosted-release-contract.js')],
  { encoding: 'utf8' },
);
if (hostedContract.stdout) process.stdout.write(hostedContract.stdout);
if (hostedContract.stderr) process.stderr.write(hostedContract.stderr);
if (hostedContract.status !== 0) fail('hosted release contract failed');

if (failed) process.exit(1);
process.stdout.write('ok   release-evidence-contract PASS\n');
