# Use LabWired Agent

## Start

```bash
labwired agent
```

## Sign in

If the Agent asks you to sign in, leave the session and run:

```bash
labwired agent login
labwired agent
```

## Bring up a board or part

Describe the hardware and the result you want:

> Use an RP2040 board. Blink its built-in LED once per second.

The Agent looks up board and part facts before it writes code. Include the exact
board name, part number, or wiring when you know it.

## Repair firmware

Give the Agent the project and the failing behavior:

> Build this firmware. Fix the smallest issue that stops the LED from blinking.

The Agent keeps the behavior check unchanged while it repairs the firmware. It
stops and reports the gap if it cannot prove the behavior.

## Test on the twin

Ask for the expected behavior in plain language:

> Test on the twin that the LED changes state every 500 milliseconds.

The Agent builds the firmware, runs the twin, and checks the expected behavior.
See [Verification](VERIFY.md) for how to read the result.

## Observe a run

Ask for logs or a plot without asking for a pass result:

> Run the twin and show the UART output.

> Plot the LED state over time.

An observation helps with debugging. It is not a behavior test by itself.

## Check a physical board

This step is optional. Connect a supported probe and board, then ask:

> Flash the same firmware to my board and capture the LABWIRED_OK serial marker.

The Agent reports the physical check separately from the twin result.

## Use a generic hardware profile

Put a reviewed version 1 profile at `.labwired/hardware.json`. The profile is
data, not a shell script. It selects only trusted providers and keeps target
knowledge in the project instead of board-specific Agent code. Start from
`fixtures/hardware-profiles/minimal.json` or the complete
`fixtures/hardware-profiles/esp32c3-acceptance.template.json`.

The complete schema has these fields:

- `schema`: must be `1`.
- `target`: required `id` and `chip`, plus explicit `probeSerial` and
  `serialPort` for physical work. Values such as `auto`, `first`, `any`, and
  `default` are rejected.
- `build`: `provider`, relative `workspace`, provider `environment`, relative
  `artifact`, and optional bounded `timeoutSeconds`. Trusted build providers
  are `platformio`, `make`, `cmake`, and `prebuilt`. `prebuilt` imports and
  hashes an existing artifact; it does not claim compilation.
- `twin`: optional `labwired-sim` provider, relative `system`,
  `artifactRelation` (`exact` or `surrogate`), and timeout. A surrogate also
  requires its own relative `artifact` and non-empty `sharedSources` list.
- `flash`: optional `platformio` or `probe-rs` provider and timeout.
- `observations`: behavior IDs using `serial`, `RTT` (`rtt` in JSON),
  `logic-csv`, or `network`, with a required evidence level and timeout.
  Serial/RTT use `contains`. Logic CSV declares the file, channel, time/value
  columns, minimum edge count, and optional frequency bounds. Network declares
  a device marker, the marker field containing the host address, and a bounded
  host probe path.

All profile paths are relative and must remain below the profile workspace;
absolute paths, `..`, symlink escapes, unknown keys/providers, inline secrets,
and credentials embedded in URLs or authorization strings are rejected. Put
credentials in the provider's native secret store or process environment, not
in the profile. Do not commit a machine-filled physical profile.

Planning is read-only. It resolves provider versions and exact device
identities and prints a SHA-256 digest:

```bash
labwired agent hardware plan --profile .labwired/hardware.json --out .labwired/evidence
```

Review the plan, wiring, target, probe serial, serial port, artifact, and every
action. Execution requires that exact digest; any profile, identity, or tool
change invalidates it:

```bash
labwired agent hardware run --profile .labwired/hardware.json \
  --out .labwired/evidence --confirm <64-character-plan-digest>
```

On macOS and Linux, use the commands above in `bash` or your normal shell. On
Windows PowerShell, invoke the same interface as
`labwired-agent.ps1 hardware plan ...` and `labwired-agent.ps1 hardware run
...`; `labwired.cmd` is also available from Command Prompt.

The public hardware CLI exits `0` for successful planning or a passing run.
Exit `2` is limited to CLI usage errors and missing or wrong confirmation. The
strict acceptance wrapper also intentionally maps its preflight `BLOCKED`
conditions to `2`. Ordinary provider, identity, or capability `BLOCKED`
results and execution or evidence `FAIL` results exit `3`.
Planning never creates the evidence directory or builds, flashes, or opens an
instrument. Runs lock the explicit target, probe, and port identities so two
sessions cannot control the same lab resource.
