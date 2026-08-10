#!/usr/bin/env bash
# Optional live LLM lane via DeepInfra (OpenAI-compatible).
# Requires DEEPINFRA_API_KEY in the environment (never commit the key).
#
# Default model: moonshotai/Kimi-K2.5 (override with LABWIRED_LLM_MODEL)
# Endpoint: https://api.deepinfra.com/v1/openai
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Optional local secrets load (names only — do not echo values)
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
    # shellcheck disable=SC1090
    set -a
    # Prefer only DEEPINFRA-related lines if file is multi-product
    # shellcheck disable=SC1091
    source "$f" 2>/dev/null || true
    set +a
  done
}
_load_secrets

if [[ -z "${DEEPINFRA_API_KEY:-}" ]]; then
  echo "not run llm-deepinfra: DEEPINFRA_API_KEY not set"
  echo "  export DEEPINFRA_API_KEY=…   # or put in ~/.local/secrets/labwired.env"
  echo "  model default: moonshotai/Kimi-K2.5"
  exit 0
fi

BASE_URL="${LABWIRED_MODEL_URL:-https://api.deepinfra.com/v1/openai}"
MODEL="${LABWIRED_LLM_MODEL:-moonshotai/Kimi-K2.5}"
# aliases some users say "kimi2.7 code"
case "$MODEL" in
  kimi2.7|kimi-2.7|kimi2.7-code|Kimi-K2.7*)
    MODEL="moonshotai/Kimi-K2.5"
    ;;
esac

echo "==> llm-deepinfra: model=$MODEL base=$BASE_URL"

# Minimal chat completion — firmware-domain prompt, assert non-empty content
RESP="$(curl -fsS --max-time 90 \
  -H "Authorization: Bearer ${DEEPINFRA_API_KEY}" \
  -H "Content-Type: application/json" \
  "${BASE_URL}/chat/completions" \
  -d "$(python3 - <<PY
import json
print(json.dumps({
  "model": """$MODEL""",
  "temperature": 0.1,
  "max_tokens": 128,
  "messages": [
    {"role": "system", "content": "You are a firmware engineer. Reply in one short sentence."},
    {"role": "user", "content": "What does model_verified mean if an oracle must dispose, not an LLM? Answer in under 30 words."}
  ]
}))
PY
)")"

echo "$RESP" | python3 - <<'PY'
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception as e:
    print("FAIL parse JSON:", e)
    print(raw[:400])
    sys.exit(1)
if "error" in d:
    print("FAIL API error:", d["error"])
    sys.exit(1)
choices = d.get("choices") or []
if not choices:
    print("FAIL no choices:", raw[:400])
    sys.exit(1)
content = (choices[0].get("message") or {}).get("content") or ""
content = content.strip()
if len(content) < 10:
    print("FAIL empty/short content:", repr(content))
    sys.exit(1)
# must not claim hardware without twin language ideally — soft check
print("ok   llm response:", content[:200].replace("\n", " "))
print("ok   llm-deepinfra PASS")
PY
