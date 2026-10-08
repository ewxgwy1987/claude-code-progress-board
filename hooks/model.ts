import type { Activity, AgentItem, CallItem, Durations, Goal, TaskItem, WorkflowAgent, WorkflowItem } from '../types'

export type BoardSnapshot = {
  v: 1
  savedAt: number
  writer?: string
  tasks: TaskItem[]
  agents: AgentItem[]
  workflows: WorkflowItem[]
  activity: Activity | null
  goal: Goal | null
}

export const KEEP = 30
export const KEEP_FINISHED = 15
export const WORKFLOW_AGENT = 'workflow agent'

export const median = (xs: readonly number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

export const remember = (xs: readonly number[], ms: number) => (ms > 0 ? [...xs, ms].slice(-KEEP) : [...xs])

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const fmtStamp = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const bar = (pct: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(width - filled) }
}

const SVG_W = 140
const SVG_H = 10

export const BAR_HEX: Record<string, string> = {
  green: '#3aa55d',
  cyan: '#1a9fd6',
  yellow: '#e2b21c',
  red: '#d9534f',
  gray: '#9a9a9a',
}

export const svgBar = (pct: number, color: string | undefined) => {
  const w = Math.round((Math.min(100, Math.max(0, pct)) / 100) * SVG_W)
  const fill = BAR_HEX[color ?? 'gray'] ?? BAR_HEX.gray
  const done = w > 0 ? `<rect width="${w}" height="${SVG_H}" rx="3" fill="${fill}"/>` : ''
  return {
    width: SVG_W,
    height: SVG_H,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}"><rect width="${SVG_W}" height="${SVG_H}" rx="3" fill="#8a8a8a" fill-opacity="0.25"/>${done}</svg>`,
  }
}

const etaNote = (open: readonly Progress[], remainingMs: number | null) =>
  open.length === 0
    ? ''
    : open.some(r => r.tone === 'late')
      ? ' · running over estimate'
      : remainingMs === null
        ? ' · no estimate yet'
        : ` · ~${fmtDur(remainingMs)} left`

export const collapse = <T>(
  items: readonly T[],
  isOpen: (x: T) => boolean,
  recency: (x: T) => number,
  keep = KEEP_FINISHED,
) => {
  const finished = items.filter(x => !isOpen(x)).sort((a, b) => recency(b) - recency(a))
  const shown = [...items.filter(isOpen), ...finished.slice(0, keep)].sort((a, b) => recency(b) - recency(a))
  return { shown, hidden: Math.max(0, finished.length - keep) }
}

export type Tone = 'done' | 'running' | 'late' | 'waiting' | 'failed'

export type Progress = {
  pct: number
  tone: Tone
  note: string
  remainingMs: number | null
}

const running = (elapsed: number, estimate: number | null): Progress => {
  if (estimate === null) return { pct: 0, tone: 'running', note: `${fmtDur(elapsed)} elapsed · no estimate yet`, remainingMs: null }
  if (elapsed > estimate)
    return { pct: 99, tone: 'late', note: `${fmtDur(elapsed)} elapsed · over estimate by ${fmtDur(elapsed - estimate)}`, remainingMs: 0 }
  const pct = Math.min(95, (elapsed / estimate) * 100)
  return { pct, tone: 'running', note: `~${fmtDur(estimate - elapsed)} left`, remainingMs: estimate - elapsed }
}

export const activeMs = (t: TaskItem, now: number) => {
  const end = t.doneAt ?? now
  const paused = (t.pausedMs ?? 0) + (t.pausedAt !== undefined ? Math.max(0, end - t.pausedAt) : 0)
  return Math.max(0, end - (t.startedAt ?? t.createdAt) - paused)
}

export const taskTime = (t: TaskItem) => t.updatedAt ?? t.doneAt ?? t.startedAt ?? t.createdAt
export const isTaskOpen = (t: TaskItem) => t.status !== 'completed'

export const taskProgress = (t: TaskItem, all: readonly TaskItem[], estimate: number | null, now: number): Progress => {
  if (t.status === 'completed') {
    const took = t.doneAt !== undefined && t.startedAt !== undefined ? ` · took ${fmtDur(activeMs(t, now))}` : ''
    return { pct: 100, tone: 'done', note: `done${took}`, remainingMs: 0 }
  }
  if (t.status === 'in_progress') {
    const work = activeMs(t, now)
    const p = running(work, estimate)
    if (t.pausedAt === undefined) return p
    const over = p.tone === 'late' ? ' · over estimate' : ''
    return { pct: Math.min(95, p.pct), tone: 'waiting', note: `paused · waiting for you · ${fmtDur(work)} of work${over}`, remainingMs: p.remainingMs }
  }
  const blockers = t.blockedBy.filter(id => {
    const o = all.find(x => x.id === id)
    return o !== undefined && o.status !== 'completed'
  })
  return {
    pct: 0,
    tone: 'waiting',
    note: blockers.length ? `blocked by ${blockers.map(id => `#${id}`).join(', ')}` : 'pending',
    remainingMs: estimate,
  }
}

