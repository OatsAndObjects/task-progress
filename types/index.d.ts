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

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { progress: TaskProgressRecord | null; hidden: boolean; frame: number }
  }
}
