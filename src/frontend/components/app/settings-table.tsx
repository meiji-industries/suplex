import { ChevronDown, Search } from "lucide-react";
import { type ComponentProps, type ReactElement, type ReactNode, type TdHTMLAttributes } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";

export type SettingsTableColumn = { key: string; label?: ReactNode; width: number };

export function SettingsToolbar({ searchLabel, searchPlaceholder, filterLabel, searchWidth = "default", actions, searchValue, onSearchChange, filters }: { searchLabel: string; searchPlaceholder: string; filterLabel: string; searchWidth?: "default" | "compact"; actions: ReactNode; searchValue?: string; onSearchChange?: (value: string) => void; filters?: { options: readonly string[]; value: string; onChange: (value: string) => void } }): ReactElement {
  return (
    <div className="flex min-h-[34px] flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-[239px] gap-1.5">
        <label className={cn("relative block max-w-full", searchWidth === "compact" ? "w-[286px]" : "w-[300px]")}>
          <Search className="pointer-events-none absolute left-3 top-2 size-4 text-muted-foreground" />
          {searchValue !== undefined && onSearchChange ? <input aria-label={searchLabel} className="h-8 w-full rounded-lg border-[0.5px] border-[lch(84.44%_0_282)] bg-[lch(99.997%_0.5_282)] py-1.5 pl-8 pr-6 text-[13px] font-medium outline-none placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-100" onChange={(event) => onSearchChange(event.target.value)} placeholder={searchPlaceholder} value={searchValue} /> : <input aria-label={searchLabel} className="h-8 w-full rounded-lg border-[0.5px] border-[lch(84.44%_0_282)] bg-[lch(99.997%_0.5_282)] py-1.5 pl-8 pr-6 text-[13px] font-medium outline-none placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-100" disabled placeholder={searchPlaceholder} />}
        </label>
        {filters ? <Select value={filters.value} onValueChange={(value) => { if (value !== null) filters.onChange(value); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{filters.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select> : <button className="hidden h-8 items-center gap-2 rounded-lg border-[0.5px] border-[lch(84.44%_0_282)] bg-[lch(99.997%_0.5_282)] px-2.5 text-[13px] font-medium shadow-[0_1px_1px_rgb(0_0_0_/_0.03)] disabled:cursor-default disabled:opacity-100 sm:inline-flex" disabled type="button">{filterLabel}<ChevronDown className="size-3.5 text-muted-foreground" /></button>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function SettingsToolbarAction({ tone = "secondary", type = "button", ...props }: Omit<ComponentProps<typeof Button>, "className" | "size" | "variant"> & { tone?: "primary" | "secondary" }): ReactElement {
  return <Button {...props} size="sm" type={type} variant={tone === "primary" ? "default" : "outline"} />;
}

export function SettingsDataTable({ label, columns, className, children }: { label: string; columns: SettingsTableColumn[]; className?: string; children: ReactNode }): ReactElement {
  const width = columns.reduce((sum, column) => sum + column.width, 0);
  return (
    <div className={cn("-mx-4 overflow-x-auto lg:-mx-14", className)}>
      <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-left" style={{ minWidth: width }}>
        <colgroup>{columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
        <thead><tr className="h-8 text-[12px] font-medium text-muted-foreground">{columns.map((column) => <th className="font-medium" key={column.key} scope="col">{column.label ? <span className="-ml-[6.5px] inline-flex h-6 items-center rounded-full px-1.5">{column.label}</span> : null}</th>)}</tr></thead>
        {children}
      </table>
    </div>
  );
}

export function SettingsTableGroup({ label, count, columnCount, children }: { label: string; count: number; columnCount: number; children: ReactNode }): ReactElement {
  return (
    <tbody>
      <tr className="h-8"><td className="p-0" colSpan={columnCount}><div className="mx-2 flex h-8 items-center gap-1 rounded-lg bg-black/[0.04] px-[52px] text-[12px] text-muted-foreground"><span>{label}</span><span>{count}</span></div></td></tr>
      {children}
    </tbody>
  );
}

export function SettingsTableRow({ size = "compact", className, ...props }: ComponentProps<"tr"> & { size?: "compact" | "member" }): ReactElement {
  return <tr className={cn("text-[13px] [&>td]:transition-colors hover:[&>td]:bg-black/[0.025] [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg", props.onClick && "cursor-pointer focus-visible:outline-none focus-visible:[&>td]:bg-black/[0.04]", size === "member" ? "h-[50px]" : "h-11", className)} {...props} />;
}

export function SettingsTableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): ReactElement {
  return <td className={cn("px-1.5 align-middle", className)} {...props} />;
}

export function SettingsTableEmpty({ columnCount, children }: { columnCount: number; children: ReactNode }): ReactElement {
  return <tbody><tr className="h-11 text-[13px] text-muted-foreground"><td colSpan={columnCount}><div className="pl-[54px]">{children}</div></td></tr></tbody>;
}
