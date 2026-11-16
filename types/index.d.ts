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
    }
  }
}
