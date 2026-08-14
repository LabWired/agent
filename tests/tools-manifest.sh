#!/usr/bin/env bash
# tools-manifest.sh — ONE tool table, and it must match reality.
#
# share/tools.json is the single home for the RPC tool table and the mode policy.
# A manifest is only worth having if it cannot quietly disagree with the things it
# claims to describe, so this gate checks it against all three:
#
#   1. the CLI      — every non-sentinel argv[0] must be a subcommand that
#                     bin/labwired-agent really dispatches. bin/labwired-agent
#                     ends its case with a `*)` pass-through to the agent runtime,
#                     so a typo'd subcommand does NOT error — it silently starts
#                     opencode. Only the explicit case labels count as dispatch.
#   2. the server   — server/rpc-server.mjs must carry no inline tool array, and
#                     its live tool/list must equal the manifest field for field.
#   3. the extension— extensions/labwired-vscode/src/tools/registry.ts routes
#                     non-sentinel tools through tool/run, so where the two tables
#                     name the same tool the argv must agree.
#
# Sentinel argv[0] values (__debug__, __plot__, __hw__) are handled in-process by
# the server and never reach the CLI. They are exempt from check 1 ONLY, they are
# read from the manifest's own sentinels[], and every exemption is printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/share/tools.json"
CLI="$ROOT/bin/labwired-agent"
SERVER="$ROOT/server/rpc-server.mjs"
REGISTRY="$ROOT/extensions/labwired-vscode/src/tools/registry.ts"
NODE_BIN="$(command -v node)"

fail=0
say_fail() { echo "FAIL $*"; fail=1; }

[[ -f "$MANIFEST" ]] || { echo "FAIL manifest missing: $MANIFEST"; exit 1; }
[[ -f "$CLI" ]]      || { echo "FAIL CLI missing: $CLI"; exit 1; }
[[ -f "$SERVER" ]]   || { echo "FAIL server missing: $SERVER"; exit 1; }

# ——— 1. the CLI's real subcommands ———
# The dispatching case is the LAST `case "${1:-}" in` at column 0. An earlier one
# lives inside a heredoc (the installed shim) and must not be read as dispatch.
cli_subcommands() {
  awk '
    /^case "\$\{1:-\}" in$/ { start = NR }
    { line[NR] = $0 }
    END {
      for (i = start; i <= NR; i++) {
        if (line[i] == "esac") break
        # case labels: two-space indent, then alternatives, then ")"
        if (match(line[i], /^  [^ (][^)]*\)/)) {
          lbl = substr(line[i], 3, RLENGTH - 3)
          n = split(lbl, alts, "|")
          for (j = 1; j <= n; j++) {
            gsub(/^[ \t"]+|[ \t"]+$/, "", alts[j])
            if (alts[j] != "" && alts[j] != "*") print alts[j]
          }
        }
      }
    }
  ' "$CLI"
}

SUBS="$(cli_subcommands)"
sub_count="$(printf '%s\n' "$SUBS" | grep -c . || true)"
echo "CLI dispatches $sub_count subcommands: $(printf '%s ' $SUBS)"
# Anti-vacuity: if the extractor breaks, it must not report an empty/short list
# and pass everything by accident.
if [[ "$sub_count" -lt 10 ]]; then
  say_fail "subcommand extraction returned only $sub_count labels — extractor broken"
fi
for anchor in doctor probe version claim-shape; do
  printf '%s\n' "$SUBS" | grep -qx "$anchor" \
    || say_fail "subcommand extraction missed the anchor \`$anchor\` — extractor broken"
done

# ——— 2. manifest rows vs the CLI ———
manifest_rows() {  # name<TAB>argv0<TAB>is_sentinel<TAB>modes(csv)
  python3 - "$MANIFEST" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
sent = set(doc["sentinels"])
for t in doc["tools"]:
    a0 = t["argv"][0]
    print("\t".join([t["name"], a0, "1" if a0 in sent else "0",
                     ",".join(t.get("modes", []))]))
PY
}

ROWS="$(manifest_rows)"
row_count="$(printf '%s\n' "$ROWS" | grep -c . || true)"
if [[ "$row_count" -lt 1 ]]; then
  echo "FAIL manifest produced no rows — nothing was checked"
  exit 1
fi

