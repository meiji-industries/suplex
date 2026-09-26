import type { z } from "zod";
import type { TaskChecksResponseSchema } from "../../contracts/task-responses.js";
import { TestResults, TestResultsHeader, TestResultsSummary, TestResultsContent, Test, TestName, TestStatus } from "../../components/ai-elements/test-results.js";

const statuses = { successful: "passed", failing: "failed", pending: "running" } as const;
const skipped = (run: z.infer<typeof TaskChecksResponseSchema>["runs"][number]) => run.conclusion === "SKIPPED" || run.conclusion === "NEUTRAL";
export function TaskCheckResults({ runs }: { runs: z.infer<typeof TaskChecksResponseSchema>["runs"] }) {
  const summary = { total: runs.length, passed: runs.filter(run => run.status === "successful" && !skipped(run)).length, failed: runs.filter(run => run.status === "failing").length, skipped: runs.filter(run => run.conclusion === "SKIPPED").length };
  const pending = runs.filter(run => run.status === "pending").length;
  const neutral = runs.filter(run => run.conclusion === "NEUTRAL").length;
  return <TestResults summary={summary}>
    <TestResultsHeader><div className="grid gap-2"><h3 className="text-sm font-medium">GitHub check runs</h3><TestResultsSummary />{pending ? <p className="text-xs text-muted-foreground">{pending} pending</p> : null}{neutral ? <p className="text-xs text-muted-foreground">{neutral} neutral</p> : null}</div></TestResultsHeader>
    <TestResultsContent>{runs.map((run, index) => <Test key={`${run.name}:${index}`} name={run.name} status={skipped(run) ? "skipped" : statuses[run.status]}>
      <TestStatus /><TestName><span className="break-all">{run.name}</span></TestName><span className="text-xs">{run.conclusion === "NEUTRAL" ? "Neutral" : skipped(run) ? "Skipped" : run.status === "pending" ? "Pending" : run.status === "failing" ? "Failed" : "Passed"}</span>
      {run.url ? <a href={run.url} target="_blank" rel="noreferrer" aria-label={`Open ${run.name}`} className="text-xs underline">Open</a> : null}
    </Test>)}</TestResultsContent>
  </TestResults>;
}
