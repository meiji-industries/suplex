"use client";

import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";

const Collapsible = BaseCollapsible.Root;
const CollapsibleContent = BaseCollapsible.Panel;
const CollapsibleTrigger = BaseCollapsible.Trigger;
import { cn } from "../../lib/utils.js";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  PlusIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block.js";

export type ToolProps = Omit<ComponentProps<typeof Collapsible>, "className"> & { className?: string };

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose w-full min-w-0", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  input?: ToolPart["input"];
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-3 text-blue-600" />,
  "input-available": <ClockIcon className="size-3 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-3" />,
  "output-available": <CheckCircleIcon className="size-3 text-green-600" />,
  "output-denied": <XCircleIcon className="size-3 text-orange-600" />,
  "output-error": <XCircleIcon className="size-3 text-red-600" />,
};

const shellTools = new Set(["bash", "shell", "terminal", "exec", "run"]);

/** One-line preview of a tool input: the first string field, else compact JSON. */
export const summarizeToolInput = (input: ToolPart["input"]): string => {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const text = Object.values(input as Record<string, unknown>).find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (text) return text.replace(/\s+/g, " ").trim();
    return JSON.stringify(input);
  }
  return "";
};

export const ToolHeader = ({
  className,
  title,
  input,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const name = title ?? derivedName;
  const Icon = shellTools.has(name.toLowerCase()) ? TerminalIcon : WrenchIcon;
  const summary = summarizeToolInput(input);

  return (
    <CollapsibleTrigger
      className={cn(
        "group/collapsible -mx-1.5 flex max-w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-muted/50",
        className
      )}
      title={summary || undefined}
      {...props}
    >
      <span className="relative shrink-0">
        <Icon className="size-3 text-muted-foreground group-hover/collapsible:opacity-0" />
        <PlusIcon className="absolute inset-0 m-auto hidden size-3 text-muted-foreground group-hover/collapsible:block group-data-[panel-open]:rotate-45" />
      </span>
      <span className="shrink-0 text-sm">{name}</span>
      {summary ? (
        <span className="truncate rounded-md bg-muted px-1 py-0.5 font-mono text-xs font-medium text-muted-foreground">{summary}</span>
      ) : null}
      {state !== "output-available" ? <span className="shrink-0" title={statusLabels[state]} aria-label={statusLabels[state]}>{statusIcons[state]}</span> : null}
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = Omit<ComponentProps<typeof CollapsibleContent>, "className"> & { className?: string };

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[closed]:fade-out-0 data-[closed]:slide-out-to-top-2 data-[open]:slide-in-from-top-2 space-y-3 py-2 pl-5 text-popover-foreground outline-none data-[closed]:animate-out data-[open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
