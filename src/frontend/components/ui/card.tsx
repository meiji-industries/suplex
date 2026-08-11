import * as React from "react";

import { cn } from "../../lib/utils.js";

function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div data-slot="card" className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)} {...props} />;
}

function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div data-slot="card-content" className={cn("p-4", className)} {...props} />;
}

export { Card, CardContent };
