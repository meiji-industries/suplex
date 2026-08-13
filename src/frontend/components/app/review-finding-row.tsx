import { ChevronDown } from "lucide-react";
import { type ReactElement } from "react";

import { Collapsible } from "../ui/collapsible.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import type { ReviewFindingResponse } from "../../../http/contracts/tasks.js";

type Finding = ReviewFindingResponse;

export function ReviewFindingRow({ finding }: { finding: Finding }): ReactElement {
  const blocking = finding.severity === "blocking";
  return (
    <Collapsible.Root>
      <div className="min-w-0 border-b last:border-b-0">
        <Collapsible.Trigger render={<Button variant="ghost" size="sm" />}>
          <span className="min-w-0 flex-1 text-left">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant={blocking ? "destructive" : "outline"}>{finding.severity}</Badge>
              <code className="min-w-0 max-w-full truncate text-[11px]">{finding.id}</code>
              <span className="text-[11px] text-muted-foreground">{finding.disposition}</span>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{finding.evidenceRef}</span>
          </span>
          <ChevronDown aria-hidden="true" />
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <div className="space-y-2 px-2 pb-2 text-[12px]">
            <p className="whitespace-pre-wrap break-words">{finding.rationale}</p>
            {finding.repairInstruction ? <div><div className="font-medium">Repair instruction</div><p className="whitespace-pre-wrap break-words text-muted-foreground">{finding.repairInstruction}</p></div> : null}
          </div>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
}
