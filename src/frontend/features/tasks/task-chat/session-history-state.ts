import type { NativeHistoryMessage, SessionHistoryPage } from "../../../../tasks/history/contracts.js";

export function mergeNativeHistory(current: readonly NativeHistoryMessage[], incoming: readonly NativeHistoryMessage[], placement: "earlier" | "latest"): NativeHistoryMessage[] {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  const incomingIds = new Set(incoming.map(message => message.id));
  if (placement === "earlier") {
    const ids = [...incoming.map(message => message.id), ...current.filter(message => !incomingIds.has(message.id)).map(message => message.id)];
    return [...new Set(ids)].flatMap(id => {
      const message = messages.get(id);
      return message ? [message] : [];
    });
  }

  const currentIds = new Set(current.map(message => message.id));
  const overlapIndices = incoming.flatMap(message => currentIds.has(message.id) ? [current.findIndex(currentMessage => currentMessage.id === message.id)] : []);
  const firstOverlapIndex = overlapIndices.length ? Math.min(...overlapIndices) : -1;
  const lastOverlapIndex = overlapIndices.length ? Math.max(...overlapIndices) : -1;
  const prefix = firstOverlapIndex >= 0 ? current.slice(0, firstOverlapIndex) : current;
  const suffix = lastOverlapIndex >= 0 ? current.slice(lastOverlapIndex + 1) : [];
  const ids = [
    ...prefix.filter(message => !incomingIds.has(message.id)).map(message => message.id),
    ...incoming.map(message => message.id),
    ...suffix.filter(message => !incomingIds.has(message.id)).map(message => message.id),
  ];
  return [...new Set(ids)].flatMap(id => {
    const message = messages.get(id);
    return message ? [message] : [];
  });
}

export type LiveHistoryState = {
  messages: NativeHistoryMessage[];
  order: string[];
};

export function reconcileLiveHistory(
  current: LiveHistoryState,
  incoming: readonly NativeHistoryMessage[],
  order: readonly string[],
  removedIds: readonly string[] = [],
): LiveHistoryState {
  const removed = new Set(removedIds);
  const previousLiveIds = new Set(current.order);
  const nextLiveIds = new Set(order);
  const messagesById = new Map(current.messages.map(message => [message.id, message]));
  for (const message of incoming) messagesById.set(message.id, message);
  for (const id of removed) messagesById.delete(id);

  const olderIds = current.messages
    .map(message => message.id)
    .filter(id => !removed.has(id) && !previousLiveIds.has(id) && !nextLiveIds.has(id));
  const ids = [...olderIds, ...order.filter(id => !removed.has(id))];
  const messages = [...new Set(ids)].flatMap(id => {
    const message = messagesById.get(id);
    return message ? [message] : [];
  });
  return { messages, order: [...order] };
}

export async function readLatestHistory(current: readonly NativeHistoryMessage[], loadPage: (before?: string) => Promise<SessionHistoryPage>): Promise<SessionHistoryPage> {
  const latest = await loadPage();
  const pages = [latest];
  const currentIds = new Set(current.map(message => message.id));
  let overlaps = latest.messages.some(message => currentIds.has(message.id));
  let cursor = latest.olderCursor;
  const readCursors = new Set<string>();
  while (current.length && !overlaps && cursor && !readCursors.has(cursor)) {
    readCursors.add(cursor);
    const page = await loadPage(cursor);
    pages.push(page);
    overlaps = page.messages.some(message => currentIds.has(message.id));
    cursor = page.olderCursor;
  }
  const incoming = [...pages].reverse().flatMap(page => page.messages);
  return { messages: mergeNativeHistory(current, incoming, "latest"), olderCursor: latest.olderCursor };
}

export function readSnapshotHistory(
  current: readonly NativeHistoryMessage[],
  snapshot: SessionHistoryPage,
  loadEarlierPage: (before: string) => Promise<SessionHistoryPage>,
): Promise<SessionHistoryPage> {
  return readLatestHistory(current, before => before === undefined ? Promise.resolve(snapshot) : loadEarlierPage(before));
}

export function historyAtBottom(input: { scrollHeight: number; scrollTop: number; clientHeight: number }, tolerance = 24): boolean {
  return input.scrollHeight - input.scrollTop - input.clientHeight <= tolerance;
}

export function anchoredScrollTop(previous: { scrollHeight: number; scrollTop: number }, nextScrollHeight: number): number {
  return previous.scrollTop + nextScrollHeight - previous.scrollHeight;
}

export function sessionHistoryLabels(sessions: readonly { id: string; label: string }[]): Map<string, string> {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const session of sessions) totals.set(session.label, (totals.get(session.label) ?? 0) + 1);
  return new Map(sessions.map(session => {
    const number = (seen.get(session.label) ?? 0) + 1;
    seen.set(session.label, number);
    return [session.id, totals.get(session.label)! > 1 ? `${session.label} ${number}` : session.label];
  }));
}
