import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, AgentItem, CallItem, CallStatus, Durations, Goal, TaskItem, TaskStatus, WorkflowItem } from '../types'
import {
  activeMs,
  adoptWorkflowSubagents,
  activitySummary,
  agentEstimate,
  agentProgress,
  agentSummary,
  agentTime,
  bar,
  callProgress,
  callTime,
  collapse,
  describeCall,
  EMPTY_DURATIONS,
  endStatus,
  fmtDur,
  fmtStamp,
  goalProgress,
  isAgentActive,
  isAgentUnfinished,
  isCallUnfinished,
  isCallOpen,
  isTaskOpen,
  isWorkflowActive,
  isWorkflowUnfinished,
  median,
  mergeBoards,
  normalizeDurations,
  normalizeWorkflow,
  parseTaskNotice,
  remember,
  restoreBoard,
  stableBody,
  svgBar,
  taskProgress,
  taskSummary,
  taskTime,
  WORKFLOW_AGENT,
  WORKFLOW_SUBAGENT,
  workflowAgentProgress,
  workflowProgress,
  workflowSummary,
  workflowTime,
} from './model'
import type { BoardBody, BoardSnapshot, Progress, Summary, Tone } from './model'
import { resolveAgentTitle } from './titles'
import type { TitleIO } from './titles'

const PANE = 'progress-board'
const STORE_KEY = 'durations'
const TICK_MS = 2000
const MAX_CALLS = 50
const TASKS_TOOL = 'tasks'
const TASKS_TOOL_FULL = 'mcp__progress-board__tasks'
const BOARD_INDEX = 'boards'
const KEEP_BOARDS = 20
const SAVE_MS = 3000
const boardKey = (sessionId: string) => `board:${sessionId}`
const STAMP_W = 15
const ICON_W = 2
const PCT_W = 6

const tasksAtom = atom({ plugin: 'progress-board', key: 'tasks' } as const, [])
const agentsAtom = atom({ plugin: 'progress-board', key: 'agents' } as const, [])
const durationsAtom = atom({ plugin: 'progress-board', key: 'durations' } as const, EMPTY_DURATIONS)
const activityAtom = atom({ plugin: 'progress-board', key: 'activity' } as const, null)
const workflowsAtom = atom({ plugin: 'progress-board', key: 'workflows' } as const, [])
const goalAtom = atom({ plugin: 'progress-board', key: 'goal' } as const, null)
const nowAtom = atom({ plugin: 'progress-board', key: 'now' } as const, 0)
const openedAtom = atom({ plugin: 'progress-board', key: 'isOpened' } as const, false)
const wrapAtom = atom({ plugin: 'progress-board', key: 'isWrapped' } as const, null)

type $ = EngineInterface

const TONE_COLOR: Record<Tone, string | undefined> = {
  done: 'green',
  running: 'cyan',
  late: 'yellow',
  waiting: undefined,
  failed: 'red',
}

const TONE_ICON: Record<Tone, string> = { done: '✓', running: '▶', late: '▶', waiting: '○', failed: '✗' }

const readDurations = async ($: $) => normalizeDurations(await read($, durationsAtom))
const readWorkflows = async ($: $) => (await read($, workflowsAtom)).map(normalizeWorkflow)

const saveDurations = async ($: $, change: (d: Durations) => Durations) => {
  const next = await update($, durationsAtom, d => change(normalizeDurations(d)))
  await $.store.set(STORE_KEY, next)
}

const openPane = async ($: $, asked: boolean) => {
  if (!asked && (await read($, openedAtom))) return
  await update($, openedAtom, () => true)
  void $.ui.open({ id: PANE, title: 'Progress' })
}

const applyTaskStatus = (task: TaskItem, status: TaskStatus, now: number): TaskItem => {
  if (task.status === status && task.updatedAt !== undefined) return task
  const t: TaskItem =
    task.status === 'completed' && status !== 'completed'
      ? { ...task, pausedAt: undefined, pausedMs: 0 }
      : task.pausedAt !== undefined
        ? { ...task, pausedAt: undefined, pausedMs: (task.pausedMs ?? 0) + Math.max(0, now - task.pausedAt) }
        : task
  return {
    ...t,
    status,
    startedAt:
      t.status === 'completed' && status !== 'completed'
        ? status === 'in_progress' ? now : undefined
        : status === 'in_progress' ? (t.startedAt ?? now) : t.startedAt,
    doneAt: status === 'completed' ? (t.doneAt ?? now) : undefined,
    updatedAt: now,
  }
}

const finishedDurations = (before: readonly TaskItem[], after: readonly TaskItem[]) =>
  after.flatMap(t => {
    const was = before.find(b => b.id === t.id)
    return t.status === 'completed' && was?.status !== 'completed' && t.doneAt !== undefined && t.startedAt !== undefined
      ? [activeMs(t, t.doneAt)]
      : []
  })

const setTasks = async ($: $, change: (tasks: TaskItem[]) => TaskItem[]) => {
  let took: number[] = []
  await update($, tasksAtom, before => {
    const after = change(before)
    took = finishedDurations(before, after)
    return after
  })
  if (took.length) await saveDurations($, d => ({ ...d, task: took.reduce(remember, d.task) }))
}

