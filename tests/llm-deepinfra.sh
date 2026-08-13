#!/usr/bin/env bash
# Optional live LLM lane via DeepInfra (OpenAI-compatible).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

_load_secrets() {
  local f
  for f in \
    "${LABWIRED_SECRETS_FILE:-}" \
    "$HOME/.local/secrets/labwired.env" \
    "$HOME/.local/secrets/deepinfra.env" \
    "$HOME/.local/secrets/kernelcad-prod.env" \
    "$HOME/.config/labwired/secrets.env"
  do
    [[ -n "$f" && -f "$f" ]] || continue
    set -a
    # shellcheck disable=SC1090
    source "$f" 2>/dev/null || true
    set +a
  done
}
_load_secrets

if [[ -z "${DEEPINFRA_API_KEY:-}" ]]; then
  [[ "${1:-}" != "--check" ]] || exit 3
  echo "not run llm-deepinfra: DEEPINFRA_API_KEY not set"
  echo "  export DEEPINFRA_API_KEY=…   # or put in ~/.local/secrets/labwired.env"
  echo "  model default: moonshotai/Kimi-K2.5"
  exit 0
fi
[[ "${1:-}" != "--check" ]] || exit 0
MODE="${1:-}"

BASE_URL="${LABWIRED_MODEL_URL:-https://api.deepinfra.com/v1/openai}"
MODEL="${LABWIRED_LLM_MODEL:-moonshotai/Kimi-K2.5}"
case "$MODEL" in
  kimi2.7|kimi-2.7|kimi2.7-code|Kimi-K2.7*) MODEL="moonshotai/Kimi-K2.5" ;;
esac

echo "==> llm-deepinfra: model=$MODEL base=$BASE_URL"

if [[ -n "${LABWIRED_LLM_RESPONSE_FILE:-}" ]]; then
  RESP_FILE="$LABWIRED_LLM_RESPONSE_FILE"
  CLEAN_RESP=0
else
  RESP_FILE="$(mktemp)"
  CLEAN_RESP=1
  curl -fsS --max-time 180 \
    -H "Authorization: Bearer ${DEEPINFRA_API_KEY}" \
    -H "Content-Type: application/json" \
    "${BASE_URL}/chat/completions" \
    -o "$RESP_FILE" \
    -d "$(python3 - "$ROOT" "$MODE" "$MODEL" <<'PY'
import json
import pathlib
import sys
root, mode, model = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if mode == "--develop-acceptance":
  cases = json.loads((root / "fixtures/develop-acceptance/cases.json").read_text())
  system = "You are a firmware acceptance reviewer. Return strict JSON only, without markdown fences."
  user = json.dumps(cases, separators=(",", ":"))
  max_tokens = 4000
else:
  system = "You are a firmware engineer. Reply in one short sentence."
  user = "What does model_verified mean if an oracle must dispose, not an LLM? Answer in under 30 words."
  max_tokens = 128
print(json.dumps({
  "model": model,
  "temperature": 0.1,
  "max_tokens": max_tokens,
  "messages": [
    {"role": "system", "content": system},
    {"role": "user", "content": user}
  ]
}))
PY
)"
fi

CONTENT_FILE="$(mktemp)"
cleanup() {
  rm -f "$CONTENT_FILE"
  [[ "$CLEAN_RESP" != "1" ]] || rm -f "$RESP_FILE"
}
trap cleanup EXIT
python3 - "$RESP_FILE" "$CONTENT_FILE" <<'PY'
import json
import sys

raw = open(sys.argv[1], encoding="utf-8").read()
try:
    data = json.loads(raw)
except Exception as error:
    print("FAIL parse JSON:", error)
    print(raw[:400])
    sys.exit(1)
if "error" in data:
    print("FAIL API error:", data["error"])
    sys.exit(1)
choices = data.get("choices") or []
if not choices:
    print("FAIL no choices:", raw[:400])
    sys.exit(1)
content = ((choices[0].get("message") or {}).get("content") or "").strip()
if len(content) < 10:
    print("FAIL empty/short content:", repr(content))
    sys.exit(1)
print("ok   llm response:", content[:200].replace("\n", " "))
open(sys.argv[2], "w", encoding="utf-8").write(content)
print("ok   llm-deepinfra PASS")
PY

if [[ "$MODE" == "--develop-acceptance" ]]; then
  bash "$ROOT/tests/develop-acceptance-smoke.sh" "$CONTENT_FILE"
fi
