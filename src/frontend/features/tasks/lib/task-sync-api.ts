import type { SyncMessage } from "../../../contracts/generated/SyncMessage.js";
import { clientTabId } from "../../../shell/client-lifecycle.js";

const reconnectDelay = (attempt: number): number => Math.min(10_000, 1_000 * 2 ** attempt);
/** The server sends a frame every 15 seconds. Three missed frames mean the socket is dead. */
const silenceLimit = 45_000;

/**
 * Opens the company sync socket and opens it again after each loss.
 * `onDown` runs when the socket closes or goes silent. Returns the function that closes it.
 */
export function openTaskSync(companyId: string, onMessage: (message: SyncMessage) => void, onDown: () => void): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: number | undefined;
  let watchdog: number | undefined;
  let attempt = 0;
  const release = (source: WebSocket): void => {
    window.clearTimeout(watchdog);
    source.onmessage = null;
    source.onclose = null;
    source.close();
  };
  const down = (source: WebSocket): void => {
    if (disposed || source !== socket) return;
    socket = undefined;
    release(source);
    onDown();
    retry = window.setTimeout(connect, reconnectDelay(attempt++));
  };
  const connect = (): void => {
    if (disposed) return;
    let next: WebSocket;
    try {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const tabId = clientTabId();
      next = new WebSocket(`${scheme}://${location.host}/api/companies/${encodeURIComponent(companyId)}/sync${tabId ? `?tabId=${encodeURIComponent(tabId)}` : ""}`);
    } catch {
      // No WebSocket is available. The task list keeps its HTTP reads.
      return;
    }
    socket = next;
    const heard = (): void => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => down(next), silenceLimit);
    };
    heard();
    next.onmessage = event => {
      let message: SyncMessage;
      try { message = JSON.parse(String(event.data)); } catch { down(next); return; }
      attempt = 0;
      heard();
      onMessage(message);
    };
    next.onclose = () => down(next);
  };
  connect();
  return () => {
    disposed = true;
    window.clearTimeout(retry);
    if (socket) release(socket);
    socket = undefined;
  };
}
