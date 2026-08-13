'use strict';

const REQUIRED_ACTION_REFS = new Map([
  ['actions/checkout', 'v7'],
  ['actions/upload-artifact', 'v7'],
]);

function indentation(line) {
  return line.match(/^ */)[0].length;
}

function stripYamlComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") {
        index++;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index++;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function yamlScalar(value) {
  const trimmed = stripYamlComment(value).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
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
    const separator = reference.lastIndexOf('@');
    if (separator < 0) continue;
    const actionIdentifier = reference.slice(0, separator).toLowerCase();
    const actionRef = reference.slice(separator + 1);
    for (const [action, expectedRef] of REQUIRED_ACTION_REFS) {
      if (actionIdentifier === action && actionRef === expectedRef) break;
      if (actionIdentifier === action) {
        violations.push(`${relative} uses ${reference}; expected ${action}@${expectedRef}`);
        break;
      }
    }
  }
  return violations;
}

module.exports = { validateActionRuntimePins, workflowStepUses };