echo ""
echo "--- manifest argv[0] vs CLI dispatch ($row_count rows) ---"
while IFS=$'\t' read -r name argv0 sentinel modes; do
  [[ -n "$name" ]] || continue
  if [[ "$sentinel" == "1" ]]; then
    echo "exempt  $name — argv[0] \`$argv0\` is a manifest sentinel, handled in-process by the server, never dispatched by the CLI"
    continue
  fi
  if printf '%s\n' "$SUBS" | grep -qx "$argv0"; then
    echo "ok      $name — \`$argv0\` is dispatched by bin/labwired-agent"
  else
    say_fail "$name — argv[0] \`$argv0\` is NOT a subcommand bin/labwired-agent dispatches"
  fi
  if [[ -z "$modes" ]]; then
    say_fail "$name — empty modes[]; a tool with no modes is invisible to the mode policy"
  fi
done <<EOF
$ROWS
EOF

# ——— 3. the server must own no second copy ———
echo ""
echo "--- server has no inline tool table ---"
if grep -nE '^const TOOLS = \[' "$SERVER"; then
  say_fail "server/rpc-server.mjs re-grew an inline TOOLS array — that is the fork this manifest removed"
else
  echo "ok      no inline \`const TOOLS = [\` in server/rpc-server.mjs"
fi
for gone in 'const destructive = new Set' 'const verifyOnly = new Set'; do
  if grep -nF "$gone" "$SERVER"; then
    say_fail "server/rpc-server.mjs re-grew an inline mode set ($gone)"
  else
    echo "ok      no inline mode set \`$gone\`"
  fi
done

# ——— 4. the live server must serve exactly the manifest ———
echo ""
echo "--- live tool/list vs manifest ---"
live_check() {
  python3 - "$SERVER" "$NODE_BIN" "$MANIFEST" <<'PY'
import json, os, select, subprocess, sys, time
server, node, manifest = sys.argv[1:4]
p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=dict(os.environ))
for i, (method, params) in enumerate(
        [("initialize", {"clientName": "tools-manifest-gate"}), ("tool/list", {})], start=1):
    b = json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}).encode()
    p.stdin.write(f"Content-Length: {len(b)}\r\n\r\n".encode() + b)
p.stdin.flush()
buf, got, deadline = b"", {}, time.time() + 30
while time.time() < deadline and len(got) < 2:
    ready, _, _ = select.select([p.stdout], [], [], 0.2)
    if not ready:
        continue
    c = p.stdout.read1(1 << 20)
    if not c:
        break
    buf += c
    while True:
        s = buf.find(b"\r\n\r\n")
        if s < 0:
            break
        n = int(buf[:s].decode().split(":", 1)[1].strip())
        e = s + 4 + n
        if len(buf) < e:
            break
        msg = json.loads(buf[s + 4:e]); buf = buf[e:]
        if msg.get("id") in (1, 2):
            got[msg["id"]] = msg
p.terminate()
bad = []
if 1 not in got or 2 not in got:
    print("FAIL server did not answer initialize + tool/list")
    sys.exit(1)
doc = json.load(open(manifest))
served = got[2].get("result", {}).get("tools")
if served is None:
    bad.append("tool/list returned no tools")
    served = []
want = [{"name": t["name"], "title": t["title"], "group": t["group"],
         "params": t.get("params", [])} for t in doc["tools"]]
if served != want:
    bad.append("tool/list does not equal the manifest")
    wn = [t["name"] for t in want]
    sn = [t["name"] for t in served]
    if wn != sn:
        bad.append(f"  names: manifest={wn}\n         served  ={sn}")
    for a, b_ in zip(want, served):
        if a != b_:
            bad.append(f"  row differs: manifest={a} served={b_}")
else:
    print(f"ok      tool/list serves the manifest verbatim ({len(served)} tools)")

# Every mode named in the manifest must be a mode the server advertises.
adv = set(got[1].get("result", {}).get("capabilities", {}).get("modes", []))
if not adv:
    bad.append("initialize advertised no modes — cannot validate manifest mode names")
named = set(doc["modePolicy"].keys())
for t in doc["tools"]:
    named |= set(t.get("modes", []))
unknown = sorted(named - adv)
if unknown:
    bad.append(f"manifest names modes the server does not advertise: {unknown} (advertised: {sorted(adv)})")
else:
    print(f"ok      every manifest mode is advertised by the server ({sorted(adv)})")

# Gated modes must carry a message that names the tool.
for mode, pol in doc["modePolicy"].items():
    if "${name}" not in pol.get("message", ""):
        bad.append(f"modePolicy.{mode}.message does not interpolate ${{name}}")
if not bad:
    print("ok      mode policy is well formed")
