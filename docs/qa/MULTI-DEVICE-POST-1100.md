# Multi-device retest post #1100 (auto-oracle) — 2026-07-29

Deploy: API Worker `30499066950` success after merge of #1100.

## Headline
- **10/12** agent pass (was 8/12 pre-oracle)
- **Verified live** solid on **ESP32-C3** (LED, traffic, weather, **ultrasonic** now works)
- Pico / nRF / STM32F103: still **prove thrash** (run_and_verify ×4) without Verified bubble — loop continues, twin serial/prove still fails
- S3 OLED: timeout / no agent completion
- Classic ESP32 button: agent responds, not verified (button needs stimuli)

## Interpretation
#1100 fixed invented-marker path for C3 (ultrasonic now Verified). Non-C3 twin still does not emit matching serial under hosted prove — next dig: builder compile + UART capture for Pico/nRF/STM.

Artifacts: `multi-device-post-1100.log`, `MULTI-DEVICE-HEADLESS-2026-07-29T23-22-15.json`
