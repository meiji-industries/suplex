import type { ComponentProps } from "react";
import { Button } from "../ui/button.js";

export function ToolActionButton(props: Omit<ComponentProps<typeof Button>, "size">) {
  return <Button {...props} size="xs" />;
}
