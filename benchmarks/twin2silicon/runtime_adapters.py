"""Native CLI contracts and streaming usage normalization for benchmark runtimes.

The caller runs each command with ``AdapterContext.workspace`` as its working
directory. Claude does not expose a workspace command-line option, so its MCP
configuration is deliberately placed beneath ``config_dir``; the command uses
``config_dir / 'claude-mcp.json'`` without creating that file.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Literal


RuntimeName = Literal["opencode", "codex", "claude"]
_MAX_USAGE_COUNT = 1_000_000_000_000
_MAX_COST_USD = 1_000_000_000.0
_CLAUDE_MCP_CONFIG = "claude-mcp.json"


def codex_mcp_toml() -> str:
    """Return the isolated local LabWired MCP registration for Codex trials."""

    return '[mcp_servers.labwired]\ncommand = "npx"\nargs = ["-y", "@labwired/mcp"]\n'


def write_codex_mcp_config(config_dir: Path) -> Path:
    """Write the isolated Codex MCP configuration and return its path."""

    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.toml"
    config_path.write_text(codex_mcp_toml(), encoding="utf-8")
    return config_path


@dataclass(frozen=True)
class AdapterContext:
    """Execution inputs shared by the native runtime adapters."""

    runtime: RuntimeName
    executable: str
    workspace: Path
    prompt: str
    config_dir: Path
    stdout_path: Path
    stderr_path: Path


@dataclass(frozen=True)
class NormalizedUsage:
    """Usage available directly from a runtime's structured output."""

    requests: int | None
    fresh_input: int | None
    cached_input: int | None
    reasoning: int | None
    output: int | None
    estimated_cost_usd: float | None
    unavailable_reason: str | None


def build_runtime_command(runtime: RuntimeName, context: AdapterContext) -> list[str]:
    """Build the native, model-default command for ``runtime``."""

    if runtime != context.runtime:
        raise ValueError("runtime does not match context")
    if runtime == "codex":
        return [
            context.executable,
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "workspace-write",
            "-C",
            str(context.workspace),
            context.prompt,
        ]
    if runtime == "claude":
        return [
            context.executable,
            "--print",
            "--output-format",
            "stream-json",
            "--no-session-persistence",
            "--permission-mode",
            "acceptEdits",
            "--mcp-config",
            str(context.config_dir / _CLAUDE_MCP_CONFIG),
            "--strict-mcp-config",
            context.prompt,
        ]
    if runtime == "opencode":
        return [
            context.executable,
            "run",
            "--format",
            "json",
            "--dir",
            str(context.workspace),
            context.prompt,
        ]
    raise ValueError(f"unsupported runtime: {runtime}")


def normalize_usage(runtime: RuntimeName, lines: Iterable[str]) -> NormalizedUsage:
    """Normalize newline-delimited structured runtime output without pricing inference."""

    records = _json_records(lines)
    if runtime == "opencode":
        return _normalize_opencode(records)
    if runtime == "codex":
        return _normalize_codex(records)
    if runtime == "claude":
        return _normalize_claude(records)
    raise ValueError(f"unsupported runtime: {runtime}")


def _json_records(lines: Iterable[str]) -> Iterator[dict[str, object]]:
    source = lines.splitlines() if isinstance(lines, str) else lines
    for line in source:
        try:
            record = json.loads(line)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if isinstance(record, dict):
            yield record


