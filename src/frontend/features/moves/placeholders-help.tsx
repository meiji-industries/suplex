import type { ReactElement } from "react";

import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "../../components/ui/popover.js";
import { moveInputs } from "./lib/move-inputs.js";

const examples = [
  ["{{version}}", "Text. You type it when you start the move."],
  ["{{bump: patch | minor | major}}", "A choice. The first option is the default."],
] as const;

/** How to declare inputs, and the inputs this text declares. Opens on hover or click. */
export function PlaceholdersHelp({ text }: { text: string }): ReactElement {
  const found = moveInputs(text);
  return <Popover>
    <PopoverTrigger openOnHover delay={150} render={<button type="button" className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:text-foreground" />}>
      Placeholders{found.length ? ` · ${found.length}` : ""}
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80">
      <PopoverHeader>
        <PopoverTitle>Placeholders</PopoverTitle>
        <PopoverDescription>A placeholder asks for a value when the move starts.</PopoverDescription>
      </PopoverHeader>
      <dl className="grid gap-2 text-xs">
        {examples.map(([syntax, meaning]) => <div key={syntax}><dt><code className="rounded-sm bg-muted px-1 py-0.5 font-mono">{syntax}</code></dt><dd className="mt-1 text-muted-foreground">{meaning}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">Use a name again to insert the same value.</p>
      {found.length ? <p className="text-xs text-muted-foreground">This move asks for {found.map(input => input.name).join(", ")}.</p> : null}
    </PopoverContent>
  </Popover>;
}
