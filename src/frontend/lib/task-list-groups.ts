import { ACTIVE_PHASES } from "../../issue-phases.js";
import type { TaskPhase } from "./view-shared.js";

export type TaskListFilter = "active" | "backlog" | "all" | "archived";
export type TaskListGroupId = "active" | "backlog" | "blocked" | "completed" | "cancelled";

export function taskListGroups<Task extends { phase: TaskPhase; blocked: boolean; updatedAt: string }>(tasks: readonly Task[], filter: TaskListFilter): Array<{ id: TaskListGroupId; title: string; tasks: Task[] }> {
  const groups: Array<{ id: TaskListGroupId; title: string; tasks: Task[] }> = [
    { id: "active", title: "In progress", tasks: tasks.filter((task) => ACTIVE_PHASES.has(task.phase) && !task.blocked) },
    { id: "backlog", title: "Backlog", tasks: tasks.filter((task) => task.phase === "backlog") },
    { id: "blocked", title: "Blocked", tasks: tasks.filter((task) => task.blocked) },
    { id: "completed", title: "Completed", tasks: tasks.filter((task) => task.phase === "done") },
    { id: "cancelled", title: "Cancelled", tasks: tasks.filter((task) => task.phase === "cancelled") },
  ];

  return groups
    .filter((group) => {
      if (!group.tasks.length || filter === "all") return group.tasks.length > 0;
      if (filter === "archived") return group.id === "completed" || group.id === "cancelled";
      return filter === "active" ? group.id === "active" || group.id === "blocked" : group.id === filter;
    })
    .map((group) => ({ ...group, tasks: [...group.tasks].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)) }));
}
