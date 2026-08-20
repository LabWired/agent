/**
 * Differential twin-vs-desk comparison.
 *
 * One firmware artifact is taken to two independent targets: the LabWired
 * digital twin and a real desk board. Each side produces its own authenticated
 * evidence bundle. This module compares the two bundles and publishes the
 * disagreement as a first-class result.
 *
 * Hard rules encoded here (see skills/desk-hw/SKILL.md):
 *
 *  - A side's claim is computed from that side's bundle only. There is no code
 *    path that copies a level, a grade, or a pass from one side to the other,
 *    so hardware green can never be upgraded to twin green or the reverse.
 *  - `model_verified` is twin-only. It is minted from twin model evidence and
 *    never from flash, serial, or any desk record.
 *  - `hardware_observed` is desk-only. A desk record carrying a model level is
 *    inconclusive desk evidence, never a desk pass.
 *  - Both sides must bind to the exact same artifact digest. A mismatch is
 *    `invalid`; it is never smoothed into agreement.
 *  - Absent desk evidence is `desk-unavailable`, never a silent pass.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { levelSatisfies, sha256File, verifyEvidenceBundle } from './evidence.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

/** Levels a twin bundle is permitted to record. */
export const TWIN_LEVELS = Object.freeze(['compiled', 'model_observed', 'surrogate_model_observed']);
/** Levels a desk bundle is permitted to record as physical evidence. */
export const DESK_LEVELS = Object.freeze(['hardware_observed']);
/** Levels that carry no verdict for either side. */
export const INCONCLUSIVE_LEVELS = Object.freeze(['not-run', 'blocked', 'imported', 'untrusted_observation']);

const TWIN_SET = new Set(TWIN_LEVELS);
const DESK_SET = new Set(DESK_LEVELS);
const INCONCLUSIVE_SET = new Set(INCONCLUSIVE_LEVELS);

/** Process exit codes. Agreement is the only zero. */
export const DIFFERENTIAL_EXIT_CODES = Object.freeze({
  agree: 0,
  invalid: 2,
  disagree: 3,
  'desk-unavailable': 4,
  'twin-unavailable': 5,
});

export function exitCodeForVerdict(verdict) {
  const code = DIFFERENTIAL_EXIT_CODES[verdict];
  if (code === undefined) throw new TypeError(`unknown differential verdict ${verdict}`);
  return code;
}

