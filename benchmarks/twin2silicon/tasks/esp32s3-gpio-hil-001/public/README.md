# ESP32-S3 GPIO repair

Repair the ESP-IDF firmware in `firmware/` so GPIO 2 is driven high when the
firmware reports readiness. Keep the readiness message and nonce behavior
intact. The evaluator builds the PlatformIO project, flashes an ESP32-S3
DevKitC-1, observes its console output, and validates the resulting hardware
state.

The checked-in nonce header makes the project build standalone. During an
evaluation run, the harness replaces its placeholder value with a unique run
nonce.
