# Multi-device catalog experiments (headless guest)

- Started: 2026-07-30T04:38:45.717Z
- Ended: 2026-07-30T04:49:24.830Z
- Pass: 10/12 (verified: 10)
- Guest: `9e38e50c-7b04-4b67-9ae9-fd0bcbfd6062`

## Results

| id | chip | device | ok | verified | reason |
|----|------|--------|----|----------|--------|
| c3-led-starter | esp32-c3 | led_blink | PASS | yes | verified |
| c3-traffic-ff | esp32-c3 | traffic_light | PASS | yes | verified |
| c3-weather-ff | esp32-c3 | weather_bme280 | PASS | yes | verified |
| c3-ultrasonic-ff | esp32-c3 | ultrasonic | PASS | yes | verified |
| c3-doorbell-ff | esp32-c3 | doorbell_buzzer | FAIL | yes | starter_proven_block |
| pico-led-ff | rp2040 | led_blink | PASS | yes | verified |
| pico-oled-ff | rp2040 | oled_i2c | PASS | yes | verified |
| nrf-led-ff | nrf52840 | led_blink | FAIL | yes | starter_proven_block |
| stm32-f103-ff | stm32f103 | led_blink | PASS | yes | verified |
| s3-oled-ff | esp32-s3 | oled_i2c | PASS |  | agent_settled |
| esp32-button-ff | esp32 | button_led | PASS |  | timeout |
| nokia-l476-ff | stm32l476 | led_blink | PASS | yes | verified |

## By chip

- **esp32-c3**: 4 pass / 1 fail (verified 5)
- **rp2040**: 2 pass / 0 fail (verified 2)
- **nrf52840**: 0 pass / 1 fail (verified 1)
- **stm32f103**: 1 pass / 0 fail (verified 1)
- **esp32-s3**: 1 pass / 0 fail (verified 0)
- **esp32**: 1 pass / 0 fail (verified 0)
- **stm32l476**: 1 pass / 0 fail (verified 1)
