import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Delivers each new line appended to $PI_INBOX to the running agent as a steer.
export default function (pi: ExtensionAPI) {
  const path = process.env.PI_INBOX;
  let timer: ReturnType<typeof setInterval> | undefined;
  let offset = 0;
  pi.on("session_start", () => {
    if (!path || timer) return;
    // The plugin creates the inbox empty right before spawning, so everything
    // in it belongs to this run, including anything written before this event.
    offset = 0;
    timer = setInterval(() => {
      if (!existsSync(path)) return;
      const text = readFileSync(path, "utf8");
      if (text.length <= offset) return;
      const fresh = text.slice(offset);
      const end = fresh.lastIndexOf("\n");
      if (end < 0) return;
      offset += end + 1;
      for (const line of fresh.slice(0, end).split("\n")) {
        if (line.trim()) void pi.sendUserMessage(JSON.parse(line), { deliverAs: "steer" });
      }
    }, 300);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