def _normalize_opencode(records: Iterable[dict[str, object]]) -> NormalizedUsage:
    totals: dict[str, int] = {}
    overflowed_totals: set[str] = set()
    request_count = 0
    cost_total = 0.0
    has_cost = False
    cost_overflowed = False

    for record in records:
        if record.get("type") != "step_finish":
            continue
        part = _mapping(record.get("part"))
        tokens = _mapping(part.get("tokens")) if part else None
        values = {
            "fresh_input": _bounded_int(tokens.get("input")) if tokens else None,
            "cached_input": _bounded_int(_mapping(tokens.get("cache")).get("read"))
            if tokens and _mapping(tokens.get("cache"))
            else None,
            "reasoning": _bounded_int(tokens.get("reasoning")) if tokens else None,
            "output": _bounded_int(tokens.get("output")) if tokens else None,
        }
        cost = _bounded_float(part.get("cost")) if part else None
        if all(value is None for value in values.values()) and cost is None:
            continue
        if request_count >= _MAX_USAGE_COUNT:
            return _usage_result(0, {}, None)
        request_count += 1
        for name, value in values.items():
            if value is None or name in overflowed_totals:
                continue
            total = totals.get(name, 0) + value
            if total > _MAX_USAGE_COUNT:
                totals.pop(name, None)
                overflowed_totals.add(name)
            else:
                totals[name] = total
        if cost is not None and not cost_overflowed:
            total_cost = cost_total + cost
            if total_cost > _MAX_COST_USD:
                cost_overflowed = True
                has_cost = False
            else:
                cost_total = total_cost
                has_cost = True

    return _usage_result(request_count, totals, cost_total if has_cost else None)


def _normalize_codex(records: Iterable[dict[str, object]]) -> NormalizedUsage:
    final_usage: dict[str, int | None] | None = None
    for record in records:
        if record.get("type") != "turn.completed":
            continue
        usage = _mapping(record.get("usage"))
        final_usage = _token_values(usage)

    if final_usage is None or not any(
        value is not None for value in final_usage.values()
    ):
        return _usage_result(0, {}, None)
    return _usage_result(
        1, {name: value for name, value in final_usage.items() if value is not None}, None
    )


def _normalize_claude(records: Iterable[dict[str, object]]) -> NormalizedUsage:
    final_usage: dict[str, int | None] | None = None
    final_cost: float | None = None
    for record in records:
        if record.get("type") != "result":
            continue
        usage = _mapping(record.get("usage"))
        values = {
            "fresh_input": _bounded_int(usage.get("input_tokens")) if usage else None,
            "cached_input": _bounded_int(usage.get("cache_read_input_tokens")) if usage else None,
            "reasoning": _bounded_int(usage.get("reasoning_tokens")) if usage else None,
            "output": _bounded_int(usage.get("output_tokens")) if usage else None,
        }
        cost = _bounded_float(record.get("total_cost_usd"))
        final_usage = values
        final_cost = cost

    if final_usage is None or (
        not any(value is not None for value in final_usage.values())
        and final_cost is None
    ):
        return _usage_result(0, {}, None)
    return _usage_result(
        1,
        {name: value for name, value in final_usage.items() if value is not None},
        final_cost,
    )


def _token_values(usage: dict[str, object] | None) -> dict[str, int | None]:
    if usage is None:
        return {
            "fresh_input": None,
            "cached_input": None,
            "reasoning": None,
            "output": None,
        }
    return {
        "fresh_input": _bounded_int(usage.get("input_tokens")),
        "cached_input": _bounded_int(usage.get("cached_input_tokens")),
        "reasoning": _bounded_int(usage.get("reasoning_tokens")),
        "output": _bounded_int(usage.get("output_tokens")),
    }


def _usage_result(
    requests: int, values: dict[str, int], cost: float | None
) -> NormalizedUsage:
    if requests == 0:
        return NormalizedUsage(
            None, None, None, None, None, None, "runtime did not expose usage"
        )
    if not values and cost is None:
        return NormalizedUsage(
            requests, None, None, None, None, None, "runtime did not expose usage"
        )
    return NormalizedUsage(
        requests,
        values.get("fresh_input"),
        values.get("cached_input"),
        values.get("reasoning"),
        values.get("output"),
        cost,
        None,
    )


def _mapping(value: object) -> dict[str, object] | None:
    return value if isinstance(value, dict) else None


def _bounded_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= _MAX_USAGE_COUNT else None


def _bounded_float(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= _MAX_COST_USD:
        return None
    return number
