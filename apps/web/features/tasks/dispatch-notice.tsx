import { useEffect, useState } from "react";
import { Clock, TriangleAlert } from "lucide-react";
import type { DispatchNotice } from "../../contracts/generated/DispatchNotice.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";

const wakeTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Time until `timestamp`, such as "in 2m 05s". A past time is "now". */
export function timeUntil(timestamp: string, now = Date.now()): string {
  const seconds = Math.ceil((Date.parse(timestamp) - now) / 1_000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `in ${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Why the host has not dispatched the next turn. A display observation only. */
export function DispatchNoticeAlert({ notice }: { notice: DispatchNotice }) {
  const [now, setNow] = useState(() => Date.now());
  const nextWakeAt = notice.nextWakeAt;
  useEffect(() => {
    if (!nextWakeAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [nextWakeAt]);
  const waiting = notice.kind === "idle_wait";
  return <Alert variant={waiting ? "default" : "destructive"} data-dispatch-notice={notice.kind}>
    {waiting ? <Clock aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
    <AlertDescription>
      <p>{notice.text}</p>
      {nextWakeAt ? <p>Next wake <time dateTime={nextWakeAt} title={new Date(nextWakeAt).toLocaleString()}>{timeUntil(nextWakeAt, now)}</time> at {wakeTime.format(new Date(nextWakeAt))}.</p> : null}
    </AlertDescription>
  </Alert>;
}
