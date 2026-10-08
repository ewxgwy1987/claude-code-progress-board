export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TaskItem = {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  doneAt?: number
  updatedAt?: number
  pausedAt?: number
  pausedMs?: number
  blockedBy: string[]
}

export type AgentItem = {
  id: string
  description: string
  type: string
  status: string
  startedAt: number
  doneAt?: number
  tools: number
  lastTool?: string
  isSeeded?: boolean
  isTeammate?: boolean
}

export type CallStatus = 'running' | 'done' | 'failed'

export type CallItem = {
  id: string
  tool: string
  label: string
  status: CallStatus
  startedAt: number
  doneAt?: number
}

export type Activity = {
  isRunning: boolean
  startedAt: number
  endedAt?: number
  calls: CallItem[]
  total: number
}

export type WorkflowAgent = {
  id: string
  n: number
  status: string
  startedAt: number
  doneAt?: number
  tools: number
  lastTool?: string
  isForced?: boolean
  label?: string
  phase?: string
}

export type WorkflowItem = {
  taskId: string
  toolUseId: string
  name: string
  status: string
  startedAt: number
  doneAt?: number
  agents: WorkflowAgent[]
  agentCount?: number
  transcriptDir?: string
  tools: number
  lastTool?: string
  isForced?: boolean
}

export type GoalStatus = 'active' | 'declined' | 'cleared'

export type Goal = {
  condition: string
  status: GoalStatus
  setBy: 'claude' | 'you'
  setAt: number
  endedAt?: number
  turns: number
}

export type Durations = {
  task: number[]
  agent: Record<string, number[]>
  tool: Record<string, number[]>
  turn: number[]
  workflow: Record<string, number[]>
}

declare module 'claude-code' {
  interface PluginState {
    'progress-board': {
      tasks: TaskItem[]
      agents: AgentItem[]
      durations: Durations
      activity: Activity | null
      workflows: WorkflowItem[]
      goal: Goal | null
      now: number
      isOpened: boolean
      isWrapped: boolean | null
    }
  }
}
