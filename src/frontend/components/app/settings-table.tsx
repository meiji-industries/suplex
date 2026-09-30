import { ChevronRight } from "lucide-react"; import { createPortal } from "react-dom";
import { createContext, useContext, useState, type ComponentProps, type ReactElement, type ReactNode, type TdHTMLAttributes } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { Skeleton } from "../ui/skeleton.js";

/** A column without a width takes the remaining space. */
export type SettingsTableColumn = { key: string; label?: ReactNode; width?: number; align?: "center" };

export function SettingsToolbar({ searchLabel, searchPlaceholder, searchWidth = "default", searchValue, onSearchChange, filters, actions, actionsInHeader = false }: { actionsInHeader?: boolean; searchLabel: string; searchPlaceholder: string; searchWidth?: "default" | "compact"; searchValue: string; onSearchChange: (value: string) => void; filters?: { options: readonly string[]; value: string; onChange: (value: string) => void }; actions?: ReactNode }): ReactElement {
  return (
    <div data-settings-toolbar className="flex min-h-[34px] flex-wrap items-center justify-between gap-x-6 gap-y-2 [[data-settings-header]+&]:mb-4 [[data-settings-header]+&+*]:mt-0 [[data-settings-header]+section>&:first-child]:mb-4 [[data-settings-header]+section>&:first-child+*]:mt-0">
      <div className="flex min-w-0 flex-1 basis-[239px] gap-1.5">
        <label className={cn("block max-w-full", searchWidth === "compact" ? "w-[286px]" : "w-[300px]")}>
          <Input size="sm" type="search" aria-label={searchLabel} onChange={(event) => onSearchChange(event.target.value)} placeholder={searchPlaceholder} value={searchValue} />
        </label>
        {filters ? <Select value={filters.value} onValueChange={(value) => { if (value !== null) filters.onChange(value); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{filters.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select> : null}
      </div>
      {actions ? <ToolbarActions inHeader={actionsInHeader}>{actions}</ToolbarActions> : null}
    </div>
  );
}

/** True when the search term is empty or any value contains it, ignoring case. */
export function matchesSearch(search: string, ...values: Array<string | null | undefined>): boolean {
  const term = search.trim().toLowerCase();
  return !term || values.some((value) => value?.toLowerCase().includes(term));
}

export function SettingsToolbarAction({ tone = "secondary", type = "button", ...props }: Omit<ComponentProps<typeof Button>, "className" | "size" | "variant"> & { tone?: "primary" | "secondary" }): ReactElement {
  return <Button {...props} size="sm" type={type} variant={tone === "primary" ? "default" : "outline"} />;
}

/** Minimum width a flexible column keeps before the table scrolls sideways. */
const FLEXIBLE_COLUMN_MIN = 240;

export function SettingsDataTable({ label, columns, className, children }: { label: string; columns: SettingsTableColumn[]; className?: string; children: ReactNode }): ReactElement {
  const width = columns.reduce((sum, column) => sum + (column.width ?? FLEXIBLE_COLUMN_MIN), 0);
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-left" style={{ minWidth: width }}>
        <colgroup>{columns.map((column) => <col key={column.key} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
        <thead><tr className="h-9 text-xs font-medium text-muted-foreground">{columns.map((column) => <th className={cn("border-b px-3 font-medium", column.align === "center" && "text-center")} key={column.key} scope="col">{column.label}</th>)}</tr></thead>
        {children}
      </table>
    </div>
  );
}

/** A collapsible group of rows. The header shows the group name and its row count. */
export function SettingsTableGroup({ label, count, columnCount, defaultOpen = true, children }: { label: string; count: number; columnCount: number; defaultOpen?: boolean; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <tbody>
      <tr><td className={cn("bg-muted/60 p-0", open && "border-b")} colSpan={columnCount}>
        <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex h-9 w-full items-center gap-1.5 px-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} />
          <span>{label}</span><span className="tabular-nums">{count}</span>
        </button>
      </td></tr>
      {open ? children : null}
    </tbody>
  );
}

/** A 1px divider separates rows. The last row of the table has no divider. */
export function SettingsTableRow({ size = "compact", className, children, ...props }: ComponentProps<"tr"> & { size?: "compact" | "member" }): ReactElement {
  return <tr data-settings-row className={cn("text-sm [&>td]:border-b [&>td]:transition-colors [tbody:last-of-type>&:last-child>td]:border-b-0 hover:[&>td]:bg-muted/50", props.onClick && "cursor-pointer focus-visible:outline-none focus-visible:[&>td]:bg-muted/60", size === "member" ? "h-[50px]" : "h-11", className)} {...props}>{children}</tr>;
}

export function SettingsTableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): ReactElement {
  return <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
}

export function SettingsTableEmpty({ columnCount, children }: { columnCount: number; children: ReactNode }): ReactElement {
  return <tbody><tr className="h-11 text-sm text-muted-foreground"><td className="px-3" colSpan={columnCount}>{children}</td></tr></tbody>;
}

/** Placeholder rows while a table loads its data. */
export function SettingsTableLoading({ columnCount, rows = 3 }: { columnCount: number; rows?: number }): ReactElement {
  return <tbody aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, row) => <tr key={row} className="h-11">{Array.from({ length: columnCount }, (_, column) => <td key={column} className="px-3"><Skeleton className="h-3.5 w-2/3" /></td>)}</tr>)}</tbody>;
}

/** The page header's button area. A toolbar can render its buttons there, so every page keeps its buttons top right. */
export const SettingsHeaderSlotContext = createContext<{ slot: HTMLElement | null; setSlot: (slot: HTMLElement | null) => void }>({ slot: null, setSlot: () => undefined });

function ToolbarActions({ inHeader, children }: { inHeader: boolean; children: ReactNode }): ReactElement {
  const { slot } = useContext(SettingsHeaderSlotContext);
  if (inHeader && slot) return createPortal(children, slot);
  return <div className="flex shrink-0 items-center gap-2">{children}</div>;
}
