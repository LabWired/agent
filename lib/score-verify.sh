#!/usr/bin/env bash
# score-verify.sh — score a labwired_verify JSON or matrix inputs.
# shellcheck shell=bash
#
# Usage:
#   labwired_score_verify [--expect STATUS] [file|-]
#     Read verify JSON from file or stdin; print integer score; exit 0 on match
#     (or always 0 when --expect omitted and JSON is parseable with a status).
#   labwired_score_verify --matrix --oracle 0|1 [--build 0|1] [--warnings N] [--lines N]
#     Score = 100*oracle + 20*build - 5*warnings - 2*lines  (never LLM-as-judge)
#
# Exit: 0 success (score printed), 1 mismatch / negative matrix when strict,
#       2 usage / unparseable.

labwired_score_verify() {
  local expect="" matrix=0
  local oracle="" build="0" warnings="0" lines="0"
  local file=""
  local arg

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --expect)
        expect="${2:-}"
        shift 2
        ;;
      --matrix)
        matrix=1
        shift
        ;;
      --oracle)
        oracle="${2:-}"
        shift 2
        ;;
      --build)
        build="${2:-0}"
        shift 2
        ;;
      --warnings)
        warnings="${2:-0}"
        shift 2
        ;;
      --lines)
        lines="${2:-0}"
        shift 2
        ;;
      -h|--help)
        cat <<'EOF' >&2
usage: labwired_score_verify [--expect STATUS] [file|-]
       labwired_score_verify --matrix --oracle 0|1 [--build 0|1] [--warnings N] [--lines N]

Score formula (matrix / derived from verify JSON):
  score = 100*oracle + 20*build - 5*warnings - 2*lines
  oracle = 1 if status is model_verified (or all oracle_results passed); else 0
  build  = 1 if proven true or build_ok; else 0
EOF
        return 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        echo "score-verify: unknown flag $1" >&2
        return 2
        ;;
      *)
        if [[ -z "$file" ]]; then
          file="$1"
          shift
        else
          echo "score-verify: unexpected arg $1" >&2
          return 2
        fi
        ;;
    esac
  done

  if [[ "$matrix" -eq 1 ]]; then
    if [[ -z "$oracle" ]]; then
      echo "score-verify: --matrix requires --oracle 0|1" >&2
      return 2
    fi
    case "$oracle" in 0|1) ;; *)
      echo "score-verify: --oracle must be 0 or 1" >&2
      return 2
      ;;
    esac
    case "$build" in 0|1) ;; *)
      echo "score-verify: --build must be 0 or 1" >&2
      return 2
      ;;
    esac
    local score
    score=$((100 * oracle + 20 * build - 5 * warnings - 2 * lines))
    printf '%s\n' "$score"
    if [[ -n "$expect" ]]; then
      # Matrix mode with --expect: treat oracle==1 as model_verified-ish green
      if [[ "$oracle" -eq 1 ]]; then
        [[ "$expect" == "model_verified" || "$expect" == "hardware_observed" ]] && return 0
        return 1
      fi
      [[ "$expect" == "failed" || "$expect" == "inconclusive" || "$expect" == "unsupported" || "$expect" == "abstain" ]] && return 0
      return 1
    fi
    return 0
  fi

  local raw
  if [[ -n "$file" && "$file" != "-" ]]; then
    if [[ ! -f "$file" ]]; then
      echo "score-verify: file not found: $file" >&2
      return 2
    fi
    raw="$(cat -- "$file")"
  else
    raw="$(cat)"
  fi

  local out rc
  set +e
  out="$(printf '%s' "$raw" | python3 -c '
import json, sys, re

raw = sys.stdin.read()
expect = sys.argv[1] if len(sys.argv) > 1 else ""

STATUSES = (
    "model_verified",
    "hardware_observed",
    "failed",
    "inconclusive",
    "unsupported",
    "abstain",
)

def find_status(obj):
    if isinstance(obj, dict):
        if "status" in obj and obj["status"] in STATUSES:
            return obj["status"]
        for v in obj.values():
            s = find_status(v)
            if s:
                return s
    elif isinstance(obj, list):
        for v in obj:
            s = find_status(v)
            if s:
                return s
    elif isinstance(obj, str):
        try:
            return find_status(json.loads(obj))
        except Exception:
            m = re.search(
                r"\"status\"\s*:\s*\"(" + "|".join(STATUSES) + r")\"",
                obj,
            )
            if m:
                return m.group(1)
    return None

def walk_find(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = walk_find(v, key)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = walk_find(v, key)
            if r is not None:
                return r
    return None

data = None
try:
    data = json.loads(raw)
except Exception:
    data = None

status = find_status(data) if data is not None else None
if not status:
    m = re.search(
        r"\"status\"\s*:\s*\"(" + "|".join(STATUSES) + r")\"",
        raw,
    )
    status = m.group(1) if m else None

if not status:
    sys.stderr.write("score-verify: no status field found\n")
    sys.exit(2)

# Derive matrix factors from verify payload
oracle = 1 if status == "model_verified" else 0
if status == "hardware_observed":
    # HW green is not twin oracle green; score still rewards marker path modestly
    oracle = 0

proven = walk_find(data, "proven") if data is not None else None
build_ok = walk_find(data, "build_ok") if data is not None else None
build = 0
if proven is True or build_ok is True:
    build = 1
elif status in ("model_verified", "hardware_observed"):
    build = 1

oracle_results = walk_find(data, "oracle_results") if data is not None else None
if isinstance(oracle_results, list) and oracle_results:
    all_pass = all(
        isinstance(r, dict) and r.get("passed") is True for r in oracle_results
    )
    if all_pass and status == "model_verified":
        oracle = 1
    elif not all_pass:
        oracle = 0

warnings = walk_find(data, "warnings") if data is not None else None
if isinstance(warnings, list):
    n_warnings = len(warnings)
elif isinstance(warnings, int):
    n_warnings = warnings
else:
    n_warnings = 0

lines = walk_find(data, "lines_changed") if data is not None else None
if lines is None:
    lines = walk_find(data, "lines") if data is not None else None
if not isinstance(lines, int):
    lines = 0

score = 100 * oracle + 20 * build - 5 * n_warnings - 2 * lines
print(score)

if expect:
    sys.exit(0 if status == expect else 1)
sys.exit(0)
' "${expect}")"
  rc=$?
  set -e

  if [[ -n "$out" ]]; then
    printf '%s\n' "$out"
  fi
  return "$rc"
}

# Allow direct execution: bash lib/score-verify.sh ...
if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  labwired_score_verify "$@"
fi