for b_ in bad:
    print("FAIL " + b_)
sys.exit(1 if bad else 0)
PY
}
live_check || fail=1

# ——— 5. the VS Code extension registry must not contradict the manifest ———
# The extension keeps its OWN richer table (descriptions, required/default params,
# UI-only tools the server has no row for), so this gate asserts agreement rather
# than replacing it — see the header of share/tools.json and the report.
# NOT asserted, deliberately and visibly: title, group and description. Those are
# display strings the extension words for its own UI, and they already differ
# (e.g. probe_flash "Flash" vs "Flash firmware"). argv is what crosses tool/run.
echo ""
echo "--- extension registry vs manifest (shared tools) ---"
if [[ ! -f "$REGISTRY" ]]; then
  echo "skip    extension registry not present at $REGISTRY"
else
  registry_check() {
  python3 - "$MANIFEST" "$REGISTRY" <<'PY'
import json, re, sys
manifest, registry = sys.argv[1:3]
doc = json.load(open(manifest))
sent = set(doc["sentinels"])
mine = {t["name"]: t for t in doc["tools"]}
src = open(registry).read()

start = src.index("export const TOOLS")
start = src.index("[", src.index("=", start))  # skip the `ToolDef[]` in the type
depth, i, objs, cur, instr, esc = 0, start, [], "", False, False
while i < len(src):
    ch = src[i]
    if instr:
        if esc: esc = False
        elif ch == "\\": esc = True
        elif ch == '"': instr = False
    elif ch == '"': instr = True
    elif ch == "{":
        depth += 1
        if depth == 1: cur = ""
    elif ch == "}":
        depth -= 1
        if depth == 0:
            objs.append(cur); cur = ""
            i += 1; continue
    elif ch == "]" and depth == 0:
        break
    if depth >= 1: cur += ch
    i += 1

def bracket(block, key):
    m = re.search(key + r"\s*:\s*\[", block)
    if not m: return None
    j = m.end() - 1; d = 0
    while j < len(block):
        if block[j] == "[": d += 1
        elif block[j] == "]":
            d -= 1
            if d == 0: return block[m.end():j]
        j += 1
    return None

theirs = {}
for o in objs:
    nm = re.search(r'name:\s*"([^"]+)"', o)
    if not nm: continue
    argv_blk = bracket(o, "argv")
    argv = re.findall(r'"((?:[^"\\]|\\.)*)"', argv_blk) if argv_blk else []
    if not argv:
        one = re.search(r'argv:\s*\[\s*"([^"]+)"\s*\]', o)
        argv = [one.group(1)] if one else []
    params_blk = bracket(o, "params") or ""
    req = []
    for pobj in re.findall(r"\{[^{}]*\}", params_blk):
        pn = re.search(r'name:\s*"([^"]+)"', pobj)
        if pn and re.search(r"required:\s*true", pobj):
            req.append(pn.group(1))
    theirs[nm.group(1)] = {"argv": argv, "required": req}

if len(theirs) < 10:
    print(f"FAIL registry parse found only {len(theirs)} tools — parser broken, not a green result")
    sys.exit(1)
print(f"parsed  {len(theirs)} tools from the extension registry, {len(mine)} from the manifest")

bad = []
shared = sorted(set(mine) & set(theirs))
print(f"shared  {len(shared)} tools: {' '.join(shared)}")
print(f"ext-only (no server row, runs via CLI fallback): {' '.join(sorted(set(theirs) - set(mine)))}")
print(f"server-only (not offered by the extension UI):   {' '.join(sorted(set(mine) - set(theirs)))}")
for n in shared:
    a, b = mine[n]["argv"], theirs[n]["argv"]
    if a[0] != b[0]:
        bad.append(f"{n}: argv[0] differs — manifest {a[0]!r} vs registry {b[0]!r}")
        continue
    if a[0] in sent:
        print(f"exempt  {n} — sentinel {a[0]}; the extension handles it in its own debug service, "
              f"never through tool/run, so only argv[0] is compared")
        continue
    if a != b:
        bad.append(f"{n}: argv differs — manifest {a} vs registry {b}")
    else:
        missing = [p for p in theirs[n]["required"] if p not in mine[n].get("params", [])]
        if missing:
            bad.append(f"{n}: registry marks {missing} required but the manifest has no such params — "
                       f"the server would drop them")
        else:
            print(f"ok      {n} — argv identical, required params accepted")
for b in bad:
    print("FAIL " + b)
sys.exit(1 if bad else 0)
PY
  }
  registry_check || fail=1
