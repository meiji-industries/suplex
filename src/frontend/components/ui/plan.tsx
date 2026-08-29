import * as React from "react";
import { ChevronsUpDown } from "lucide-react";

import { Button } from "./button.js";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card.js";
import { Collapsible } from "./collapsible.js";

function Plan(props: React.ComponentProps<typeof Collapsible.Root>) {
  return <Collapsible.Root {...props} render={<Card data-slot="plan" size="sm" />} />;
}

function PlanHeader(props: React.ComponentProps<typeof CardHeader>) {
  return <CardHeader data-plan-slot="plan-header" {...props} />;
}

function PlanTitle(props: React.ComponentProps<typeof CardTitle>) {
  return <CardTitle data-plan-slot="plan-title" {...props} />;
}

function PlanDescription(props: React.ComponentProps<typeof CardDescription>) {
  return <CardDescription data-plan-slot="plan-description" {...props} />;
}

function PlanAction(props: React.ComponentProps<typeof CardAction>) {
  return <CardAction data-plan-slot="plan-action" {...props} />;
}

function PlanTrigger({ label = "Toggle plan", ...props }: React.ComponentProps<typeof Collapsible.Trigger> & { label?: string }) {
  return (
    <Collapsible.Trigger {...props} data-slot="plan-trigger" render={<Button variant="ghost" size="icon" />}>
      <ChevronsUpDown />
      <span className="sr-only">{label}</span>
    </Collapsible.Trigger>
  );
}

function PlanContent(props: React.ComponentProps<typeof Collapsible.Panel>) {
  return <Collapsible.Panel {...props} render={<CardContent data-plan-slot="plan-content" />} />;
}

function PlanFooter(props: React.ComponentProps<typeof CardFooter>) {
  return <CardFooter data-plan-slot="plan-footer" {...props} />;
}

export { Plan, PlanAction, PlanContent, PlanDescription, PlanFooter, PlanHeader, PlanTitle, PlanTrigger };
