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
import stat
import secrets
import sys
import time
import signal
import subprocess
import threading
from functools import partial
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


class UartWorkerFatal(BaseException):
    pass


class _FileEvent:
    def __init__(self, path: Path) -> None:
        self.path = path

    def set(self) -> None:
        self.path.write_text("ready", encoding="utf-8")


def _uart_subprocess_worker(spec_path: Path) -> int:
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if spec["mode"] == "startup-hang":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            time.sleep(1)
    cancel_event = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: cancel_event.set())
    try:
        result = capture_uart_nonce(spec["device"], spec["baud"], spec["nonce"], spec["timeout_seconds"],
                                    spec["log_path"], cancel_event=cancel_event,
                                    started_event=_FileEvent(Path(spec["ready_path"])))
        write_json_atomic(spec["result_path"], {"kind": "result", "matched": result.matched,
            "bytes_captured": result.bytes_captured, "timed_out": result.timed_out,
            "termination_reason": result.termination_reason})
    except BaseException as error:
        write_json_atomic(spec["result_path"], {"kind": "error", "detail": f"{type(error).__name__}: {error}"})
        Path(spec["ready_path"]).write_text("error", encoding="utf-8")
    return 0


def _stop_uart_process(process: subprocess.Popen[Any]) -> bool:
    if process.poll() is None:
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=.5)
        except subprocess.TimeoutExpired: pass
    if process.poll() is None:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: process.wait(timeout=.5)
        except subprocess.TimeoutExpired: pass
    return process.poll() is not None


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
    for path in _safe_files(root):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(bytes.fromhex(_safe_hash(path)))
    return digest.hexdigest()


def _safe_tree(source: Path, field: str) -> Path:
    if stat.S_ISLNK(os.lstat(source).st_mode):
        raise ValueError(f"{field} root is a symlink")
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise ValueError(f"{field} is not a directory")
    _safe_files(source)
    return source


def _safe_files(root: Path) -> list[Path]:
    root = root.absolute()
    files: list[Path] = []
    def visit(directory: Path) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                path = directory / entry.name
                if stat.S_ISLNK(info.st_mode):
                    raise ValueError(f"unsafe symlink: {path.relative_to(root)}")
                if stat.S_ISDIR(info.st_mode):
                    visit(path)
                elif stat.S_ISREG(info.st_mode):
                    files.append(path)
                else:
                    raise ValueError(f"unsafe non-regular file: {path.relative_to(root)}")
    visit(root)
    return sorted(files)


def _safe_hash(path: Path) -> str:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        before = os.lstat(path); opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError(f"unsafe changed artifact: {path.name}")
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(fd)


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
    source = _safe_tree(source, "candidate/public workspace")
    destination.mkdir()
    for path in _safe_files(source):
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        source_fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                while chunk := os.read(source_fd, 1024 * 1024):
                    os.write(target_fd, chunk)
            finally:
                os.close(target_fd)
        finally:
            os.close(source_fd)


def _command_record(result: Any, run_dir: Path, redactions: tuple[str, ...] = ()) -> dict[str, Any]:
    def sanitize(value: str) -> str:
        for secret in redactions:
            if secret:
                value = value.replace(secret, "<redacted>")
        return value
    def relative(value: str) -> str:
        try:
            return Path(value).resolve().relative_to(run_dir).as_posix()
        except ValueError:
            return "workspace" if Path(value).name == "workspace" else Path(value).name
    return {"argv": [sanitize(Path(item).name if Path(item).is_absolute() else item) for item in result.command],
            "cwd": relative(result.cwd), "stdout": relative(result.stdout_path),
            "stderr": relative(result.stderr_path), "started_at_utc": result.started_at_utc,
            "ended_at_utc": result.ended_at_utc, "returncode": result.returncode,
            "timed_out": result.timed_out, "duration_seconds": result.duration_seconds,
            "cleanup_error": result.cleanup_error}