const AGENT_DONE = new Set(['completed'])
const AGENT_FAILED = new Set(['failed', 'killed', 'interrupted'])
const AGENT_PAUSED = new Set(['idle', 'waiting', 'pending'])

export const isAgentUnfinished = (a: { status: string }) => !AGENT_DONE.has(a.status)
export const isAgentActive = (a: { status: string }) => !AGENT_DONE.has(a.status) && !AGENT_FAILED.has(a.status)
export const agentTime = (a: { startedAt: number; doneAt?: number }) => a.doneAt ?? a.startedAt

export const agentProgress = (a: AgentItem, estimate: number | null, now: number): Progress => {
  const end = a.doneAt ?? now
  if (AGENT_DONE.has(a.status)) return { pct: 100, tone: 'done', note: `done · took ${fmtDur(end - a.startedAt)}`, remainingMs: 0 }
  if (AGENT_FAILED.has(a.status)) return { pct: 100, tone: 'failed', note: `${a.status} after ${fmtDur(end - a.startedAt)}`, remainingMs: 0 }
  const p = running(now - a.startedAt, estimate)
  return AGENT_PAUSED.has(a.status) ? { ...p, tone: 'waiting', note: `${a.status} · ${p.note}` } : p
}

export const agentEstimate = (d: Durations, type: string) => median(d.agent[type] ?? []) ?? median(Object.values(d.agent).flat())

export type Summary = { done: number; total: number; pct: number; remainingMs: number | null; note: string }

export const taskSummary = (tasks: readonly TaskItem[], d: Durations, now: number): Summary => {
  const estimate = median(d.task)
  const rows = tasks.map(t => taskProgress(t, tasks, estimate, now))
  const done = tasks.filter(t => t.status === 'completed').length
  const pct = tasks.length ? rows.reduce((s, r) => s + r.pct, 0) / tasks.length : 0
  const open = rows.filter(r => r.tone !== 'done')
  const remainingMs = open.length === 0 ? 0 : open.some(r => r.remainingMs === null) ? null : open.reduce((s, r) => s + (r.remainingMs ?? 0), 0)
  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const isPaused = inProgress.length > 0 && inProgress.every(t => t.pausedAt !== undefined)
  const note =
    tasks.length === 0
      ? 'no tasks yet'
      : open.length === 0
        ? 'all done'
        : isPaused
          ? 'paused · waiting for you'
          : etaNote(open, remainingMs).slice(3)
  return { done, total: tasks.length, pct, remainingMs, note }
}

export const agentSummary = (agents: readonly AgentItem[], d: Durations, now: number): Summary => {
  const rows = agents.map(a => agentProgress(a, agentEstimate(d, a.type), now))
  const done = agents.filter(a => !isAgentActive(a)).length
  const pct = agents.length ? rows.reduce((s, r) => s + r.pct, 0) / agents.length : 0
  const open = rows.filter(r => r.tone !== 'done' && r.tone !== 'failed')
  const remainingMs = open.length === 0 ? 0 : open.some(r => r.remainingMs === null) ? null : Math.max(...open.map(r => r.remainingMs ?? 0))
  const failed = rows.filter(r => r.tone === 'failed').length
  const counts = agents.length
    ? `${open.length} running · ${done - failed} done${failed ? ` · ${failed} failed` : ''}`
    : 'no subagents yet'
  return { done, total: agents.length, pct, remainingMs, note: counts + etaNote(open, remainingMs) }
}

export const EMPTY_DURATIONS: Durations = { task: [], agent: {}, tool: {}, turn: [], workflow: {} }

