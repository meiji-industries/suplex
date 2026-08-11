import { Input as InputPrimitive } from "@base-ui/react/input";
import * as React from "react";

import { cn } from "../../lib/utils.js";

function Input({ className, ...props }: React.ComponentProps<typeof InputPrimitive>): React.ReactElement {
  return <InputPrimitive data-slot="input" className={cn("h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/30", className)} {...props} />;
}

export { Input };
