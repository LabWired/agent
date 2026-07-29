#include <Arduino.h>

// Universal Arduino sketch — only Serial.println (no dual Serial0, no custom ELF).
// Twin path: monorepo labwired-sim `test` (C3 fast-boot), same as arduino-matrix L0–L2.
// Desk path: PIO flash + USB serial capture.
static const char *const kMarker = "LABWIRED_C3_CYCLE_OK";

void setup() {
  Serial.begin(115200);
  delay(1);
  Serial.println(kMarker);
  Serial.println("chip=esp32c3");
  Serial.println("fw=labwired-dev-cycle-1");
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(1);
  digitalWrite(8, LOW);
  delay(1);
  Serial.println(kMarker);
}
