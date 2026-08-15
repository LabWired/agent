#!/usr/bin/env python3
"""Run one bounded native runtime trial against a public firmware task."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Iterator

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmarks.twin2silicon.hil.process import run_command
from benchmarks.twin2silicon.hil.results import write_json_atomic
from benchmarks.twin2silicon.runtime_adapters import (
    AdapterContext,
    NormalizedUsage,
    build_runtime_command,
    extract_native_model,
    normalize_usage,
    write_codex_mcp_config,
)


RUNTIMES = ("opencode", "codex", "claude")
ROOT = Path(__file__).resolve().parent
TASKS = ROOT / "tasks"
INSTRUCTIONS = ROOT / "shared-agent-instructions.md"
RUNTIME_CONFIG = ROOT / "runtime-config"


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
    parser.add_argument("runtime", choices=RUNTIMES)
    parser.add_argument("--task", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--executable")
    parser.add_argument("--timeout-seconds", type=_positive_seconds)
    return parser


def _task_root(value: str) -> Path:
    candidate = Path(value)
    if len(candidate.parts) == 1:
        candidate = TASKS / candidate
    return candidate.resolve()


def _public_inputs(task_root: Path) -> tuple[Path, float, int]:
    task = json.loads((task_root / "task.json").read_text(encoding="utf-8"))
    public_dir = task["public_dir"]
    budget = task["budgets"]["wall_time_seconds"]
    repair_iterations = task["budgets"]["repair_iterations"]
    if isinstance(public_dir, Path) or not isinstance(public_dir, str):
        raise ValueError("task public_dir must be a path string")
    if (
        isinstance(budget, bool)
        or not isinstance(budget, (int, float))
        or not math.isfinite(float(budget))
        or budget <= 0
    ):
        raise ValueError("task wall_time_seconds must be positive")
    if (
        isinstance(repair_iterations, bool)
        or not isinstance(repair_iterations, int)
        or repair_iterations <= 0
    ):
        raise ValueError("task repair_iterations must be a positive integer")
    source_root = task_root / public_dir
    public_root = source_root.resolve()
    if task_root not in public_root.parents or not source_root.is_dir():
        raise ValueError("task public_dir must name a directory below the task root")
    _reject_public_symlinks(source_root)
    return public_root, float(budget), repair_iterations


def _reject_public_symlinks(public_root: Path) -> None:
    for directory, directories, files in os.walk(public_root, followlinks=False):
        for path in (Path(directory), *(Path(directory) / name for name in directories + files)):
            if stat.S_ISLNK(os.lstat(path).st_mode):
                raise ValueError("public inputs must not contain symlinks")


def _prepare_runtime_config(runtime: str, config_dir: Path) -> None:
    config_dir.mkdir(parents=True, exist_ok=True)
    if runtime == "codex":
        write_codex_mcp_config(config_dir)
        return
    source_name = "opencode.json" if runtime == "opencode" else "claude-mcp.json"
    shutil.copyfile(RUNTIME_CONFIG / source_name, config_dir / source_name)


@contextmanager
def _runtime_environment(runtime: str, config_dir: Path) -> Iterator[None]:
    if runtime == "codex":
        with _isolated_codex_home():
            yield
        return
    values = {
        "opencode": {"OPENCODE_CONFIG": str(config_dir / "opencode.json")},
        "claude": {},
    }[runtime]
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextmanager
def _isolated_codex_home() -> Iterator[None]:
    configured_home = os.environ.get("CODEX_HOME")
    source_home = (
        Path(configured_home).expanduser()
        if configured_home
        else Path.home() / ".codex"
    )
    with tempfile.TemporaryDirectory(prefix="twin2silicon-codex-") as directory:
        isolated_home = Path(directory)
        config_path = write_codex_mcp_config(isolated_home)
        config_path.chmod(0o600)
        source_auth = source_home / "auth.json"
        if source_auth.is_file():
            destination_auth = isolated_home / "auth.json"
            shutil.copyfile(source_auth, destination_auth)
            destination_auth.chmod(0o600)
        previous = os.environ.get("CODEX_HOME")
        os.environ["CODEX_HOME"] = str(isolated_home)
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("CODEX_HOME", None)
            else:
                os.environ["CODEX_HOME"] = previous


def _version(executable: str, cwd: Path, timeout_seconds: float) -> str | None:
    try:
        completed = subprocess.run(
            [executable, "--version"],
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=min(timeout_seconds, 5),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    output = (completed.stdout or completed.stderr).strip()
    return output.splitlines()[0][:4096] if output else None


def _prompt(candidate: Path, instructions: str, repair_iterations: int) -> str:
    readme = candidate / "README.md"
    task_prompt = readme.read_text(encoding="utf-8") if readme.is_file() else "Repair the public firmware task."
    return (
        f"{instructions}\n\n# Trial limit\n\n"
        f"Maximum repair attempts: {repair_iterations}\n\n# Public task\n\n{task_prompt}"
    )


def _unavailable_usage() -> NormalizedUsage:
    return NormalizedUsage(None, None, None, None, None, None, "runtime did not expose usage")


def _write_trial_result(trial: Path, result: dict[str, object], usage: NormalizedUsage) -> None:
    write_json_atomic(trial / "agent-result.json", result)
    write_json_atomic(trial / "usage.json", asdict(usage))


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    trial = args.output.resolve()
    if os.path.lexists(trial):
        print("output path already exists", file=sys.stderr)
        return 2

    trial.mkdir(parents=True)
    usage = _unavailable_usage()
    result: dict[str, object] = {
        "schema_version": "1.0",
        "runtime": args.runtime,
        "model_override": None,
        "native_model": None,
        "status": "infrastructure_error",
        "returncode": None,
        "timed_out": False,
        "elapsed_seconds": 0.0,
        "executable_version": None,
        "stdout_path": "agent.stdout.log",
        "stderr_path": "agent.stderr.log",
    }

    try:
        public_root, budget_seconds, repair_iterations = _public_inputs(_task_root(args.task))
        timeout_seconds = min(args.timeout_seconds or budget_seconds, budget_seconds)
        candidate = trial / "candidate"
        shutil.copytree(public_root, candidate)
        instructions = INSTRUCTIONS.read_text(encoding="utf-8")
        (candidate / ("CLAUDE.md" if args.runtime == "claude" else "AGENTS.md")).write_text(
            instructions, encoding="utf-8"
        )
        config_dir = trial / "runtime-config"
        _prepare_runtime_config(args.runtime, config_dir)
        executable = args.executable or args.runtime
        context = AdapterContext(
            runtime=args.runtime,
            executable=executable,
            workspace=candidate,
            prompt=_prompt(candidate, instructions, repair_iterations),
            config_dir=config_dir,
            stdout_path=trial / "agent.stdout.log",
            stderr_path=trial / "agent.stderr.log",
        )
        command = build_runtime_command(args.runtime, context)
        with _runtime_environment(args.runtime, config_dir):
            result["executable_version"] = _version(executable, candidate, timeout_seconds)
            started = time.monotonic()
            try:
                completed = run_command(
                    command,
                    cwd=candidate,
                    stdout_path=context.stdout_path,
                    stderr_path=context.stderr_path,
                    timeout_seconds=timeout_seconds,
                )
            except OSError as error:
                result["elapsed_seconds"] = time.monotonic() - started
                result["error"] = str(error)
            else:
                result.update(
                    returncode=completed.returncode,
                    timed_out=completed.timed_out,
                    elapsed_seconds=completed.duration_seconds,
                )
                if completed.timed_out:
                    result["status"] = "timeout"
                elif completed.cleanup_error:
                    result["status"] = "infrastructure_error"
                    result["error"] = completed.cleanup_error
                elif completed.returncode:
                    result["status"] = "failed"
                else:
                    result["status"] = "completed"
                try:
                    stdout_lines = context.stdout_path.read_text(
                        encoding="utf-8", errors="replace"
                    ).splitlines()
                    usage = normalize_usage(args.runtime, stdout_lines)
                    result["native_model"] = extract_native_model(args.runtime, stdout_lines)
                except OSError:
                    usage = _unavailable_usage()
    except Exception as error:
        result["error"] = str(error)

    _write_trial_result(trial, result, usage)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
