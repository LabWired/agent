#!/usr/bin/env node
/**
 * Record the twin-vs-desk differential fixtures once.
 *
 * These are genuine evidence bundles produced by `createEvidenceBundle`, not
 * hand-written JSON, so the committed fixtures exercise the same authentication
 * path a live run does. Regenerate only when the evidence format changes:
 *
 *   node tests/helpers/make-twin-desk-fixtures.mjs
 *
 * Bundle timestamps are fixed in the past. `verifyEvidenceBundle` only bounds
 * timestamps from above, so recorded bundles stay verifiable indefinitely.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvidenceBundle, sha256File } from '../../lib/hardware/evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'fixtures/twin-desk-diff');

const TARGET = Object.freeze({ id: 'desk-c3', chip: 'esp32c3' });
const BEHAVIORS = Object.freeze(['heartbeat', 'led-blink']);
// Recorded at generation time so each bundle's claims sit inside its own
// `.owner.json` run window. Verification only bounds timestamps from above, so
// the committed fixtures stay verifiable indefinitely.
const RECORDED_AT = Date.now();
const STARTED_AT = new Date(RECORDED_AT).toISOString();
const ENDED_AT = new Date(RECORDED_AT + 4_000).toISOString();

function observations(requiredLevel) {
  return [
    { id: 'heartbeat', provider: 'serial', requiredLevel },
    { id: 'led-blink', provider: 'logic-csv', requiredLevel },
  ];
}

async function writeRaw(bundle, name, body) {
  const file = path.join(bundle.root, 'observations', name);
  await fs.writeFile(file, body);
  return `observations/${name}`;
}

/**
 * @param {string} name bundle directory under fixtures/twin-desk-diff
 * @param {'twin'|'desk'} side
 * @param {string} artifactSha256
 * @param {Record<string, {level: string, raw?: string}>} outcomes keyed by behavior id
 */
async function record(name, side, artifactSha256, outcomes) {
  const directory = path.join(OUT, name);
  await fs.rm(directory, { recursive: true, force: true });
  const requiredLevel = side === 'twin' ? 'model_observed' : 'hardware_observed';
  const profile = { target: TARGET, observations: observations(requiredLevel) };
  const bundle = await createEvidenceBundle(directory, profile, {
    stages: side === 'twin'
      ? [{ id: 'build', provider: 'platformio' }, { id: 'twin', provider: 'labwired-sim' }]
      : [{ id: 'build', provider: 'platformio' }, { id: 'flash', provider: 'probe-rs' }],
  });
  for (const behaviorId of BEHAVIORS) {
    const outcome = outcomes[behaviorId];
    const reference = await writeRaw(bundle, `${behaviorId}.${side}.capture.log`,
      `${side} capture for ${behaviorId}\nlevel=${outcome.level}\n${outcome.raw ?? ''}`);
    if (outcome.level === 'failed' || outcome.level === 'blocked') {
      await bundle.recordBehavior(behaviorId, {
        behaviorId,
        provider: profile.observations.find((item) => item.id === behaviorId).provider,
        level: outcome.level,
        rawEvidenceRefs: [reference],
        diagnostics: { detail: outcome.raw ?? `${side} did not establish ${behaviorId}` },
      });
      continue;
    }
    const common = {
      behaviorId,
      provider: profile.observations.find((item) => item.id === behaviorId).provider,
      level: outcome.level,
      artifactSha256,
      targetIdentity: { ...TARGET },
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      toolVersion: side === 'twin' ? 'labwired-sim recorded fixture' : 'probe-rs recorded fixture',
      rawEvidenceRefs: [reference],
      diagnostics: { detail: outcome.raw ?? `${side} observed ${behaviorId}` },
    };
    if (outcome.level === 'model_observed') common.nativeArtifactSha256 = artifactSha256;
    if (outcome.level === 'hardware_observed') common.flashedArtifactSha256 = artifactSha256;
    await bundle.recordBehavior(behaviorId, common);
  }
  const receipt = await bundle.finalize();
  await fs.writeFile(path.join(OUT, `${name}.receipt.json`),
    `${JSON.stringify({ bundle: name, side, artifactSha256, manifestSha256: receipt.manifestSha256, result: receipt.result }, null, 2)}\n`);
  process.stdout.write(`recorded ${name} (${side}) result=${receipt.result} manifest=${receipt.manifestSha256}\n`);
  return receipt;
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const artifactA = path.join(OUT, 'firmware-a.bin');
  const artifactB = path.join(OUT, 'firmware-b.bin');
  await fs.writeFile(artifactA, 'labwired twin-desk differential firmware A\n');
  await fs.writeFile(artifactB, 'labwired twin-desk differential firmware B\n');
  const shaA = await sha256File(artifactA);
  const shaB = await sha256File(artifactB);

  // Both targets ran firmware A and both saw both behaviors.
  await record('agree/twin', 'twin', shaA, {
    heartbeat: { level: 'model_observed' }, 'led-blink': { level: 'model_observed' },
  });
  await record('agree/desk', 'desk', shaA, {
    heartbeat: { level: 'hardware_observed' }, 'led-blink': { level: 'hardware_observed' },
  });

  // The twin says the LED blinks; the desk board says it does not. This is the
  // published disagreement.
  await record('disagree/desk', 'desk', shaA, {
    heartbeat: { level: 'hardware_observed' },
    'led-blink': { level: 'failed', raw: 'logic capture recorded 0 edges on the LED channel' },
  });

  // No probe was detected, so nothing physical was observed at all.
  await record('no-probe/desk', 'desk', shaA, {
    heartbeat: { level: 'blocked', raw: 'no probe detected; exact flash was not proven' },
    'led-blink': { level: 'blocked', raw: 'no probe detected; exact flash was not proven' },
  });

  // A twin bundle that claims physical evidence must never be accepted.
  await record('contaminated/twin', 'twin', shaA, {
    heartbeat: { level: 'hardware_observed' }, 'led-blink': { level: 'model_observed' },
  });

  // A desk bundle bound to a different firmware than the twin ran.
  await record('mismatch/desk', 'desk', shaB, {
    heartbeat: { level: 'hardware_observed' }, 'led-blink': { level: 'hardware_observed' },
  });

  process.stdout.write(`artifact A ${shaA}\nartifact B ${shaB}\n`);
}

await main();
