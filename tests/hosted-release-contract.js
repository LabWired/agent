#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workflowPath = '.github/workflows/release-readiness.yml';
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL hosted release contract: ${message}\n`);
  failed = true;
}

function requireText(text, needle, context) {
  if (!text.includes(needle)) fail(`${context} missing ${needle}`);
}

function forbidText(text, needle, context) {
  if (text.includes(needle)) fail(`${context} must not contain ${needle}`);
}

function jobs(workflow) {
  const start = workflow.search(/^jobs:\s*$/m);
  if (start < 0) {
    fail(`${workflowPath} has no jobs mapping`);
    return new Map();
  }
  const tail = workflow.slice(start);
  const matches = [...tail.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  const result = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const key = matches[index][1];
    const begin = matches[index].index;
    const end = index + 1 < matches.length ? matches[index + 1].index : tail.length;
    result.set(key, tail.slice(begin, end));
  }
  return result;
}

if (!fs.existsSync(path.join(root, workflowPath))) {
  fail(`missing ${workflowPath}`);
} else {
  const workflow = fs.readFileSync(path.join(root, workflowPath), 'utf8');
  requireText(workflow, 'workflow_dispatch:', workflowPath);

  for (const input of [
    'candidate_version',
    'previous_version',
    'previous_ubuntu_archive_url',
    'previous_ubuntu_archive_sha256',
    'previous_macos_archive_url',
    'previous_macos_archive_sha256',
    'previous_windows_archive_url',
    'previous_windows_archive_sha256',
  ]) {
    requireText(workflow, `      ${input}:`, `${workflowPath} inputs`);
    const inputBlock = workflow.match(new RegExp(`^      ${input}:\\n([\\s\\S]*?)(?=^      [a-z0-9_]+:|^jobs:)`, 'm'));
    if (!inputBlock || !/^        required: true$/m.test(inputBlock[0])) {
      fail(`${workflowPath} input ${input} must be required`);
    }
  }

  const workflowJobs = jobs(workflow);
  for (const [key, runner, archiveUrl, archiveSha, upgradeCommand, artifact, artifactRoot] of [
    [
      'hosted-release-ubuntu',
      'runs-on: ubuntu-latest',
      'inputs.previous_ubuntu_archive_url',
      'inputs.previous_ubuntu_archive_sha256',
      'tests/upgrade-smoke.sh',
      'labwired-agent-release-readiness-ubuntu',
      'evidence/release-readiness/ubuntu',
    ],
    [
      'hosted-release-macos',
      'runs-on: macos-14',
      'inputs.previous_macos_archive_url',
      'inputs.previous_macos_archive_sha256',
      'tests/upgrade-smoke.sh',
      'labwired-agent-release-readiness-macos',
      'evidence/release-readiness/macos',
    ],
    [
      'hosted-release-windows',
      'runs-on: windows-latest',
      'inputs.previous_windows_archive_url',
      'inputs.previous_windows_archive_sha256',
      'tests/windows-upgrade-smoke.ps1',
      'labwired-agent-release-readiness-windows',
      'evidence/release-readiness/windows',
    ],
  ]) {
    const job = workflowJobs.get(key);
    if (!job) {
      fail(`${workflowPath} missing job ${key}`);
      continue;
    }
    requireText(job, runner, key);
    requireText(job, 'Validate required release inputs and credentials', key);
    const validationIndex = job.indexOf('Validate required release inputs and credentials');
    const checkoutIndex = job.indexOf('actions/checkout@v4');
    if (validationIndex < 0 || checkoutIndex < 0 || validationIndex > checkoutIndex) {
      fail(`${key} must validate required inputs and credentials before checkout`);
    }
    requireText(job, 'secrets.LABWIRED_RELEASE_ACCESS_TOKEN', key);
    requireText(job, 'secrets.LABWIRED_RELEASE_PROJECT', key);
    requireText(job, 'inputs.candidate_version', key);
    requireText(job, 'inputs.previous_version', key);
    requireText(job, archiveUrl, key);
    requireText(job, archiveSha, key);
    requireText(job, 'actions/checkout@v4', key);
    requireText(job, 'hosted-tools: model gateway + MCP authenticated', key);
    requireText(job, 'scripts/hosted-mcp-probe.py', key);
    requireText(job, upgradeCommand, key);
    requireText(job, 'LABWIRED_PREVIOUS_AGENT_VERSION', key);
    requireText(job, 'LABWIRED_PREVIOUS_AGENT_SHA256', key);
    requireText(job, 'hosted-status.txt', key);
    requireText(job, 'mcp-result.txt', key);
    requireText(job, 'upgrade', key);
    requireText(job, 'platform.txt', key);
    requireText(job, 'capabilities.txt', key);
    requireText(job, 'result.txt', key);
    requireText(job, 'actions/upload-artifact@v4', key);
    requireText(job, 'if: always()', key);
    requireText(job, 'if-no-files-found: error', key);
    requireText(job, artifact, key);
    requireText(job, 'RELEASE_ACCESS_TOKEN: ${{ secrets.LABWIRED_RELEASE_ACCESS_TOKEN }}', key);
    requireText(job, 'RELEASE_PROJECT: ${{ secrets.LABWIRED_RELEASE_PROJECT }}', key);
    forbidText(job, 'continue-on-error: true', key);
    forbidText(job, '>> "$GITHUB_ENV"', key);
    forbidText(job, '>> $env:GITHUB_ENV', key);
    const upload = job.slice(job.lastIndexOf('- name: Upload'));
    requireText(upload, 'path: |', `${key} upload allowlist`);
    const allowedPaths = [
      `${artifactRoot}/hosted-status.txt`,
      `${artifactRoot}/mcp-result.txt`,
      `${artifactRoot}/upgrade`,
      `${artifactRoot}/platform.txt`,
      `${artifactRoot}/capabilities.txt`,
      `${artifactRoot}/result.txt`,
    ];
    for (const allowedPath of allowedPaths) {
      requireText(upload, allowedPath, `${key} upload allowlist`);
    }
    const uploadPathBlock = upload.match(/^          path: \|\n((?:            .+\n)+)/m);
    const uploadedPaths = uploadPathBlock
      ? uploadPathBlock[1].trim().split(/\s*\n\s*/).filter(Boolean)
      : [];
    if (JSON.stringify(uploadedPaths) !== JSON.stringify(allowedPaths)) {
      fail(`${key} upload paths must be the exact sanitized evidence allowlist`);
    }
    if (new RegExp(`^\\s*path: ${artifactRoot.replaceAll('/', '\\/')}\\s*$`, 'm').test(upload)) {
      fail(`${key} must not recursively upload the unrestricted evidence root`);
    }
    for (const unsafeArtifactName of [
      'cloud.json',
      'session.json',
      'config.json',
      'environment.txt',
      'headers.txt',
      'token.txt',
    ]) {
      forbidText(upload, unsafeArtifactName, `${key} upload`);
    }
  }

  const windows = workflowJobs.get('hosted-release-windows') || '';
  requireText(windows, 'powershell.exe', 'hosted-release-windows');
  requireText(windows, 'pwsh.exe', 'hosted-release-windows');
  requireText(windows, 'bash.exe', 'hosted-release-windows authenticated doctor');
  requireText(windows, 'bin/labwired-agent', 'hosted-release-windows authenticated doctor');
  requireText(windows, "if (@($hostedDoctor | Where-Object", 'hosted-release-windows authenticated doctor result');
  requireText(windows, '[Text.UTF8Encoding]::new($false)', 'hosted-release-windows BOM-free session');
  requireText(windows, 'windows-powershell=', 'hosted-release-windows');
  requireText(windows, 'powershell-core=', 'hosted-release-windows');
}

const testingDocsPath = path.join(root, 'docs/TESTING.md');
const testingDocs = fs.readFileSync(testingDocsPath, 'utf8');
for (const requiredDocumentation of [
  'Credentialed hosted release readiness',
  'LABWIRED_RELEASE_ACCESS_TOKEN',
  'LABWIRED_RELEASE_PROJECT',
  'candidate_version',
  'previous_version',
  'mandatory for release readiness',
  'Ordinary pull request hosted lanes may report `not run`',
  'labwired-agent-release-readiness-ubuntu',
  'labwired-agent-release-readiness-macos',
  'labwired-agent-release-readiness-windows',
]) {
  requireText(testingDocs, requiredDocumentation, 'docs/TESTING.md');
}

if (failed) process.exit(1);
process.stdout.write('ok   hosted-release-contract PASS\n');