def _tool_version(name: str, executable: os.PathLike[str] | str, workspace: Path,
                  run_dir: Path, env: Mapping[str, str] | None = None,
                  redactions: tuple[str, ...] = (), timeout_seconds: float = 2) -> dict[str, str]:
    record = {"executable": Path(executable).name, "version": "not_available"}
    try:
        result = run_command([executable, "--version"], cwd=workspace,
                             stdout_path=run_dir / f"version.{name}.stdout.log",
                             stderr_path=run_dir / f"version.{name}.stderr.log", timeout_seconds=timeout_seconds, env=env,
                             redact_values=redactions)
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


def _tool_environment() -> dict[str, str]:
    allowed = ("PATH", "HOME", "PLATFORMIO_CORE_DIR", "TMPDIR", "LANG", "LC_ALL")
    return {name: os.environ[name] for name in allowed if name in os.environ}


def _reject_secret_files(root: Path, secret_values: tuple[str, ...]) -> None:
    needles = tuple(value.encode() for value in secret_values if value)
    for path in _safe_files(root):
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            contents = bytearray()
            while chunk := os.read(fd, 1024 * 1024):
                contents.extend(chunk)
            if any(needle in contents for needle in needles):
                raise ValueError(f"credential value found in workspace artifact: {path.relative_to(root)}")
        finally:
            os.close(fd)


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
    value.add_argument("--fixture-uart-worker-mode", choices=("normal", "startup-hang"), default="normal",
                       help="offline fixture only: exercise UART worker startup cleanup")
    value.add_argument("--fixture-wall-time-seconds", type=float,
                       help="offline fixture only: shorten (never extend) overall wall budget")
    return value


