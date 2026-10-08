import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { mergeBoards } from '../hooks/model'

const RUN = {
  command: 'progress-board',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const task = (id: string, subject: string, status: 'pending' | 'in_progress' | 'completed', at: number) => ({
  id,
  subject,
  status,
  createdAt: 0,
  startedAt: status === 'pending' ? undefined : 0,
  doneAt: status === 'completed' ? at : undefined,
  updatedAt: at,
  blockedBy: [],
})

const EMPTY = { tasks: [], agents: [], workflows: [], activity: null, goal: null }

test('merging keeps both windows’ items and prefers the more finished copy', () => {
  const mine = { ...EMPTY, tasks: [task('1', 'Build', 'in_progress', 10), task('2', 'Only here', 'pending', 5)] }
  const theirs = {
    ...EMPTY,
    tasks: [task('1', 'Build', 'completed', 20), task('3', 'Only there', 'pending', 7)],
    agents: [{ id: 'x', description: 'Run elsewhere', type: 'Explore', status: 'running', startedAt: 1, tools: 2 }],
  }
  const merged = mergeBoards(mine, theirs)
  expect(merged.tasks.map(t => `${t.id}:${t.status}`).sort()).toEqual(['1:completed', '2:pending', '3:pending'])
  expect(merged.agents.map(a => a.id)).toEqual(['x'])
})

test('another window’s board in the shared store is merged in, and the result is written back', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(1_000_000)
  mock.store(on, {
    'board:sess-1': {
      v: 1,
      savedAt: 1_000_500,
      writer: 'other-window',
      ...EMPTY,
      tasks: [task('9', 'Started in the app', 'in_progress', 1_000_400)],
    },
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { id: 'progress-board' } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__progress-board__tasks' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__progress-board__tasks', tasks: [{ subject: 'Made in the CLI', status: 'pending' }] } as never)
  await clock.advance(3_100)

  const { text } = await $.command.run(RUN)
  expect(text).toContain('Started in the app')
  expect(text).toContain('Made in the CLI')
})
