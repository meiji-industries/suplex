import * as React from "react";

import { cn } from "../../lib/utils.js";

function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>): React.ReactElement {
  return <span data-slot="badge" className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", className)} {...props} />;
}

export { Badge };
