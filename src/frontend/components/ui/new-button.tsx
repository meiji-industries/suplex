import { Plus } from "lucide-react";
import * as React from "react";

import { Button } from "./button.js";
import { cn } from "../../lib/utils.js";

/** Extra classes merge after the defaults, so a page can adjust one New button. */
function NewButton({ children, className, ...props }: Omit<React.ComponentProps<typeof Button>, "size" | "variant">): React.ReactElement {
  return (
    <Button
      {...props}
      className={cn("gap-2 bg-primary p-3 font-medium text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground", className)}
      size="sm"
    >
      <Plus />
      {children ?? "New"}
    </Button>
  );
}

export { NewButton };
