// Harness tools reach Claude Code as text, not tool calls, so its concise view counts none.
// Claude Code's subagentStatusLine draws the latest step from the row files run.ts writes.
export type Activity = { readonly step: string; readonly tools: number }

// A harness names its own tools: control characters (escape sequences) never reach the terminal.
export const stepOf = (line: string) =>
  line
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim()
    .replace(/^▸\s*/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
