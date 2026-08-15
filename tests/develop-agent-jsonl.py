#!/usr/bin/env python3
"""Validate and copy documented OpenCode --format json JSONL stdout."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ALLOWED = {"step_start", "step_finish", "tool_use", "text"}


def reject(message: str) -> int:
    print(f"strict JSONL rejected: {message}", file=sys.stderr)
    return 1


def sanitize_stderr(source: Path, target: Path) -> int:
    try:
        text = source.read_text(encoding="utf-8", errors="replace")
        text = re.sub(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            "[redacted-private-key]",
            text,
            flags=re.I | re.S,
        )
        text = re.sub(r"(?im)^\s*authorization\s*:\s*.*$", "Authorization: [redacted]", text)
        text = re.sub(r"(?i)bearer\s+\S+", "[redacted]", text)
        text = re.sub(
            r"(?i)\b([a-z0-9_]*(?:api[_-]?key|provider[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret))"
            r"\s*[:=]\s*(?:['\"]?)[^\s,'\";]+",
            lambda match: f"{match.group(1)}=[redacted]",
            text,
        )
        text = re.sub(
            r"\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|(?:lwd|lwr|di)_[A-Za-z0-9_-]{8,})\b",
            "[redacted-key]",
            text,
        )
        text = re.sub(r"(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", "[redacted-email]", text)
        def clean_url(match):
            try:
                split = urlsplit(match.group(0))
                host = split.hostname or ""
                port = f":{split.port}" if split.port else ""
                return urlunsplit((split.scheme, host + port, split.path, "", ""))
            except ValueError:
                return "[redacted-url]"
        text = re.sub(r"https?://\S+", clean_url, text)
        target.write_text(text, encoding="utf-8")
    except OSError as exc:
        return reject(f"cannot sanitize stderr: {exc}")
    return 0


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "sanitize-stderr":
        return sanitize_stderr(Path(sys.argv[2]), Path(sys.argv[3]))
    if len(sys.argv) != 3:
        print("usage: develop-agent-jsonl.py <stdout> <events>", file=sys.stderr)
        return 2
    source, target = map(Path, sys.argv[1:])
    events = []
    try:
        lines = source.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        return reject(f"unreadable stdout: {exc}")
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return reject(f"unexpected non-JSON stdout at line {number}")
        if not isinstance(event, dict) or event.get("type") not in ALLOWED:
            return reject(f"unexpected event framing at line {number}")
        part = event.get("part")
        if not isinstance(part, dict):
            return reject(f"event missing part object at line {number}")
        if event["type"] == "tool_use":
            if not isinstance(part.get("id"), str) or not isinstance(part.get("tool"), str) or not isinstance(part.get("state"), dict):
                return reject(f"invalid tool_use shape at line {number}")
        elif event["type"] == "text":
            if not isinstance(part.get("id"), str) or not isinstance(part.get("text"), str):
                return reject(f"invalid text shape at line {number}")
        events.append(event)
    if not events:
        return reject("agent emitted no documented JSON events")
    try:
        target.write_text("".join(json.dumps(event, separators=(",", ":")) + "\n" for event in events), encoding="utf-8")
    except OSError as exc:
        return reject(f"cannot write events: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
