export type TaskDetailStatus = { phase: string; terminal: boolean; revision: number };

export function taskDetailNeedsRefresh(current: TaskDetailStatus | undefined, next: TaskDetailStatus): boolean {
  return current !== undefined && (current.phase !== next.phase || current.terminal !== next.terminal || current.revision !== next.revision);
}
