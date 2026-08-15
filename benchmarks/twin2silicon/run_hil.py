#!/usr/bin/env python3
"""Run an isolated, reproducible ESP32-S3 hardware-in-loop evaluation.

Fixture commands are argv arrays supplied with ``--identity-command-json``;
shell command strings are deliberately unsupported.
"""

from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import sys
import threading
from typing import Any, Mapping

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmarks.twin2silicon.hil.esp32s3 import (
    BoardLock, BoardLockTimeout, Esp32S3Config, capture_uart_nonce,
    flash_firmware, read_registers, validate_identity,
)
from benchmarks.twin2silicon.hil.process import run_command
from benchmarks.twin2silicon.hil.results import sha256_file, write_json_atomic


ROOT = Path(__file__).resolve().parent
TASKS = ROOT / "tasks"
HARNESS_REVISION = "twin2silicon-hil-1"


def _number(value: object, field: str, *, integer: bool = False) -> int | float:
    valid = isinstance(value, int if integer else (int, float)) and not isinstance(value, bool)
    finite = integer or (valid and math.isfinite(value))
    if not valid or value < 0 or not finite:
        raise ValueError(f"{field} must be a nonnegative finite {'integer' if integer else 'number'}")
    return int(value) if integer else float(value)


def parse_usage(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    root_keys = {"schema_version", "requests", "tokens", "final_context_tokens", "latency_seconds",
                 "provider", "model", "rates_usd_per_million", "price_source", "price_effective_date"}
    if not isinstance(raw, Mapping) or set(raw) != root_keys or raw.get("schema_version") != "1.0":
        raise ValueError("usage schema must be exactly version 1.0")
    if not isinstance(raw, Mapping) or not isinstance(raw.get("tokens"), Mapping):
        raise ValueError("usage must contain an object and tokens object")
    if not isinstance(raw.get("rates_usd_per_million"), Mapping):
        raise ValueError("usage must contain rates_usd_per_million")
    if set(raw["tokens"]) != {"fresh_input", "cached_input", "output", "reasoning"}:
        raise ValueError("usage token keys are not exact")
    if set(raw["rates_usd_per_million"]) != {"fresh_input", "cached_input", "output"}:
        raise ValueError("usage rate keys are not exact")
    tokens = {name: _number(raw["tokens"].get(name), f"tokens.{name}", integer=True)
              for name in ("fresh_input", "cached_input", "output", "reasoning")}
    rates = {name: _number(raw["rates_usd_per_million"].get(name), f"rates.{name}")
             for name in ("fresh_input", "cached_input", "output")}
    for name in ("provider", "model", "price_source", "price_effective_date"):
        if not isinstance(raw.get(name), str) or not raw[name]:
            raise ValueError(f"{name} must be a nonempty string")
    result = {
        "schema_version": "1.0", "requests": _number(raw.get("requests"), "requests", integer=True),
        "tokens": tokens, "final_context_tokens": _number(raw.get("final_context_tokens"), "final_context_tokens", integer=True),
        "latency_seconds": _number(raw.get("latency_seconds"), "latency_seconds"),
        "provider": raw["provider"], "model": raw["model"], "rates_usd_per_million": rates,
        "price_source": raw["price_source"], "price_effective_date": raw["price_effective_date"],
    }
    result["cost_usd"] = (tokens["fresh_input"] * rates["fresh_input"]
                          + tokens["cached_input"] * rates["cached_input"]
                          + tokens["output"] * rates["output"]) / 1_000_000
    return result


def _tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def _safe_tree(source: Path, field: str) -> Path:
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise ValueError(f"{field} is not a directory")
    for item in source.rglob("*"):
        if item.is_symlink():
            raise ValueError(f"{field} contains a symlink: {item.relative_to(source)}")
    return source


def _resolve_task(value: str) -> Path:
    supplied = Path(value)
    candidate = supplied if supplied.is_absolute() or len(supplied.parts) > 1 else TASKS / supplied
    resolved = candidate.resolve(strict=True)
    if resolved != TASKS.resolve() and TASKS.resolve() not in resolved.parents:
        raise ValueError("task must be beneath the benchmark tasks directory")
    if not resolved.is_dir() or (resolved / "task.json").is_symlink():
        raise ValueError("invalid task directory")
    return resolved


def _copy_public(source: Path, destination: Path) -> None:
    _safe_tree(source, "candidate/public workspace")
    shutil.copytree(source, destination, symlinks=False)


def _command_record(result: Any, run_dir: Path) -> dict[str, Any]:
    def relative(value: str) -> str:
        try:
            return Path(value).resolve().relative_to(run_dir).as_posix()
        except ValueError:
            return "workspace" if Path(value).name == "workspace" else Path(value).name
    return {"argv": [Path(item).name if Path(item).is_absolute() else item for item in result.command],
            "cwd": relative(result.cwd), "stdout": relative(result.stdout_path),
            "stderr": relative(result.stderr_path), "started_at_utc": result.started_at_utc,
            "ended_at_utc": result.ended_at_utc, "returncode": result.returncode,
            "timed_out": result.timed_out, "duration_seconds": result.duration_seconds,
            "cleanup_error": result.cleanup_error}


def _tool_version(name: str, executable: os.PathLike[str] | str, workspace: Path,
                  run_dir: Path, env: Mapping[str, str] | None = None) -> dict[str, str]:
    record = {"executable": Path(executable).name, "version": "not_available"}
    try:
        result = run_command([executable, "--version"], cwd=workspace,
                             stdout_path=run_dir / f"version.{name}.stdout.log",
                             stderr_path=run_dir / f"version.{name}.stderr.log", timeout_seconds=2, env=env)
        if result.returncode == 0 and not result.timed_out and not result.cleanup_error:
            text = Path(result.stdout_path).read_text(encoding="utf-8", errors="replace").strip()
            record["version"] = " ".join(text.split())[:200] or "unknown"
    except OSError:
        pass
    return record


def _agent_environment() -> dict[str, str]:
    allowed = ("PATH", "HOME", "LABWIRED_HOME", "XDG_CONFIG_HOME", "TMPDIR", "LANG", "LC_ALL",
               "LABWIRED_ACCESS_TOKEN", "LABWIRED_PROJECT", "LABWIRED_MODEL_URL", "LABWIRED_MODEL_KEY")
    return {name: os.environ[name] for name in allowed if name in os.environ}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("task", help="task id, or path beneath benchmarks/twin2silicon/tasks")
    value.add_argument("--run-dir", required=True, type=Path)
    mode = value.add_mutually_exclusive_group(required=True)
    mode.add_argument("--evaluate-only", action="store_true")
    mode.add_argument("--agent-bin", type=Path)
    value.add_argument("--candidate", type=Path)
    value.add_argument("--model")
    value.add_argument("--jtag-serial", required=True)
    value.add_argument("--uart-device", required=True)
    value.add_argument("--openocd", required=True)
    value.add_argument("--platformio", default="pio")
    value.add_argument("--identity-command-json", help="fixture identity argv as a JSON array (never a shell string)")
    value.add_argument("--usage-json", type=Path)
    value.add_argument("--fixture-uart-timeout-seconds", type=float,
                       help="offline fixture only: shorten (never extend) the oracle UART timeout")
    value.add_argument("--fixture-identity-timeout-seconds", type=float,
                       help="offline fixture only: shorten (never extend) identity/lock timeout")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.evaluate_only != bool(args.candidate) or (args.agent_bin and not args.model):
        parser().error("evaluate-only requires --candidate; agent mode requires --model")
    run_dir = args.run_dir.absolute()
    if run_dir.exists():
        print("run directory already exists", file=sys.stderr)
        return 2
    # Reserve the path before resolving tools or executing any command.
    run_dir.mkdir(parents=True)
    manifest: dict[str, Any] = {
        "schema_version": "1.0", "run": {"id": run_dir.name, "started_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")},
        "task": {}, "harness_revision": HARNESS_REVISION, "model": None, "provider": None,
        "requests": None, "tokens": {"fresh_input": None, "cached_input": None, "output": None, "reasoning": None},
        "final_context_tokens": None, "latency_seconds": None, "cost_usd": None,
        "configured_budgets": {}, "budget_validity": {}, "tool_versions": {},
        "model_status": "not_run", "compile_status": "not_run", "simulator_status": "not_supported",
        "hardware_status": "not_run", "infrastructure_status": "ok", "uart": None,
        "register_assertions": [], "termination": "running", "failure_category": None,
        "hashes": {}, "artifacts": [], "environment": {}, "phases": [],
    }
    def persist() -> None:
        write_json_atomic(run_dir / "run.json", manifest)
    def record_phase(name: str, result: Any = None, **details: Any) -> None:
        phase = {"name": name, **details}
        if result is not None:
            phase["command"] = _command_record(result, run_dir)
        manifest["phases"].append(phase)
        persist()
    persist()
    try:
        task_root = _resolve_task(args.task)
        task = json.loads((task_root / "task.json").read_text(encoding="utf-8"))
        if task.get("schema_version") != "1.0":
            raise ValueError("unsupported task schema")
        public = (task_root / task["public_dir"]).resolve(strict=True)
        oracle_path = (task_root / task["hidden_oracle"]).resolve(strict=True)
        if task_root not in public.parents or task_root not in oracle_path.parents:
            raise ValueError("task path escapes task directory")
        config = Esp32S3Config.from_oracle(json.loads(oracle_path.read_text(encoding="utf-8")))
        if args.fixture_uart_timeout_seconds is not None:
            fixture_timeout = args.fixture_uart_timeout_seconds
            if not math.isfinite(fixture_timeout) or fixture_timeout < 0 or fixture_timeout > config.uart_timeout_seconds:
                raise ValueError("fixture UART timeout must be finite, nonnegative, and no larger than the oracle timeout")
            config = replace(config, uart_timeout_seconds=fixture_timeout)
        if args.fixture_identity_timeout_seconds is not None:
            fixture_timeout = args.fixture_identity_timeout_seconds
            if not math.isfinite(fixture_timeout) or fixture_timeout < 0 or fixture_timeout > config.identity_timeout_seconds:
                raise ValueError("fixture identity timeout must be finite, nonnegative, and no larger than oracle timeout")
            config = replace(config, identity_timeout_seconds=fixture_timeout)
        source = _safe_tree(args.candidate, "candidate") if args.evaluate_only else _safe_tree(public, "public")
        workspace = run_dir / "workspace"
        _copy_public(source, workspace)
        nonce = secrets.token_hex(16)
        nonce_header = workspace / "firmware/include/run_nonce.h"
        nonce_header.parent.mkdir(parents=True, exist_ok=True)
        nonce_header.write_text(f'#pragma once\n#define LABWIRED_RUN_NONCE "{nonce}"\n', encoding="utf-8")
        manifest["task"] = {"id": task["id"], "schema_version": task["schema_version"]}
        manifest["configured_budgets"] = task.get("budgets", {})
        manifest["budget_validity"] = {
            name: {"configured": task.get("budgets", {}).get(name), "observed": None, "within_budget": None}
            for name in ("wall_time_seconds", "model_tokens", "repair_iterations")
        }
        manifest["environment"] = {"jtag_serial_sha256": hashlib.sha256(args.jtag_serial.encode()).hexdigest(),
                                   "uart_device": Path(args.uart_device).name}
        manifest["hashes"]["oracle_descriptor"] = sha256_file(oracle_path)
        manifest["hashes"]["source_initial"] = _tree_hash(workspace)
        record_phase("prepared")
        manifest["tool_versions"] = {
            "platformio": _tool_version("platformio", args.platformio, workspace, run_dir),
            "openocd": _tool_version("openocd", args.openocd, workspace, run_dir),
        }
        if args.agent_bin:
            manifest["tool_versions"]["agent"] = _tool_version(
                "agent", args.agent_bin, workspace, run_dir, _agent_environment())
        persist()

        if args.usage_json:
            usage = parse_usage(args.usage_json)
            write_json_atomic(run_dir / "cost.json", usage)
            for name in ("requests", "tokens", "final_context_tokens", "latency_seconds", "provider", "model", "cost_usd"):
                manifest[name] = usage[name]
            observed_tokens = usage["tokens"]["fresh_input"] + usage["tokens"]["cached_input"] + usage["tokens"]["output"]
            manifest["budget_validity"]["model_tokens"].update(
                observed=observed_tokens,
                within_budget=observed_tokens <= task.get("budgets", {}).get("model_tokens", math.inf))
            manifest["budget_validity"]["wall_time_seconds"].update(
                observed=usage["latency_seconds"],
                within_budget=usage["latency_seconds"] <= task.get("budgets", {}).get("wall_time_seconds", math.inf))
        elif args.agent_bin:
            manifest["model"] = args.model

        if args.agent_bin:
            prompt = (workspace / "README.md").read_text(encoding="utf-8")
            clean_env = _agent_environment()
            agent = run_command([args.agent_bin, "agent", "run", "--model", args.model, prompt], cwd=workspace,
                                stdout_path=run_dir / "agent.stdout.log", stderr_path=run_dir / "agent.stderr.log",
                                timeout_seconds=float(task["budgets"]["wall_time_seconds"]), env=clean_env)
            record_phase("agent", agent)
            if agent.timed_out or agent.cleanup_error:
                raise RuntimeError("agent process did not terminate cleanly")
            manifest["model_status"] = "pass" if agent.returncode == 0 else "fail"
            if agent.returncode != 0:
                manifest["termination"], manifest["failure_category"] = "completed", "model"
                manifest["hashes"]["source_final"] = _tree_hash(workspace)
                return _finalize(run_dir, manifest)
        else:
            manifest["model_status"] = "not_run"
        manifest["hashes"]["source_final"] = _tree_hash(workspace)
        persist()

        firmware = workspace / "firmware"
        build_command = [args.platformio, "run", "--project-dir", str(firmware), "--environment", config.platformio_environment or "esp32s3"]
        clean = run_command(build_command + ["--target", "clean"], cwd=workspace,
                            stdout_path=run_dir / "clean.stdout.log", stderr_path=run_dir / "clean.stderr.log",
                            timeout_seconds=float(task["budgets"]["wall_time_seconds"]))
        record_phase("clean", clean)
        if clean.timed_out or clean.cleanup_error:
            raise RuntimeError("clean process did not terminate cleanly")
        if clean.returncode:
            raise RuntimeError("clean command failed")
        build = run_command(build_command, cwd=workspace, stdout_path=run_dir / "build.stdout.log",
                            stderr_path=run_dir / "build.stderr.log", timeout_seconds=float(task["budgets"]["wall_time_seconds"]))
        record_phase("build", build)
        if build.timed_out or build.cleanup_error:
            raise RuntimeError("build process did not terminate cleanly")
        if build.returncode:
            manifest["compile_status"] = "fail"
            manifest["hardware_status"] = "not_run"
            manifest["termination"], manifest["failure_category"] = "completed", "compile"
            return _finalize(run_dir, manifest)
        manifest["compile_status"] = "pass"
        artifact = firmware / config.flash_artifact
        if not artifact.is_file():
            raise RuntimeError("successful build produced no firmware artifact")
        manifest["hashes"]["firmware"] = sha256_file(artifact)
        persist()

        if args.identity_command_json:
            identity_command = json.loads(args.identity_command_json)
            if not isinstance(identity_command, list) or not identity_command or not all(isinstance(x, str) for x in identity_command):
                raise ValueError("identity command JSON must be a nonempty string array")
        else:
            identity_command = list(config.identity_command)
        uart_result: dict[str, Any] = {}
        uart_error: list[BaseException] = []
        with BoardLock(run_dir.parent / ".board-locks", args.jtag_serial, timeout_seconds=config.identity_timeout_seconds):
            identity = validate_identity(identity_command, args.jtag_serial, cwd=workspace, evidence_dir=run_dir,
                                         timeout_seconds=config.identity_timeout_seconds)
            record_phase("identity", identity.command_result, status=identity.status)
            if identity.status != "pass":
                raise RuntimeError(identity.detail or "board identity failed")
            persist()
            cancel_uart = threading.Event()
            def capture_cancellable() -> None:
                try:
                    uart_result["value"] = capture_uart_nonce(args.uart_device, config.uart_baud, nonce,
                                                              config.uart_timeout_seconds, run_dir / "uart.raw.log",
                                                              cancel_event=cancel_uart)
                except BaseException as error:
                    uart_error.append(error)
            uart_thread = threading.Thread(target=capture_cancellable, name="hil-uart", daemon=False)
            uart_thread.start()
            try:
                flash_command = [args.platformio, "run", "--project-dir", str(firmware), "--environment",
                                 config.platformio_environment or "esp32s3", "--target", config.flash_target]
                flashed = flash_firmware(flash_command, cwd=workspace, evidence_dir=run_dir,
                                         timeout_seconds=config.flash_timeout_seconds, identity_validated=True)
                record_phase("flash", flashed.command_result, status=flashed.status, category=flashed.category)
                if flashed.status == "pass":
                    uart_thread.join(config.uart_timeout_seconds + 0.5)
            finally:
                cancel_uart.set()
                uart_thread.join(1)
            if uart_thread.is_alive() or uart_error:
                raise RuntimeError(f"UART capture failed: {uart_error[0] if uart_error else 'cleanup timeout'}")
            uart = uart_result["value"]
            manifest["uart"] = {"matched": uart.matched, "termination": uart.termination_reason,
                                "bytes_captured": uart.bytes_captured}
            record_phase("uart", matched=uart.matched, termination=uart.termination_reason,
                         bytes_captured=uart.bytes_captured)
            if flashed.status == "infrastructure_error":
                raise RuntimeError(flashed.detail or "flash infrastructure failure")
            if flashed.status == "hardware_fail" or not uart.matched:
                manifest["hardware_status"] = "fail"
                manifest["termination"], manifest["failure_category"] = "completed", flashed.category or "uart_nonce"
                return _finalize(run_dir, manifest)
            registers = read_registers(args.openocd, config.openocd_board_config, args.jtag_serial,
                                       config.assertions, cwd=workspace, evidence_dir=run_dir,
                                       timeout_seconds=config.openocd_command_timeout_seconds)
            if registers.status == "infrastructure_error":
                record_phase("register", registers.command_result, status=registers.status)
                raise RuntimeError(registers.detail or "OpenOCD infrastructure failure")
            manifest["register_assertions"] = [
                {"name": item.name, "passed": item.passed, "observed_masked": f"0x{item.value & item.mask:08x}"}
                for item in registers.evaluation.observations
            ]
            manifest["hardware_status"] = "pass" if registers.status == "pass" else "fail"
            record_phase("register", registers.command_result, status=registers.status,
                         assertions=manifest["register_assertions"])
            manifest["termination"] = "completed"
            manifest["failure_category"] = None if registers.status == "pass" else "register_mismatch"
        return _finalize(run_dir, manifest)
    except (KeyboardInterrupt, SystemExit) as error:
        manifest["infrastructure_status"] = "error"
        manifest["termination"] = "interrupted"
        manifest["failure_category"] = "interrupt"
        manifest["detail"] = type(error).__name__
        _finalize(run_dir, manifest)
        return 2
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, RuntimeError, BoardLockTimeout) as error:
        manifest["infrastructure_status"] = "error"
        manifest["termination"] = "invalid"
        manifest["failure_category"] = "infrastructure"
        manifest["detail"] = str(error)
        _finalize(run_dir, manifest)
        print(str(error), file=sys.stderr)
        return 2


def _finalize(run_dir: Path, manifest: dict[str, Any]) -> int:
    result = {name: manifest.get(name) for name in (
        "model_status", "compile_status", "simulator_status", "hardware_status",
        "infrastructure_status", "termination", "failure_category", "uart", "register_assertions")}
    write_json_atomic(run_dir / "result.json", result)
    artifacts: list[str] = []
    hashes = manifest.setdefault("hashes", {})
    for path in sorted(item for item in run_dir.rglob("*") if item.is_file() and item.name != "run.json"):
        relative = path.relative_to(run_dir).as_posix()
        artifacts.append(relative)
        hashes[f"artifact:{relative}"] = sha256_file(path)
    manifest["artifacts"] = artifacts
    manifest["run"]["ended_at_utc"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    write_json_atomic(run_dir / "run.json", manifest)
    return 2 if manifest["infrastructure_status"] == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
