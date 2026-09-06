import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode, TdHTMLAttributes } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";

export type SettingsTableColumn = { key: string; label?: ReactNode; width: number };

export function SettingsToolbar({ searchLabel, searchPlaceholder, filterLabel, searchWidth = "default", actions, searchValue, onSearchChange, filters }: { searchLabel: string; searchPlaceholder: string; filterLabel: string; searchWidth?: "default" | "compact"; actions: ReactNode; searchValue?: string; onSearchChange?: (value: string) => void; filters?: { options: readonly string[]; value: string; onChange: (value: string) => void } }): ReactElement {
  return (
    <div className="flex min-h-[34px] flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-[239px] gap-1.5">
        <label className={cn("block max-w-full", searchWidth === "compact" ? "w-[286px]" : "w-[300px]")}>
          {searchValue !== undefined && onSearchChange ? <Input aria-label={searchLabel} onChange={(event) => onSearchChange(event.target.value)} placeholder={searchPlaceholder} value={searchValue} /> : <Input aria-label={searchLabel} disabled placeholder={searchPlaceholder} />}
        </label>
        {filters ? <Select value={filters.value} onValueChange={(value) => { if (value !== null) filters.onChange(value); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{filters.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select> : <span className="hidden sm:inline-flex"><Button disabled size="sm" type="button" variant="outline">{filterLabel}<ChevronDown /></Button></span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function SettingsToolbarAction({ tone = "secondary", type = "button", ...props }: Omit<ComponentProps<typeof Button>, "className" | "size" | "variant"> & { tone?: "primary" | "secondary" }): ReactElement {
  return <Button {...props} size="sm" type={type} variant={tone === "primary" ? "default" : "outline"} />;
}

export function SettingsDataTable({ label, columns, className, children }: { label: string; columns: SettingsTableColumn[]; className?: string; children: ReactNode }): ReactElement {
  const width = 60 + columns.reduce((sum, column) => sum + column.width, 0);
  return (
    <div className={cn("-mx-4 overflow-x-auto lg:-mx-14", className)}>
      <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-left" style={{ minWidth: width }}>
        <colgroup><col style={{ width: 60 }} />{columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
        <thead><tr className="h-8 text-[12px] font-medium text-muted-foreground"><th className="font-medium" scope="col" />{columns.map((column) => <th className="font-medium" key={column.key} scope="col">{column.label ? <span className="-ml-[6.5px] inline-flex h-6 items-center rounded-full px-1.5">{column.label}</span> : null}</th>)}</tr></thead>
        {children}
      </table>
    </div>
  );
}

export function SettingsTableGroup({ label, count, columnCount, children }: { label: string; count: number; columnCount: number; children: ReactNode }): ReactElement {
  return (
    <tbody>
      <tr className="h-8"><td className="p-0" colSpan={columnCount + 1}><div className="mx-2 flex h-8 items-center gap-1 rounded-lg bg-muted/60 px-[52px] text-[12px] text-muted-foreground"><span>{label}</span><span>{count}</span></div></td></tr>
      {children}
    </tbody>
  );
}

export function SettingsTableRow({ size = "compact", className, children, ...props }: ComponentProps<"tr"> & { size?: "compact" | "member" }): ReactElement {
  return <tr className={cn("text-[13px] [&>td]:transition-colors hover:[&>td]:bg-muted/40 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg", props.onClick && "cursor-pointer focus-visible:outline-none focus-visible:[&>td]:bg-muted/60", size === "member" ? "h-[50px]" : "h-11", className)} {...props}><td className="align-middle p-0" />{children}</tr>;
}

export function SettingsTableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): ReactElement {
  return <td className={cn("px-1.5 align-middle", className)} {...props} />;
}

export function SettingsTableEmpty({ columnCount, children }: { columnCount: number; children: ReactNode }): ReactElement {
  return <tbody><tr className="h-11 text-[13px] text-muted-foreground"><td colSpan={columnCount + 1}><div className="pl-[54px]">{children}</div></td></tr></tbody>;
}
