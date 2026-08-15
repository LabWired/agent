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
    stderr.write_text(
        "Authorization: Basic auth-secret\nBearer provider-secret\napi_key=api-sentinel\nDEEPINFRA_API_KEY=deepinfra-sentinel\n"
        "password: pass-sentinel token=token-sentinel secret=secret-sentinel\n"
        "-----BEGIN PRIVATE KEY-----\nprivate-sentinel\n-----END PRIVATE KEY-----\n"
        "user@example.com https://user:pw@host/path?jwt=signed-sentinel\n"
    )
    sanitized = Path(tmp) / "stderr.sanitized"
    clean = subprocess.run([sys.executable, str(parser), "sanitize-stderr", str(stderr), str(sanitized)], text=True, capture_output=True)
    assert clean.returncode == 0, clean.stderr
    cleaned = sanitized.read_text()
    for sentinel in ("auth-secret", "provider-secret", "api-sentinel", "deepinfra-sentinel", "pass-sentinel", "token-sentinel", "secret-sentinel", "private-sentinel", "user@example.com", "signed-sentinel", "user:pw"):
        assert sentinel not in cleaned, sentinel
    assert "https://host/path" in cleaned

print("ok   develop-agent strict JSONL")
