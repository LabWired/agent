#!/usr/bin/env python3
"""Strict oracle for LabWired hosted-agent JSONL certification evidence."""
from __future__ import annotations

import json
import hashlib
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

CONTEXT = {"labwired_context", "context"}
GROUNDING_WORDS = ("part", "datasheet", "search", "sdk", "svd", "schematic", "netlist", "project")
COMPILE_WORDS = ("compile", "build", "pio run", "platformio", "make")
VERIFY_WORDS = ("verify", "test")
RUN_WORDS = ("labwired_run", "firmware run", "simulate", "twin run", "run firmware")
INSPECT_WORDS = ("inspect", "observe", "trace", "uart", "marker")
EDIT_WORDS = ("write", "edit", "patch", "apply_patch")
FLASH_WORDS = ("flash", "probe", "desk_hw", "desk-hw")
SOURCE_KEYS = {"citation", "citations", "source", "sources", "url", "document", "datasheet", "path", "reference", "references"}
SECRET_QUERY = re.compile(
    r"^(?:token|key|secret|signature|sig|credential|authorization|api[_-]?key|access[_-]?token|"
    r"security[_-]?token|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$",
    re.I,
)
SECRET_TEXT = re.compile(
    r"(?i)(?:bearer\s+[a-z0-9._~+/=-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|"
    r"(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)
HARDWARE_FACT = re.compile(
    r"(?i)\b(?:GPIO\s*\d+|P[A-Z]\d+|0x[0-9a-f]{4,}|"
    r"[A-Z][A-Z0-9]+_(?:ENR|CR|SR|DR|MODER|AFR)|(?:UART|USART|SPI|I2C|ADC|PWM)\d*|"
    r"LED|Wi-?Fi|pin(?:\s+assignment)?|register|peripheral|clock|baud)\b"
)


class Rejected(ValueError):
    pass


def contains(name: str, words: tuple[str, ...]) -> bool:
    lowered = name.lower().replace("-", "_")
    return any(word.replace("-", "_") in lowered for word in words)


def action_text(event: dict, name: str) -> str:
    pieces = [name]
    for key, value in walk(event):
        if str(key).lower() in {"command", "cmd", "input", "args", "path", "file"}:
            if isinstance(value, (str, int, float)):
                pieces.append(str(value))
            elif isinstance(value, dict):
                pieces.append(json.dumps(value, sort_keys=True))
    return " ".join(pieces)


def action_contains(event: dict, name: str, words: tuple[str, ...]) -> bool:
    return contains(action_text(event, name), words)


def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def tool_name(event: dict) -> str:
    candidates = [
        event.get("tool"), event.get("tool_name"), event.get("name"),
        (event.get("part") or {}).get("tool") if isinstance(event.get("part"), dict) else None,
        (event.get("part") or {}).get("name") if isinstance(event.get("part"), dict) else None,
    ]
    return next((str(value) for value in candidates if value), "")


def event_id(event: dict, index: int) -> str:
    for value in (event.get("id"), event.get("event_id"), (event.get("part") or {}).get("id") if isinstance(event.get("part"), dict) else None):
        if value:
            # IDs are useful for ordering/correlation, not as customer content.
            # Hashing also prevents opaque provider IDs from carrying secrets.
            return "sha256:" + hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]
    return f"event-{index + 1}"


def is_tool_event(event: dict) -> bool:
    kind = str(event.get("type", "")).lower()
    return bool(tool_name(event)) and ("tool" in kind or "part" in event or "result" in event or "state" in event)


def outcome(event: dict) -> bool | None:
    """Return affirmative success, explicit failure, or unknown.

    OpenCode places the authoritative state under part.state. Inputs are never
    inspected because model-supplied args are not execution outcomes.
    """
    affirmative = False

    def inspect(value):
        nonlocal affirmative
        if not isinstance(value, dict):
            return False
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in {"input", "args", "arguments", "command", "cmd"}:
                continue
            if lowered in {"ok", "success", "passed"} and isinstance(item, bool):
                if not item:
                    return True
                affirmative = True
            elif lowered in {"exit_code", "exitcode"} and isinstance(item, int) and not isinstance(item, bool):
                if item != 0:
                    return True
                affirmative = True
            elif lowered == "status" and isinstance(item, str):
                status = item.lower()
                if status in {"error", "failed", "failure", "rejected", "cancelled", "timeout"}:
                    return True
                if status in {"completed", "complete", "success", "succeeded", "passed", "ok"}:
                    affirmative = True
            if isinstance(item, dict) and inspect(item):
                return True
        return False

    authoritative = {k: v for k, v in event.items() if k not in {"input", "args", "arguments"}}
    if inspect(authoritative):
        return False
    return True if affirmative else None


def succeeded(event: dict) -> bool:
    return outcome(event) is True


