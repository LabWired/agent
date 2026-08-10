#!/usr/bin/env bash
# Ready-gate QA. Exit 0 ⇒ AGENT_PRODUCT_READY=yes
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@20/bin:${ROOT}/bin:${HOME}/.labwired/bin:${PATH}"
RPC="$ROOT/server/rpc-server.mjs"
EDITOR="${LABWIRED_EDITOR_ROOT:-$(cd "$ROOT/../labwired-cursor" 2>/dev/null && pwd || true)}"
OUT="$ROOT/docs/qa/gap-ready-qa-latest.json"
mkdir -p "$ROOT/docs/qa"
cp -f "$RPC" "${HOME}/.labwired/agent/server/rpc-server.mjs" 2>/dev/null || true

python3 - "$RPC" "$ROOT" "$EDITOR" "$OUT" <<'PY'
import json, os, re, select, subprocess, sys, time
rpc, root, editor, outp = sys.argv[1:5]
checks = []

def ok(k, c, d=""):
    checks.append({"id": k, "pass": bool(c), "evidence": (d or "")[:200]})
    print(("PASS" if c else "FAIL") + f"  {k} — {(d or '')[:120]}")

# syntax
r = subprocess.run(["node", "--check", rpc], capture_output=True, text=True)
ok("syntax", r.returncode == 0, r.stderr[:80] if r.returncode else "ok")

# static editor
def has(path, pat):
    try:
        with open(path) as f:
            return bool(re.search(pat, f.read()))
    except Exception:
        return False

def rgrep(pat, base):
    r = subprocess.run(["rg", "-q", pat, base, "--glob", "*.ts"], capture_output=True)
    return r.returncode == 0

ok("cmd-debug", has(f"{editor}/src/vs/workbench/contrib/void/browser/labwiredDebugActions.ts", "labwired.debugInfo")
   and has(f"{editor}/src/vs/workbench/contrib/void/browser/void.contribution.ts", "labwiredDebugActions"))
for cid in ["labwired.openHwLab", "labwired.openEvidence", "labwired.signIn", "labwired.refreshAgent", "labwired.gdbStart", "labwired.debugRead", "labwired.flashConfirm"]:
    ok(f"cmd-{cid}", rgrep(cid, f"{editor}/src/vs/workbench/contrib/void"))
ok("ui-hwlab", has(f"{editor}/src/vs/workbench/contrib/void/browser/react/src/hw-lab-tsx/HwLab.tsx", "plotParse|SerialPlotStrip|regSource|refreshLiveRegisters"))
ok("ui-agent-status", has(f"{editor}/src/vs/workbench/contrib/void/browser/react/src/hw-lab-tsx/HwLab.tsx", "Agent offline|agentReady"))
out_js = f"{editor}/src/vs/workbench/contrib/void/browser/react/out/hw-lab-tsx/index.js"
ok("ui-build", os.path.isfile(out_js) and has(out_js, "SerialPlotStrip"))
ok("chat-slash", has(f"{editor}/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/slashCommands.ts", r"name: 'gdb'"))
ok("chat-ux-starters", has(f"{editor}/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx", r"Check agent|Twin-verify|hardware_observed"))
ok("chat-ux-claims", has(f"{editor}/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx", r"model_verified"))

# twin
r = subprocess.run([f"{root}/bin/labwired-agent", "assert-status", "model_verified", f"{root}/fixtures/gate1/artifacts/fixed.verify.json"], capture_output=True, text=True)
ok("twin-gate1", r.returncode == 0, r.stderr[:80] or r.stdout[:80])

# RPC
p = subprocess.Popen(["node", rpc], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
buf = b""

def send(o):
    b = json.dumps(o).encode()
    p.stdin.write(f"Content-Length: {len(b)}\r\n\r\n".encode() + b)
    p.stdin.flush()

def wait(i, t=30):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], 0.25)
        if r:
            c = p.stdout.read1(65536)
            if not c:
                break
            buf += c
        while True:
            j = buf.find(b"\r\n\r\n")
            if j < 0:
                break
            h = buf[:j].decode()
            m = re.search(r"content-length:\s*(\d+)", h, re.I)
            if not m:
                buf = buf[j + 4 :]
                continue
            n = int(m.group(1))
            s = j + 4
            if len(buf) < s + n:
                break
            msg = json.loads(buf[s : s + n])
            buf = buf[s + n :]
            if msg.get("id") == i:
                return msg
    return None

