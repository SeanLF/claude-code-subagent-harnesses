import type { RenderElement, RenderNode, RenderPropsOf } from 'claude-code'
import { unhidden } from './text'

export const NO_OUTPUT = 'Done; no output reported.'

const FOLDED: Record<string, number> = { edit: 12, plan: 12, message: 12, compact: 1 }
const VERBS: Record<string, [string, string]> = {
  execute: ['Running', 'Ran'],
  compact: ['Compacting', 'Compacted'],
  question: ['Asking', 'Asked'],
}

function outputLine(line: string, first: boolean, diff: boolean): RenderElement {
  const lead = first ? '  ⎿  ' : '     '
  const color = diff && line.startsWith('+ ') ? 'diffAdded' : diff && line.startsWith('- ') ? 'diffRemoved' : undefined
  return color
    ? {
        type: 'Text',
        children: [
          { type: 'Text', props: { dimColor: true }, children: [lead] },
          { type: 'Text', props: { color }, children: [line] },
        ],
      }
    : { type: 'Text', props: { dimColor: true }, children: [`${lead}${line}`] }
}

const COUNTED: Record<string, [string, string, string, string]> = {
  read: ['Reading', 'Read', 'file', 'files'],
  search: ['Searching', 'Searched', 'pattern', 'patterns'],
  execute: ['Running', 'Ran', 'command', 'commands'],
  edit: ['Editing', 'Edited', 'file', 'files'],
  delete: ['Deleting', 'Deleted', 'file', 'files'],
  move: ['Moving', 'Moved', 'file', 'files'],
  fetch: ['Fetching', 'Fetched', 'page', 'pages'],
  question: ['Asking', 'Asked', 'question', 'questions'],
  message: ['Receiving', 'Received', 'message', 'messages'],
  wait: ['Waiting on', 'Waited on', 'step', 'steps'],
}

function titleOf(input: unknown): string {
  const title = (input as { title?: unknown } | null)?.title
  return typeof title === 'string' ? unhidden(title).replace(/\s+/g, ' ') : ''
}

export function drawGroup(props: RenderPropsOf['ToolGroup']): RenderElement {
  const kindOf = (call: (typeof props.calls)[number]) => (call.input as { kind?: unknown } | null)?.kind
  const counted = props.calls.some((call) => kindOf(call) !== 'wait') ? props.calls.filter((call) => kindOf(call) !== 'wait') : props.calls
  const counts = new Map<string, number>()
  for (const call of counted) {
    const kind = kindOf(call)
    const known = typeof kind === 'string' && Object.hasOwn(COUNTED, kind) ? kind : 'other'
    counts.set(known, (counts.get(known) ?? 0) + 1)
  }
  const parts = [...counts].flatMap(([kind, n], i): RenderNode[] => {
    const [live, done, one, many] = COUNTED[kind] ?? ['', '', 'other step', 'other steps']
    const verb = props.isActive ? live : done
    const lead = i === 0 ? verb : verb.toLowerCase()
    const said: RenderNode[] = [{ type: 'Text', props: { bold: true }, children: [String(n)] }, ` ${n === 1 ? one : many}`]
    return [...(i === 0 ? [] : [', ']), ...(lead ? [`${lead} `] : []), ...said]
  })
  const failed = props.calls.filter((call) => call.isErrored && !call.isInterrupted).length
  const stopped = props.calls.filter((call) => call.isInterrupted).length
  const current = props.isActive ? (props.calls.findLast((call) => call.isRunning) ?? props.calls.at(-1)) : undefined
  const title = current ? titleOf(current.input) : ''
  return {
    type: 'Box',
    props: { key: 'via-group', marginTop: 1, paddingLeft: 2 },
    children: [
      {
        type: 'Text',
        props: { dimColor: true, wrap: 'truncate-end' },
        hover: { dimColor: false },
        children: [
          ...parts,
          ...(failed > 0 ? [`, ${failed} failed`] : []),
          ...(stopped > 0 ? [`, ${stopped} interrupted`] : []),
          ...(props.isActive ? ['…'] : []),
          ...(title ? [` · ${title}`] : []),
        ],
      },
    ],
  }
}

export function drawCall(props: RenderPropsOf['ToolUse']): RenderElement {
  const input = (typeof props.input === 'object' && props.input !== null ? props.input : {}) as {
    kind?: unknown
    title?: unknown
    path?: unknown
  }
  const kind = typeof input.kind === 'string' ? input.kind : 'other'
  const title = titleOf(input)
  const path = typeof input.path === 'string' ? unhidden(input.path) : ''
  const [running, done] = VERBS[kind] ?? ['', '']
  const verb = props.isInterrupted ? 'Interrupted' : props.isErrored ? 'Failed' : props.isRunning ? running : done
  const said = typeof props.output === 'string' ? unhidden(props.output).trim() : ''
  const output = said === NO_OUTPUT ? '' : said
  const lines = output ? output.split('\n') : []
  const shown = props.isExpanded ? lines : lines.slice(0, FOLDED[kind] ?? 3)
  const more = lines.length - shown.length
  const diff = kind === 'edit'
  const named: RenderNode = path.startsWith('/')
    ? { type: 'Link', props: { href: `file://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}` }, children: [title] }
    : title
  return {
    type: 'Box',
    props: { flexDirection: 'column' },
    children: [
      {
        type: 'Text',
        children: verb
          ? [{ type: 'Text', props: { bold: true }, children: [verb] }, ' ', named]
          : [{ type: 'Text', props: { bold: true }, children: [named] }, ...(props.isRunning ? ['…'] : [])],
      },
      ...shown.map((line, i) => outputLine(line, i === 0, diff)),
      ...(more > 0
        ? [
            {
              type: 'Text' as const,
              props: { dimColor: true },
              children: [`     … ${more} more ${more === 1 ? 'line' : 'lines'} (ctrl+o to expand)`],
            },
          ]
        : []),
    ],
  }
}
