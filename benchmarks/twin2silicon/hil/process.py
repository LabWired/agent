"""Bounded subprocess execution with persistent evidence."""

from datetime import datetime, timezone
import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Sequence, Union

from .results import CommandResult, PathLike


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run_command(
    command: Sequence[Union[str, os.PathLike[str]]],
    *,
    cwd: PathLike,
    stdout_path: PathLike,
    stderr_path: PathLike,
    timeout_seconds: float,
) -> CommandResult:
    normalized_command = tuple(os.fspath(part) for part in command)
    normalized_cwd = str(Path(cwd).resolve())
    normalized_stdout = str(Path(stdout_path).resolve())
    normalized_stderr = str(Path(stderr_path).resolve())
    Path(normalized_stdout).parent.mkdir(parents=True, exist_ok=True)
    Path(normalized_stderr).parent.mkdir(parents=True, exist_ok=True)

    started_at = _utc_now()
    started_monotonic = time.monotonic()
    timed_out = False
    with open(normalized_stdout, "wb") as stdout, open(normalized_stderr, "wb") as stderr:
        process = subprocess.Popen(
            normalized_command,
            cwd=normalized_cwd,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        try:
            process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=0.5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=0.5)

    ended_at = _utc_now()
    return CommandResult(
        command=normalized_command,
        cwd=normalized_cwd,
        returncode=process.returncode,
        timed_out=timed_out,
        started_at_utc=started_at,
        ended_at_utc=ended_at,
        duration_seconds=time.monotonic() - started_monotonic,
        stdout_path=normalized_stdout,
        stderr_path=normalized_stderr,
    )
