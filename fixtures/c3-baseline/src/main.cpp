#include <Arduino.h>

// Serial marker for C3 HW promote / serial-capture checks.
// Must match fixture README and any twin oracle that shares this beachhead.
static const char *const kMarker = "LABWIRED_C3_BASELINE_OK";

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(kMarker);
}

void loop() {
  // Re-print periodically so capture windows still see the marker after attach.
  delay(1000);
  Serial.println(kMarker);
}
