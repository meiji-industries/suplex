import { useEffect, type RefObject } from "react";

const editable = "input, textarea, select, [contenteditable=true]";

/** ⌘K on macOS, Ctrl+K elsewhere. */
export function isCommandK(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
}

/** True when a keydown opens the command menu. A view that claims ⌘K first prevents its default. */
export function opensCommandMenu(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  return isCommandK(event) || !event.metaKey && !event.ctrlKey && event.key === "/";
}

/**
 * While mounted, ⌘K focuses the given input instead of opening the command menu. The listener runs in
 * the capture phase so it claims the key before the global shortcut handler sees it. Keys typed into
 * another field or inside a dialog keep their normal behavior.
 */
export function useCommandKFocus(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const focus = (event: KeyboardEvent): void => {
      const input = ref.current;
      if (!input || event.defaultPrevented || !isCommandK(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target !== input && (target.matches(editable) || target.closest("[role=dialog], [role=alertdialog]"))) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", focus, true);
    return () => window.removeEventListener("keydown", focus, true);
  }, [ref]);
}
