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
  /** From the dispatch tag: the cube this agent builds or reviews. */
  cube?: { id: string; kind: 'build' | 'review' }
  /** Short summary of its latest tool call, e.g. `Edit hooks/x.ts`. */
  lastTool?: string
}
/** One function-level step of a cube. Boards stored before 0.10 hold strings, normalized to `{file:'',fn:'',does}`. */
export type FlowStep = {
  /** Repo-relative path, or "shell" / "browser" / "terminal" for non-code steps. */
  file: string
  /** Function, method or component; for non-code steps the command or tool. */
  fn: string
  /** One short sentence. */
  does: string
  /** Optional "file:fn" of the next function it calls. */
  calls?: string
}
/** One piece of code a cube will touch. */
export type CodeTouch = {
  /** Repo-relative path, may include " › function". */
  file: string
  /** Short plain description of the change. */
  change: string
}
export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'NEEDS_INVESTIGATION'
export type ReviewFinding = { severity: 'P0' | 'P1' | 'P2' | 'P3'; file?: string; line?: number; summary: string }
export type ReviewQuiz = { q: string; options: string[]; answer: number }
/** The pr-reviewer stage every cube ends with. */
export type CubeReview = {
  status: 'running' | 'passed' | 'changes' | 'investigate'
  verdict?: ReviewVerdict
  summary?: string
  understanding?: string
  findings?: ReviewFinding[]
  quiz?: ReviewQuiz[]
  at: number
}
export type CubeStatus = 'proposed' | 'approved' | 'queued' | 'running' | 'reviewing' | 'done' | 'failed' | 'skipped' | 'rejected' | 'revising'
/** One atomic unit of a task the user approves before it runs. */
export type Cube = {
  /** `c1`, `c2`, ... (lower case). */
  id: string
  title: string
  /** One sentence: the single thing this cube does. */
  action: string
  /** 2-6 ordered function-level steps inside the cube. */
  flow: FlowStep[]
  /** Ids of cubes that must be done first. */
  after: string[]
  /** A verifiable check that proves the cube is done. */
  doneWhen: string
  files?: string[]
  /** Legacy plain-words paragraph (older plans); the web falls back to it. */
  details?: string
  /** 1-2 plain sentences: what this cube does and why (max 300 chars). */
  summary?: string
  /** Points: exactly what problem this cube solves (1-6). */
  problem?: string[]
  /** Plain-words steps Claude will take (1-8); `flow` stays the function-level call graph. */
  steps?: string[]
  /** Code that will be touched (1-10). */
  code?: CodeTouch[]
  /** At most 10. */
  minutes: number
  status: CubeStatus
  /** The user's change request (or rejection reason). */
  note?: string
  editedBy?: 'user' | 'claude'
  version: number
  agentId?: string
  startedAt?: number
  endedAt?: number
  /** Questions the user asked about this step and Claude's answers (never changes the cube). */
  thread?: CubeMessage[]
  /** The PR review of this cube's changes (pr-reviewer skill). */
  review?: CubeReview
}
export type CubeMessage = { role: 'user' | 'claude'; text: string; at: number }
export type CubeBoard = {
  task: string
  /** When true, only cubes the user approved may be dispatched. */
  gate: boolean
  cubes: Cube[]
  /** Key of the reviewing cubes the combined review prompt was last sent for (ids and finish times). */
  reviewSent?: string
  /** Cube ids grouped by dependency depth (computed): lane 0 has no deps. */
  lanes: string[][]
}
/** Usage numbers shown on the dashboard. */
export type SnapshotUsage = {
  context: { tokens: number | null; window: number; percent: number | null }
  fiveHour: { percent: number; resetsAt: string | null } | null
  weekly: { percent: number; resetsAt: string | null } | null
  cost: { usd: number } | null
  /** Session totals, summed from each turn's usage. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Total tokens of the last 40 turns, newest last. */
  perTurn: number[]
  /** Who used the tokens (all optional; the Usage screen reads this). */
  breakdown?: { byCube: UsageSlice[]; byAgent: UsageSlice[]; byModel: UsageSlice[]; context: UsageSlice[] }
  /** The 20 biggest tool results, largest first. */
  topTools?: { tool: string; target: string; tokens: number }[]
  updatedAt: number
}
export type UsageSlice = { label: string; tokens: number }
/** The session dashboard's whole state; the web app reads exactly this shape. */
export type Snapshot = {
  session: { id: string; cwd: string; startedAt: number }
  orchestrate: boolean
  progress: { task: string; step: number; totalSteps: number; label: string; done: boolean } | null
  plan: { task: string; steps: SnapshotPlanStep[] } | null
  agents: SnapshotAgent[]
  /** The approval cube board of the current task, if it was planned in cubes. */
  cubes: CubeBoard | null
  usage: SnapshotUsage | null
  /** The /context output saved when the last cube of a plan finished (then /clear ran). */
  lastContextMap?: { at: number; text: string; file: string }
}
/** A dashboard command, from the web bridge: `{ action, ...args }`. */
export type DashboardCommand = { action: string; [arg: string]: unknown }
export type DashboardCommandResult = { ok: boolean; message: string; data?: Record<string, unknown> }

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
      /** Approval gate for new cube boards; unset means on. */
      cubesGate: 'on' | 'off'
      /** Prompts a tool call could not submit; sent on the next turn.complete. */
      deferredPrompts: string[]
      /** True once the Approach question was asked for the current plan. */
      approachAsked: boolean
      /** True after a person closed the Cubes pane, until the next plan. */
      cubesPaneClosed: boolean
      /** Cube ids whose details are open in the Cubes pane. */
      cubesPaneOpen: string[]
      /** Counter bumped by the agent poll while an agent runs, so the Cubes pane redraws its countdown. */
      paneTick: number
    }
  }
}
