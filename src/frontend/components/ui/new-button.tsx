import { Plus } from "lucide-react";
import * as React from "react";

import { Button } from "./button.js";

function NewButton({ children, ...props }: Omit<React.ComponentProps<typeof Button>, "className" | "size" | "variant">): React.ReactElement {
  return (
    <Button
      {...props}
      className="gap-2 bg-primary p-3 font-medium text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
      size="sm"
    >
      <Plus />
      {children ?? "New"}
    </Button>
  );
}

export { NewButton };
