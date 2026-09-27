import type { TaskUsage, UsageTokens } from "../../../contracts/usage.js";

function emptyTokens(): UsageTokens { return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }; }
function addTokens(total: UsageTokens, value: UsageTokens): void { total.input += value.input; total.output += value.output; total.reasoning += value.reasoning; total.cache.read += value.cache.read; total.cache.write += value.cache.write; }

export function usageIsUnpriced(entry: TaskUsage): boolean {
  return entry.cost === 0 && entry.tokens.input + entry.tokens.output + entry.tokens.reasoning + entry.tokens.cache.read + entry.tokens.cache.write > 0;
}

export function usageMetrics(usage: TaskUsage[]) {
  const tokens = emptyTokens();
  const root = new Set<string>();
  const worker = new Set<string>();
  const failed = new Set<string>();
  const turns = new Map<string, Map<string, [number, number]>>();
  let cost = 0;
  let steps = 0;
  let unpricedMessages = 0;
  let subsidizedMessages = 0;
  for (const entry of usage) {
    addTokens(tokens, entry.tokens); cost += entry.cost; steps += entry.steps;
    if (usageIsUnpriced(entry)) unpricedMessages += 1;
    if (entry.subsidized) subsidizedMessages += 1;
    const turn = `${entry.sessionId}:${entry.turnId}`;
    (entry.role === "root" ? root : worker).add(turn);
    if (entry.failed) failed.add(turn);
    if (entry.completedAt !== null) {
      const session = turns.get(entry.sessionId) ?? new Map<string, [number, number]>();
      const current = session.get(entry.turnId);
      const finish = Math.max(entry.startedAt, entry.completedAt);
      session.set(entry.turnId, current
        ? [Math.min(current[0], entry.startedAt), Math.max(current[1], finish)]
        : [entry.startedAt, finish]);
      turns.set(entry.sessionId, session);
    }
  }
  let durationMs = 0;
  let measuredDuration = false;
  for (const session of turns.values()) {
    const list = [...session.values()].filter(([start, finish]) => finish > start);
    let end = -Infinity;
    for (const [start, finish] of list.sort((a, b) => a[0] - b[0])) {
      durationMs += Math.max(0, finish - Math.max(start, end));
      end = Math.max(end, finish);
      measuredDuration = true;
    }
  }
  return { cost: usage.length && (cost > 0 || unpricedMessages === 0) ? cost : null, measuredMessages: usage.length, unpricedMessages, subsidized: subsidizedMessages > 0 && usage.every(entry => entry.subsidized || entry.cost <= 0), subsidizedMessages, tokens, totalTokens: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
    turns: root.size + worker.size, rootTurns: root.size, workerTurns: worker.size, steps, failedTurns: failed.size,
    incompleteMessages: usage.filter(entry => entry.completedAt === null).length,
    summaries: usage.filter(entry => entry.summary).length, durationMs: measuredDuration ? durationMs : null };
}

export function percentile(values: number[], percent: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * percent;
  const lower = ordered[Math.floor(index)];
  const upper = ordered[Math.ceil(index)];
  return lower === undefined || upper === undefined ? null : lower + (upper - lower) * (index - Math.floor(index));
}
