#!/usr/bin/env python3
"""Confirm that a selected UART is reported by PlatformIO for one JTAG serial."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any


_DEFAULT_TIMEOUT_SECONDS = 5.0


def _positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("timeout must be a number") from error
    if seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be greater than zero")
    return seconds


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uart-device", required=True)
    parser.add_argument("--jtag-serial", required=True)
    parser.add_argument("--timeout-seconds", type=_positive_seconds, default=_DEFAULT_TIMEOUT_SECONDS,
                        help=argparse.SUPPRESS)
    return parser


def _has_exact_serial(hwid: str, serial: str) -> bool:
    return re.search(r"(?:^|\s)SER=" + re.escape(serial) + r"(?=\s|$)", hwid) is not None


def _devices(timeout_seconds: float) -> list[dict[str, Any]] | None:
    try:
        completed = subprocess.run(
            ["pio", "device", "list", "--json-output"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, list) and all(isinstance(item, dict) for item in value) else None


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    devices = _devices(args.timeout_seconds)
    if devices is None:
        return 2
    for device in devices:
        if device.get("port") == args.uart_device and isinstance(device.get("hwid"), str):
            if _has_exact_serial(device["hwid"], args.jtag_serial):
                print(args.jtag_serial)
                return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
