import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// Two rules for a folded run of via's step calls, checked over a group's whole life rather than one frame:
// A. A group keeps one drawer, via's or Claude Code's own, from its first frame to its last: a switch changes its
//    height on screen (the flicker).
// B. A row only Claude Code knows of (a recalled memory, a hook timing) is never hidden: while one is in the group,
//    Claude Code draws it. The hook can't see such a row; the test knows it is there.
// No ToolGroup hook keeps both: isCallsOnly is false for a failed call and for another row alike, so "a command
// fails" and "a command fails and a hook timing row joins" look the same to it, and A wants via's line in the one
// where B wants Claude Code's. via keeps A there (the flicker is common, the hidden row rare), and the cases where
// it can't keep a rule are named below. Both would hold with a hook that sets only a group's summary text.
const TOOL = 'mcp__plugin_via_step__step'
type Call = RenderPropsOf['ToolGroup']['calls'][number]
type Frame = { calls: Call[]; isActive: boolean; other?: true }

const call = (n: number, over: Partial<Call> = {}): Call => ({
  tool_use_id: `toolu_step_t1_${n}`,
  tool: TOOL,
  input: { kind: 'execute', title: `echo ${n}` },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...over,
})

// Calls arrive one by one, each running then done, while the group is live; then the group is history.
function life(n: number, change: (frame: Frame, at: number) => Frame = (f) => f): Frame[] {
  const frames: Frame[] = []
  for (let i = 1; i <= n; i += 1) {
    const done = Array.from({ length: i - 1 }, (_, k) => call(k + 1))
    frames.push(change({ calls: [...done, call(i, { isRunning: true })], isActive: true }, frames.length))
    frames.push(change({ calls: [...done, call(i)], isActive: true }, frames.length))
  }
  const last = frames.at(-1) as Frame
  frames.push(change({ ...last, isActive: false }, frames.length))
  return frames
}
const from = (start: number, edit: (frame: Frame) => Frame) => (frame: Frame, at: number) => (at >= start ? edit(frame) : frame)
const fail = (n: number) => (f: Frame) => ({
  ...f,
  calls: f.calls.map((c, i) => (i === n - 1 ? { ...c, isRunning: false, isErrored: true } : c)),
})
const stop = (n: number) => (f: Frame) => ({
  ...f,
  calls: f.calls.map((c, i) => (i === n - 1 ? { ...c, isRunning: false, isInterrupted: true } : c)),
})
const other = (f: Frame): Frame => ({ ...f, other: true })

const LIVES: Record<string, Frame[]> = {
  'three clean commands': life(3),
  'a command fails mid-run': life(3, from(3, fail(2))),
  'a command is interrupted': life(3, from(3, stop(2))),
  'a hook timing row joins': life(3, from(3, other)),
  'a hook timing row joins, then a command fails': life(3, (f, at) => (at >= 2 ? other(at >= 4 ? fail(1)(f) : f) : f)),
  'a command fails and a hook timing row joins': life(
    3,
    from(3, (f) => other(fail(2)(f))),
  ),
}

// What the props can't avoid: A, where another row joins a group via already drew; B, where it joins one with a
// failed call.
const ACCEPTED = [
  'A: a hook timing row joins: drawers went via → via → via → claude → claude → claude → claude',
  'A: a hook timing row joins, then a command fails: drawers went via → via → claude → claude → claude → claude → claude',
  ...[3, 4, 5, 6].map((i) => `B: a command fails and a hook timing row joins, frame ${i}: via drew over a row it can't see`),
]

const NATIVE = 'drawn by Claude Code'
test('a group of via steps keeps one drawer for its life (A) and never hides a row only Claude Code knows of (B)', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', children: [NATIVE] }))
  const broken: string[] = []
  for (const [name, frames] of Object.entries(LIVES)) {
    const drawers: string[] = []
    for (const [i, frame] of frames.entries()) {
      const failed = frame.calls.some((c) => c.isErrored || c.isInterrupted)
      // Each life is its own group, as Claude Code tells them apart: by their calls' ids.
      const calls = frame.calls.map((c) => ({ ...c, tool_use_id: `${name}: ${c.tool_use_id}` }))
      const props = { calls, isActive: frame.isActive, isExpanded: false, isCallsOnly: !frame.other && !failed }
      const drawn = await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: `${name}-${i}`, props })
      const drawer = JSON.stringify(drawn).includes(NATIVE) ? 'claude' : 'via'
      if (frame.other && drawer === 'via') broken.push(`B: ${name}, frame ${i}: via drew over a row it can't see`)
      drawers.push(drawer)
    }
    if (new Set(drawers).size > 1) broken.push(`A: ${name}: drawers went ${drawers.join(' → ')}`)
  }
  expect(broken).toEqual(ACCEPTED)
})
