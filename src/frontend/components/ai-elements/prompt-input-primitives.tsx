import * as React from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "cmdk";
import { PreviewCard } from "@base-ui/react/preview-card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem as BaseDropdownMenuItem, DropdownMenuTrigger as BaseDropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon, InputGroupButton as BaseInputGroupButton, InputGroupTextarea } from "../ui/input-group.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { Spinner } from "../ui/spinner.js";
import { Tooltip, TooltipContent, TooltipTrigger as BaseTooltipTrigger } from "../ui/tooltip.js";

function renderChild(asChild: boolean | undefined, children: React.ReactNode) {
  return asChild && React.isValidElement(children) ? children : undefined;
}

function DropdownMenuTrigger({ asChild, children, ...props }: { asChild?: boolean; children?: React.ReactNode } & Record<string, unknown>) {
  return <BaseDropdownMenuTrigger {...props} render={renderChild(asChild, children)}>{asChild ? undefined : children}</BaseDropdownMenuTrigger>;
}

type LooseControlProps = {
  children?: React.ReactNode;
  className?: string | undefined;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onSelect?: (event: Event) => void;
  [key: string]: unknown;
};

function DropdownMenuItem(props: LooseControlProps) {
  // eslint-disable-next-line no-restricted-syntax -- LooseControlProps adapts AI Elements call sites to the shadcn control.
  return <BaseDropdownMenuItem {...props as unknown as React.ComponentProps<typeof BaseDropdownMenuItem>} />;
}

function InputGroupButton(props: LooseControlProps) {
  // eslint-disable-next-line no-restricted-syntax -- LooseControlProps adapts AI Elements call sites to the shadcn control.
  return <BaseInputGroupButton {...props as unknown as React.ComponentProps<typeof BaseInputGroupButton>} />;
}

function TooltipTrigger({ asChild, children, ...props }: { asChild?: boolean; children?: React.ReactNode } & Record<string, unknown>) {
  return <BaseTooltipTrigger {...props} render={renderChild(asChild, children)}>{asChild ? undefined : children}</BaseTooltipTrigger>;
}

function HoverCard({ openDelay: _openDelay, closeDelay: _closeDelay, ...props }: Record<string, unknown>) {
  return <PreviewCard.Root {...props} />;
}

function HoverCardTrigger({ asChild, children, ...props }: { asChild?: boolean; children?: React.ReactNode } & Record<string, unknown>) {
  return <PreviewCard.Trigger {...props} render={renderChild(asChild, children)}>{asChild ? undefined : children}</PreviewCard.Trigger>;
}

function HoverCardContent({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) {
  return <PreviewCard.Portal><PreviewCard.Positioner><PreviewCard.Popup {...props}>{children}</PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal>;
}

export {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  HoverCard, HoverCardContent, HoverCardTrigger,
  InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Spinner,
  Tooltip, TooltipContent, TooltipTrigger,
};
