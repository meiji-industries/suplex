"use client";

import { Button } from "../ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card.js";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";

const Collapsible = BaseCollapsible.Root;
const CollapsibleContent = BaseCollapsible.Panel;
const CollapsibleTrigger = BaseCollapsible.Trigger;
import { cn } from "../../lib/utils.js";
import { ChevronsUpDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";

import { Shimmer } from "./shimmer.js";

interface PlanContextValue {
  isStreaming: boolean;
}

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error("Plan components must be used within Plan");
  }
  return context;
};

export type PlanProps = Omit<ComponentProps<typeof Collapsible>, "className"> & { className?: string } & {
  isStreaming?: boolean;
};

export const Plan = ({
  className,
  isStreaming = false,
  children,
  ...props
}: PlanProps) => {
  const contextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

  return (
    <PlanContext.Provider value={contextValue}>
      <Collapsible data-slot="plan" render={<Card className={cn("shadow-none", className)} />} {...props}>{children}</Collapsible>
    </PlanContext.Provider>
  );
};

export type PlanHeaderProps = ComponentProps<typeof CardHeader>;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
  <CardHeader
    className={cn("flex items-start justify-between", className)}
    data-slot="plan-header"
    {...props}
  />
);

export type PlanTitleProps = Omit<
  ComponentProps<typeof CardTitle>,
  "children"
> & {
  children: string;
};

export const PlanTitle = ({ children, ...props }: PlanTitleProps) => {
  const { isStreaming } = usePlan();

  return (
    <CardTitle data-slot="plan-title" {...props}>
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </CardTitle>
  );
};

export type PlanDescriptionProps = Omit<
  ComponentProps<typeof CardDescription>,
  "children"
> & {
  children: string;
};

export const PlanDescription = ({
  className,
  children,
  ...props
}: PlanDescriptionProps) => {
  const { isStreaming } = usePlan();

  return (
    <CardDescription
      className={cn("text-balance", className)}
      data-slot="plan-description"
      {...props}
    >
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </CardDescription>
  );
};

export type PlanActionProps = ComponentProps<typeof CardAction>;

export const PlanAction = (props: PlanActionProps) => (
  <CardAction data-slot="plan-action" {...props} />
);

export type PlanContentProps = ComponentProps<typeof CardContent>;

export const PlanContent = (props: PlanContentProps) => (
  <CollapsibleContent render={<CardContent data-slot="plan-content" {...props} />} />
);

export type PlanFooterProps = ComponentProps<"div">;

export const PlanFooter = (props: PlanFooterProps) => (
  <CardFooter data-slot="plan-footer" {...props} />
);

export type PlanTriggerProps = Omit<ComponentProps<typeof CollapsibleTrigger>, "className"> & { className?: string };

export const PlanTrigger = ({ className, ...props }: PlanTriggerProps) => (
  <CollapsibleTrigger render={<Button size="icon" variant="ghost" />}
      className={cn("size-8", className)}
      data-slot="plan-trigger"
      {...props}
    >
      <ChevronsUpDownIcon className="size-4" />
      <span className="sr-only">Toggle plan</span>
  </CollapsibleTrigger>
);
