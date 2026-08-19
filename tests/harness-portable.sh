#!/usr/bin/env bash
# Foreign-install simulation: the universal pack must be self-contained when
# copied into a bare directory with no opencode config (what `npx skills add`
# effectively does for a foreign agent host).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

# shellcheck source=lib/pack-classification.sh
source "$ROOT/tests/lib/pack-classification.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/labwired-harness-portable.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

for s in "${UNIVERSAL_PACKS[@]}"; do
  cp -R "$ROOT/skills/$s" "$TMP/$s"
done

# 1. opencode-only packs must not be in the universal set (disjoint lists).
for s in "${OPENCODE_ONLY_PACKS[@]}"; do
  if [[ -d "$TMP/$s" ]]; then
    bad "opencode-only pack leaked into universal set: $s"
  else
    pass "opencode-only excluded: $s"
  fi
done

# 2. Every copied SKILL.md has a frontmatter block with name + description.
for s in "${UNIVERSAL_PACKS[@]}"; do
  f="$TMP/$s/SKILL.md"
  frontmatter="$(awk '/^---$/{c++; next} c==1' "$f")"
  if grep -q '^name:' <<<"$frontmatter" && grep -q '^description:' <<<"$frontmatter"; then
    pass "portable $s frontmatter name+description"
  else
    bad "portable $s frontmatter missing name/description"
  fi
done

# 3. No symlink escapes the copied tree (a foreign host receives plain files).
escapes="$(find "$TMP" -type l | while read -r l; do
  target="$(readlink "$l")"
  case "$target" in (/*|*..*) echo "$l" ;; esac
done)"
if [[ -z "$escapes" ]]; then
  pass "no escaping symlinks"
else
  bad "escaping symlinks: $escapes"
fi

# 4. Universal + opencode-only lists together equal the shipped set.
shipped="$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
classified="$(printf '%s\n' "${UNIVERSAL_PACKS[@]}" "${OPENCODE_ONLY_PACKS[@]}" | sort)"
if [[ "$shipped" == "$classified" ]]; then
  pass "classification partitions shipped set"
else
  bad "classification mismatch: $(diff <(echo "$shipped") <(echo "$classified") | head -10)"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "harness-portable FAILED"
  exit 1
fi
echo "ok   harness-portable PASS"
exit 0
