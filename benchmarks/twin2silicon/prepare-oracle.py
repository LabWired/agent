from pathlib import Path
import sys

template, system, firmware, output = map(Path, sys.argv[1:])
text = template.read_text()
text = text.replace('"__SYSTEM__"', f'"{system.resolve()}"')
text = text.replace('"__FIRMWARE__"', f'"{firmware.resolve()}"')
if "__SYSTEM__" in text or "__FIRMWARE__" in text:
    raise SystemExit("unresolved oracle placeholder")
output.write_text(text)
