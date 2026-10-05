import type { ReactElement } from "react";
import { CircleOff, Combine, FolderGit2, GitBranch, GitMerge, GitPullRequest, GitPullRequestDraft, ListChecks, ScanEye, Send, TestTube2, UserCheck, Wrench } from "lucide-react";

import type { RepositoryConnection } from "../../contracts/project-integration.js";
import { DeliveryTargetSchema, type DeliveryTarget, type TaskInput } from "../../contracts/tasks.js";
import type { WorkflowId } from "../../contracts/workflows.js";
import { supportsDeliveryTarget } from "./lib/delivery-target-capabilities.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { TaskOptionFilter } from "./task-option-filter.js";

type VisualEvidence = NonNullable<TaskInput["visualEvidence"]>;

export const workflowIcons: Record<WorkflowId, ReactElement> = {
  standard: <ListChecks aria-hidden="true" className="size-[11px]" />,
  direct_build: <Send aria-hidden="true" className="size-[11px]" />,
  independent_review: <ScanEye aria-hidden="true" className="size-[11px]" />,
  competing_plans: <Combine aria-hidden="true" className="size-[11px]" />,
  refine_pull_request: <Wrench aria-hidden="true" className="size-[11px]" />,
  approve_then_build: <UserCheck aria-hidden="true" className="size-[11px]" />,
};

const deliveryIcons: Record<DeliveryTarget, ReactElement> = {
  local_worktree: <FolderGit2 aria-hidden="true" className="size-[11px]" />,
  remote_branch: <GitBranch aria-hidden="true" className="size-[11px]" />,
  pull_request_draft: <GitPullRequestDraft aria-hidden="true" className="size-[11px]" />,
  pull_request_ready: <GitPullRequest aria-hidden="true" className="size-[11px]" />,
  merged: <GitMerge aria-hidden="true" className="size-[11px]" />,
};

/** "with tests and proof". Tests need the project's verification command. */
export function TaskChecksOption({ runProjectTests, visualEvidence, verificationCommand, disabled, onChange }: {
  runProjectTests: boolean;
  visualEvidence: VisualEvidence;
  verificationCommand: string | undefined;
  disabled: boolean;
  onChange: (checks: { runProjectTests: boolean; visualEvidence: VisualEvidence }) => void;
}): ReactElement {
  const canTest = Boolean(verificationCommand?.trim());
  return <TaskOptionFilter prefix="with" label="Tests and proof" valueIcon={runProjectTests ? visualEvidence === "off" ? <TestTube2 aria-hidden="true" className="size-[11px]" /> : <ListChecks aria-hidden="true" className="size-[11px]" /> : visualEvidence === "off" ? <CircleOff aria-hidden="true" className="size-[11px]" /> : <ScanEye aria-hidden="true" className="size-[11px]" />} value={[...(runProjectTests ? ["tests"] : []), ...(visualEvidence !== "off" ? ["proof"] : [])]} valueLabel={[runProjectTests ? "tests" : "", visualEvidence === "off" ? "" : visualEvidence === "required" ? "necessary proof" : "proof"].filter(Boolean).join(" and ") || "no checks"} disabled={disabled} options={[{ value: "tests", label: "Tests", icon: <TestTube2 aria-hidden="true" className="size-[11px]" />, disabled: !canTest }, { value: "proof", label: "Proof", icon: <ScanEye aria-hidden="true" className="size-[11px]" /> }]} onValueChange={values => onChange({
    runProjectTests: canTest ? values.includes("tests") : runProjectTests,
    visualEvidence: values.includes("proof") ? visualEvidence === "required" ? "required" : "capture" : "off",
  })} />;
}

/** "then <delivery target>", limited to the targets the repository host supports. */
export function TaskDeliveryOption({ value, connection, disabled, onChange }: {
  value: DeliveryTarget;
  connection: RepositoryConnection | undefined;
  disabled: boolean;
  onChange: (target: DeliveryTarget) => void;
}): ReactElement {
  const options = taskDeliveryTargetOptions.filter(option => supportsDeliveryTarget(connection, option.value));
  return <TaskOptionFilter prefix="then" label="Delivery target" value={value} disabled={disabled} options={options.map(option => ({ value: option.value, icon: deliveryIcons[option.value], label: option.value === "pull_request_draft" ? "open a draft PR" : option.value === "pull_request_ready" ? "open a PR" : option.label.toLowerCase() }))} onValueChange={next => onChange(DeliveryTargetSchema.parse(next))} />;
}
