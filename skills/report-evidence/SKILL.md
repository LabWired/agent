---
name: report-evidence
description: >-
  Turn labwired_verify JSON and gaps into a human or CI report. Never invent a
  pass; quote status, gaps, and evidence_ref only as returned.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
---

# Report evidence

## Hard rule

The report **mirrors the oracle**. You do not upgrade status.
If `status` is not `model_verified`, the report must not say the firmware is
model-verified. Quote the verify payload only as returned.

## Procedure

1. Take a saved verify payload (file or last tool result): `status`, `gaps`,
   `evidence_ref`, clause results, diagnosis.
2. Structure the report:
   - **Status** — exact enum value
   - **Firmware / diagram / oracle refs** when present
   - **Gaps** — list blocking items; do not omit
   - **Evidence** — `evidence_ref` only if present; say if missing
   - **Allowed claim** — one sentence from claim vocabulary
3. For CI, prefer machine-checkable form:
   `labwired assert-status model_verified < verify.json`
4. Optional: load `inspect-evidence` when explaining digests/signatures.
5. Never invent signatures, digests, or a green status.

## Claim vocabulary

Same as `verify-firmware`:

| Status | Allowed wording |
|--------|-----------------|
| `model_verified` | model-verified (sim/oracle only) |
| `failed` | failed — behavior contradicted oracle or faulted |
| `inconclusive` | inconclusive — missing evidence or runner failure |
| `unsupported` | unsupported — unmodeled surface |
