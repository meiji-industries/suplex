import { useEffect, type RefObject } from "react";

const editable = "input, textarea, select, [contenteditable=true]";

/** True when a key typed at the target belongs to a field or a dialog, not to a global shortcut. */
export function inFieldOrDialog(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.matches(editable) || target instanceof HTMLElement && target.isContentEditable || Boolean(target.closest("[role=dialog], [role=alertdialog]"));
}

/** ⌘K on macOS, Ctrl+K elsewhere. */
export function isCommandK(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
}

/** True when a keydown opens the command menu. A view that claims ⌘K first prevents its default. */
export function opensCommandMenu(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  return isCommandK(event) || !event.metaKey && !event.ctrlKey && event.key === "/";
}

/** True when a keydown opens Settings: ⌘, on macOS, Ctrl+, elsewhere. */
export function opensSettings(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key === ",";
}

/** The Settings shortcut as the user's platform writes it. Without a desktop platform, the browser's platform decides. */
export function settingsShortcutLabel(): string {
  const platform = window.suplexApp?.platform ?? (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "macos" : "other");
  return platform === "macos" ? "⌘," : "Ctrl+,";
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
      if (event.target !== input && inFieldOrDialog(event.target)) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", focus, true);
    return () => window.removeEventListener("keydown", focus, true);
  }, [ref]);
}
