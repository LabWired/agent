#!/usr/bin/env python3
"""Run one simple ESP32-S3 build, flash, UART, and JTAG evaluation."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import sys
import threading

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmarks.twin2silicon.hil.esp32s3 import (
    BoardLock,
    Esp32S3Config,
    capture_uart_nonce,
    flash_firmware,
    read_registers,
    validate_identity,
)
from benchmarks.twin2silicon.hil.process import run_command
from benchmarks.twin2silicon.hil.results import sha256_file, write_json_atomic


TASKS = Path(__file__).resolve().parent / "tasks"


def _usage(path: Path) -> dict:
    data = json.loads(path.read_text())
    tokens = data["tokens"]
    rates = data["rates_usd_per_million"]
    for value in (*tokens.values(), *rates.values(), data["requests"]):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("usage values must be finite and nonnegative")
    data["estimated_cost_usd"] = (
        tokens["fresh_input"] * rates["fresh_input"]
        + tokens["cached_input"] * rates["cached_input"]
        + tokens["output"] * rates["output"]
    ) / 1_000_000
    return data


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--jtag-serial", required=True)
    parser.add_argument("--uart-device", required=True)
    parser.add_argument("--platformio", default="pio")
    parser.add_argument("--openocd", required=True)
    parser.add_argument("--identity-command-json")
    parser.add_argument("--usage-json", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    run_dir = args.run_dir.resolve()
    if run_dir.exists():
        print("run directory already exists", file=sys.stderr)
        return 2
    run_dir.mkdir(parents=True)
    result = {
        "schema_version": "1.0",
        "status": "running",
        "compile_status": "not_run",
        "hardware_status": "not_run",
        "infrastructure_status": "ok",
        "uart": None,
        "registers": [],
        "cost": None,
        "hashes": {},
    }

    def save() -> None:
        write_json_atomic(run_dir / "run.json", result)

    save()
    try:
        task_root = (TASKS / args.task).resolve() if len(Path(args.task).parts) == 1 else Path(args.task).resolve()
        task = json.loads((task_root / "task.json").read_text())
        oracle_path = task_root / task["hidden_oracle"]
        config = Esp32S3Config.from_oracle(json.loads(oracle_path.read_text()))
        workspace = run_dir / "workspace"
        shutil.copytree(args.candidate.resolve(strict=True), workspace)
        nonce = secrets.token_hex(16)
        header = workspace / "firmware/include/run_nonce.h"
        header.parent.mkdir(parents=True, exist_ok=True)
        header.write_text(f'#pragma once\n#define LABWIRED_RUN_NONCE "{nonce}"\n')
        result["task_id"] = task["id"]
        result["hashes"]["oracle"] = sha256_file(oracle_path)
        if args.usage_json:
            cost = _usage(args.usage_json)
            result["cost"] = cost
            write_json_atomic(run_dir / "cost.json", cost)
        save()

        firmware = workspace / "firmware"
        build = [args.platformio, "run", "--project-dir", str(firmware),
                 "--environment", config.platformio_environment or "esp32s3"]
        clean = run_command(build + ["--target", "clean"], cwd=workspace,
                            stdout_path=run_dir / "clean.stdout.log",
                            stderr_path=run_dir / "clean.stderr.log",
                            timeout_seconds=task["budgets"]["wall_time_seconds"])
        if clean.timed_out or clean.cleanup_error or clean.returncode:
            raise RuntimeError("clean failed")
        compiled = run_command(build, cwd=workspace, stdout_path=run_dir / "build.stdout.log",
                               stderr_path=run_dir / "build.stderr.log",
                               timeout_seconds=task["budgets"]["wall_time_seconds"])
        if compiled.timed_out or compiled.cleanup_error:
            raise RuntimeError("build infrastructure failed")
        if compiled.returncode:
            result.update(status="fail", compile_status="fail")
            save()
            return 0
        result["compile_status"] = "pass"
        artifact = firmware / config.flash_artifact
        result["hashes"]["firmware"] = sha256_file(artifact)
        save()

        identity_command = (json.loads(args.identity_command_json)
                            if args.identity_command_json else list(config.identity_command))
        with BoardLock(run_dir.parent / ".board-locks", args.jtag_serial,
                       timeout_seconds=config.identity_timeout_seconds):
            identity = validate_identity(identity_command, args.jtag_serial, cwd=workspace,
                                         evidence_dir=run_dir,
                                         timeout_seconds=config.identity_timeout_seconds)
            if identity.status != "pass":
                raise RuntimeError(identity.detail or "board identity failed")

            uart_box = {}
            uart_errors = []
            def capture() -> None:
                try:
                    uart_box["result"] = capture_uart_nonce(
                        args.uart_device, config.uart_baud, nonce,
                        config.uart_timeout_seconds, run_dir / "uart.log")
                except Exception as error:
                    uart_errors.append(error)
            uart_thread = threading.Thread(target=capture)
            uart_thread.start()
            flash_command = build + ["--target", config.flash_target]
            flashed = flash_firmware(flash_command, cwd=workspace, evidence_dir=run_dir,
                                     timeout_seconds=config.flash_timeout_seconds,
                                     identity_validated=True)
            uart_thread.join(config.uart_timeout_seconds + 1)
            if uart_thread.is_alive() or uart_errors:
                raise RuntimeError("UART capture failed")
            uart = uart_box["result"]
            result["uart"] = {"matched": uart.matched, "termination": uart.termination_reason,
                              "bytes": uart.bytes_captured}
            if flashed.status == "infrastructure_error":
                raise RuntimeError(flashed.detail or "flash infrastructure failed")
            if flashed.status == "hardware_fail" or not uart.matched:
                result.update(status="fail", hardware_status="fail")
                save()
                return 0

            registers = read_registers(args.openocd, config.openocd_board_config,
                                       args.jtag_serial, config.assertions, cwd=workspace,
                                       evidence_dir=run_dir,
                                       timeout_seconds=config.openocd_command_timeout_seconds)
            if registers.status == "infrastructure_error":
                raise RuntimeError(registers.detail or "OpenOCD failed")
            result["registers"] = [
                {"name": item.name, "passed": item.passed,
                 "observed_masked": f"0x{item.value & item.mask:08x}"}
                for item in registers.evaluation.observations
            ]
            result["hardware_status"] = "pass" if registers.status == "pass" else "fail"
            result["status"] = "pass" if registers.status == "pass" else "fail"
            save()
            return 0
    except Exception as error:
        result.update(status="invalid", infrastructure_status="error", error=str(error))
        save()
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
