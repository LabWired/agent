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
