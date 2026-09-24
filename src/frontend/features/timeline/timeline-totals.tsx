import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { Collapsible } from "../../components/ui/collapsible.js";
import { withCompany } from "../../lib/api.js";
import type { WorkTimelineSummary, WorkTotal } from "./timeline-model.js";
import { formatDuration } from "./timeline-format.js";

function SummaryTable({
  label,
  totals,
  companyId,
  tickets = false,
}: {
  label: string;
  totals: WorkTotal[];
  companyId: string;
  tickets?: boolean;
}): ReactElement {
  const totalDurationMs = totals.reduce(
    (total, item) => total + item.durationMs,
    0,
  );
  return (
    <section
      aria-label={label}
      className="min-w-0 border-t border-border/70 lg:border-r lg:last:border-r-0"
    >
      <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/30 px-3 text-xs sm:px-4">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {totals.length} · {formatDuration(totalDurationMs)}
        </span>
      </div>
      {totals.length === 0 ? (
        <div className="px-3 py-6 text-xs text-muted-foreground sm:px-4">
          No recorded time in this range.
        </div>
      ) : (
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-20" />
          </colgroup>
          <thead className="sr-only">
            <tr>
              <th>Item</th>
              <th>Invocations</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((total) => (
              <tr
                key={total.key}
                className="border-b border-border/55 last:border-b-0"
              >
                <td className="min-w-0 px-3 py-2 sm:px-4">
                  {tickets ? (
                    <a
                      className="block truncate font-medium hover:underline"
                      href={withCompany(
                        `/tasks/${encodeURIComponent(total.key)}`,
                        companyId,
                      )}
                    >
                      {total.issueKey ? (
                        <span className="mr-1.5 font-normal text-muted-foreground">
                          {total.issueKey}
                        </span>
                      ) : null}
                      {total.label}
                    </a>
                  ) : (
                    <span className="block truncate font-medium">
                      {total.label}
                    </span>
                  )}
                  <span className="block truncate text-xs text-muted-foreground">
                    {total.secondary}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-muted-foreground">
                  {total.invocationCount}×
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums sm:px-4">
                  {formatDuration(total.durationMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function TimelineTotals({
  summary,
  groupByProject,
  companyId,
}: {
  summary: WorkTimelineSummary;
  groupByProject: boolean;
  companyId: string;
}): ReactElement {
  const groups =
    summary.projectGroups.length > 0
      ? summary.projectGroups
      : [
          {
            projectId: "empty",
            projectName: "",
            ticketTotals: [],
            dayTotals: [],
            durationMs: 0,
          },
        ];
  if (!groupByProject)
    return (
      <div className="grid lg:grid-cols-2">
        <SummaryTable
          label="Daily agent-hours"
          totals={summary.dayTotals}
          companyId={companyId}
        />
        <SummaryTable
          label="Ticket totals"
          totals={summary.ticketTotals}
          companyId={companyId}
          tickets
        />
      </div>
    );
  return (
    <div>
      {groups.map((group) =>
        group.projectName ? (
          <Collapsible.Root
            key={group.projectId}
            className="group/timeline-project"
          >
            <Collapsible.Trigger
              data-project-header={group.projectName}
              className="flex h-9 w-full items-center gap-2 border-t border-border/70 bg-muted/30 px-3 text-left text-xs font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-4"
            >
              <ChevronRight className="size-3 text-muted-foreground transition-transform group-data-[open]/timeline-project:rotate-90" />
              <span>{group.projectName}</span>
              <span className="ml-auto">
                {group.ticketTotals.length} tickets ·{" "}
                {formatDuration(group.durationMs)}
              </span>
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <div className="grid lg:grid-cols-2">
                <SummaryTable
                  label="Daily agent-hours"
                  totals={group.dayTotals}
                  companyId={companyId}
                />
                <SummaryTable
                  label="Ticket totals"
                  totals={group.ticketTotals}
                  companyId={companyId}
                  tickets
                />
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ) : (
          <div key={group.projectId} className="grid lg:grid-cols-2">
            <SummaryTable
              label="Daily agent-hours"
              totals={group.dayTotals}
              companyId={companyId}
            />
            <SummaryTable
              label="Ticket totals"
              totals={group.ticketTotals}
              companyId={companyId}
              tickets
            />
          </div>
        ),
      )}
    </div>
  );
}