type ListedTask = { subject: string; status: TaskStatus; activeForm?: string }

const applyTaskList = async ($: $, items: readonly ListedTask[]) => {
  const now = await $.clock.now()
  await setTasks($, tasks =>
    items.map((item, i) => {
      const was = tasks.find(t => t.subject === item.subject)
      const base: TaskItem = was ?? { id: '', subject: item.subject, status: 'pending', createdAt: now, blockedBy: [] }
      return applyTaskStatus({ ...base, id: String(i + 1), activeForm: item.activeForm }, item.status, now)
    }),
  )
  await openPane($, false)
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

const parseTaskList = (raw: unknown): ListedTask[] | null => {
  const list = (raw as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(list)) return null
  const items = list.flatMap(x => {
    const o = (x ?? {}) as Record<string, unknown>
    const subject = typeof o.subject === 'string' ? o.subject.trim() : ''
    const status = typeof o.status === 'string' && STATUSES.includes(o.status) ? (o.status as TaskStatus) : null
    if (!subject || !status) return []
    return [{ subject, status, activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined }]
  })
  return items.length === list.length ? items : null
}

const setAgents = async ($: $, change: (agents: AgentItem[]) => AgentItem[]) => {
  let finished: AgentItem[] = []
  await update($, agentsAtom, before => {
    const after = change(before)
    finished = after.filter(
      a => a.status === 'completed' && !a.isSeeded && a.doneAt !== undefined && before.some(b => b.id === a.id && isAgentActive(b)),
    )
    return after
  })
  if (finished.length)
    await saveDurations($, d => {
      const agent = { ...d.agent }
      for (const a of finished) agent[a.type] = remember(agent[a.type] ?? [], (a.doneAt ?? 0) - a.startedAt)
      return { ...d, agent }
    })
}

const setWorkflows = async ($: $, change: (ws: WorkflowItem[]) => WorkflowItem[]) => {
  let runs: number[] = []
  let workflow: Record<string, number> = {}
  await update($, workflowsAtom, raw => {
    const before = raw.map(normalizeWorkflow)
    const after = change(before)
    runs = []
    workflow = {}
    for (const w of after) {
      const was = before.find(b => b.taskId === w.taskId)
      const isNew = w.status === 'completed' && !w.isForced && w.doneAt !== undefined && was !== undefined && isWorkflowActive(was)
      if (isNew) workflow[w.name] = (w.doneAt ?? 0) - w.startedAt
      for (const a of w.agents) {
        const prev = was?.agents.find(x => x.id === a.id)
        if (a.status === 'completed' && !a.isForced && a.doneAt !== undefined && prev && isAgentActive(prev)) runs.push(a.doneAt - a.startedAt)
      }
    }
    return after
  })
  if (runs.length || Object.keys(workflow).length)
    await saveDurations($, d => {
      const byName = { ...d.workflow }
      for (const [name, ms] of Object.entries(workflow)) byName[name] = remember(byName[name] ?? [], ms)
      return { ...d, workflow: byName, agent: { ...d.agent, [WORKFLOW_AGENT]: runs.reduce(remember, d.agent[WORKFLOW_AGENT] ?? []) } }
    })
}

const isKnownSubagent = async ($: $, id: string) => (await read($, agentsAtom)).some(a => a.id === id)

const touchWorkflowAgent = async ($: $, id: string, tool?: string) => {
  const ws = await readWorkflows($)
  const listed = ws.find(w => w.agents.some(a => a.id === id))
  if (listed && !tool) return
  const owner = listed ?? [...ws].reverse().find(isWorkflowActive)
  if (!owner) return
  const now = await $.clock.now()
  await setWorkflows($, list =>
    list.map(w => {
      if (w.taskId !== owner.taskId) return w
      const has = w.agents.some(a => a.id === id)
      const n = Math.max(0, ...w.agents.map(a => a.n)) + 1
      const agents = has ? w.agents : [...w.agents, { id, n, status: 'running', startedAt: now, tools: 0 }]
      if (!tool) return { ...w, agents }
      return {
        ...w,
        tools: w.tools + 1,
        lastTool: tool,
        agents: agents.map(a => (a.id === id ? { ...a, tools: a.tools + 1, lastTool: tool } : a)),
      }
    }),
  )
  await update($, nowAtom, () => now)
  if (!owner.agents.find(a => a.id === id)?.label) void titleWorkflowAgent($, id)
}

const titleIO = ($: $): TitleIO => ({
  read: path => $.fs.read(path),
  ask: async prompt => {
    const r = await $.model.complete({ model: 'haiku', prompt, effort: 'low', maxTokens: 120, timeoutMs: 20_000 })
    return r.isAnswered ? r.text : undefined
  },
})

const titleWorkflowAgent = async ($: $, id: string) => {
  const owner = (await readWorkflows($)).find(w => w.agents.some(a => a.id === id && !a.label))
  if (!owner?.transcriptDir) return
  const title = await resolveAgentTitle(titleIO($), owner.transcriptDir, id)
  if (!title.label) return
  await setWorkflows($, ws =>
    ws.map(w => ({
      ...w,
      agents: w.agents.map(a => (a.id === id && !a.label ? { ...a, label: title.label, phase: title.phase ?? a.phase } : a)),
    })),
  )
}

type Notice = { taskId: string; toolUseId?: string; status?: string; durationMs?: number; isGuess?: boolean }

const finishBackground = async ($: $, notice: Notice) => {
  const status = endStatus(notice.status === 'running' ? undefined : notice.status)
  const now = await $.clock.now()
  const hit = (await readWorkflows($)).find(
    w => isWorkflowActive(w) && (w.taskId === notice.taskId || (notice.toolUseId !== undefined && w.toolUseId === notice.toolUseId)),
  )
  if (hit) {
    const doneAt = notice.durationMs ? hit.startedAt + notice.durationMs : now
    await setWorkflows($, list =>
      list.map(w =>
        w.taskId === hit.taskId
          ? {
              ...w,
              status,
              doneAt,
              isForced: notice.isGuess === true,
              agents: w.agents.map(a => (isAgentActive(a) ? { ...a, status, doneAt: Math.max(a.startedAt, doneAt), isForced: true } : a)),
            }
          : w,
      ),
    )
  }
  if ((await read($, agentsAtom)).some(a => a.id === notice.taskId && isAgentActive(a))) {
    await setAgents($, list => list.map(a => (a.id === notice.taskId && isAgentActive(a) ? { ...a, status, doneAt: now } : a)))
  }
  await update($, nowAtom, () => now)
}

const finishCall = async ($: $, call: CallItem, status: CallStatus) => {
  const now = await $.clock.now()
  await update($, activityAtom, a => (a ? { ...a, calls: a.calls.map(c => (c.id === call.id ? { ...c, status, doneAt: now } : c)) } : a))
  await update($, nowAtom, () => now)
  if (status === 'done') {
    await saveDurations($, d => ({ ...d, tool: { ...d.tool, [call.tool]: remember(d.tool[call.tool] ?? [], now - call.startedAt) } }))
  }
}

const refreshAgents = async ($: $, seed: boolean) => {
  const listed = await $.agent.list()
  const now = await $.clock.now()
  await setAgents($, agents => {
    const merged = agents.map(a => {
      const live = listed.find(l => l.id === a.id)
      if (!live || live.status === a.status) return a
      const isDone = !isAgentActive({ status: live.status })
      if (!isDone && !isAgentActive(a)) return { ...a, status: live.status, startedAt: now, doneAt: undefined, isSeeded: true }
      return { ...a, status: live.status, doneAt: isDone ? (a.doneAt ?? now) : undefined }
    })
    if (!seed) return merged
    const extra = listed
      .filter(l => !merged.some(a => a.id === l.id) && isAgentActive({ status: l.status }))
      .map(l => ({ id: l.id, description: l.description, type: l.type, status: l.status, startedAt: now, tools: 0, isSeeded: true }))
    return [...merged, ...extra]
  })
}

const WRITER = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
let lastSynced = ''
let lastSeenAt = 0
let isSyncing = false

const readBody = async ($: $): Promise<BoardBody> => ({
  tasks: await read($, tasksAtom),
  agents: await read($, agentsAtom),
  workflows: await readWorkflows($),
  activity: await read($, activityAtom),
  goal: await read($, goalAtom),
})

const writeBody = async ($: $, b: BoardBody) => {
  await update($, tasksAtom, () => b.tasks)
  await update($, agentsAtom, () => b.agents)
  await update($, workflowsAtom, () => b.workflows)
  await update($, activityAtom, () => b.activity)
  await update($, goalAtom, () => b.goal)
}

const ALIVE_KEY = 'alive'
const ALIVE_MS = 10_000

const heartbeat = async ($: $) => {
  const now = await $.clock.now()
  const sessionId = await $.session.id()
  const all = ((await $.store.get(ALIVE_KEY)) as Record<string, { sessionId: string; at: number }> | undefined) ?? {}
  const fresh = Object.fromEntries(Object.entries(all).filter(([, v]) => now - v.at < ALIVE_MS * 6))
  await $.store.set(ALIVE_KEY, { ...fresh, [WRITER]: { sessionId, at: now } })
}

const isOtherWindowAlive = async ($: $) => {
  const now = await $.clock.now()
  const sessionId = await $.session.id()
  const all = ((await $.store.get(ALIVE_KEY)) as Record<string, { sessionId: string; at: number }> | undefined) ?? {}
  return Object.entries(all).some(([w, v]) => w !== WRITER && v.sessionId === sessionId && now - v.at < ALIVE_MS)
}

const syncBoard = async ($: $) => {
  if (isSyncing) return
  isSyncing = true
  try {
    await heartbeat($)
    await saveBoard($)
  } finally {
    isSyncing = false
  }
}

const saveBoard = async ($: $) => {
  const now = await $.clock.now()
  const id = await $.session.id()
  const stored = (await $.store.get(boardKey(id))) as BoardSnapshot | undefined
  let body = await readBody($)
  if (stored?.v === 1 && stored.writer !== WRITER && stored.savedAt > lastSeenAt) {
    lastSeenAt = stored.savedAt
    const merged = mergeBoards(body, stored)
    if (stableBody(merged) !== stableBody(body)) {
      await writeBody($, merged)
      await update($, nowAtom, () => now)
      body = merged
    }
    if (stableBody(merged) === stableBody(stored)) {
      lastSynced = stableBody(merged)
      return
    }
  }
  const text = stableBody(body)
  if (text === lastSynced) return
  lastSynced = text
  const snapshot: BoardSnapshot = { v: 1, savedAt: now, writer: WRITER, ...body }
  lastSeenAt = Math.max(lastSeenAt, now)
  await $.store.set(boardKey(id), snapshot)
  const index = ((await $.store.get(BOARD_INDEX)) as { id: string; savedAt: number }[] | undefined) ?? []
  const next = [{ id, savedAt: now }, ...index.filter(b => b.id !== id)]
  for (const old of next.slice(KEEP_BOARDS)) await $.store.delete(boardKey(old.id))
  await $.store.set(BOARD_INDEX, next.slice(0, KEEP_BOARDS))
}

const restoreSavedBoard = async ($: $) => {
  const isEmpty =
    (await read($, tasksAtom)).length === 0 &&
    (await read($, agentsAtom)).length === 0 &&
    (await read($, workflowsAtom)).length === 0 &&
    (await read($, activityAtom)) === null &&
    (await read($, goalAtom)) === null
  if (!isEmpty) return false
  const live = new Set((await $.agent.list()).filter(a => isAgentActive(a)).map(a => a.id))
  const board = restoreBoard(await $.store.get(boardKey(await $.session.id())), live, await isOtherWindowAlive($))
  if (!board) return false
  await update($, tasksAtom, () => board.tasks)
  await update($, agentsAtom, () => board.agents)
  await update($, workflowsAtom, () => board.workflows)
  await update($, activityAtom, () => board.activity)
  await update($, goalAtom, () => board.goal)
  return true
}

const clearFinished = async ($: $) => {
  const tasks = await update($, tasksAtom, ts => ts.filter(isTaskOpen))
  const agents = await update($, agentsAtom, as => as.filter(isAgentActive))
  const ws = await update($, workflowsAtom, list => list.map(normalizeWorkflow).filter(isWorkflowActive))
  await update($, activityAtom, a => (a?.isRunning ? { ...a, calls: a.calls.filter(isCallOpen) } : null))
  await update($, goalAtom, g => (g?.status === 'active' ? g : null))
  return tasks.length + agents.length + ws.length
}

export type BoardState = {
  tasks: readonly TaskItem[]
  agents: readonly AgentItem[]
  activity: Activity | null
  workflows: readonly WorkflowItem[]
  goal: Goal | null
}

const agentLabel = (a: { n: number; label?: string; phase?: string }) =>
  `${a.label ?? `agent ${a.n}`}${a.phase ? ` · ${a.phase}` : ''}`

const moreLine = (hidden: number) => `… ${hidden} earlier finished · /progress-board clear removes them`

export const summaryText = ({ tasks, agents, activity, workflows, goal }: BoardState, d: Durations, now: number) => {
  const lines: string[] = []
  const line = (stamp: number, text: string) => lines.push(`  ${fmtStamp(stamp)} ${text}`)
  if (goal) lines.push(`Goal · ${goal.condition} · ${goalProgress(goal, tasks, d, now).note} · set ${fmtStamp(goal.setAt)}`)

  const ts = taskSummary(tasks, d, now)
  lines.push(`Tasks ${ts.done}/${ts.total} · ${Math.round(ts.pct)}% · ${ts.note}`)
  const est = median(d.task)
  const tc = collapse(tasks, isTaskOpen, taskTime)
  for (const t of tc.shown) {
    const p = taskProgress(t, tasks, est, now)
    line(taskTime(t), `#${t.id} ${t.subject} · ${Math.round(p.pct)}% · ${p.note}`)
  }
  if (tc.hidden) lines.push(`  ${moreLine(tc.hidden)}`)

  const as = agentSummary(agents, d, now)
  lines.push(`Subagents ${as.done}/${as.total} · ${Math.round(as.pct)}% · ${as.note}`)
  const ac = collapse(agents, isAgentUnfinished, agentTime)
  for (const a of ac.shown) {
    const p = agentProgress(a, agentEstimate(d, a.type), now)
    line(agentTime(a), `${a.type} · ${a.description} · ${Math.round(p.pct)}% · ${p.note}`)
  }
  if (ac.hidden) lines.push(`  ${moreLine(ac.hidden)}`)

  if (workflows.length) {
    const ws = workflowSummary(workflows, d, now)
    lines.push(`Workflows ${ws.done}/${ws.total} · ${Math.round(ws.pct)}% · ${ws.note}`)
    const wc = collapse(workflows, isWorkflowUnfinished, workflowTime)
    for (const w of wc.shown) {
      const p = workflowProgress(w, d, now)
      line(workflowTime(w), `${w.name} · ${Math.round(p.pct)}% · ${p.note}`)
      const kids = collapse(w.agents, isAgentUnfinished, agentTime)
      for (const k of kids.shown) {
        const kp = workflowAgentProgress(k, d, now)
        line(agentTime(k), `  ↳ ${agentLabel(k)} · ${Math.round(kp.pct)}% · ${kp.note}`)
      }
      if (kids.hidden) lines.push(`      ${moreLine(kids.hidden)}`)
    }
    if (wc.hidden) lines.push(`  ${moreLine(wc.hidden)}`)
  }

  if (activity) {
    const s = activitySummary(activity, d, now)
    lines.push(`Activity ${s.done}/${s.total} · ${Math.round(s.pct)}% · ${s.note}`)
    const cc = collapse(activity.calls, isCallUnfinished, callTime)
    for (const c of cc.shown) {
      const p = callProgress(c, d, now)
      line(callTime(c), `${c.label} · ${Math.round(p.pct)}% · ${p.note}`)
    }
    const hidden = cc.hidden + (activity.total - activity.calls.length)
    if (hidden) lines.push(`  … ${hidden} earlier call${hidden === 1 ? '' : 's'} done`)
  }
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const wrapByDefault = options.wrapText === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress-board',
      description: 'Open the progress pane; "clear" removes finished items, "wrap" toggles multi-line descriptions',
      argumentHint: '[clear | wrap [on|off]]',
      immediate: true,
    })
    const stored = await $.store.get(STORE_KEY)
    if (stored) await update($, durationsAtom, () => normalizeDurations(stored))
    if (await restoreSavedBoard($)) await openPane($, false)
    const adopted = adoptWorkflowSubagents(await read($, agentsAtom), await readWorkflows($))
    if (adopted.moved) {
      await update($, agentsAtom, () => adopted.agents)
      await update($, workflowsAtom, () => adopted.workflows)
    }
    await $.tool.register({
      name: TASKS_TOOL,
      description:
        "Shows your plan as a task list with progress bars in the user's progress pane. Call it at the start of any multi-step piece of work and again whenever a task's status changes, always sending the whole list in order. Keep exactly one task in_progress while you work on it and mark it completed as soon as it is done.",
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Short imperative title, e.g. "Add config encryption"' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string', description: 'Present-continuous form shown while in progress, e.g. "Adding config encryption"' },
              },
              required: ['subject', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
    })
    await refreshAgents($, true)

    void $.clock.every(SAVE_MS, () => {
      void syncBoard($)
    })

    void $.clock.every(TICK_MS, () => {
      void (async () => {
        const tasks = await read($, tasksAtom)
        const hasActiveAgent = (await read($, agentsAtom)).some(isAgentActive)
        const isWorking = (await read($, activityAtom))?.isRunning === true
        const hasWorkflow = (await read($, workflowsAtom)).some(isWorkflowActive)
        if (!hasActiveAgent && !isWorking && !hasWorkflow && !tasks.some(t => t.status === 'in_progress')) return
        const now = await $.clock.now()
        await update($, nowAtom, () => now)
        if (hasActiveAgent) await refreshAgents($, false)
      })()
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await syncBoard($)
    return next(e)
  })

  on('command.run', { command: 'progress-board' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'wrap' || arg === 'wrap on' || arg === 'wrap off') {
      const next = arg === 'wrap' ? !((await read($, wrapAtom)) ?? wrapByDefault) : arg === 'wrap on'
      await update($, wrapAtom, () => next)
      await openPane($, true)
      return { text: next ? 'Descriptions now wrap onto several lines.' : 'Descriptions now stay on one line.' }
    }
    if (arg === 'clear') {
      const left = await clearFinished($)
      return { text: `Finished items cleared; ${left} still running or pending.` }
    }
    await openPane($, true)
    const now = await $.clock.now()
    return {
      text: summaryText(
        {
          tasks: await read($, tasksAtom),
          agents: await read($, agentsAtom),
          activity: await read($, activityAtom),
          workflows: await readWorkflows($),
          goal: await read($, goalAtom),
        },
        await readDurations($),
        now,
      ),
    }
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result) {
      const now = await $.clock.now()
      const task: TaskItem = {
        id: ran.result.task.id,
        subject: e.subject,
        activeForm: e.activeForm,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        blockedBy: [],
      }
      await setTasks($, tasks => [...tasks.filter(t => t.id !== task.id), task])
      await openPane($, false)
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result?.success) {
      const now = await $.clock.now()
      const status = e.status === 'deleted' ? undefined : e.status
      await setTasks($, tasks => {
        if (e.status === 'deleted') return tasks.filter(t => t.id !== e.taskId)
        return tasks.map(t => {
          if (t.id !== e.taskId) return t
          const renamed = {
            ...t,
            subject: e.subject ?? t.subject,
            activeForm: e.activeForm ?? t.activeForm,
            blockedBy: [...new Set([...t.blockedBy, ...(e.addBlockedBy ?? [])])],
          }
          return status ? applyTaskStatus(renamed, status, now) : renamed
        })
      })
    }
    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await applyTaskList($, e.todos.map(t => ({ subject: t.content, status: t.status, activeForm: t.activeForm })))
    }
    return ran
  })

  on('tool.call', { tool: TASKS_TOOL_FULL }, async ($, e) => {
    const items = parseTaskList(e)
    if (!items) {
      return { result: 'Not updated: send { tasks: [{ subject, status }] } with status pending, in_progress or completed for every item.' }
    }
    await applyTaskList($, items)
    const done = items.filter(t => t.status === 'completed').length
    return { result: `Task list shown in the progress pane: ${done}/${items.length} completed.` }
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      if (await isKnownSubagent($, id)) {
        await update($, agentsAtom, agents => agents.map(a => (a.id === id ? { ...a, tools: a.tools + 1, lastTool: e.tool } : a)))
      } else {
        await touchWorkflowAgent($, id, e.tool)
      }
      return next(e)
    }
    if (e.tool === TASKS_TOOL_FULL) return next(e)

    const now = await $.clock.now()
    const call: CallItem = {
      id: e.tool_use_id,
      tool: e.tool,
      label: describeCall(e.tool, e as unknown as Record<string, unknown>),
      status: 'running',
      startedAt: now,
    }
    await update($, activityAtom, a => {
      const base = a?.isRunning ? a : { isRunning: true, startedAt: now, calls: [], total: 0 }
      return { ...base, calls: [...base.calls, call].slice(-MAX_CALLS), total: base.total + 1 }
    })
    await update($, nowAtom, () => now)
    try {
      const ran = await next(e)
      await finishCall($, call, ran.deny !== undefined || ran.isError === true ? 'failed' : 'done')
      return ran
    } catch (err) {
      await finishCall($, call, 'failed')
      throw err
    }
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id && !(await isKnownSubagent($, id))) await touchWorkflowAgent($, id)
    return yield* next(e)
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const now = await $.clock.now()
    const provisional = `pending:${e.tool_use_id}`
    await setWorkflows($, ws => [
      ...ws,
      {
        taskId: provisional,
        toolUseId: e.tool_use_id,
        name: e.name ?? e.title ?? 'workflow',
        status: 'running',
        startedAt: now,
        agents: [],
        tools: 0,
      },
    ])
    await update($, nowAtom, () => now)
    const settle = async (r?: { taskId: string; workflowName?: string; transcriptDir?: string }) => {
      await setWorkflows($, ws =>
        r
          ? ws.map(w =>
              w.taskId === provisional ? { ...w, taskId: r.taskId, name: r.workflowName ?? w.name, transcriptDir: r.transcriptDir } : w,
            )
          : ws.filter(w => w.taskId !== provisional),
      )
      if (r) await openPane($, false)
    }
    try {
      const ran = await next(e)
      await settle(ran.deny === undefined && !ran.isError && ran.result?.taskId && !ran.result.error ? ran.result : undefined)
      return ran
    } catch (err) {
      await settle()
      throw err
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const notice = parseTaskNotice(e.text)
      if (notice) await finishBackground($, notice)
    }
    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const task = e.props.task
    if (task?.id && task.status) {
      const id = task.id
      const isOpen =
        (await readWorkflows($)).some(w => w.taskId === id && isWorkflowActive(w)) ||
        (await read($, agentsAtom)).some(a => a.id === id && isAgentActive(a))
      if (isOpen) await finishBackground($, { taskId: id, toolUseId: task.toolUseId, status: task.status, durationMs: task.durationMs })
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const live = e.background_tasks
    if (Array.isArray(live)) {
      const ids = new Set(live.map(t => t.id))
      const gone = (await readWorkflows($)).filter(w => isWorkflowActive(w) && !ids.has(w.taskId))
      for (const w of gone) await finishBackground($, { taskId: w.taskId, isGuess: true })
    }
    return next(e)
  })

  on('tool.call', { tool: 'ProposeGoal' }, async ($, e, next) => {
    const ran = await next(e)
    const now = await $.clock.now()
    const isSet = ran.deny === undefined && !ran.isError
    const goal: Goal = {
      condition: (isSet && ran.result?.condition) || e.condition,
      status: isSet ? 'active' : 'declined',
      setBy: 'claude',
      setAt: now,
      endedAt: isSet ? undefined : now,
      turns: 0,
    }
    await update($, goalAtom, () => goal)
    await openPane($, false)
    return ran
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const ran = await next(e)
    const args = e.args.trim()
    const now = await $.clock.now()
    if (/^(clear|stop|off|cancel)$/i.test(args)) {
      await update($, goalAtom, g => (g && g.status === 'active' ? { ...g, status: 'cleared' as const, endedAt: now } : g))
    } else if (args) {
      await update($, goalAtom, () => ({ condition: args, status: 'active' as const, setBy: 'you' as const, setAt: now, turns: 0 }))
      await openPane($, false)
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, goalAtom, g => (g?.status === 'active' ? { ...g, turns: g.turns + 1 } : g))
    await update($, tasksAtom, ts =>
      ts.map(t => (t.pausedAt !== undefined ? { ...t, pausedAt: undefined, pausedMs: (t.pausedMs ?? 0) + Math.max(0, now - t.pausedAt) } : t)),
    )
    await update($, activityAtom, () => ({ isRunning: true, startedAt: now, calls: [], total: 0 }))
    await update($, nowAtom, () => now)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id && e.subagentType === WORKFLOW_SUBAGENT) {
      const owner = [...(await readWorkflows($))].reverse().find(isWorkflowActive)
      if (owner) {
        const now = await $.clock.now()
        const label = e.description?.trim() || undefined
        await setWorkflows($, ws =>
          ws.map(w => {
            if (w.taskId !== owner.taskId) return w
            if (w.agents.some(a => a.id === id)) return { ...w, agents: w.agents.map(a => (a.id === id && !a.label ? { ...a, label } : a)) }
            const n = Math.max(0, ...w.agents.map(a => a.n)) + 1
            return { ...w, agents: [...w.agents, { id, n, status: 'running', startedAt: now, tools: 0, label }] }
          }),
        )
        await update($, nowAtom, () => now)
        return started
      }
    }
    if (started.agentId) {
      const now = await $.clock.now()
      const agent: AgentItem = {
        id: started.agentId,
        description: e.description,
        type: e.subagentType || 'general-purpose',
        status: 'running',
        startedAt: now,
        tools: 0,
        isTeammate: e.isTeammate === true,
      }
      await setAgents($, agents => [...agents.filter(a => a.id !== agent.id), agent])
      if ((await readWorkflows($)).some(w => w.agents.some(a => a.id === agent.id))) {
        await setWorkflows($, ws => ws.map(w => ({ ...w, agents: w.agents.filter(a => a.id !== agent.id) })))
      }
      await update($, nowAtom, () => now)
      await openPane($, false)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const now = await $.clock.now()
    if (!id) {
      const ended = await update($, activityAtom, a => (a?.isRunning ? { ...a, isRunning: false, endedAt: now } : a))
      await update($, tasksAtom, ts => ts.map(t => (t.status === 'in_progress' && t.pausedAt === undefined ? { ...t, pausedAt: now } : t)))
      if (ended && !e.isAborted && ended.total > 0) await saveDurations($, d => ({ ...d, turn: remember(d.turn, now - ended.startedAt) }))
    } else {
      const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      await setAgents($, agents =>
        agents.map(a => (a.id === id && !a.isTeammate && a.type !== 'teammate' && isAgentActive(a) ? { ...a, status, doneAt: now } : a)),
      )
      if ((await readWorkflows($)).some(w => w.agents.some(a => a.id === id && isAgentActive(a)))) {
        await setWorkflows($, ws =>
          ws.map(w => ({ ...w, agents: w.agents.map(a => (a.id === id && isAgentActive(a) ? { ...a, status, doneAt: now } : a)) })),
        )
        void titleWorkflowAgent($, id)
      }
    }
    await update($, nowAtom, () => now)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const tasks = await read($, tasksAtom)
    const agents = await read($, agentsAtom)
    const d = await readDurations($)
    const activity = await read($, activityAtom)
    const workflows = await readWorkflows($)
    const goal = await read($, goalAtom)
    const now = Math.max(await read($, nowAtom), await $.clock.now())

    if (tasks.length === 0 && agents.length === 0 && workflows.length === 0 && !activity && !goal) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nothing running yet.</Text>
          <Text dimColor>Tasks, subagents, workflows and Claude's tool calls show up here as they happen.</Text>
        </Box>
      )
    }

    const els = $.ui.resolve(e)
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const Button = 'Button' in els ? els.Button : undefined
    const isWrapped = (await read($, wrapAtom)) ?? wrapByDefault
    const wrap = isWrapped ? 'wrap' : 'truncate-end'
    const cols = e.props.bodyColumns
    const barW = Svg ? 18 : Math.min(20, Math.max(8, Math.floor(cols * 0.15)))
    const free = Math.max(0, cols - STAMP_W - ICON_W - barW - PCT_W)
    const nameW = Math.max(16, Math.floor(free * 0.6))
    const headW = STAMP_W + ICON_W + nameW

    const meter = (pct: number, color: string | undefined, isDim: boolean) => {
      const b = bar(pct, barW)
      const svg = svgBar(pct, isDim ? 'gray' : color)
      return [
        Svg ? (
          <Box key="bar" flexShrink={0}>
            <Svg source={svg.source} width={svg.width} height={svg.height} alt={`${Math.round(pct)}%`} />
          </Box>
        ) : (
          <Box key="bar" width={barW} flexShrink={0}>
            <Text color={color} dimColor={isDim}>{b.filled}</Text>
            <Text dimColor>{b.empty}</Text>
          </Box>
        ),
        <Box key="pct" width={PCT_W} flexShrink={0}>
          <Text color={color} dimColor={isDim} bold={!isDim}>{`${Math.round(pct)}%`.padStart(5)}</Text>
        </Box>,
      ]
    }

    const row = (key: string, stamp: number, label: string, p: Progress) => {
      const color = TONE_COLOR[p.tone]
      const isDim = p.tone === 'waiting'
      return (
        <Box key={key} alignItems="flex-start">
          <Box width={STAMP_W} flexShrink={0}>
            <Text dimColor>{fmtStamp(stamp)}</Text>
          </Box>
          <Box width={ICON_W} flexShrink={0}>
            <Text color={color} dimColor={isDim}>{TONE_ICON[p.tone]}</Text>
          </Box>
          <Box width={nameW} flexShrink={0}>
            <Text dimColor={isDim} wrap={wrap}>{label}</Text>
          </Box>
          {meter(p.pct, color, isDim)}
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap={wrap}>{` ${p.note}`}</Text>
          </Box>
        </Box>
      )
    }

    const header = (key: string, title: string, s: Summary, isQuiet = false) => {
      const color = s.total > 0 && s.done === s.total ? 'green' : 'cyan'
      return (
        <Box key={key} alignItems="flex-start">
          <Box width={headW} flexShrink={0}>
            <Text bold dimColor={isQuiet} wrap="truncate-end">{`${title} ${s.done}/${s.total}`}</Text>
          </Box>
          {meter(s.pct, color, false)}
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap={wrap}>{` ${s.note}`}</Text>
          </Box>
        </Box>
      )
    }

    const more = (key: string, hidden: number, text = moreLine(hidden)) =>
      hidden > 0 ? [
        <Box key={key}>
          <Box width={STAMP_W + ICON_W} flexShrink={0}>
            <Text> </Text>
          </Box>
          <Text dimColor wrap="truncate-end">{text}</Text>
        </Box>,
      ] : []

    const rows = []
    const gap = (key: string) => rows.length && rows.push(<Text key={key}> </Text>)

    if (goal) {
      rows.push(row('goal', goal.setAt, `Goal · ${goal.condition}`, goalProgress(goal, tasks, d, now)))
    }

    if (tasks.length) {
      gap('gap-tasks')
      const est = median(d.task)
      rows.push(header('tasks-head', 'Tasks', taskSummary(tasks, d, now)))
      const c = collapse(tasks, isTaskOpen, taskTime)
      for (const t of c.shown) {
        const label = `#${t.id} ${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}`
        rows.push(row(`task-${t.id}`, taskTime(t), label, taskProgress(t, tasks, est, now)))
      }
      rows.push(...more('tasks-more', c.hidden))
    }

    if (agents.length) {
      gap('gap-agents')
      rows.push(header('agents-head', 'Subagents', agentSummary(agents, d, now)))
      const c = collapse(agents, isAgentUnfinished, agentTime)
      for (const a of c.shown) {
        const p = agentProgress(a, agentEstimate(d, a.type), now)
        const live = isAgentActive(a) && a.tools ? ` · ${a.tools} tool calls${a.lastTool ? ` · ${a.lastTool}` : ''}` : ''
        rows.push(row(`agent-${a.id}`, agentTime(a), `${a.type} · ${a.description}`, { ...p, note: p.note + live }))
      }
      rows.push(...more('agents-more', c.hidden))
    }

    if (workflows.length) {
      gap('gap-wf')
      rows.push(header('workflows-head', 'Workflows', workflowSummary(workflows, d, now)))
      const c = collapse(workflows, isWorkflowUnfinished, workflowTime)
      for (const w of c.shown) {
        rows.push(row(`wf-${w.taskId}`, workflowTime(w), `Workflow · ${w.name}`, workflowProgress(w, d, now)))
        const kids = collapse(w.agents, isAgentUnfinished, agentTime)
        for (const k of kids.shown) {
          rows.push(row(`wf-${w.taskId}-${k.id}`, agentTime(k), `  ↳ ${agentLabel(k)}`, workflowAgentProgress(k, d, now)))
        }
        rows.push(...more(`wf-${w.taskId}-more`, kids.hidden, `  … ${kids.hidden} earlier agents finished`))
      }
      rows.push(...more('wf-more', c.hidden))
    }

    if (activity) {
      gap('gap-activity')
      if (!activity.isRunning && activity.total === 0) {
        rows.push(
          <Box key="activity-quiet">
            <Box width={headW} flexShrink={0}>
              <Text bold dimColor>Activity</Text>
            </Box>
            <Text dimColor wrap="truncate-end">{`last turn · no tool calls · took ${fmtDur((activity.endedAt ?? now) - activity.startedAt)}`}</Text>
          </Box>,
        )
      } else {
        rows.push(header('activity-head', 'Activity', activitySummary(activity, d, now), !activity.isRunning))
        const c = collapse(activity.calls, isCallUnfinished, callTime)
        for (const call of c.shown) rows.push(row(`call-${call.id}`, callTime(call), call.label, callProgress(call, d, now)))
        const hidden = c.hidden + (activity.total - activity.calls.length)
        rows.push(...more('activity-more', hidden, `… ${hidden} earlier call${hidden === 1 ? '' : 's'} done`))
      }
    }

    const samples =
      d.task.length + Object.values(d.agent).flat().length + Object.values(d.tool).flat().length + Object.values(d.workflow).flat().length
    rows.push(<Text key="gap-foot"> </Text>)
    if (Button) {
      rows.push(
        <Box key="foot-actions">
          <Button
            key="wrap-toggle"
            label={isWrapped ? 'Single-line descriptions' : 'Wrap descriptions'}
            onPress={() => update($, wrapAtom, v => !(v ?? wrapByDefault))}
          />
        </Box>,
      )
    }
    rows.push(
      <Text key="foot" dimColor wrap="truncate-end">
        {samples
          ? `Newest first · times are start or finish · estimates: median of ${samples} past durations`
          : 'Newest first · estimates appear once something has finished'}
      </Text>,
    )
    return <Box flexDirection="column">{rows}</Box>
  })
}