def main(argv: list[str] | None = None) -> int:
    run_started_monotonic = time.monotonic()
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
    overall_deadline: float | None = None
    def bounded_timeout(cap: float) -> float:
        if overall_deadline is None:
            return cap
        remaining = overall_deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("overall wall-time budget exhausted")
        return min(cap, remaining)
    redactions = tuple(filter(None, (args.jtag_serial, args.uart_device,
                        *(os.environ.get(name, "") for name in ("LABWIRED_ACCESS_TOKEN", "LABWIRED_MODEL_KEY")))))
    credential_values = tuple(filter(None, (os.environ.get(name, "") for name in (
        "LABWIRED_ACCESS_TOKEN", "LABWIRED_PROJECT", "LABWIRED_MODEL_URL", "LABWIRED_MODEL_KEY"))))
    tool_env = _tool_environment()
    tool_runner = partial(run_command, env=tool_env, redact_values=credential_values)
    def record_phase(name: str, result: Any = None, **details: Any) -> None:
        phase = {"name": name, **details}
        if result is not None:
            phase["command"] = _command_record(result, run_dir, redactions)
        manifest["phases"].append(phase)
        persist()
    persist()
    try:
        task_root = _resolve_task(args.task)
        task = json.loads((task_root / "task.json").read_text(encoding="utf-8"))
        wall_cap = float(task["budgets"]["wall_time_seconds"])
        if args.fixture_wall_time_seconds is not None:
            if (not math.isfinite(args.fixture_wall_time_seconds) or args.fixture_wall_time_seconds < 0
                    or args.fixture_wall_time_seconds > wall_cap):
                raise ValueError("fixture wall timeout must be finite, nonnegative, and no larger than configured")
            wall_cap = args.fixture_wall_time_seconds
            task["budgets"]["wall_time_seconds"] = wall_cap
        overall_deadline = time.monotonic() + wall_cap
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
            name: {"configured": configured, "observed": None, "within_budget": None}
            for name, configured in task.get("budgets", {}).items()
        }
        for name in ("simulator_runs", "diagnostic_hil_runs"):
            if name in manifest["budget_validity"]:
                configured = manifest["budget_validity"][name]["configured"]
                manifest["budget_validity"][name].update(observed=0, within_budget=0 <= configured)
        manifest["environment"] = {"jtag_serial_sha256": hashlib.sha256(args.jtag_serial.encode()).hexdigest(),
                                   "uart_device": Path(args.uart_device).name}
        manifest["hashes"]["oracle_descriptor"] = sha256_file(oracle_path)
        manifest["hashes"]["source_initial"] = _tree_hash(workspace)
        record_phase("prepared")
        manifest["tool_versions"] = {
            "platformio": _tool_version("platformio", args.platformio, workspace, run_dir, tool_env, credential_values,
                                        bounded_timeout(2)),
            "openocd": _tool_version("openocd", args.openocd, workspace, run_dir, tool_env, credential_values,
                                     bounded_timeout(2)),
        }
        if args.agent_bin:
            manifest["tool_versions"]["agent"] = _tool_version(
                "agent", args.agent_bin, workspace, run_dir, _agent_environment(), credential_values,
                bounded_timeout(2))
        persist()

        if args.usage_json:
            usage = parse_usage(args.usage_json)
            write_json_atomic(run_dir / "cost.json", usage)
            for name in ("requests", "tokens", "final_context_tokens", "latency_seconds", "provider", "model", "cost_usd"):
                manifest[name] = usage[name]
            observed_tokens = usage["final_context_tokens"]
            manifest["budget_validity"]["model_tokens"].update(
                observed=observed_tokens,
                within_budget=observed_tokens <= task.get("budgets", {}).get("model_tokens", math.inf))
        elif args.agent_bin:
            manifest["model"] = args.model

        if args.agent_bin:
            prompt = (workspace / "README.md").read_text(encoding="utf-8")
            clean_env = _agent_environment()
            agent = run_command([args.agent_bin, "agent", "run", "--model", args.model, prompt], cwd=workspace,
                                stdout_path=run_dir / "agent.stdout.log", stderr_path=run_dir / "agent.stderr.log",
                                timeout_seconds=bounded_timeout(float(task["budgets"]["wall_time_seconds"])), env=clean_env,
                                redact_values=credential_values)
            if agent.timed_out or agent.cleanup_error:
                manifest["infrastructure_status"] = "error"
                record_phase("agent", agent)
                raise RuntimeError("agent process did not terminate cleanly")
            manifest["model_status"] = "pass" if agent.returncode == 0 else "fail"
            if agent.returncode != 0:
                manifest["termination"], manifest["failure_category"] = "completed", "model"
                record_phase("agent", agent)
                manifest["hashes"]["source_final"] = _tree_hash(workspace)
                return _finalize(run_dir, manifest, run_started_monotonic)
            record_phase("agent", agent)
            _reject_secret_files(workspace, credential_values)
        else:
            manifest["model_status"] = "not_run"
        manifest["hashes"]["source_final"] = _tree_hash(workspace)
        persist()

        firmware = workspace / "firmware"
        build_command = [args.platformio, "run", "--project-dir", str(firmware), "--environment", config.platformio_environment or "esp32s3"]
        _safe_files(workspace)
        clean = run_command(build_command + ["--target", "clean"], cwd=workspace,
                            stdout_path=run_dir / "clean.stdout.log", stderr_path=run_dir / "clean.stderr.log",
                            timeout_seconds=bounded_timeout(float(task["budgets"]["wall_time_seconds"])), env=tool_env,
                            redact_values=credential_values)
        if clean.timed_out or clean.cleanup_error:
            manifest["infrastructure_status"] = "error"
            record_phase("clean", clean)
            raise RuntimeError("clean process did not terminate cleanly")
        if clean.returncode:
            manifest["infrastructure_status"] = "error"
            record_phase("clean", clean)
            raise RuntimeError("clean command failed")
        record_phase("clean", clean)
        build = run_command(build_command, cwd=workspace, stdout_path=run_dir / "build.stdout.log",
                            stderr_path=run_dir / "build.stderr.log", timeout_seconds=bounded_timeout(float(task["budgets"]["wall_time_seconds"])),
                            env=tool_env, redact_values=credential_values)
        if build.timed_out or build.cleanup_error:
            manifest["infrastructure_status"] = "error"
            record_phase("build", build)
            raise RuntimeError("build process did not terminate cleanly")
        if build.returncode:
            manifest["compile_status"] = "fail"
            manifest["hardware_status"] = "not_run"
            manifest["termination"], manifest["failure_category"] = "completed", "compile"
            record_phase("build", build)
            return _finalize(run_dir, manifest, run_started_monotonic)
        manifest["compile_status"] = "pass"
        record_phase("build", build)
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
        with BoardLock(run_dir.parent / ".board-locks", args.jtag_serial,
                       timeout_seconds=bounded_timeout(config.identity_timeout_seconds)):
            identity = validate_identity(identity_command, args.jtag_serial, cwd=workspace, evidence_dir=run_dir,
                                         timeout_seconds=bounded_timeout(config.identity_timeout_seconds), runner=tool_runner)
            if identity.status != "pass":
                manifest["infrastructure_status"] = "error"
                record_phase("identity", identity.command_result, status=identity.status)
                raise RuntimeError(identity.detail or "board identity failed")
            record_phase("identity", identity.command_result, status=identity.status)
            persist()
            worker_spec = run_dir / ".uart-worker.json"
            worker_ready = run_dir / ".uart-worker.ready"
            worker_result = run_dir / ".uart-worker.result.json"
            uart_timeout = bounded_timeout(config.uart_timeout_seconds)
            write_json_atomic(worker_spec, {"device": args.uart_device, "baud": config.uart_baud,
                "nonce": nonce, "timeout_seconds": uart_timeout,
                "log_path": str(run_dir / "uart.raw.log"), "ready_path": str(worker_ready),
                "result_path": str(worker_result), "mode": args.fixture_uart_worker_mode})
            worker_stdout = open(run_dir / "uart-worker.stdout.log", "wb")
            worker_stderr = open(run_dir / "uart-worker.stderr.log", "wb")
            uart_process: subprocess.Popen[Any] | None = None
            uart_process_started = False
            try:
                uart_process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                                  "--_uart-worker", str(worker_spec)],
                                                 cwd=workspace, stdout=worker_stdout, stderr=worker_stderr,
                                                 env=tool_env, start_new_session=True)
                uart_process_started = True
                ready_deadline = time.monotonic() + bounded_timeout(2)
                while not worker_ready.exists() and uart_process.poll() is None and time.monotonic() < ready_deadline:
                    time.sleep(.01)
                if not worker_ready.exists():
                    raise RuntimeError("UART capture failed to start: startup timeout")
                flash_command = [args.platformio, "run", "--project-dir", str(firmware), "--environment",
                                 config.platformio_environment or "esp32s3", "--target", config.flash_target]
                flashed = flash_firmware(flash_command, cwd=workspace, evidence_dir=run_dir,
                                         timeout_seconds=bounded_timeout(config.flash_timeout_seconds), identity_validated=True,
                                         runner=tool_runner)
                if flashed.status == "infrastructure_error":
                    manifest["infrastructure_status"] = "error"
                elif flashed.status == "hardware_fail":
                    manifest["hardware_status"] = "fail"
                record_phase("flash", flashed.command_result, status=flashed.status, category=flashed.category)
                if flashed.status == "pass":
                    try: uart_process.wait(timeout=bounded_timeout(uart_timeout + 0.5))
                    except subprocess.TimeoutExpired: pass
            finally:
                uart_stopped = not uart_process_started or _stop_uart_process(uart_process)
                worker_stdout.close()
                worker_stderr.close()
            if not uart_stopped:
                raise UartWorkerFatal("UART worker could not be stopped")
            uart_payload = (json.loads(worker_result.read_text(encoding="utf-8"))
                            if worker_result.exists() else None)
            for control_path in (worker_spec, worker_ready, worker_result):
                try: control_path.unlink()
                except FileNotFoundError: pass
            if uart_payload is None:
                raise RuntimeError("UART capture produced no result")
            if uart_payload["kind"] == "error":
                raise RuntimeError(f"UART capture failed: {uart_payload['detail']}")
            manifest["uart"] = {"matched": uart_payload["matched"], "termination": uart_payload["termination_reason"],
                                "bytes_captured": uart_payload["bytes_captured"]}
            if not uart_payload["matched"] and flashed.status != "infrastructure_error":
                manifest["hardware_status"] = "fail"
            record_phase("uart", matched=uart_payload["matched"], termination=uart_payload["termination_reason"],
                         bytes_captured=uart_payload["bytes_captured"])
            if flashed.status == "infrastructure_error":
                raise RuntimeError(flashed.detail or "flash infrastructure failure")
            if flashed.status == "hardware_fail" or not uart_payload["matched"]:
                manifest["hardware_status"] = "fail"
                manifest["termination"], manifest["failure_category"] = "completed", flashed.category or "uart_nonce"
                return _finalize(run_dir, manifest, run_started_monotonic)
            registers = read_registers(args.openocd, config.openocd_board_config, args.jtag_serial,
                                       config.assertions, cwd=workspace, evidence_dir=run_dir,
                                       timeout_seconds=bounded_timeout(config.openocd_command_timeout_seconds), runner=tool_runner)
            if registers.status == "infrastructure_error":
                manifest["infrastructure_status"] = "error"
                record_phase("register", registers.command_result, status=registers.status)
                raise RuntimeError(registers.detail or "OpenOCD infrastructure failure")
            manifest["register_assertions"] = [
                {"name": item.name, "passed": item.passed, "observed_masked": f"0x{item.value & item.mask:08x}"}
                for item in registers.evaluation.observations
            ]
            manifest["hardware_status"] = "pass" if registers.status == "pass" else "fail"
            manifest["termination"] = "completed"
            manifest["failure_category"] = None if registers.status == "pass" else "register_mismatch"
            record_phase("register", registers.command_result, status=registers.status,
                         assertions=manifest["register_assertions"])
        return _finalize(run_dir, manifest, run_started_monotonic)
    except UartWorkerFatal as error:
        manifest["infrastructure_status"] = "error"
        manifest["termination"] = "invalid"
        manifest["failure_category"] = "uart_cleanup"
        manifest["detail"] = str(error)
        persist()
        return 2
    except (KeyboardInterrupt, SystemExit) as error:
        manifest["infrastructure_status"] = "error"
        manifest["termination"] = "interrupted"
        manifest["failure_category"] = "interrupt"
        manifest["detail"] = type(error).__name__
        try:
            _finalize(run_dir, manifest, run_started_monotonic)
        except (OSError, ValueError):
            persist()
        return 2
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, RuntimeError, BoardLockTimeout) as error:
        manifest["infrastructure_status"] = "error"
        manifest["termination"] = "invalid"
        manifest["failure_category"] = "infrastructure"
        manifest["detail"] = str(error)
        try:
            _finalize(run_dir, manifest, run_started_monotonic)
        except (OSError, ValueError) as final_error:
            manifest["detail"] = f"{error}; evidence rejected: {final_error}"
            persist()
        print(str(error), file=sys.stderr)
        return 2


