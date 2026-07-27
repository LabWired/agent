---
name: inspect-evidence
description: >-
  Explain a LabWired evidence_ref or verification result: status, gaps, artifact
  digests, and what claims are allowed. Read-only; never invent signatures.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
---

# Inspect evidence

## Procedure

1. If the user provides `evidence_ref` (`sha256:…`), locate the evidence file under
   `$LABWIRED_EVIDENCE_DIR` or `~/.labwired/evidence/sha256/<hex>.json` when present.
2. Parse the manifest: subject firmware_ref, oracle/system refs, result.status, gaps, producer.
3. Restate allowed claims from `result.status` only.
4. If only a live `labwired_verify` payload is available, interpret `status`, `gaps`,
   `evidence_ref`, and `evidence_signature` without inventing missing fields.
5. If the file is missing, say so — do not fabricate evidence.

## Never

- Treat missing evidence as model_verified.
- Upgrade model verification to hardware confirmation.