def returned_payloads(event: dict) -> list[object]:
    """Provider/tool-returned payloads only; excludes model-supplied inputs."""
    payloads: list[object] = []
    for container in (event, event.get("part") if isinstance(event.get("part"), dict) else None):
        if not isinstance(container, dict):
            continue
        for key in ("result", "output"):
            if key in container:
                payloads.append(container[key])
        state = container.get("state")
        if isinstance(state, dict):
            for key in ("result", "output"):
                if key in state:
                    payloads.append(state[key])
    return payloads


def citations(event: dict) -> list[str]:
    found: list[str] = []
    payloads = returned_payloads(event)
    for payload in payloads:
        for key, value in walk(payload):
            if str(key).lower() not in SOURCE_KEYS:
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, (str, int, float)):
                    continue
                text = sanitize_citation(str(item))
                if text and text not in found:
                    found.append(text[:512])
    # Hosted knowledge tools commonly return a text payload. Extract only
    # source-like identifiers, never the full payload/customer prompt.
    for payload in payloads:
        serialized = json.dumps(payload, ensure_ascii=False) if not isinstance(payload, str) else payload
        for match in re.findall(r"https?://[^\s\"'<>]+|(?:doc|sdk|svd|schematic|netlist|project):[A-Za-z0-9._/#:-]+", serialized):
            text = sanitize_citation(match)
            if text not in found:
                found.append(text[:512])
    return found


def sanitize_citation(text: str) -> str:
    text = SECRET_TEXT.sub("[redacted]", text)
    if text.startswith(("http://", "https://")):
        split = urlsplit(text)
        query = urlencode([(k, "[redacted]" if SECRET_QUERY.match(k) else v) for k, v in parse_qsl(split.query, keep_blank_values=True)])
        text = urlunsplit((split.scheme, split.netloc, split.path, query, ""))
    return text


def final_event(events: list[dict]) -> dict:
    finals = [e for e in events if str(e.get("type", "")).lower() in {"final", "message", "assistant", "result", "text"} and not is_tool_event(e)]
    if not finals:
        raise Rejected("missing structured final report event")
    return finals[-1]


def report_claim(report: dict) -> str:
    payload = report_payload(report)
    explicit = payload.get("claim") or payload.get("status")
    if explicit:
        return str(explicit)
    text = json.dumps(report.get("part", report), ensure_ascii=False).lower()
    for claim in ("hardware_observed", "model_verified", "partially_verified", "compiled_only", "failed"):
        if claim in text:
            return claim
    return "reported"


def report_payload(report: dict) -> dict:
    result = report.get("result")
    if isinstance(result, dict):
        return result
    part = report.get("part")
    if isinstance(part, dict):
        result = part.get("result")
        if isinstance(result, dict):
            return result
        text = part.get("text")
        if isinstance(text, str):
            candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                return parsed
    return report


