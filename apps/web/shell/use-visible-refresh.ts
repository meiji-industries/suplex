import { useEffect, useRef } from "react";

/**
 * Calls `read` every `intervalMs` while the document is visible, and again
 * when the window gets focus or the document becomes visible. A focus or
 * visibility read comes at most once in `minGapMs` after the last read.
 */
export function useVisibleRefresh(read: () => void, intervalMs: number, { enabled = true, minGapMs = 0 }: { enabled?: boolean; minGapMs?: number } = {}): void {
  const latest = useRef(read);
  useEffect(() => { latest.current = read; }, [read]);

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const run = (throttled: boolean): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (throttled && now - last < minGapMs) return;
      last = now;
      latest.current();
    };
    const timer = window.setInterval(() => run(false), intervalMs);
    const onFocus = (): void => run(true);
    const onVisibility = (): void => { if (document.visibilityState === "visible") run(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, minGapMs]);
}
