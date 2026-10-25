#!/bin/sh
# Live checks for an ACP agent behind relay/relay.mjs: stream, interrupt, resume, stop, refused model, steer.
# Usage: RELAY_STEER=steering|prompt check.sh <workdir> <model> <bad-model> -- <agent command...>
set -u
work=$1 model=$2 bad=$3
shift 4
relay="$(cd "$(dirname "$0")/.." && pwd)/relay.mjs"
mkdir -p "$work" && cd "$work" || exit 1
# The checks are about the connection, not permissions: approve what the agent asks.
export RELAY_POLICY=allow

# Prints each prompt's message text and stopReason, the last usage, and the session id.
summary() {
  python3 -I - "$1" <<'EOF'
import json, sys
msg, usage, sid = "", None, None
for line in open(sys.argv[1]):
    try: e = json.loads(line)
    except ValueError: continue
    if e.get("relay") == "session": sid = e["sessionId"]
    if e.get("relay") in ("model", "error"): print("  " + e["relay"] + ":", e.get("name") or e.get("message"))
    if e.get("relay") == "prompt_done":
        print("  prompt:", repr(msg[-80:]), e.get("stopReason"), e.get("usage")); msg = ""
    u = e.get("update") or {}
    if u.get("sessionUpdate") == "agent_message_chunk": msg += (u.get("content") or {}).get("text", "")
    if u.get("sessionUpdate") == "usage_update": usage = (u.get("used"), u.get("size"))
print("  usage:", usage, "session:", sid)
EOF
}
wait_for() { i=0; while [ $i -lt 90 ]; do pgrep -f "$1" >/dev/null && return 0; i=$((i + 1)); sleep 1; done; return 1; }

echo "== 1 stream"
echo "Reply with only the word PONG." | RELAY_MODEL=$model node "$relay" -- "$@" > stream.jsonl 2> stream.err
echo "  exit $?"; summary stream.jsonl

echo "== 2 interrupt"
: > inbox.jsonl
pkill -f '^sleep 31$'
start=$(date +%s)
echo "Use your bash tool to run: sleep 31. Then reply SLEPT." | RELAY_INBOX="$work/inbox.jsonl" RELAY_MODEL=$model node "$relay" -- "$@" > interrupt.jsonl 2> interrupt.err &
pid=$!
if wait_for '^sleep 31$'; then echo '{"interrupt":"Stop. Reply with only the word REDIRECTED."}' >> inbox.jsonl; echo "  sent at $(( $(date +%s) - start ))s"; else echo "  sleep never started"; fi
wait $pid; echo "  exit $? after $(( $(date +%s) - start ))s"; summary interrupt.jsonl
pgrep -fl '^sleep 31$' && echo "  ORPHAN sleep" || echo "  no orphan sleep"

echo "== 3 resume"
sid=$(python3 -I -c 'import json,sys; print(next(json.loads(l)["sessionId"] for l in open(sys.argv[1]) if "\"relay\":\"session\"" in l))' interrupt.jsonl)
echo "Which single word did you reply with last? Reply with only that word." | RELAY_SESSION=$sid RELAY_MODEL=$model node "$relay" -- "$@" > resume.jsonl 2> resume.err
echo "  exit $?"; summary resume.jsonl

echo "== 4 stop"
pkill -f '^sleep 61$'
echo "Use your bash tool to run: sleep 61. Then reply SLEPT." | RELAY_MODEL=$model node "$relay" -- "$@" > stop.jsonl 2> stop.err &
pid=$!
if wait_for '^sleep 61$'; then kill -TERM $pid; sleep 4; else echo "  sleep never started"; kill -TERM $pid; fi
ps -p $pid >/dev/null && echo "  relay ALIVE" || echo "  relay gone"
pgrep -fl '^sleep 61$' && echo "  ORPHAN sleep" || echo "  no orphan sleep"

echo "== 5 failure"
echo "Reply with only the word PONG." | RELAY_MODEL=$bad node "$relay" -- "$@" > failure.jsonl 2> failure.err
echo "  exit $?"; summary failure.jsonl; tail -2 failure.err | sed 's/^/  stderr: /'

echo "== 6 steer"
: > inbox.jsonl
pkill -f '^sleep 26$'
echo "Use your bash tool to run: sleep 26. Then reply DONE." | RELAY_INBOX="$work/inbox.jsonl" RELAY_MODEL=$model node "$relay" -- "$@" > steer.jsonl 2> steer.err &
pid=$!
if wait_for '^sleep 26$'; then echo '"Change of plan: after the sleep, also run: echo STEERED. Then reply with its output and DONE."' >> inbox.jsonl; else echo "  sleep never started"; fi
wait $pid; echo "  exit $?"; summary steer.jsonl
# One prompt whose answer has STEERED: the message reached the running prompt, not a second one.
echo "  prompts: $(grep -c '"relay":"prompt_done"' steer.jsonl), steered: $(grep -c '"relay":"steered"' steer.jsonl)"