send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"workspacePath": root, "clientName": "ready"}})
ok("rpc-init", wait(1, 5) is not None)
send({"jsonrpc": "2.0", "id": 2, "method": "tool/list"})
names = [t["name"] for t in (wait(2) or {}).get("result", {}).get("tools", [])]
need = ["debug_info", "debug_gdb_start", "debug_read", "plot_status", "hw_claim_shape", "hw_promote", "probe_flash"]
ok("rpc-tools", all(n in names for n in need), str([n for n in need if n not in names]))
send({"jsonrpc": "2.0", "id": 3, "method": "mode/set", "params": {"mode": "plan"}})
wait(3)
send({"jsonrpc": "2.0", "id": 4, "method": "tool/run", "params": {"name": "debug_gdb_start", "params": {"chip": "x"}}})
ok("rpc-plan-gdb", "Plan mode" in (wait(4) or {}).get("error", {}).get("message", ""))
# Safety: Plan must block hw_promote (nested flash path) — not only probe_flash
send({"jsonrpc": "2.0", "id": 40, "method": "tool/run", "params": {"name": "hw_promote", "params": {"elf": "/tmp/x.elf", "chip": "c", "target": "probe", "confirm": "1"}}})
ok("rpc-plan-hw-promote", "Plan mode" in (wait(40) or {}).get("error", {}).get("message", ""))
send({"jsonrpc": "2.0", "id": 41, "method": "tool/run", "params": {"name": "hw_promote", "params": {"dry_run": "1", "flashed": "1", "marker_matched": "1", "target": "virtual"}}})
ok("rpc-plan-hw-promote-dry", "Plan mode" in (wait(41) or {}).get("error", {}).get("message", ""))
send({"jsonrpc": "2.0", "id": 5, "method": "mode/set", "params": {"mode": "act"}})
wait(5)
send({"jsonrpc": "2.0", "id": 6, "method": "tool/run", "params": {"name": "probe_flash", "params": {"elf": "x", "chip": "c", "target": "probe"}}})
ok("rpc-flash-confirm", "confirm" in (wait(6) or {}).get("error", {}).get("message", "").lower())
send({"jsonrpc": "2.0", "id": 7, "method": "tool/run", "params": {"name": "hw_claim_shape", "params": {"flashed": "1", "marker_matched": "1"}}})
ok("rpc-hw-observed", "hardware_observed" in ((wait(7) or {}).get("result") or {}).get("stdout", ""))
send({"jsonrpc": "2.0", "id": 8, "method": "tool/run", "params": {"name": "hw_claim_shape", "params": {"status": "model_verified", "flashed": "1", "marker_matched": "1"}}})
ok("rpc-refuse-mv", ((wait(8) or {}).get("result") or {}).get("code") == 1)
send({"jsonrpc": "2.0", "id": 9, "method": "tool/run", "params": {"name": "hw_promote", "params": {"dry_run": "1", "flashed": "1", "marker_matched": "1", "target": "virtual"}}})
r9 = (wait(9) or {}).get("result") or {}
ok("rpc-promote-dry", r9.get("code") == 0 and "hardware_observed" in (r9.get("stdout") or ""), (r9.get("stdout") or r9.get("stderr") or "")[:100])
send({"jsonrpc": "2.0", "id": 10, "method": "chat/send", "params": {"text": "/gdb info"}})
ok("rpc-chat-gdb", (wait(10, 20) or {}).get("result", {}).get("source") == "tool")
send({"jsonrpc": "2.0", "id": 11, "method": "chat/send", "params": {"text": "/promote"}})
ok("rpc-chat-promote", (wait(11, 20) or {}).get("result", {}).get("source") == "tool")
send({"jsonrpc": "2.0", "id": 12, "method": "tool/run", "params": {"name": "debug_read", "params": {"addr": "0x3FC88000", "len": "16", "chip": "esp32c3"}}})
r12 = (wait(12, 25) or {}).get("result") or {}
live = r12.get("code") == 0 and "3fc88000" in (r12.get("stdout") or "").lower()
ok("rpc-debug-read-live", live, (r12.get("stdout") or r12.get("stderr") or "")[:120])
p.terminate()
try:
    p.wait(timeout=2)
except Exception:
    p.kill()

passed = sum(1 for c in checks if c["pass"])
failed = sum(1 for c in checks if not c["pass"])
ready = failed == 0
doc = {
    "stamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "pass": passed,
    "fail": failed,
    "agent_product_ready": ready,
    "definition": (
        "AGENT_PRODUCT_READY: Parts 1–4 implemented and automated; Part 5 static commands/slash/UI build; "
        "live debug_read on esp32c3; flash confirm; promote dry_run; twin gate1. "
        "NOT claiming: full Electron click E2E, GDB step/BP UI, STM32 powered read, physical flash+serial desk run."
    ),
    "checks": checks,
}
json.dump(doc, open(outp, "w"), indent=2)
print(json.dumps({"pass": passed, "fail": failed, "agent_product_ready": ready}, indent=2))
sys.exit(0 if ready else 1)
PY
EC=$?
echo "---"
cat "$OUT"
echo "EXIT:$EC"
exit $EC
