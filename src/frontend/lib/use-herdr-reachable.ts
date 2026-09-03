import { useEffect, useState } from "react";

export function useHerdrReachable(sseDisconnected = false): boolean | undefined {
  const [reachable, setReachable] = useState<boolean>();
  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try { const response = await fetch("/api/health"); const body = await response.json() as { herdr?: { reachable: boolean } }; if (active) setReachable(body.herdr?.reachable ?? false); }
      catch { if (active) setReachable(false); }
    };
    void refresh();
    if (!sseDisconnected && reachable !== false) return () => { active = false; };
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [reachable, sseDisconnected]);
  return reachable;
}