def _finalize(run_dir: Path, manifest: dict[str, Any], started_monotonic: float) -> int:
    credential_values = tuple(filter(None, (os.environ.get(name, "") for name in (
        "LABWIRED_ACCESS_TOKEN", "LABWIRED_PROJECT", "LABWIRED_MODEL_URL", "LABWIRED_MODEL_KEY"))))
    _reject_secret_files(run_dir, credential_values)
    result = {name: manifest.get(name) for name in (
        "model_status", "compile_status", "simulator_status", "hardware_status",
        "infrastructure_status", "termination", "failure_category", "uart", "register_assertions")}
    write_json_atomic(run_dir / "result.json", result)
    artifacts: list[str] = []
    hashes = manifest.setdefault("hashes", {})
    for path in (item for item in _safe_files(run_dir) if item.name != "run.json"):
        relative = path.relative_to(run_dir).as_posix()
        artifacts.append(relative)
        hashes[f"artifact:{relative}"] = _safe_hash(path)
    manifest["artifacts"] = artifacts
    manifest["run"]["ended_at_utc"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    elapsed = time.monotonic() - started_monotonic
    wall = manifest.get("budget_validity", {}).get("wall_time_seconds")
    if wall is not None:
        wall.update(observed=elapsed, within_budget=elapsed <= wall["configured"])
    write_json_atomic(run_dir / "run.json", manifest)
    return 2 if manifest["infrastructure_status"] == "error" else 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--_uart-worker":
        raise SystemExit(_uart_subprocess_worker(Path(sys.argv[2])))
    raise SystemExit(main())
