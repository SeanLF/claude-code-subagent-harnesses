# Live check: plays via's side of the relay's permission questions, answering each with a fixed choice.
# Usage: python3 -I ask-check.py <workdir> <agent mode> <allow|deny> <prompt> -- <agent command...>
import json, os, subprocess, sys, time

work, mode, answer, prompt = sys.argv[1:5]
agent = sys.argv[sys.argv.index("--") + 1 :]
relay = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "relay.mjs")
os.makedirs(work, exist_ok=True)
inbox = os.path.join(work, "inbox.jsonl")
open(inbox, "w").close()
env = dict(os.environ, VIA_INBOX=inbox, VIA_POLICY="ask", VIA_AGENT_MODE=mode)
start = time.time()
proc = subprocess.Popen(["node", relay, "--", *agent], cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
proc.stdin.write(prompt)
proc.stdin.close()
text = ""
for line in proc.stdout:
    try:
        event = json.loads(line)
    except ValueError:
        continue
    via = event.get("via")
    if via in ("model", "error"):
        print(f"{via}:", event.get("name") or event.get("message"))
    if via == "ask":
        call = event["toolCall"]
        kinds = [o["kind"] for o in event["options"]]
        want = "allow_once" if answer == "allow" else "reject_once"
        option = next((o["optionId"] for o in event["options"] if o["kind"] == want), None)
        print(f"ask {event['id']}: {call['kind']} {call['title']!r} options={kinds} -> {want}")
        with open(inbox, "a") as f:
            f.write(json.dumps({"answer": event["id"], "optionId": option}) + "\n")
    update = event.get("update") or {}
    if update.get("sessionUpdate") == "agent_message_chunk":
        text += (update.get("content") or {}).get("text", "")
    if update.get("sessionUpdate") == "tool_call_update" and update.get("status") in ("completed", "failed"):
        print("tool", update.get("status"), repr(update.get("title")))
    if via == "prompt_done":
        print("done:", event.get("stopReason"))
proc.wait()
print(f"answer: {text.strip()[-200:]!r} ({time.time() - start:.0f}s)")
