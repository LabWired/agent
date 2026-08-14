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