export const normalizeDurations = (raw: unknown): Durations => {
  const d = (raw ?? {}) as Partial<Durations>
  return {
    task: Array.isArray(d.task) ? d.task : [],
    agent: d.agent && typeof d.agent === 'object' ? d.agent : {},
    tool: d.tool && typeof d.tool === 'object' ? d.tool : {},
    turn: Array.isArray(d.turn) ? d.turn : [],
    workflow: d.workflow && typeof d.workflow === 'object' ? d.workflow : {},
  }
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const toolName = (tool: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1]}:${m[2]}` : tool
}

export const describeCall = (tool: string, input: Record<string, unknown>) => {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).replace(/\s+/g, ' ').trim() : undefined)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  const detail =
    tool === 'Bash' || tool === 'PowerShell'
      ? (str('description') ?? str('command'))
      : tool === 'Grep' || tool === 'Glob'
        ? str('pattern')
        : tool === 'Agent'
          ? str('description')
          : tool === 'WebFetch'
            ? str('url')
            : tool === 'WebSearch'
              ? str('query')
              : tool === 'Skill'
                ? str('skill')
                : path
                  ? baseName(path)
                  : (str('description') ?? str('title') ?? str('name'))
  return detail ? `${toolName(tool)} · ${detail}` : toolName(tool)
}

export const callTime = (c: CallItem) => c.doneAt ?? c.startedAt
export const isCallOpen = (c: CallItem) => c.status === 'running'
export const isCallUnfinished = (c: CallItem) => c.status !== 'done'

export const callProgress = (c: CallItem, d: Durations, now: number): Progress => {
  const took = (c.doneAt ?? now) - c.startedAt
  if (c.status === 'done') return { pct: 100, tone: 'done', note: `took ${fmtDur(took)}`, remainingMs: 0 }
  if (c.status === 'failed') return { pct: 100, tone: 'failed', note: `failed after ${fmtDur(took)}`, remainingMs: 0 }
  return running(took, median(d.tool[c.tool] ?? []))
}

export const activitySummary = (a: Activity, d: Durations, now: number): Summary => {
  const done = a.calls.filter(c => c.status !== 'running').length + (a.total - a.calls.length)
  const failed = a.calls.filter(c => c.status === 'failed').length
  const calls = a.total ? `${a.total} tool call${a.total === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}` : 'no tool calls'
  if (!a.isRunning) {
    const took = (a.endedAt ?? now) - a.startedAt
    return { done: a.total, total: a.total, pct: a.total ? 100 : 0, remainingMs: 0, note: `last turn · ${calls} · took ${fmtDur(took)}` }
  }
  const p = running(now - a.startedAt, median(d.turn))
  return { done, total: a.total, pct: p.pct, remainingMs: p.remainingMs, note: `${calls} · ${p.note}` }
}

export type TaskNotice = { taskId: string; toolUseId?: string; status?: string; durationMs?: number }

const tag = (text: string, name: string) => {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(text)
  return m?.[1] || undefined
}

export const parseTaskNotice = (text: string): TaskNotice | null => {
  if (!text.includes('<task-notification>')) return null
  const taskId = tag(text, 'task-id')
  if (!taskId) return null
  const ms = Number(tag(text, 'duration_ms'))
  return {
    taskId,
    toolUseId: tag(text, 'tool-use-id'),
    status: tag(text, 'status'),
    durationMs: Number.isFinite(ms) && ms > 0 ? ms : undefined,
  }
}

export const isWorkflowActive = (w: { status: string }) => w.status === 'running'
export const isWorkflowUnfinished = (w: { status: string }) => w.status !== 'completed'
export const workflowTime = (w: WorkflowItem) => w.doneAt ?? w.startedAt

export const normalizeWorkflow = (w: WorkflowItem): WorkflowItem => {
  if (Array.isArray(w.agents) && typeof w.tools === 'number') return w
  const legacy = (w as { agentIds?: unknown }).agentIds
  return {
    ...w,
    agents: Array.isArray(w.agents) ? w.agents : [],
    agentCount: Array.isArray(legacy) ? legacy.length : w.agentCount,
    tools: w.tools || 0,
  }
}

export const endStatus = (s: string | undefined) => (s === undefined || s === 'completed' ? 'completed' : s === 'failed' ? 'failed' : 'killed')

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const workflowDetail = (w: WorkflowItem) => {
  const agents = w.agents.length || w.agentCount || 0
  return `${agents ? ` · ${plural(agents, 'agent')}` : ''}${w.tools ? ` · ${plural(w.tools, 'tool call')}` : ''}`
}

export const workflowEstimate = (d: Durations, name: string) => median(d.workflow[name] ?? []) ?? median(Object.values(d.workflow).flat())

export const workflowProgress = (w: WorkflowItem, d: Durations, now: number): Progress => {
  const took = (w.doneAt ?? now) - w.startedAt
  if (w.status === 'completed') return { pct: 100, tone: 'done', note: `done · took ${fmtDur(took)}${workflowDetail(w)}`, remainingMs: 0 }
  if (!isWorkflowActive(w)) return { pct: 100, tone: 'failed', note: `${w.status} after ${fmtDur(took)}${workflowDetail(w)}`, remainingMs: 0 }
  const p = running(took, workflowEstimate(d, w.name))
  const finished = w.agents.filter(a => !isAgentActive(a)).length
  const live = w.agents.length ? ` · agents ${finished}/${w.agents.length} done` : ''
  const last = w.lastTool ? ` · ${w.lastTool}` : ''
  return { ...p, note: `${p.note}${live}${w.tools ? ` · ${plural(w.tools, 'tool call')}` : ''}${last}` }
}

export const workflowAgentProgress = (a: WorkflowAgent, d: Durations, now: number): Progress => {
  const end = a.doneAt ?? now
  const tools = a.tools ? ` · ${plural(a.tools, 'tool call')}` : ''
  if (AGENT_DONE.has(a.status)) return { pct: 100, tone: 'done', note: `done · took ${fmtDur(end - a.startedAt)}${tools}`, remainingMs: 0 }
  if (AGENT_FAILED.has(a.status)) return { pct: 100, tone: 'failed', note: `${a.status} after ${fmtDur(end - a.startedAt)}${tools}`, remainingMs: 0 }
  const p = running(now - a.startedAt, median(d.agent[WORKFLOW_AGENT] ?? []))
  return { ...p, note: `${p.note}${tools}${a.lastTool ? ` · ${a.lastTool}` : ''}` }
}

export const workflowSummary = (ws: readonly WorkflowItem[], d: Durations, now: number): Summary => {
  const rows = ws.map(w => workflowProgress(w, d, now))
  const open = rows.filter(r => r.tone !== 'done' && r.tone !== 'failed')
  const done = ws.length - open.length
  const pct = ws.length ? rows.reduce((s, r) => s + r.pct, 0) / ws.length : 0
  const remainingMs = open.length === 0 ? 0 : open.some(r => r.remainingMs === null) ? null : Math.max(...open.map(r => r.remainingMs ?? 0))
  return { done, total: ws.length, pct, remainingMs, note: `${open.length} running · ${done} finished${etaNote(open, remainingMs)}` }
}

export const goalProgress = (g: Goal, tasks: readonly TaskItem[], d: Durations, now: number): Progress => {
  const since = fmtDur((g.endedAt ?? now) - g.setAt)
  const who = g.setBy === 'you' ? 'set by you' : 'set by Claude'
  if (g.status === 'declined') return { pct: 0, tone: 'failed', note: 'declined', remainingMs: null }
  if (g.status === 'cleared') return { pct: 0, tone: 'waiting', note: `cleared after ${since}`, remainingMs: null }
  const turns = plural(g.turns, 'turn')
  if (tasks.length === 0) return { pct: 0, tone: 'running', note: `active · ${who} · ${turns} · ${since}`, remainingMs: null }
  const plan = taskSummary(tasks, d, now)
  return {
    pct: plan.pct,
    tone: 'running',
    note: `active · plan ${plan.done}/${plan.total} · ${turns} · ${since}`,
    remainingMs: plan.remainingMs,
  }
}

export const restoreBoard = (raw: unknown, liveAgentIds: ReadonlySet<string>, isOtherWindowAlive = false): BoardSnapshot | null => {
  const s = raw as Partial<BoardSnapshot> | null
  if (!s || s.v !== 1 || typeof s.savedAt !== 'number') return null
  if (isOtherWindowAlive) {
    return { v: 1, savedAt: s.savedAt, tasks: s.tasks ?? [], agents: s.agents ?? [], workflows: (s.workflows ?? []).map(normalizeWorkflow), activity: s.activity ?? null, goal: s.goal ?? null }
  }
  const at = s.savedAt
  const stop = <A extends { status: string; doneAt?: number }>(a: A): A =>
    isAgentActive(a) ? { ...a, status: 'interrupted', doneAt: a.doneAt ?? at } : a
  return {
    v: 1,
    savedAt: at,
    tasks: (s.tasks ?? []).map(t => (t.status === 'in_progress' && t.pausedAt === undefined ? { ...t, pausedAt: at } : t)),
    agents: (s.agents ?? []).map(a => (liveAgentIds.has(a.id) ? a : stop(a))),
    workflows: (s.workflows ?? []).map(normalizeWorkflow).map(w =>
      isWorkflowActive(w) ? { ...w, status: 'interrupted', doneAt: w.doneAt ?? at, isForced: true, agents: w.agents.map(stop) } : w,
    ),
    activity: s.activity ? { ...s.activity, isRunning: false, endedAt: s.activity.endedAt ?? at } : null,
    goal: s.goal ?? null,
  }
}

export const WORKFLOW_SUBAGENT = 'workflow-subagent'

export const adoptWorkflowSubagents = (agents: readonly AgentItem[], workflows: readonly WorkflowItem[]) => {
  const ws = workflows.map(w => ({ ...w, agents: [...w.agents] }))
  const kept: AgentItem[] = []
  for (const a of agents) {
    const owner =
      a.type === WORKFLOW_SUBAGENT
        ? ws.filter(w => w.startedAt <= a.startedAt + 10_000).sort((x, y) => y.startedAt - x.startedAt)[0]
        : undefined
    if (!owner) {
      kept.push(a)
      continue
    }
    if (owner.agents.some(c => c.id === a.id)) continue
    owner.agents.push({
      id: a.id,
      n: Math.max(0, ...owner.agents.map(c => c.n)) + 1,
      status: a.status,
      startedAt: a.startedAt,
      doneAt: a.doneAt,
      tools: a.tools,
      lastTool: a.lastTool,
      label: a.description || undefined,
    })
    owner.tools += a.tools
  }
  return { agents: kept, workflows: ws, moved: agents.length - kept.length }
}

export type BoardBody = Omit<BoardSnapshot, 'v' | 'savedAt'>

const isDoneStatus = (s: string) => s === 'completed' || s === 'done'

const newer = <T>(a: T, b: T, rank: (x: T) => [number, number]) => {
  const [ra, ta] = rank(a)
  const [rb, tb] = rank(b)
  return rb > ra || (rb === ra && tb > ta) ? b : a
}

const mergeBy = <T>(mine: readonly T[], theirs: readonly T[], key: (x: T) => string, rank: (x: T) => [number, number]) => {
  const out = new Map<string, T>()
  for (const x of mine) out.set(key(x), x)
  for (const x of theirs) {
    const k = key(x)
    const have = out.get(k)
    out.set(k, have === undefined ? x : newer(have, x, rank))
  }
  return [...out.values()]
}

const taskRank = (t: TaskItem): [number, number] => [t.status === 'completed' ? 2 : t.status === 'in_progress' ? 1 : 0, taskTime(t)]
const agentRank = (a: { status: string; startedAt: number; doneAt?: number; tools: number }): [number, number] => [
  isAgentActive(a) ? 0 : 1,
  (a.doneAt ?? a.startedAt) + a.tools,
]

export const mergeBoards = (mine: BoardBody, theirs: BoardBody): BoardBody => ({
  tasks: mergeBy(mine.tasks, theirs.tasks, t => t.id, taskRank),
  agents: mergeBy(mine.agents, theirs.agents, a => a.id, agentRank),
  workflows: mergeBy(
    mine.workflows.map(normalizeWorkflow),
    theirs.workflows.map(normalizeWorkflow),
    w => w.taskId,
    w => [isWorkflowActive(w) ? 0 : 1, (w.doneAt ?? w.startedAt) + w.tools],
  ).map(w => {
    const other = [...mine.workflows, ...theirs.workflows].map(normalizeWorkflow).filter(x => x.taskId === w.taskId)
    const agents = other.reduce<WorkflowAgent[]>((acc, x) => mergeBy(acc, x.agents, a => a.id, agentRank), [])
    return { ...w, agents, tools: Math.max(w.tools, ...other.map(x => x.tools)) }
  }),
  activity:
    mine.activity && theirs.activity
      ? theirs.activity.startedAt > mine.activity.startedAt ||
        (theirs.activity.startedAt === mine.activity.startedAt && theirs.activity.total > mine.activity.total)
        ? theirs.activity
        : mine.activity
      : (mine.activity ?? theirs.activity),
  goal:
    mine.goal && theirs.goal
      ? theirs.goal.setAt > mine.goal.setAt || (theirs.goal.setAt === mine.goal.setAt && (theirs.goal.endedAt ?? 0) > (mine.goal.endedAt ?? 0))
        ? theirs.goal
        : mine.goal
      : (mine.goal ?? theirs.goal),
})

export const stableBody = (b: BoardBody) =>
  JSON.stringify({
    tasks: [...b.tasks].sort((x, y) => x.id.localeCompare(y.id)),
    agents: [...b.agents].sort((x, y) => x.id.localeCompare(y.id)),
    workflows: [...b.workflows].sort((x, y) => x.taskId.localeCompare(y.taskId)),
    activity: b.activity,
    goal: b.goal,
  })

export const isDoneItem = isDoneStatus
