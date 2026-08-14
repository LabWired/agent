#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');
const { validateActionRuntimePins, workflowStepUses } = require('./lib/action-runtime-pins');

const root = path.resolve(__dirname, '..');
const ignoredInstallPath = childProcess.spawnSync(
  'git',
  ['check-ignore', '--quiet', 'node_modules/yaml/package.json'],
  { cwd: root },
);
assert.strictEqual(ignoredInstallPath.status, 0, 'root node_modules install output must be ignored');

const validWorkflow = `
name: valid
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Upload
        uses: actions/upload-artifact@v7
`;

assert.deepStrictEqual(validateActionRuntimePins(validWorkflow, 'valid.yml'), []);

const quotedCurrentWorkflow = `
jobs:
  quoted:
    steps:
      - uses: "actions/checkout@v7" # current checkout
      - uses: 'actions/upload-artifact@v7' # current upload
`;
assert.deepStrictEqual(validateActionRuntimePins(quotedCurrentWorkflow, 'quoted-current.yml'), []);
assert.deepStrictEqual(workflowStepUses(`
jobs:
  scalar:
    steps:
      - uses: 'owner/it''s-action@v1' # doubled quote
      - uses: "owner/hash#action@v1" # hash inside quotes
`), ["owner/it's-action@v1", 'owner/hash#action@v1']);

for (const [reference, label] of [
  ['actions/checkout@v4', 'legacy major'],
  ['actions/checkout@main', 'floating branch'],
  ['actions/checkout@master', 'floating legacy branch'],
  ['actions/upload-artifact@release-please', 'arbitrary tag'],
  ['actions/upload-artifact@0123456789abcdef0123456789abcdef01234567', 'SHA'],
]) {
  const mutated = validWorkflow.replace('actions/checkout@v7', reference);
  const violations = validateActionRuntimePins(mutated, `${label}.yml`);
  assert.strictEqual(violations.length, 1, `${label} must be rejected`);
  assert.match(violations[0], /expected .*@v7/);
}

const scriptTextWorkflow = `
name: script text
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Explain migration
        run: |
          echo 'replace actions/checkout@v4'
          echo 'uses: actions/upload-artifact@main'
      - uses: actions/upload-artifact@v7
`;

assert.deepStrictEqual(validateActionRuntimePins(scriptTextWorkflow, 'script.yml'), []);

const multipleJobsWorkflow = `
jobs:
  linux:
    steps:
      - uses: actions/checkout@v7
  nested-name:
    steps:
      - name: Upload
        uses: actions/upload-artifact@v4
`;
assert.strictEqual(validateActionRuntimePins(multipleJobsWorkflow, 'jobs.yml').length, 1);

for (const [usesLine, label] of [
  ['"actions/checkout@v4" # old', 'double-quoted inline comment'],
  ["'actions/upload-artifact@v4' # old", 'single-quoted inline comment'],
  ['Actions/Checkout@v4', 'case-variant checkout'],
  ['ACTIONS/UPLOAD-ARTIFACT@main', 'case-variant upload'],
]) {
  const workflow = `jobs:\n  pin:\n    steps:\n      - uses: ${usesLine}\n`;
  assert.strictEqual(validateActionRuntimePins(workflow, `${label}.yml`).length, 1, `${label} must be rejected`);
}

assert.deepStrictEqual(validateActionRuntimePins(`
jobs:
  pin:
    steps:
      - uses: Actions/Checkout@v7
      - uses: ACTIONS/UPLOAD-ARTIFACT@v7
`, 'case-current.yml'), []);

for (const [workflow, label] of [
  ['jobs: { flow: { steps: [{ uses: actions/checkout@v4 }] } }', 'flow-style steps'],
  [`jobs:
  tagged:
    steps:
      - uses: !!str actions/checkout@v4
`, 'tagged scalar'],
  [`jobs:
  anchored:
    steps:
      - uses: &old actions/upload-artifact@v4
      - uses: *old
`, 'anchored scalar'],
  [`jobs:
  escaped:
    steps:
      - uses: "actions\\x2fcheckout@v4"
`, 'YAML hex escape'],
]) {
  assert.ok(validateActionRuntimePins(workflow, `${label}.yml`).length >= 1, `${label} must be rejected`);
}

assert.ok(validateActionRuntimePins('jobs: [not-a-mapping]', 'invalid-shape.yml').length >= 1,
  'invalid workflow shape must fail closed');
assert.ok(validateActionRuntimePins('jobs: {', 'invalid-yaml.yml').length >= 1,
  'invalid YAML must fail closed');

process.stdout.write('ok   action-runtime-pins-contract PASS\n');
