'use strict';

const REQUIRED_ACTION_REFS = new Map([
  ['actions/checkout', 'v7'],
  ['actions/upload-artifact', 'v7'],
]);

function indentation(line) {
  return line.match(/^ */)[0].length;
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function workflowStepUses(source) {
  const result = [];
  let jobsIndent = null;
  let stepsIndent = null;
  let stepIndent = null;
  let blockScalarIndent = null;

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = indentation(line);

    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }

    if (/^\s*jobs:\s*(?:#.*)?$/.test(line)) {
      jobsIndent = indent;
      stepsIndent = null;
      stepIndent = null;
      continue;
    }
    if (jobsIndent === null) continue;
    if (indent <= jobsIndent) {
      jobsIndent = null;
      stepsIndent = null;
      stepIndent = null;
      continue;
    }

    if (/^\s*steps:\s*(?:#.*)?$/.test(line)) {
      stepsIndent = indent;
      stepIndent = null;
      continue;
    }
    if (stepsIndent === null) continue;
    if (indent <= stepsIndent) {
      stepsIndent = null;
      stepIndent = null;
      continue;
    }

    const listItem = line.match(/^(\s*)-\s+(.*)$/);
    if (listItem && indent > stepsIndent) {
      stepIndent = indent;
      const directUses = listItem[2].match(/^uses:\s*(.+)$/);
      if (directUses) result.push(yamlScalar(directUses[1]));
      const directBlock = listItem[2].match(/^run:\s*[|>][-+]?\s*(?:#.*)?$/);
      if (directBlock) blockScalarIndent = indent;
      continue;
    }
    if (stepIndent === null) continue;

    const propertyIndent = stepIndent + 2;
    if (indent === propertyIndent) {
      const uses = line.match(/^\s*uses:\s*(.+)$/);
      if (uses) result.push(yamlScalar(uses[1]));
      if (/^\s*run:\s*[|>][-+]?\s*(?:#.*)?$/.test(line)) blockScalarIndent = indent;
    }
  }

  return result;
}

function validateActionRuntimePins(source, relative) {
  const violations = [];
  for (const reference of workflowStepUses(source)) {
    for (const [action, expectedRef] of REQUIRED_ACTION_REFS) {
      if (reference === `${action}@${expectedRef}`) break;
      if (reference.startsWith(`${action}@`)) {
        violations.push(`${relative} uses ${reference}; expected ${action}@${expectedRef}`);
        break;
      }
    }
  }
  return violations;
}

module.exports = { validateActionRuntimePins, workflowStepUses };
