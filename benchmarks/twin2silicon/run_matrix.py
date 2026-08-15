#!/usr/bin/env python3
"""Run fresh native-runtime trials sequentially and retain one HIL oracle result per candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmarks.twin2silicon.hil.results import write_json_atomic


RUNTIMES = ("opencode", "codex", "claude")
ROOT = Path(__file__).resolve().parent
TASKS = ROOT / "tasks"
USAGE_FIELDS = (
    "requests",
    "fresh_input",
    "cached_input",
    "reasoning",
    "output",
    "estimated_cost_usd",
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--jtag-serial", required=True)
    parser.add_argument("--uart-device", required=True)
    parser.add_argument("--openocd", required=True)
    parser.add_argument("--identity-command-json")
    parser.add_argument("--runtime", choices=RUNTIMES, action="append")
    parser.add_argument("--agent-only", action="store_true")
    # Test-only seams. They are deliberately omitted from operator help.
    parser.add_argument("--agent-script", type=Path, default=ROOT / "run_agent.py", help=argparse.SUPPRESS)
    parser.add_argument("--hil-script", type=Path, default=ROOT / "run_hil.py", help=argparse.SUPPRESS)
    parser.add_argument("--agent-executable", action="append", default=[], help=argparse.SUPPRESS)
    return parser


def _task_root(value: str) -> Path:
    requested = Path(value)
    return (TASKS / requested if len(requested.parts) == 1 else requested).resolve()


def _task_details(task_root: Path) -> tuple[str, Path, float]:
    task = json.loads((task_root / "task.json").read_text(encoding="utf-8"))
    task_id = task["id"]
    public_dir = task["public_dir"]
    budget = task["budgets"]["wall_time_seconds"]
    if not isinstance(task_id, str) or not isinstance(public_dir, str):
        raise ValueError("task id and public_dir must be strings")
    if isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0:
        raise ValueError("task wall_time_seconds must be positive")
    public_root = (task_root / public_dir).resolve()
    if task_root not in public_root.parents or not public_root.is_dir():
        raise ValueError("task public_dir must name a directory below the task root")
    return task_id, public_root, float(budget)


def _tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_symlink():
            raise ValueError("public inputs must not contain symlinks")
        if not path.is_file():
            continue
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _number(value: object) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return value


def _normalized_usage(path: Path) -> dict[str, object]:
    source = _read_json(path) or {}
    normalized = {field: _number(source.get(field)) for field in USAGE_FIELDS}
    reason = source.get("unavailable_reason")
    if not isinstance(reason, str) or not reason:
        reason = None
    if reason is None:
        values = tuple(normalized.values())
        if all(value is None for value in values):
            reason = "runtime did not expose usage"
        elif any(value is None for value in values):
            reason = "one or more usage fields unavailable"
    normalized["unavailable_reason"] = reason
    return normalized


def _has_hil_usage_schema(path: Path) -> bool:
    """Only forward evidence that run_hil.py can validate without invented rates."""
    source = _read_json(path)
    if source is None:
        return False
    tokens = source.get("tokens")
    rates = source.get("rates_usd_per_million")
    if not isinstance(tokens, dict) or not isinstance(rates, dict):
        return False
    required = ("fresh_input", "cached_input", "output")
    if "requests" not in source or any(field not in tokens or field not in rates for field in required):
        return False
    values = [source["requests"], *tokens.values(), *rates.values()]
    return all(_number(value) is not None for value in values)


def _parse_executables(values: list[str], parser: argparse.ArgumentParser) -> dict[str, str]:
    executables: dict[str, str] = {}
    for value in values:
        runtime, separator, executable = value.partition("=")
        if separator != "=" or runtime not in RUNTIMES or not executable:
            parser.error("--agent-executable must be RUNTIME=PATH")
        executables[runtime] = executable
    return executables


def _run_child(command: list[str], cwd: Path, stdout_path: Path, stderr_path: Path) -> tuple[int | None, str | None]:
    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            completed = subprocess.run(command, cwd=cwd, stdout=stdout, stderr=stderr, check=False)
    except OSError as error:
        return None, str(error)
    return completed.returncode, None


def _agent_row(
    runtime: str,
    task_root: Path,
    trial: Path,
    initial_public_sha256: str,
    agent_script: Path,
    executable: str | None,
) -> dict[str, object]:
    command = [sys.executable, str(agent_script), runtime, "--task", str(task_root), "--output", str(trial)]
    if executable is not None:
        command.extend(("--executable", executable))
    returncode, child_error = _run_child(
        command, ROOT,
        trial.parent / f"{trial.name}.matrix-agent.stdout.log",
        trial.parent / f"{trial.name}.matrix-agent.stderr.log",
    )
    result = _read_json(trial / "agent-result.json")
    agent_status = result.get("status") if result and isinstance(result.get("status"), str) else "infrastructure_error"
    if child_error is not None or returncode != 0:
        agent_status = "infrastructure_error"
    row: dict[str, object] = {
        "runtime": runtime,
        "initial_public_sha256": initial_public_sha256,
        "agent_status": agent_status,
        "agent_result": result,
        "agent_child_returncode": returncode,
        "usage": _normalized_usage(trial / "usage.json"),
        "hil_status": "not_run",
        "hil_run": None,
    }
    if child_error is not None:
        row["agent_error"] = child_error
    elif returncode != 0:
        row["agent_error"] = f"agent runner exited with status {returncode}"
    elif result is None:
        row["agent_error"] = "agent runner did not produce agent-result.json"
    return row


def _run_hil(row: dict[str, object], task_root: Path, trial: Path, args: argparse.Namespace) -> None:
    if row["agent_status"] != "completed":
        return
    candidate = trial / "candidate"
    if not candidate.is_dir():
        row["hil_status"] = "invalid"
        row["hil_error"] = "completed agent did not produce a candidate directory"
        return
    run_dir = trial / "hil"
    command = [
        sys.executable, str(args.hil_script), str(task_root), "--run-dir", str(run_dir),
        "--candidate", str(candidate), "--jtag-serial", args.jtag_serial,
        "--uart-device", args.uart_device, "--openocd", args.openocd,
        "--identity-command-json", args.identity_command_json,
    ]
    usage_path = trial / "usage.json"
    if _has_hil_usage_schema(usage_path):
        command.extend(("--usage-json", str(usage_path)))
    returncode, child_error = _run_child(
        command, ROOT, trial / "matrix-hil.stdout.log", trial / "matrix-hil.stderr.log",
    )
    run = _read_json(run_dir / "run.json")
    row["hil_run"] = run
    row["hil_child_returncode"] = returncode
    if child_error is not None:
        row["hil_status"] = "invalid"
        row["hil_error"] = child_error
    elif run is None:
        row["hil_status"] = "invalid"
        row["hil_error"] = "HIL runner did not produce run.json"
    else:
        status = run.get("status")
        row["hil_status"] = status if isinstance(status, str) else "invalid"


def _print_summary(rows: list[dict[str, object]]) -> None:
    print(f"{'RUNTIME':<10} {'AGENT':<22} {'HIL':<12}")
    for row in rows:
        print(f"{row['runtime']:<10} {row['agent_status']:<22} {row['hil_status']:<12}")


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not args.agent_only and not args.identity_command_json:
        parser.error("--identity-command-json is required unless --agent-only")
    output = args.output.resolve()
    if os.path.lexists(output):
        print("output path already exists", file=sys.stderr)
        return 2
    try:
        task_root = _task_root(args.task)
        task_id, public_root, _budget_seconds = _task_details(task_root)
        executables = _parse_executables(args.agent_executable, parser)
        initial_public_sha256 = _tree_sha256(public_root)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2

    output.mkdir(parents=True)
    trials_root = output / "trials"
    trials_root.mkdir()
    rows: list[dict[str, object]] = []
    matrix: dict[str, object] = {"schema_version": "1.0", "task_id": task_id, "trials": rows}
    for runtime in args.runtime or list(RUNTIMES):
        trial = trials_root / runtime
        row = _agent_row(runtime, task_root, trial, initial_public_sha256, args.agent_script, executables.get(runtime))
        if not args.agent_only:
            _run_hil(row, task_root, trial, args)
        rows.append(row)
        write_json_atomic(output / "matrix.json", matrix)
    _print_summary(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
