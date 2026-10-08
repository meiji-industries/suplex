import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

/** Lit phosphor colors: the P1 green a VT100 drew, and a recording red. */
const PHOSPHOR = {
  green: { rgb: "65 255 122", className: "text-[#1fbf55] dark:text-[#41ff7a]" },
  red: { rgb: "255 59 48", className: "text-[#e5251b] dark:text-[#ff3b30]" },
} as const;

/** The text caret while a field records dictation: a recording-red block where the browser supports caret-shape, else a red bar. */
export const recordingCaret = "caret-[#e5251b] [caret-shape:block] dark:caret-[#ff3b30]";

export type PhosphorColor = keyof typeof PHOSPHOR;

/** The glow around lit chrome, as a CSS shadow. */
export function phosphorGlow(color: PhosphorColor, blur = 6, alpha = 0.75): string {
  return `0 0 ${blur}px rgb(${PHOSPHOR[color].rgb} / ${alpha})`;
}

/** An icon lit like a phosphor screen. */
export function PhosphorIcon({ icon: Icon, color, filled = false }: { icon: LucideIcon; color: PhosphorColor; filled?: boolean }): ReactElement {
  return <Icon aria-hidden="true" className={PHOSPHOR[color].className} fill={filled ? "currentColor" : "none"} style={{ filter: `drop-shadow(${phosphorGlow(color, 3, 0.85)})` }} />;
}
