import { z } from "zod";
import type Database from "better-sqlite3";
import type { ForgeDatabase } from "../platform/database.js";

const EdgeSchema = z.object({ task_id: z.string(), depends_on_task_id: z.string() });
/**
 * One dependency gate. A declared forge_task_dependencies edge and a human-set Blocked by reference
 * are the same fact for every reader, so both arrive from one query, de-duplicated and sorted.
 * A task that names itself is not a dependency of itself.
 */
const EDGE_SOURCE = `SELECT task_id, depends_on_task_id FROM (
  SELECT task_id, depends_on_task_id FROM forge_task_dependencies
  UNION
  SELECT id AS task_id, blocked_by_task_id AS depends_on_task_id FROM forge_tasks WHERE blocked_by_task_id IS NOT NULL AND blocked_by_task_id <> id
)`;

export class TaskDependencyFailure extends Error {
  constructor(readonly publicMessage: string, readonly statusCode = 422) { super(publicMessage); }
}

export function taskDependencies(database: ForgeDatabase, taskId: string): string[] {
  return database.authQuery(db => readDependencies(db, taskId));
}

/** Every dependency edge for the given tasks, keyed by the dependent task. */
export function taskDependencyMap(database: ForgeDatabase, taskIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>(taskIds.map(id => [id, []]));
  if (!taskIds.length) return map;
  const placeholders = taskIds.map(() => "?").join(", ");
  const edges = database.authQuery(db => z.array(EdgeSchema).parse(db.prepare(`${EDGE_SOURCE} WHERE task_id IN (${placeholders}) ORDER BY depends_on_task_id`).all(...taskIds)));
  for (const edge of edges) map.get(edge.task_id)?.push(edge.depends_on_task_id);
  return map;
}

const SummarySchema = z.object({ id: z.string(), title: z.string(), status: z.string() });
export type TaskDependencySummary = z.infer<typeof SummarySchema>;

/** The dependency tasks of one task with the title and status a Coordinator needs to reason about them. */
export function taskDependencySummaries(database: ForgeDatabase, taskId: string): TaskDependencySummary[] {
  return database.authQuery(db => z.array(SummarySchema).parse(db.prepare(`SELECT t.id AS id, t.title AS title, COALESCE(c.status, 'backlog') AS status FROM (${EDGE_SOURCE} WHERE task_id = ?) d JOIN forge_tasks t ON t.id = d.depends_on_task_id LEFT JOIN forge_task_controls c ON c.task_id = t.id ORDER BY t.id`).all(taskId)));
}

function readDependencies(db: Database.Database, taskId: string): string[] {
  return z.array(EdgeSchema).parse(db.prepare(`${EDGE_SOURCE} WHERE task_id = ? ORDER BY depends_on_task_id`).all(taskId)).map(edge => edge.depends_on_task_id);
}

/**
 * Replaces the dependency set of one task. The company scope and the absence of a cycle are proven
 * inside the same transaction that writes the edges, so a concurrent write cannot introduce a loop.
 */
export function replaceTaskDependencies(database: ForgeDatabase, input: { taskId: string; companyId: string; dependsOn: string[] }): string[] {
  const dependsOn = [...new Set(input.dependsOn)].sort();
  if (dependsOn.includes(input.taskId)) throw new TaskDependencyFailure("A task cannot depend on itself");
  return database.authImmediateTransaction(db => {
    for (const dependency of dependsOn) {
      const row = db.prepare("SELECT company_id FROM forge_tasks WHERE id = ?").get(dependency) as { company_id: string } | undefined;
      if (!row || row.company_id !== input.companyId) throw new TaskDependencyFailure("A dependency task is not available", 404);
    }
    db.prepare("DELETE FROM forge_task_dependencies WHERE task_id = ?").run(input.taskId);
    const stamp = new Date().toISOString();
    for (const dependency of dependsOn) db.prepare("INSERT INTO forge_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)").run(input.taskId, dependency, stamp);
    // The walk crosses Blocked by edges too, so a loop through one is rejected here.
    assertNoCycle(db, input.taskId);
    return readDependencies(db, input.taskId);
  });
}

/** Walks the dependency edges from one task; reaching the task again proves a cycle. */
function assertNoCycle(db: Database.Database, taskId: string): void {
  const seen = new Set<string>();
  const queue = readDependencies(db, taskId);
  while (queue.length) {
    const next = queue.shift()!;
    if (next === taskId) throw new TaskDependencyFailure("The dependency creates a cycle");
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...readDependencies(db, next));
  }
}

/** Dependency-first order for the given tasks. Tasks with an equal position keep their input order. */
export function topologicalTaskOrder<T extends { id: string; dependsOn: string[] }>(entries: T[]): T[] {
  const remaining = new Map(entries.map(entry => [entry.id, entry]));
  const emitted = new Set<string>();
  const ordered: T[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(entry => entry.dependsOn.every(id => !remaining.has(id) || emitted.has(id)));
    // A cycle cannot reach the store, but a partial view can hide an edge; emit the rest in input order.
    const batch = ready.length ? ready : [...remaining.values()];
    for (const entry of batch) { ordered.push(entry); emitted.add(entry.id); remaining.delete(entry.id); }
  }
  return ordered;
}
