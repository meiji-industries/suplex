import { Search } from "lucide-react";
import { useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";

import { useCommandKFocus } from "../../shell/shortcuts.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group.js";
import { Kbd } from "../ui/kbd.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.js";

/** The filter bar above a list: views on the left, search and project on the right. */
export function ListToolbar({ children, filters }: { children: ReactNode; filters: ReactNode }): ReactElement {
  return <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b p-3">
    <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">{filters}</div>
  </div>;
}

export function ViewTabs<T extends string>({ value, options, onChange }: { value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void }): ReactElement {
  return <div className="max-w-full overflow-x-auto"><Tabs value={value} onValueChange={next => { const option = options.find(([candidate]) => candidate === next); if (option) onChange(option[0]); }}><TabsList variant="pill">
    {options.map(([option, label]) => <TabsTrigger key={option} className="font-normal" value={option}>{label}</TabsTrigger>)}
  </TabsList></Tabs></div>;
}

/** ⌘K focuses the filter. Escape clears it. */
export function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  useCommandKFocus(input);
  return <InputGroup className="w-44"><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput ref={input} aria-label={label} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); onChange(""); }} placeholder={label} /><InputGroupAddon align="inline-end"><Kbd className="font-normal" variant="outline">⌘K</Kbd></InputGroupAddon></InputGroup>;
}

/** Rows share the header columns on wide screens. `columns` is the `lg:grid-cols-[…]` class. */
export function DataList({ columns, header, label, children }: { columns: string; header: ReactNode; label: string; children: ReactNode }): ReactElement {
  return <div className={`px-2 pb-2 lg:grid ${columns} gap-x-[22px]`}>
    <div className="col-span-full hidden grid-cols-subgrid items-center px-3 pt-2 pb-1 text-muted-foreground lg:grid text-sm dark:text-[#d1d1d1]">{header}</div>
    <ul aria-label={label} className="col-span-full lg:grid lg:grid-cols-subgrid">{children}</ul>
  </div>;
}

/** Two columns on narrow screens: the main link, and the value or action at the end. */
export function DataListRow({ children, ...props }: Omit<ComponentProps<"li">, "className">): ReactElement {
  return <li {...props} className="relative grid min-h-13.5 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md px-3 py-2 text-sm before:absolute before:top-0 before:right-3 before:left-9 before:h-px before:bg-border first:before:hidden hover:bg-muted hover:before:hidden [&:hover+li]:before:hidden lg:col-span-full lg:grid-cols-subgrid lg:py-1 gap-x-[22px]">{children}</li>;
}