function reason(code, message, extra = {}) {
  return { code, message, ...extra };
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Read the behavior records out of an evidence bundle that `verifyEvidenceBundle`
 * has already re-derived byte for byte. Verification is the trust boundary; this
 * is a plain read of the bytes it just authenticated.
 */
async function readAuthenticatedRecords(directory) {
  const root = path.resolve(directory);
  const owner = await readJsonFile(path.join(root, '.owner.json'));
  const records = [];
  for (const behavior of owner.behaviors) {
    const record = await readJsonFile(path.join(root, 'observations', behavior.id, 'result.json'));
    records.push(record);
  }
  return { owner, records };
}

/**
 * Load one side of the comparison from a persisted evidence bundle.
 *
 * `side` is `twin` or `desk` and is never inferred from the bundle: the caller
 * declares which target the bundle came from, and the bundle is then held to
 * that side's level partition.
 */
export async function loadEvidenceSide(directory, { side, expectedManifestSha256 } = {}) {
  if (side !== 'twin' && side !== 'desk') throw new TypeError('side must be twin or desk');
  if (typeof directory !== 'string' || directory === '') {
    return { side, available: false, reasons: [reason('evidence_absent', `no ${side} evidence bundle was supplied`)] };
  }
  const verification = await verifyEvidenceBundle(directory, { expectedManifestSha256 });
  if (!verification.valid) {
    return {
      side,
      available: false,
      authenticity: verification.authenticity ?? 'unverified',
      reasons: [
        reason('evidence_unverified', `${side} evidence bundle did not authenticate`),
        ...(verification.reasons ?? []),
      ],
    };
  }
  const { owner, records } = await readAuthenticatedRecords(directory);
  return {
    side,
    available: true,
    authenticity: 'verified',
    manifestSha256: verification.manifestSha256,
    bundleResult: verification.result,
    targetIdentity: owner.targetIdentity,
    records,
    reasons: [],
  };
}

/**
 * Classify one recorded behavior for one side.
 *
 * Only this side's record is consulted. `pass`/`fail` are behavioral verdicts;
 * everything else is `inconclusive` and can never make the two sides agree.
 */
function classify(side, record) {
  const level = record.level;
  const allowed = side === 'twin' ? TWIN_SET : DESK_SET;
  const base = { behaviorId: record.behaviorId, provider: record.provider, requiredLevel: record.requiredLevel, level };
  if (level === 'failed') {
    return { ...base, outcome: 'fail', detail: 'recorded failed' };
  }
  if (INCONCLUSIVE_SET.has(level)) {
    return { ...base, outcome: 'inconclusive', detail: `recorded ${level}` };
  }
  if (!allowed.has(level)) {
    // A twin bundle claiming hardware evidence, or any unknown level.
    return { ...base, outcome: 'contaminated', detail: `${side} side recorded ${level}, which only the other target may record` };
  }
  if (side === 'twin' && level === 'compiled') {
    return { ...base, outcome: 'inconclusive', detail: 'compiled_only is not behavior evidence' };
  }
  if (!levelSatisfies(level, record.requiredLevel)) {
    return { ...base, outcome: 'fail', detail: `required ${record.requiredLevel}; recorded ${level}` };
  }
  return { ...base, outcome: 'pass', detail: `recorded ${level}` };
}

function artifactBindingReasons(side, record, artifactSha256) {
  const problems = [];
  if (record.artifactSha256 === undefined) return problems;
  if (record.artifactSha256 !== artifactSha256) {
    problems.push(reason('artifact_mismatch',
      `${side} behavior ${record.behaviorId} is bound to a different artifact`,
      { side, behaviorId: record.behaviorId, expected: artifactSha256, recorded: record.artifactSha256 }));
  }
  if (record.level === 'hardware_observed' && record.flashedArtifactSha256 !== artifactSha256) {
    problems.push(reason('flashed_artifact_mismatch',
      `${side} behavior ${record.behaviorId} did not flash the exact artifact`,
      { side, behaviorId: record.behaviorId, expected: artifactSha256, recorded: record.flashedArtifactSha256 ?? null }));
  }
  return problems;
}

/**
 * Summarize one side without ever consulting the other side.
 * `claim` is the publishable grade for this target alone.
 */
function summarizeSide(sideReport, artifactSha256) {
  const side = sideReport.side;
  if (!sideReport.available) {
    return {
      side,
      available: false,
      claim: null,
      grade: null,
      result: 'NOT_RUN',
      behaviors: [],
      reasons: sideReport.reasons ?? [],
    };
  }
  const behaviors = [];
  const reasons = [];
  for (const record of sideReport.records) {
    reasons.push(...artifactBindingReasons(side, record, artifactSha256));
    behaviors.push(classify(side, record));
  }
  const conclusive = behaviors.filter((item) => item.outcome === 'pass' || item.outcome === 'fail');
  const contaminated = behaviors.filter((item) => item.outcome === 'contaminated');
  for (const item of contaminated) {
    reasons.push(reason('level_partition_violated', item.detail, { side, behaviorId: item.behaviorId, level: item.level }));
  }
  const allPass = conclusive.length > 0 && conclusive.every((item) => item.outcome === 'pass');
  let grade = null;
  if (allPass && contaminated.length === 0) {
    const levels = new Set(conclusive.map((item) => item.level));
    grade = side === 'twin'
      ? (levels.has('surrogate_model_observed') ? 'surrogate_model_observed' : 'model_observed')
      : 'hardware_observed';
  }
  // `model_verified` is minted only from twin model evidence; `hardware_observed`
  // only from desk physical evidence. Neither branch can read the other side.
  const claim = grade === null ? null : (side === 'twin' ? 'model_verified' : 'hardware_observed');
  return {
    side,
    available: true,
    authenticity: sideReport.authenticity,
    manifestSha256: sideReport.manifestSha256,
    targetIdentity: sideReport.targetIdentity,
    claim,
    grade,
    result: conclusive.length === 0 ? 'INCONCLUSIVE' : (allPass ? 'PASS' : 'FAIL'),
    behaviors,
    reasons,
  };
}

function byId(behaviors) {
  return new Map(behaviors.map((item) => [item.behaviorId, item]));
}

/**
 * Compare an authenticated twin side against an authenticated desk side.
 *
 * Pure: it reads only the two summaries and the artifact digest, so the same
 * inputs are reproducible from recorded fixtures and from live runs alike.
 */
export function diffTwinDesk({ artifactSha256, artifactPath = null, twin, desk }) {
  if (typeof artifactSha256 !== 'string' || !SHA256.test(artifactSha256)) {
    throw new TypeError('artifactSha256 must be a lowercase SHA-256 digest');
  }
  const twinSummary = summarizeSide(twin, artifactSha256);
  const deskSummary = summarizeSide(desk, artifactSha256);

  const invalid = [
    ...twinSummary.reasons.filter((item) => item.code === 'artifact_mismatch' || item.code === 'flashed_artifact_mismatch' || item.code === 'level_partition_violated'),
    ...deskSummary.reasons.filter((item) => item.code === 'artifact_mismatch' || item.code === 'flashed_artifact_mismatch' || item.code === 'level_partition_violated'),
  ];

  const twinBehaviors = byId(twinSummary.behaviors);
  const deskBehaviors = byId(deskSummary.behaviors);
  const paired = [];
  const unpaired = [];
  for (const [behaviorId, twinItem] of twinBehaviors) {
    const deskItem = deskBehaviors.get(behaviorId);
    if (!deskItem) {
      unpaired.push({ behaviorId, presentOn: 'twin', twin: twinItem, desk: null });
      continue;
    }
    const comparable = (twinItem.outcome === 'pass' || twinItem.outcome === 'fail')
      && (deskItem.outcome === 'pass' || deskItem.outcome === 'fail');
    paired.push({
      behaviorId,
      twin: twinItem,
      desk: deskItem,
      agreement: comparable ? (twinItem.outcome === deskItem.outcome ? 'agree' : 'disagree') : 'incomparable',
    });
  }
  for (const [behaviorId, deskItem] of deskBehaviors) {
    if (!twinBehaviors.has(behaviorId)) unpaired.push({ behaviorId, presentOn: 'desk', twin: null, desk: deskItem });
  }
  const disagreements = paired.filter((item) => item.agreement === 'disagree');
  const agreements = paired.filter((item) => item.agreement === 'agree');
  const comparablePairs = agreements.length + disagreements.length;

  const reasons = [];
  let verdict;
  if (invalid.length > 0) {
    verdict = 'invalid';
    reasons.push(...invalid);
  } else if (!twinSummary.available || twinSummary.result === 'INCONCLUSIVE') {
    verdict = 'twin-unavailable';
    reasons.push(...(twinSummary.reasons.length ? twinSummary.reasons
      : [reason('twin_inconclusive', 'the twin bundle recorded no conclusive behavior')]));
  } else if (!deskSummary.available) {
    verdict = 'desk-unavailable';
    reasons.push(...(deskSummary.reasons.length ? deskSummary.reasons
      : [reason('evidence_absent', 'no desk evidence bundle was supplied')]));
  } else if (deskSummary.result === 'INCONCLUSIVE') {
    verdict = 'desk-unavailable';
    reasons.push(reason('desk_inconclusive',
      'the desk bundle recorded no conclusive physical behavior; no board evidence exists for this artifact'));
  } else if (comparablePairs === 0) {
    verdict = 'invalid';
    reasons.push(reason('no_comparable_behavior',
      'the twin and desk bundles share no behavior that both sides decided'));
  } else if (disagreements.length > 0) {
    verdict = 'disagree';
    for (const item of disagreements) {
      reasons.push(reason('behavior_disagreement',
        `${item.behaviorId}: twin ${item.twin.outcome} (${item.twin.level}), desk ${item.desk.outcome} (${item.desk.level})`,
        { behaviorId: item.behaviorId, twinOutcome: item.twin.outcome, deskOutcome: item.desk.outcome }));
    }
  } else {
    verdict = 'agree';
  }

  return {
    schema: 1,
    kind: 'twin-desk-differential',
    verdict,
    artifact: { sha256: artifactSha256, path: artifactPath },
    twin: twinSummary,
    desk: deskSummary,
    comparison: { paired, unpaired, comparablePairs, agreed: agreements.length, disagreed: disagreements.length },
    disagreements: disagreements.map((item) => ({
      behaviorId: item.behaviorId,
      twin: { outcome: item.twin.outcome, level: item.twin.level, detail: item.twin.detail },
      desk: { outcome: item.desk.outcome, level: item.desk.level, detail: item.desk.detail },
    })),
    reasons,
    exitCode: exitCodeForVerdict(verdict),
  };
}

/**
 * End-to-end differential over one firmware artifact and two recorded or live
 * evidence bundles. Omitting the desk bundle (no probe, no board) degrades to
 * `desk-unavailable`; it never fabricates a comparison.
 */
export async function runDifferential({ artifactPath, twin = {}, desk = {} } = {}) {
  if (typeof artifactPath !== 'string' || artifactPath === '') throw new TypeError('artifactPath is required');
  const artifactSha256 = (await sha256File(artifactPath)).toLowerCase();
  const twinSide = await loadEvidenceSide(twin.evidenceDir, { side: 'twin', expectedManifestSha256: twin.receipt });
  const deskSide = await loadEvidenceSide(desk.evidenceDir, { side: 'desk', expectedManifestSha256: desk.receipt });
  return diffTwinDesk({ artifactSha256, artifactPath: path.resolve(artifactPath), twin: twinSide, desk: deskSide });
}