fi

# ——— 6. the mode policy must still BITE at runtime ———
# A manifest that parses but no longer gates is the worst outcome of this move,
# so drive the live server: two refusals and one negative control. The control
# runs probe_flash in Act mode against a fake CLI (echo only, target=virtual), so
# nothing is flashed and a gate that refused everything cannot pass either.
echo ""
echo "--- live mode gates ---"
GTMP="$(mktemp -d)"
trap 'rm -rf "$GTMP"' EXIT
printf '%s\n' '#!/usr/bin/env bash' 'echo "FAKE-CLI $*"' >"$GTMP/fake-agent"
chmod +x "$GTMP/fake-agent"

mode_gate_check() {
  LABWIRED_AGENT_CLI_PATH="$GTMP/fake-agent" python3 - "$SERVER" "$NODE_BIN" <<'PY'
import json, os, select, subprocess, sys, time
server, node = sys.argv[1:3]
# (mode, tool, params, expect) — expect "refused" or "allowed"
cases = [
    ("plan",   "hardware_run", {"profile": "/tmp/p.json", "out": "/tmp/e", "confirm": "0" * 64}, "refused"),
    ("verify", "hardware_run", {"profile": "/tmp/p.json", "out": "/tmp/e", "confirm": "0" * 64}, "refused"),
    ("act",    "hardware_run", {"profile": "/tmp/p.json", "out": "/tmp/e", "confirm": "0" * 64}, "allowed"),
    ("debug",  "hardware_run", {"profile": "/tmp/p.json", "out": "/tmp/e", "confirm": "0" * 64}, "allowed"),
    ("plan",   "probe_flash",  {"elf": "/nonexistent.elf", "chip": "C", "target": "virtual"}, "refused"),
    ("plan",   "hw_promote",   {"dry_run": "1", "target": "virtual"},                          "refused"),
    ("verify", "hw_promote",   {"dry_run": "1", "target": "virtual"},                          "refused"),
    ("verify", "debug_read",   {"addr": "0x0", "len": "4", "chip": "C"},                       "refused"),
    ("act",    "probe_flash",  {"elf": "/nonexistent.elf", "chip": "C", "target": "virtual"}, "allowed"),
]
reqs, meta, i = [], [], 0
for mode, tool, params, expect in cases:
    i += 1; reqs.append({"jsonrpc": "2.0", "id": i, "method": "mode/set", "params": {"mode": mode}}); meta.append(None)
    i += 1; reqs.append({"jsonrpc": "2.0", "id": i, "method": "tool/run",
                         "params": {"name": tool, "params": params}})
    meta.append((mode, tool, expect))
p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=dict(os.environ))
for r in reqs:
    b = json.dumps(r).encode()
    p.stdin.write(f"Content-Length: {len(b)}\r\n\r\n".encode() + b)
p.stdin.flush()
buf, got, want, deadline = b"", {}, set(range(1, len(reqs) + 1)), time.time() + 60
while time.time() < deadline and want - set(got):
    ready, _, _ = select.select([p.stdout], [], [], 0.2)
    if not ready:
        continue
    c = p.stdout.read1(1 << 20)
    if not c:
        break
    buf += c
    while True:
        s = buf.find(b"\r\n\r\n")
        if s < 0:
            break
        n = int(buf[:s].decode().split(":", 1)[1].strip())
        e = s + 4 + n
        if len(buf) < e:
            break
        msg = json.loads(buf[s + 4:e]); buf = buf[e:]
        if msg.get("id") in want:
            got[msg["id"]] = msg
p.terminate()
bad = 0
for idx, m in enumerate(meta, start=1):
    if m is None:
        continue
    mode, tool, expect = m
    r = got.get(idx)
    if r is None:
        print(f"FAIL {mode}/{tool}: no response"); bad += 1; continue
    actual = "refused" if "error" in r else "allowed"
    detail = r["error"]["message"] if "error" in r else f"code={r['result'].get('code')}"
    if actual != expect:
        print(f"FAIL {mode}/{tool}: expected {expect}, got {actual} — {detail}"); bad += 1
    else:
        print(f"ok      {mode}/{tool} {actual} — {detail}")
sys.exit(1 if bad else 0)
PY
}
mode_gate_check || fail=1

echo ""
if [[ "$fail" -ne 0 ]]; then
  echo "FAIL tool manifest has drifted from reality"
  exit 1
fi
echo "ok   share/tools.json agrees with the CLI, the server and the extension"
