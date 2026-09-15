import type { NativeHistoryMessage } from "./contracts.js";

export interface SessionHistoryChange {
  messages: NativeHistoryMessage[];
  removedIds: string[];
  order: string[];
}

export interface SessionHistoryPollOptions {
  read: () => Promise<NativeHistoryMessage[]>;
  onHistory: (messages: NativeHistoryMessage[], recovered: boolean) => Promise<void> | void;
  onError: (error: unknown) => Promise<void> | void;
  intervalMs: number;
  maximumErrorIntervalMs?: number;
}

export function diffSessionHistory(previous: readonly NativeHistoryMessage[], next: readonly NativeHistoryMessage[]): SessionHistoryChange | null {
  const previousById = new Map(previous.map(message => [message.id, message]));
  const nextIds = new Set(next.map(message => message.id));
  const messages = next.filter(message => {
    const existing = previousById.get(message.id);
    return !existing || JSON.stringify(existing) !== JSON.stringify(message);
  });
  const removedIds = previous.flatMap(message => nextIds.has(message.id) ? [] : [message.id]);
  const order = next.map(message => message.id);
  const previousOrder = previous.map(message => message.id);
  if (!messages.length && !removedIds.length && previousOrder.every((id, index) => order[index] === id) && previousOrder.length === order.length) return null;
  return { messages, removedIds, order };
}

export function pollSessionHistory(options: SessionHistoryPollOptions): () => void {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let failed = false;
  let consecutiveFailures = 0;
  const maximumErrorIntervalMs = options.maximumErrorIntervalMs ?? 8_000;

  const schedule = (delayMs: number): void => {
    if (closed) return;
    timer = setTimeout(() => { void poll(); }, delayMs);
    timer.unref();
  };
  const poll = async (): Promise<void> => {
    try {
      const messages = await options.read();
      if (closed) return;
      await options.onHistory(messages, failed);
      if (closed) return;
      failed = false;
      consecutiveFailures = 0;
      schedule(options.intervalMs);
    } catch (error) {
      if (closed) return;
      failed = true;
      consecutiveFailures += 1;
      await options.onError(error);
      if (closed) return;
      const retryMs = Math.min(maximumErrorIntervalMs, options.intervalMs * 2 ** Math.min(consecutiveFailures, 8));
      schedule(retryMs);
    }
  };

  void poll();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}
