import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Delivers each new line appended to $PI_INBOX to the running agent: a string as a steer, and
// {interrupt} by aborting the current step. In print mode pi then exits; via runs the message next.
export default function (pi: ExtensionAPI) {
  const path = process.env.PI_INBOX;
  let timer: ReturnType<typeof setInterval> | undefined;
  let offset = 0;
  pi.on("session_start", (_event, ctx) => {
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
        if (!line.trim()) continue;
        const value: unknown = JSON.parse(line);
        if (typeof value === "string") void pi.sendUserMessage(value, { deliverAs: "steer" });
        else ctx.abort();
      }
    }, 300);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