def validate(events: list[dict], scenario: str | None = None) -> dict:
    tools = [(i, e, tool_name(e)) for i, e in enumerate(events) if is_tool_event(e)]
    if not tools:
        raise Rejected("structured tool events required; prose/self-report is not evidence")

    context = [(i, e, n) for i, e, n in tools if n.lower() in CONTEXT or contains(n, ("context",))]
    grounding = [(i, e, n) for i, e, n in tools if action_contains(e, n, GROUNDING_WORDS) and citations(e)]
    compiles = [(i, e, n) for i, e, n in tools if action_contains(e, n, COMPILE_WORDS)]
    verifies = [(i, e, n) for i, e, n in tools if action_contains(e, n, VERIFY_WORDS)]
    runs = [(i, e, n) for i, e, n in tools if action_contains(e, n, RUN_WORDS)]
    inspects = [(i, e, n) for i, e, n in tools if action_contains(e, n, INSPECT_WORDS)]
    edits = [(i, e, n) for i, e, n in tools if action_contains(e, n, EDIT_WORDS)]
    report = final_event(events)

    if not context:
        raise Rejected("missing context tool event")
    if not grounding:
        raise Rejected("missing grounding source citation from part/datasheet/search or project/SDK/SVD/schematic/netlist")
    if not compiles or not any(succeeded(e) for _, e, _ in compiles):
        raise Rejected("missing successful compile tool event")
    successful_verify = [(i, e, n) for i, e, n in verifies if succeeded(e)]
    successful_run = [(i, e, n) for i, e, n in runs if succeeded(e)]
    successful_inspect = [(i, e, n) for i, e, n in inspects if succeeded(e)]
    unsupported_ceiling = scenario == "unsupported-custom-board" and any(outcome(e) is False for _, e, _ in verifies)
    if not successful_verify and not (successful_run and successful_inspect) and not unsupported_ceiling:
        raise Rejected("missing successful verify event or ordered run+inspect evidence")

    compile_index = next(i for i, e, _ in compiles if succeeded(e))
    if successful_verify or unsupported_ceiling:
        verify_index = successful_verify[0][0] if successful_verify else next(i for i, e, _ in verifies if outcome(e) is False)
        indices = [context[0][0], grounding[0][0], compile_index, verify_index, events.index(report)]
        if indices != sorted(indices) or len(set(indices)) != len(indices):
            raise Rejected("ordered evidence must be context -> grounding -> compile -> verify -> report")
        order = ["context", "grounding", "compile", "verify", "report"]
    else:
        run_index = successful_run[0][0]
        inspect_index = next((i for i, e, _ in successful_inspect if i > run_index), successful_inspect[0][0])
        indices = [context[0][0], grounding[0][0], compile_index, run_index, inspect_index, events.index(report)]
        if indices != sorted(indices) or len(set(indices)) != len(indices):
            raise Rejected("ordered run+inspect evidence must be context -> grounding -> compile -> run -> inspect -> report")
        order = ["context", "grounding", "compile", "run", "inspect", "report"]

    attempt_count = max(1, len(edits), len(compiles))
    if attempt_count > 3:
        raise Rejected(f"edit/test attempt limit exceeded: {attempt_count} > 3")

    claim = report_claim(report)
    if claim == "model_verified" and not successful_verify:
        raise Rejected("model_verified claim requires a successful verify event")
    if claim == "hardware_observed":
        flashes = [(i, e, n) for i, e, n in tools if action_contains(e, n, FLASH_WORDS) and succeeded(e)]
        markers = [(i, e, n) for i, e, n in successful_inspect if any(k in json.dumps(e).lower() for k in ("marker", "uart", "gpio", "trace"))]
        if not flashes or not markers or flashes[0][0] >= markers[0][0]:
            raise Rejected("hardware_observed requires desk-hardware flash plus marker evidence")

    payload = report_payload(report)
    facts = payload.get("hardware_sensitive_facts")
    cited = {c for _, e, _ in grounding for c in citations(e)}
    report_text = json.dumps(report, ensure_ascii=False)
    if HARDWARE_FACT.search(report_text) and (not isinstance(facts, list) or not facts):
        raise Rejected("hardware-sensitive final claim requires a structured fact/source manifest")
    if facts is not None:
        if not isinstance(facts, list):
            raise Rejected("hardware-sensitive fact/source manifest must be a list")
        for fact in facts:
            if not isinstance(fact, dict) or not fact.get("fact") or not fact.get("source") or sanitize_citation(str(fact["source"])) not in cited:
                raise Rejected("hardware-sensitive fact lacks support from a returned/cited source")

    if scenario:
        oracle_path = Path(__file__).parent / "fixtures" / "develop-agent" / "oracles.json"
        policies = json.loads(oracle_path.read_text(encoding="utf-8"))
        if scenario not in policies:
            raise Rejected(f"unknown certification scenario: {scenario}")
        policy = policies[scenario]
        if claim not in policy["allowed_claims"]:
            raise Rejected(f"scenario {scenario} rejects final claim {claim}")
        if policy.get("requires_compile_recovery"):
            failed = [item for item in compiles if not succeeded(item[1])]
            passed = [item for item in compiles if succeeded(item[1])]
            if not failed or not passed or failed[0][0] >= passed[-1][0] or not any(failed[0][0] < i < passed[-1][0] for i, _, _ in edits):
                raise Rejected("compile recovery requires red -> focused edit -> green structured events")

    used = [(i, e, n) for i, e, n in tools if i in set(indices[:-1])]
    return {
        "event_ids": [event_id(e, i) for i, e, _ in used] + [event_id(report, events.index(report))],
        "tool_names": [n for _, _, n in used],
        "order": order,
        "source_citations": sorted(cited),
        "verify_outcomes": ["passed" if outcome(e) is True else "failed" if outcome(e) is False else "unknown" for _, e, _ in verifies + runs + inspects],
        "attempt_count": attempt_count,
        "final_claim": claim,
    }


def load_jsonl(path: Path) -> list[dict]:
    events = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise Rejected(f"invalid JSONL at line {line_number}: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise Rejected(f"event at line {line_number} is not an object")
        events.append(value)
    return events


def main() -> int:
    if len(sys.argv) not in (3, 4) or sys.argv[1] != "validate":
        print("usage: develop-agent-oracle.py validate <events.jsonl> [scenario]", file=sys.stderr)
        return 2
    try:
        bundle = validate(load_jsonl(Path(sys.argv[2])), sys.argv[3] if len(sys.argv) == 4 else None)
    except (OSError, Rejected) as exc:
        print(f"certification rejected: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(bundle, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
