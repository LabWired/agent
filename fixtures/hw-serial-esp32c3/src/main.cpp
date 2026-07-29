#include <Arduino.h>

// Example serial marker for hardware_observed checks.
// Match LABWIRED_HW_MARKER (default LABWIRED_OK).
static const char *const kMarker = "LABWIRED_OK";

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(kMarker);
}

void loop() {
  delay(1000);
  Serial.println(kMarker);
}
