import type { NativeHistoryMessage, SessionHistoryPage } from "../../../../tasks/history/contracts.js";

export function mergeNativeHistory(current: readonly NativeHistoryMessage[], incoming: readonly NativeHistoryMessage[], placement: "earlier" | "latest"): NativeHistoryMessage[] {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  const incomingIds = new Set(incoming.map(message => message.id));
  const ids = placement === "earlier"
    ? [...incoming.map(message => message.id), ...current.filter(message => !incomingIds.has(message.id)).map(message => message.id)]
    : [...current.filter(message => !incomingIds.has(message.id)).map(message => message.id), ...incoming.map(message => message.id)];
  return [...new Set(ids)].map(id => messages.get(id)!);
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
