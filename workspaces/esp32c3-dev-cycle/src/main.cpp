#include <Arduino.h>

// Oracle / serial-capture marker for this dev cycle.
static const char *const kMarker = "LABWIRED_C3_CYCLE_OK";

void setup() {
  Serial.begin(115200);
  // USB-CDC often needs a moment after boot.
  delay(800);
  Serial.println(kMarker);
  Serial.println("chip=esp32c3");
  Serial.println("fw=labwired-dev-cycle-1");
  pinMode(8, OUTPUT); // many C3 boards: onboard LED on GPIO8
}

void loop() {
  digitalWrite(8, HIGH);
  delay(200);
  digitalWrite(8, LOW);
  delay(800);
  Serial.println(kMarker);
}
