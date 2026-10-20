import { Fragment, useEffect, useState, type ReactElement } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Kbd, KbdGroup } from "../components/ui/kbd.js";
import { settingsKey, settingsShortcutLabel, shortcutReference } from "./shortcuts.js";

/** The list of keyboard shortcuts. `?` and the command menu open it. */
export function ShortcutReference(): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener("suplex:shortcut-reference", show);
    return () => window.removeEventListener("suplex:shortcut-reference", show);
  }, []);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent>
    <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle><DialogDescription>Suplex ignores these keys while you type in a field or use a dialog.</DialogDescription></DialogHeader>
    <div className="grid max-h-[60vh] gap-4 overflow-y-auto">{shortcutReference.map(({ group, items }) => <section key={group} aria-label={group} className="grid gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{group}</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">{items.map(({ keys, label }) => <Fragment key={`${keys.join("+")}:${label}`}><dt>{label}</dt><dd><KbdGroup>{keys.map((key, index) => <Fragment key={key}>{index ? <span className="text-xs text-muted-foreground">then</span> : null}<Kbd>{key === settingsKey ? settingsShortcutLabel() : key}</Kbd></Fragment>)}</KbdGroup></dd></Fragment>)}</dl>
    </section>)}</div>
  </DialogContent></Dialog>;
}
