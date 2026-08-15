"""Result contracts and durable result-file helpers."""

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Literal, Optional, Union


PathLike = Union[str, os.PathLike[str]]
ModelStatus = Literal["pass", "fail", "not_run"]
CompileStatus = Literal["pass", "fail", "not_run"]
SimulatorStatus = Literal["pass", "fail", "not_run", "not_supported"]
HardwareStatus = Literal["pass", "fail", "not_run"]
InfrastructureStatus = Literal["ok", "error"]


@dataclass(frozen=True)
class CommandResult:
    command: tuple[str, ...]
    cwd: str
    returncode: int
    timed_out: bool
    started_at_utc: str
    ended_at_utc: str
    duration_seconds: float
    stdout_path: str
    stderr_path: str


@dataclass(frozen=True)
class RunResult:
    model_status: ModelStatus
    compile_status: CompileStatus
    simulator_status: SimulatorStatus
    hardware_status: HardwareStatus
    infrastructure_status: InfrastructureStatus
    failure_category: Optional[str] = None
    detail: Optional[str] = None

    @classmethod
    def infrastructure_error(cls, category: str, detail: str) -> "RunResult":
        return cls(
            model_status="not_run",
            compile_status="not_run",
            simulator_status="not_supported",
            hardware_status="not_run",
            infrastructure_status="error",
            failure_category=category,
            detail=detail,
        )


def sha256_file(path: PathLike) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_atomic(path: PathLike, value: Any) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = temporary.name
            json.dump(value, temporary, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
