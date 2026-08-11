import { Plus } from "lucide-react";
import * as React from "react";

import { Button } from "./button.js";

function CreateButton({ children, ...props }: React.ComponentProps<typeof Button>): React.ReactElement {
  return (
    <Button {...props}>
      <Plus className="size-4" />
      {children ?? "Create"}
    </Button>
  );
}

export { CreateButton };
