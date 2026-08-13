'use strict';

const YAML = require('yaml');

const REQUIRED_ACTION_REFS = new Map([
  ['actions/checkout', 'v7'],
  ['actions/upload-artifact', 'v7'],
]);

function mapping(value, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be a mapping`);
  }
  return value;
}

function workflowStepUses(source) {
  const document = mapping(YAML.parse(source, { uniqueKeys: true }), 'workflow');
  const jobs = mapping(document.jobs, 'jobs');
  const result = [];

  for (const [jobName, jobValue] of Object.entries(jobs)) {
    const job = mapping(jobValue, `jobs.${jobName}`);
    if (job.steps === undefined) continue;
    if (!Array.isArray(job.steps)) throw new Error(`jobs.${jobName}.steps must be a sequence`);

    for (let index = 0; index < job.steps.length; index++) {
      const step = mapping(job.steps[index], `jobs.${jobName}.steps[${index}]`);
      if (step.uses === undefined) continue;
      if (typeof step.uses !== 'string') {
        throw new Error(`jobs.${jobName}.steps[${index}].uses must be a string`);
      }
      result.push(step.uses);
    }
  }

  return result;
}

function validateActionRuntimePins(source, relative) {
  let references;
  try {
    references = workflowStepUses(source);
  } catch (error) {
    return [`${relative} is not a valid workflow document: ${error.message}`];
  }

  const violations = [];
  for (const reference of references) {
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
