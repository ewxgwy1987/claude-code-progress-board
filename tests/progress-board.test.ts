import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, fmtDur, median, taskSummary } from '../hooks/model'

const RUN = {
  command: 'progress-board',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const fakeEngine = (on: On, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, store)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let nextId = 1
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { id: 'progress-board' } }) as never)
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(nextId++), subject: e.subject } } } as never
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } } as never
    if (e.tool === 'Bash' && e.command === 'exit 1') return { result: {}, isError: true } as never
    if (e.tool === 'Workflow') return { result: { status: 'async_launched', taskId: 'wf-1', workflowName: 'review', transcriptDir: 'C:/runs/wf_1' } } as never
    if (e.tool === 'ProposeGoal') return { result: { condition: e.condition, askUser: false } } as never
    return { result: {} } as never
  })
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-${++spawned}` }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('command.run', () => ({ text: '' }))
  on('classic.Stop', () => ({}) as never)
  return clock
}

test('a finished task sets the estimate for the next one', async ($, on) => {
  const clock = fakeEngine(on)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Read config', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write tests', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(60_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await clock.advance(15_000)

  const { text } = await $.command.run(RUN)
  expect(text).toContain('Tasks 1/2 · 63% · ~45s left')
  expect(text).toContain('#1 Read config · 100% · done · took 1m 00s')
  expect(text).toContain('#2 Write tests · 25% · ~45s left')
})

test('a subagent runs, then completes', async ($, on) => {
  const clock = fakeEngine(on)

  await $.agent.spawn({
    prompt: 'look around',
    description: 'Find handlers',
    subagentType: 'Explore',
    tool_use_id: 'tu-1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await clock.advance(5_000)
  const running = await $.command.run(RUN)
  expect(running.text).toContain('Explore · Find handlers · 0% · 5s elapsed · no estimate yet')

  await $.turn.complete({ answer: 'found', durationMs: 5000, isAborted: false, turnId: 't', reason: 'answer', agentId: 'agent-1' })
  const done = await $.command.run(RUN)
  expect(done.text).toContain('Subagents 1/1 · 100% · 0 running · 1 done')
  expect(done.text).toContain('Explore · Find handlers · 100% · done · took 5s')
})

test('helpers', () => {
  expect(median([3, 1, 2])).toBe(2)
  expect(median([])).toBe(null)
  expect(fmtDur(75_000)).toBe('1m 15s')
  expect(bar(50, 4)).toEqual({ filled: '██', empty: '░░' })
  const pending = { id: '1', subject: 'x', status: 'pending' as const, createdAt: 0, blockedBy: [] }
  expect(taskSummary([pending], { task: [], agent: {}, tool: {}, turn: [], workflow: {} }, 0).note).toBe('no estimate yet')
})

test('the pane draws a bar row per task on terminal and desktop', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Read config', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'progress-board',
      surface,
      component: 'Pane',
      requestId: 'progress-board',
      props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never,
    })
    expect(await ui.find({ type: 'Text', text: /Tasks 0\/1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#1 Read config/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no estimate yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty board says so instead of "all done"', async ($, on) => {
  fakeEngine(on)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('Tasks 0/0 · 0% · no tasks yet')
  expect(text).toContain('no subagents yet')
})

test('the plugin task tool fills the task list', async ($, on) => {
  fakeEngine(on)
  const ran = await $.tool.call({
    tool: 'mcp__progress-board__tasks',
    tasks: [
      { subject: 'Read config', status: 'completed' },
      { subject: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { subject: 'Update docs', status: 'pending' },
    ],
  } as never)
  expect(String(ran.result)).toContain('1/3 completed')
  const { text } = await $.command.run(RUN)
  expect(text).toContain('Tasks 1/3')
  expect(text).toContain('#2 Write tests')
  expect(text).toContain('#3 Update docs · 0% · pending')

  const bad = await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'x', status: 'later' }] } as never)
  expect(String(bad.result)).toContain('Not updated')
})

test('ordinary tool calls show in Activity with their outcome', async ($, on) => {
  const clock = fakeEngine(on)
  await $.turn.start({ text: 'go', turnId: 'm1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/parser.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(3_000)
  await $.tool.call({ tool: 'Bash', command: 'exit 1', description: 'Build the solution' })

  const running = await $.command.run(RUN)
  expect(running.text).toContain('Activity 2/2')
  expect(running.text).toContain('Edit · parser.ts · 100% · took 0s')
  expect(running.text).toContain('Bash · Build the solution · 100% · failed after 0s')

  await $.turn.complete({ answer: 'ok', durationMs: 3000, isAborted: false, turnId: 'm1', reason: 'answer' })
  const after = await $.command.run(RUN)
  expect(after.text).toContain('last turn · 2 tool calls · 1 failed · took 3s')
})

test('a workflow run collects its agents and finishes on its notice', async ($, on) => {
  const clock = fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}', title: 'review' })
  await $.tool.call({ tool: 'Grep', pattern: 'Handler', agentId: 'wf-agent-1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'a.cs', agentId: 'wf-agent-2' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'w', reason: 'answer', agentId: 'wf-agent-1' })

  const running = await $.command.run(RUN)
  expect(running.text).toContain('review · 0% · ')
  expect(running.text).toContain('agents 1/2 done · 2 tool calls · Read')

  await clock.advance(60_000)
  await $.prompt.submit({
    text: '<task-notification><task-id>wf-1</task-id><status>completed</status><usage><duration_ms>60000</duration_ms></usage></task-notification>',
    origin: { kind: 'task-notification' },
  } as never)
  const done = await $.command.run(RUN)
  expect(done.text).toContain('Workflows 1/1 · 100% · 0 running · 1 finished')
  expect(done.text).toContain('review · 100% · done · took 1m 00s · 2 agents · 2 tool calls')
})

test('a workflow missing from the end-of-turn task list is marked finished', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('Workflows 1/1 · 100%')
})

test('a goal shows as active, counts turns, and clears', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'ProposeGoal', condition: 'All tests pass', ask_user: false })
  await $.turn.start({ text: '', turnId: 'g1' })
  const active = await $.command.run(RUN)
  expect(active.text).toContain('Goal · All tests pass · active · set by Claude · 1 turn')

  await $.command.run({ ...RUN, command: 'goal', args: 'clear' })
  const cleared = await $.command.run(RUN)
  expect(cleared.text).toContain('Goal · All tests pass · cleared after')

  await $.command.run({ ...RUN, command: 'goal', args: 'Ship the dark-mode feature' })
  const mine = await $.command.run(RUN)
  expect(mine.text).toContain('Goal · Ship the dark-mode feature · active · set by you · 0 turns')
})

test('the pane draws goal and workflow rows on terminal and desktop', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'ProposeGoal', condition: 'All tests pass', ask_user: false })
  await $.tool.call({ tool: 'Workflow', script: 'x' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'progress-board',
      surface,
      component: 'Pane',
      requestId: 'progress-board',
      props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never,
    })
    expect(await ui.find({ type: 'Text', text: /Goal · All tests pass/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Workflows 0\/1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Workflow · review/ })).toBeDefined()
    await ui.unmount()
  }
})

const SPAWN = {
  prompt: 'p',
  subagentType: 'Explore',
  tool_use_id: 'tu',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

const done = (agentId: string) => ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, agentId })

test('parallel subagents finish separately, each with its own duration', async ($, on) => {
  const clock = fakeEngine(on)
  await $.agent.spawn({ ...SPAWN, description: 'First' })
  await $.agent.spawn({ ...SPAWN, description: 'Second' })
  await clock.advance(10_000)
  await $.turn.complete(done('agent-2'))

  const mid = await $.command.run(RUN)
  expect(mid.text).toContain('Explore · Second · 100% · done · took 10s')
  expect(mid.text).toContain('Explore · First · 95% · ~0s left')

  await clock.advance(20_000)
  await $.turn.complete(done('agent-1'))
  const end = await $.command.run(RUN)
  expect(end.text).toContain('Explore · First · 100% · done · took 30s')
  expect(end.text).toContain('Explore · Second · 100% · done · took 10s')
})

test('workflow agents each get their own row and finish separately', async ($, on) => {
  const clock = fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.tool.call({ tool: 'Grep', pattern: 'a', agentId: 'wa-1' } as never)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/x.ts', agentId: 'wa-2' } as never)
  await clock.advance(5_000)
  await $.turn.complete(done('wa-1'))

  const mid = await $.command.run(RUN)
  expect(mid.text).toContain('↳ agent 1 · 100% · done · took 10s · 1 tool call')
  expect(mid.text).toContain('↳ agent 2 · 50% · ~5s left · 1 tool call · Read')
  expect(mid.text).toContain('agents 1/2 done')

  await clock.advance(3_000)
  await $.turn.complete(done('wa-2'))
  const end = await $.command.run(RUN)
  expect(end.text).toContain('↳ agent 2 · 100% · done · took 8s')
})

test('rows are newest first and carry a date-time stamp', async ($, on) => {
  const clock = fakeEngine(on)
  for (const subject of ['Oldest', 'Middle', 'Newest']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: '' })
    await clock.advance(61_000)
  }
  const { text } = await $.command.run(RUN)
  const lines = (text ?? '').split('\n')
  const at = (s: string) => lines.findIndex(l => l.includes(s))
  expect(at('Newest')).toBeLessThan(at('Middle'))
  expect(at('Middle')).toBeLessThan(at('Oldest'))
  expect(lines[at('Newest')]).toMatch(/^ {2}\d\d-\d\d \d\d:\d\d:\d\d #3 Newest/)
})

test('only the 15 most recent finished items show, and clear removes finished ones', async ($, on) => {
  const clock = fakeEngine(on)
  const items = Array.from({ length: 19 }, (_, i) => ({ subject: `Step ${i + 1}`, status: i < 18 ? 'completed' : 'in_progress' }))
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: items } as never)
  await clock.advance(1_000)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('Step 19')
  expect(text).toContain('… 3 earlier finished')
  expect((text ?? '').split('\n').filter(l => / #\d+ Step \d+ · 100%/.test(l))).toHaveLength(15)

  const cleared = await $.command.run({ ...RUN, args: 'clear' })
  expect(cleared.text).toContain('1 still running or pending')
  const after = await $.command.run(RUN)
  expect(after.text).toContain('Tasks 0/1')
  expect(after.text).not.toContain('earlier finished')
})

test('a task marked done without being started shows no duration and adds no estimate', async ($, on) => {
  const clock = fakeEngine(on)
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'Quick fix', status: 'pending' }] } as never)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'Quick fix', status: 'completed' }] } as never)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('#1 Quick fix · 100% · done')
  expect(text).not.toContain('Quick fix · 100% · done · took')
})

test('a turn with no tool calls reads as such', async ($, on) => {
  fakeEngine(on)
  await $.turn.start({ text: 'hi', turnId: 'q' })
  await $.turn.complete({ answer: 'hello', durationMs: 1, isAborted: false, turnId: 'q', reason: 'answer' })
  const { text } = await $.command.run(RUN)
  expect(text).toContain('last turn · no tool calls')
})

test('an unfamiliar end status closes the workflow and its agents as stopped', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.tool.call({ tool: 'Grep', pattern: 'a', agentId: 'wa-1' } as never)
  await $.prompt.submit({
    text: '<task-notification><task-id>wf-1</task-id><status>stopped</status></task-notification>',
    origin: { kind: 'task-notification' },
  } as never)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('Workflows 1/1')
  expect(text).toContain('↳ agent 1 · 100% · killed after')
})

test('clear keeps a running workflow whole and numbers new agents after the last', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.tool.call({ tool: 'Grep', pattern: 'a', agentId: 'wa-1' } as never)
  await $.turn.complete(done('wa-1'))
  await $.command.run({ ...RUN, args: 'clear' })
  await $.tool.call({ tool: 'Grep', pattern: 'b', agentId: 'wa-2' } as never)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('↳ agent 1 · 100% · done')
  expect(text).toContain('↳ agent 2 ·')
  expect(text).toContain('agents 1/2 done')
})

test('a blocker removed by clear no longer blocks', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Base', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Follow-up', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.command.run({ ...RUN, args: 'clear' })
  const { text } = await $.command.run(RUN)
  expect(text).toContain('#2 Follow-up · 0% · pending')
})

test('desktop draws fixed-width SVG bars with the percentage as separate text; the terminal keeps text bars', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'Half way', status: 'in_progress' }] } as never)
  const PROPS = { title: 'Progress', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never

  const desk = await $.ui.mount({ plugin: 'progress-board', surface: 'desktop', component: 'Pane', requestId: 'progress-board', props: PROPS })
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.length).toBeGreaterThan(0)
  const texts = (await desk.findAll({ type: 'Text' })).map(t => JSON.stringify(t.text)).join(' | ')
  expect(texts).toContain('"   0%"')
  expect(texts).toContain('"#1 Half way"')
  expect(texts).not.toContain('░')
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'progress-board', surface: 'terminal', component: 'Pane', requestId: 'progress-board', props: PROPS })
  expect(await term.findAll({ type: 'Svg' })).toHaveLength(0)
  const termTexts = (await term.findAll({ type: 'Text' })).map(t => t.text).join('|')
  expect(termTexts).toContain('░░░░')
  expect(termTexts).toContain('   0%')
  await term.unmount()
})

test('a section with an item past its estimate says so instead of "~0s left"', async ($, on) => {
  const clock = fakeEngine(on)
  await $.agent.spawn({ ...SPAWN, description: 'Quick' })
  await clock.advance(5_000)
  await $.turn.complete(done('agent-1'))
  await $.agent.spawn({ ...SPAWN, description: 'Slow' })
  await clock.advance(20_000)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('1 running · 1 done · running over estimate')
  expect(text).toContain('Explore · Slow · 99% · 20s elapsed · over estimate by 15s')
})

test('an in-progress task pauses between turns and its duration leaves out the wait', async ($, on) => {
  const clock = fakeEngine(on)
  await $.turn.start({ text: 'go', turnId: 'p1' })
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'Ask then finish', status: 'in_progress' }] } as never)
  await clock.advance(10_000)
  await $.turn.complete({ answer: 'over to you', durationMs: 1, isAborted: false, turnId: 'p1', reason: 'answer' })
  await clock.advance(300_000)

  const waiting = await $.command.run(RUN)
  expect(waiting.text).toContain('Tasks 0/1 · 0% · paused · waiting for you')
  expect(waiting.text).toContain('paused · waiting for you · 10s of work')

  await $.turn.start({ text: 'here you go', turnId: 'p2' })
  await clock.advance(5_000)
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'Ask then finish', status: 'completed' }] } as never)
  const done = await $.command.run(RUN)
  expect(done.text).toContain('#1 Ask then finish · 100% · done · took 15s')
})

test('workflow agents are titled from the run folder', async ($, on) => {
  fakeEngine(on)
  on('fs.read', (_$, e) => {
    const path = String((e as { path?: unknown }).path).replace(/\\/g, '/')
    if (path === 'C:/runs/wf_1/agent-wa-7.meta.json') return { value: JSON.stringify({ description: 'read:handlers', workflowPhase: 'Read' }) } as never
    throw new Error(`ENOENT ${path}`)
  })
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.tool.call({ tool: 'Grep', pattern: 'a', agentId: 'wa-7' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'b', agentId: 'wa-8' } as never)
  const { text } = await $.command.run(RUN)
  expect(text).toContain('↳ read:handlers · Read · ')
  expect(text).toContain('↳ agent 2 · ')
})

test('the board is saved and comes back after a restart, with dead runs marked interrupted', async ($, on) => {
  const clock = fakeEngine(on, {
    'board:sess-1': {
      v: 1,
      savedAt: 1_000,
      tasks: [{ id: '1', subject: 'Long job', status: 'in_progress', createdAt: 0, startedAt: 0, updatedAt: 0, blockedBy: [] }],
      agents: [{ id: 'gone', description: 'Was running', type: 'Explore', status: 'running', startedAt: 0, tools: 2 }],
      workflows: [{ taskId: 'wf-x', toolUseId: 't', name: 'map', status: 'running', startedAt: 0, agents: [], tools: 0 }],
      activity: { isRunning: true, startedAt: 0, calls: [], total: 0 },
      goal: null,
    },
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__progress-board__tasks' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await clock.set(5_000)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run(RUN)
  expect(text).toContain('#1 Long job')
  expect(text).toContain('paused · waiting for you')
  expect(text).toContain('Explore · Was running · 100% · interrupted after 1s')
  expect(text).toContain('map · 100% · interrupted after 1s')
})

test('failed items always stay visible, beyond the 15 finished', async ($, on) => {
  const clock = fakeEngine(on)
  await $.agent.spawn({ ...SPAWN, description: 'Broke early' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'error', agentId: 'agent-1' })
  for (let i = 0; i < 16; i++) {
    await clock.advance(1_000)
    await $.agent.spawn({ ...SPAWN, description: `Fine ${i + 1}` })
    await $.turn.complete(done(`agent-${i + 2}`))
  }
  const { text } = await $.command.run(RUN)
  expect(text).toContain('Explore · Broke early · 100% · failed')
  expect(text).toContain('… 1 earlier finished')
})

test('/progress-board wrap toggles multi-line descriptions', async ($, on) => {
  fakeEngine(on)
  const first = await $.command.run({ ...RUN, args: 'wrap' })
  expect(first.text).toContain('now wrap onto several lines')
  const second = await $.command.run({ ...RUN, args: 'wrap' })
  expect(second.text).toContain('now stay on one line')
  const forced = await $.command.run({ ...RUN, args: 'wrap on' })
  expect(forced.text).toContain('now wrap onto several lines')
})
