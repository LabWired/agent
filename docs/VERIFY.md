# Understand Verification

A successful build means the source became firmware. It does not mean the
firmware behaved correctly.

## Observation

`labwired_run` runs firmware on the twin and returns logs and other evidence.
This is useful for debugging. Observation alone does not pass a behavior test.

## Twin behavior check

`labwired_verify` compares the twin's behavior with the expected behavior. A
complete match with no blocking gaps returns `model_verified`. This means the
twin saw the expected behavior.

Keep the expected behavior unchanged during repair. Changing it after a failure
would hide the original problem.

## Physical board check

A physical check must flash the board and capture the expected serial or RTT
marker. A successful check returns `hardware_observed`. This means the marker
was seen on the physical board. It does not replace the twin result.

## Other results

- `failed`: the behavior was wrong, or the firmware crashed.
- `inconclusive`: required evidence was missing, or the runner failed.
- `unsupported`: the twin cannot model the required behavior yet.

Every result may include gaps. Gaps state what was not checked. Report them as
written. Do not weaken a check to make it pass.

If a model key, twin, probe, or board is missing, the related optional test is
not run. It must not be reported as passed.

## Legacy hardware profiles

The legacy hardware wrappers only translate `LABWIRED_HW_*` inputs into a
version 1 hardware profile. A physical plan requires its exact digest in
`LABWIRED_HW_CONFIRM`; build/twin-only plans reuse their own digest because
they contain no flash or `hardware_observed` action. `desk-hw-physical.sh`
imports `LABWIRED_HW_ELF` with the trusted `prebuilt` provider, which hashes
and receipts the existing artifact without claiming it was compiled. Serial
capture is currently fixed at 115200 baud, and custom
`LABWIRED_HW_TWIN_STEPS` is not representable in profile v1; both unsupported
overrides fail closed instead of being ignored.

## Generic evidence vocabulary

The generic hardware runner records one of these levels for each stage or
behavior:

- `imported`: a `prebuilt` artifact was found, hashed, and receipted; it was
  not compiled by this run.
- `compiled`: the native build produced the recorded artifact.
- `model_observed`: the twin executed that exact native artifact and observed
  the behavior.
- `surrogate_model_observed`: a separately built artifact with declared shared
  sources produced the model observation. This never clears an exact-artifact
  requirement.
- `hardware_observed`: a trusted physical provider produced independent,
  identity-bound evidence after exact flash.
- `untrusted_observation`: a reserved evidence level for a possible future
  custom provider. Profile schema v1 accepts no custom provider and cannot
  produce this level operationally.
- `blocked`: a required capability, identity, confirmation, secret, artifact,
  instrument, or piece of evidence was absent.
- `failed`: a provider ran and contradicted the assertion or failed while
  collecting it.

The plan JSON, stage receipts, behavior receipts, raw captures, hashes, tool
versions, and final `result.json` are written below the selected evidence
directory. Verify an external receipt by checking its recorded SHA-256 hashes
against the referenced artifact and capture files, confirming the profile and
plan digests, and matching provider versions and explicit identities to the
reviewed plan. A copied summary without those files is not proof.

## Physical behavior evidence

Physical execution needs a reviewed profile, exact probe serial and serial-port
identity, unambiguous enumeration, available instruments, safe wiring, and an
operator-confirmed digest. The strict acceptance lane reports `BLOCKED` when
`LABWIRED_HW_PROFILE` is absent or incomplete. This repository has not claimed
a real physical acceptance PASS merely because deterministic provider tests
passed.

For an LED claim, connect a logic analyzer to the declared GPIO and common
ground, use a voltage-compatible input, and record edges plus frequency bounds.
Serial text is not GPIO proof and cannot satisfy the LED behavior.

For Wi-Fi, firmware must emit a fresh runner-provided nonce and device address;
the host then probes that address and verifies the same nonce. A static serial
message, a host-only request, or a mismatched nonce fails correlation.

When an Arduino ELF or other native artifact uses a format the twin cannot
execute, report the twin behavior as unsupported/blocked. The exact native
artifact can still use exact physical flash plus independent hardware evidence;
do not relabel a surrogate or compilation result as exact model evidence.

## Legacy environment migration

Prefer `.labwired/hardware.json`. Existing `LABWIRED_HW_ELF`,
`LABWIRED_HW_CHIP`, `LABWIRED_HW_PORT`, `LABWIRED_HW_MARKER`, and related
wrapper inputs are translated to a temporary version 1 profile. The wrappers
still require the exact `LABWIRED_HW_CONFIRM` digest before physical execution.
They cannot represent arbitrary twin steps, fix serial capture at 115200 baud,
and preserve prebuilt artifacts as imported rather than compiled. Migrate any
workflow needing other providers, observations, baud rates, or behavior-level
claims to the checked-in generic profile.
