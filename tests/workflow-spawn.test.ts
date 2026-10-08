import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fmtDur } from '../hooks/model'

const RUN = {
  command: 'progress-board',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const SPAWN = {
  prompt: 'p',
  subagentType: 'Explore',
  tool_use_id: 'tu',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

const WF_SPAWN = { ...SPAWN, subagentType: 'workflow-subagent' } as const

const LAUNCHED = { result: { status: 'async_launched', taskId: 'wf-1', workflowName: 'review', transcriptDir: 'C:/runs/wf_1' } }

type Opts = { workflowGate?: Promise<void>; onWorkflowEntered?: () => void; workflowFails?: boolean }

const fakeEngine = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on)
  mock.store(on, {})
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { id: 'progress-board' } }) as never)
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Workflow') {
      if (opts.workflowFails) return { result: {}, isError: true } as never
      opts.onWorkflowEntered?.()
      await opts.workflowGate
      return LAUNCHED as never
    }
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

const done = (agentId: string) => ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, agentId })

const lineWith = (text: string | undefined, s: string) => (text ?? '').split('\n').find(l => l.includes(s)) ?? ''

test('a workflow-subagent goes under its workflow, not under Subagents', async ($, on) => {
  const clock = fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.agent.spawn({ ...WF_SPAWN, description: 'read:config' })
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agent-1' } as never)

  const running = await $.command.run(RUN)
  expect(running.text).toContain('Subagents 0/0')
  expect(running.text).toContain('no subagents yet')
  expect(running.text).toContain('↳ read:config')
  expect(lineWith(running.text, '↳ read:config')).toContain('1 tool call')
  expect(lineWith(running.text, 'review ·')).toContain('1 tool call')

  await clock.advance(10_000)
  await $.agent.spawn({ ...WF_SPAWN, description: 'read:docs' })
  await clock.advance(5_000)
  await $.turn.complete(done('agent-1'))

  const mid = await $.command.run(RUN)
  expect(mid.text).toContain(`↳ read:config · 100% · done · took ${fmtDur(15_000)}`)
  expect(mid.text).toContain('↳ read:docs · ')
  expect(lineWith(mid.text, '↳ read:docs')).not.toContain('done')
  expect(mid.text).toContain('Subagents 0/0')
})

test('a workflow-subagent spawned before the Workflow result comes back still attaches', async ($, on) => {
  // A fake may not call engine ops itself (host rule), so the Workflow call is held open
  // while the test spawns the agent, then released. Spawning waits until the launch is
  // in flight, as a real workflow's agents can only start once the call is running.
  let release = () => {}
  let entered = () => {}
  const inFlight = new Promise<void>(r => (entered = r))
  fakeEngine(on, { workflowGate: new Promise<void>(r => (release = r)), onWorkflowEntered: entered })
  const call = $.tool.call({ tool: 'Workflow', script: 'x' })
  await inFlight
  await $.agent.spawn({ ...WF_SPAWN, description: 'read:early' })
  release()
  await call

  const { text } = await $.command.run(RUN)
  expect(text).toContain('↳ read:early')
  const lines = (text ?? '').split('\n')
  const wf = lines.findIndex(l => l.includes('review ·'))
  const child = lines.findIndex(l => l.includes('↳ read:early'))
  expect(wf).toBeGreaterThan(-1)
  expect(child).toBeGreaterThan(wf)
  expect(text).toContain('no subagents yet')
})

test('a normal subagent spawned during a workflow stays under Subagents', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.agent.spawn({ ...SPAWN, description: 'Find handlers' })

  const { text } = await $.command.run(RUN)
  expect(text).toContain('Subagents 0/1')
  expect(text).toContain('Explore · Find handlers')
  expect(text).not.toContain('↳ Find handlers')
})

test('item timestamps carry seconds', async ($, on) => {
  fakeEngine(on)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  await $.agent.spawn({ ...SPAWN, description: 'Find handlers' })
  await $.agent.spawn({ ...WF_SPAWN, description: 'read:config' })

  const { text } = await $.command.run(RUN)
  for (const s of ['Explore · Find handlers', 'review ·', '↳ read:config']) {
    expect(lineWith(text, s)).toMatch(/^ {2}\d\d-\d\d \d\d:\d\d:\d\d /)
  }
})

test('a failed Workflow call leaves no workflow row', async ($, on) => {
  fakeEngine(on, { workflowFails: true })
  await $.tool.call({ tool: 'Workflow', script: 'x' })

  const { text } = await $.command.run(RUN)
  expect((text ?? '').split('\n').some(l => l.startsWith('Workflows'))).toBe(false)
  expect(text).not.toContain('Workflows')
})
