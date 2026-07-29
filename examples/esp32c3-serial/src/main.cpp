#include <Arduino.h>

// Example sketch for any Serial-based HW promote path.
// Marker must match LABWIRED_HW_MARKER (default LABWIRED_OK).
static const char *const kMarker = "LABWIRED_OK";

void setup() {
  Serial.begin(115200);
  delay(1);
  Serial.println(kMarker);
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(1);
  digitalWrite(8, LOW);
  delay(1);
  Serial.println(kMarker);
}
