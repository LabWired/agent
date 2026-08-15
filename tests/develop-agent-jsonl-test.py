#!/usr/bin/env python3
import subprocess, sys, tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = root / "tests" / "develop-agent-jsonl.py"
valid = root / "tests" / "fixtures" / "develop-agent" / "opencode-valid.jsonl"

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "events.jsonl"
    ok = subprocess.run([sys.executable, str(parser), str(valid), str(out)], text=True, capture_output=True)
    assert ok.returncode == 0, ok.stderr
    assert out.read_text().count("\n") == 5

    mixed = Path(tmp) / "mixed.txt"
    mixed.write_text(valid.read_text() + "provider banner or corrupt framing\n")
    bad = subprocess.run([sys.executable, str(parser), str(mixed), str(out)], text=True, capture_output=True)
    assert bad.returncode != 0
    assert "unexpected non-json stdout" in bad.stderr.lower()

    stderr = Path(tmp) / "stderr.txt"
    stderr.write_text("Bearer provider-secret user@example.com https://user:pw@host/path?jwt=secret\n")
    sanitized = Path(tmp) / "stderr.sanitized"
    clean = subprocess.run([sys.executable, str(parser), "sanitize-stderr", str(stderr), str(sanitized)], text=True, capture_output=True)
    assert clean.returncode == 0, clean.stderr
    assert sanitized.read_text() == "[redacted] [redacted-email] https://host/path\n"

print("ok   develop-agent strict JSONL")
