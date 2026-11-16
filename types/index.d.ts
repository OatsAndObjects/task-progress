export type TaskProgressRecord = {
  /** Short task name, at most 40 characters. */
  task: string
  /** The model's current estimate of the number of steps. */
  totalSteps: number
  /** Steps completed so far, within 0..totalSteps. */
  step: number
  /** What is happening now. */
  label: string
  /** Epoch ms when this task was first reported. */
  startedAt: number
  /** Step count before the last call, for the fill animation. */
  prevStep: number
  /** How far through the previous step the bar showed when the last call came (0..0.9). */
  prevFill: number
  /** Epoch ms of the last call. */
  lastStepAt: number
  /** True once the task was reported finished. */
  isDone: boolean
  /** Epoch ms when it finished (0 while running). */
  finishedAt: number
}

export type PlanStep = { title: string; minutes: number; executor?: string }

export type TaskPlanRecord = {
  task: string
  steps: PlanStep[]
  /** Epoch ms when the plan was registered. */
  createdAt: number
}

/** One running (budgeted) executor sub-agent. */
export type ExecutorRun = {
  /** The sub-agent's id: `agentId` on its tool calls. */
  id: string
  /** The plan step from the `[budget: Nm step: k]` tag, if it had one. */
  step: number | null
  /** Epoch ms when it was dispatched. */
  startedAt: number
  /** Its time budget in ms. */
  budgetMs: number
  /** True once the 80% wrap-up notice has been given. */
  isWarned: boolean
}

/** A dispatch seen at `agent.spawn` whose agent id is not known yet. */
export type PendingRun = Omit<ExecutorRun, 'id'>

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'over'
export type SnapshotPlanStep = {
  /** 1-based step number, as in `[budget: Nm step: k]`. */
  k: number
  title: string
  minutes: number
  status: PlanStepStatus
  agentId?: string
  startedAt?: number
  endedAt?: number
}
export type AgentEntryStatus = 'running' | 'done' | 'failed' | 'stopped' | 'idle'
export type SnapshotAgent = {
  id: string
  description: string
  type: string
  status: AgentEntryStatus
  startedAt: number
  endedAt?: number
  budgetMin?: number
  step?: number
}
export type ShellStatus = 'running' | 'done' | 'failed' | 'stopped'
export type SnapshotShell = {
  id: string
  command: string
  description: string
  status: ShellStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
}
export type SnapshotFile = { path: string; op: 'edit' | 'write'; count: number; lastAt: number }
export type SnapshotToolEntry = { at: number; tool: string; summary: string; agentId?: string; ok: boolean }
export type UserTaskStatus = 'todo' | 'doing' | 'blocked' | 'done'
export type UserTaskPriority = 'low' | 'med' | 'high'
export type UserTask = {
  id: string
  title: string
  notes: string
  status: UserTaskStatus
  priority: UserTaskPriority
  createdAt: number
  updatedAt: number
  source: 'user' | 'plan'
}
/** The session dashboard's whole state; the web app reads exactly this shape. */
export type Snapshot = {
  session: { id: string; cwd: string; startedAt: number }
  orchestrate: boolean
  progress: { task: string; step: number; totalSteps: number; label: string; done: boolean } | null
  plan: { task: string; steps: SnapshotPlanStep[] } | null
  agents: SnapshotAgent[]
  shells: SnapshotShell[]
  files: SnapshotFile[]
  /** Newest last, at most 200. */
  toolLog: SnapshotToolEntry[]
  tasks: UserTask[]
}
/** A dashboard command, from the pane or the web bridge: `{ action, ...args }`. */
export type DashboardCommand = { action: string; [arg: string]: unknown }
export type DashboardCommandResult = { ok: boolean; message: string }
/** The running web bridge, if any. */
export type DashboardWeb = { port: number; url: string }

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      progress: TaskProgressRecord | null
      hidden: boolean
      frame: number
      /** Orchestrator mode; unset means on. */
      mode: 'on' | 'off'
      /** True once TaskInputs has been answered for the current user prompt. */
      inputsChecked: boolean
      plan: TaskPlanRecord | null
      runs: ExecutorRun[]
      pending: PendingRun[]
      /** The session dashboard (written throttled). */
      snapshot: Snapshot | null
      /** The dashboard web server while it runs. */
      web: DashboardWeb | null
    }
  }
}
