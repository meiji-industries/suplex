import { useEffect, useRef, type RefObject } from "react";

const editable = "input, textarea, select, [contenteditable=true], [contenteditable=''], [contenteditable=plaintext-only]";
/** A dialog, sheet, or alert dialog. Base UI gives each popup one of these roles. */
const overlay = "[role=dialog], [role=alertdialog]";
const openOverlay = "[data-slot=dialog-content], [data-slot=sheet-content], [data-slot=alert-dialog-content]";
/** Widgets that use letter and arrow keys for typeahead or their own movement. */
const keyedWidget = "[role=menu], [role=menubar], [role=listbox], [role=combobox], [role=tree], [role=grid]";
/** The command menu keys do not act from these targets. */
const menuExempt = "input, textarea, select, button, [contenteditable=true]";
/** Rows and cards that J, K, and the arrow keys move through. Each one is a link, so Enter opens it. */
export const shortcutItemSelector = "[data-shortcut-item]";
/** The time that a pending G waits for its second key. */
export const chordTimeout = 750;

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

function targetElement(event: KeyboardEvent): Element | null {
  return event.target instanceof Element ? event.target : null;
}

/** True when you type into the target: a field, a select, or editable content. */
export function isEditableTarget(target: Element | null): boolean {
  return Boolean(target && (target.matches(editable) || target.closest("[contenteditable=true], [contenteditable='']")));
}

/**
 * True when the global letter, chord, list, and reference keys must not act: a modifier is held, you type
 * into a field, a widget uses the key, or a dialog or sheet is open.
 */
export function ignoresShortcuts(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return true;
  const target = targetElement(event);
  if (isEditableTarget(target)) return true;
  if (target?.closest(`${overlay}, ${keyedWidget}`)) return true;
  return Boolean(document.querySelector(openOverlay));
}

/** The rows or cards in the current view, in reading order. */
export function shortcutItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(shortcutItemSelector)).filter(item => item.checkVisibility?.() ?? true);
}

/**
 * Moves focus to the next or previous row or card. With no focused item, it goes to the first item for
 * next and to the last item for previous. Returns false when the view has no items.
 */
export function moveListFocus(direction: 1 | -1): boolean {
  const items = shortcutItems();
  if (!items.length) return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(shortcutItemSelector) : null;
  const index = active ? items.indexOf(active) : -1;
  const next = index < 0 ? (direction === 1 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + direction));
  items[next]!.focus();
  items[next]!.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
}

export type ShortcutContext = {
  /** ⌘, or Ctrl+, opens Settings. */
  openSettings: () => void;
  /** The company that navigation keeps in the URL. */
  companyId: string | undefined;
  /** C starts a new task only in an active company. */
  companyActive: boolean;
  /** G then H goes to Today when the experiment is on. */
  todayPage: boolean;
  navigate: (href: string) => void;
  withCompany: (path: string, companyId: string | undefined) => string;
  newTask: () => void;
  openCommandMenu: () => void;
  openReference: () => void;
};

/** The second key of each G chord and the view that it opens. */
export const goTargets: Readonly<Record<string, string>> = { h: "/tasks", t: "/tasks", b: "/board", m: "/moves", l: "/timeline", a: "/analytics" };

/** The reference shows this key as `settingsShortcutLabel()` for the platform. */
export const settingsKey = "⌘,";

/** The rows of the shortcut reference. Each entry is one key sequence and what it does. */
export const shortcutReference: ReadonlyArray<{ group: string; items: ReadonlyArray<{ keys: readonly string[]; label: string }> }> = [
  { group: "General", items: [
    { keys: ["⌘K"], label: "Open the command menu" },
    { keys: ["/"], label: "Open the command menu" },
    { keys: ["C"], label: "Create a task" },
    { keys: ["?"], label: "Open the keyboard shortcuts" },
    { keys: [settingsKey], label: "Open Settings" },
    { keys: ["Esc"], label: "Cancel the open dialog" },
  ] },
  { group: "Navigation", items: [
    { keys: ["G", "H"], label: "Open the home view" },
    { keys: ["G", "T"], label: "Open Tasks" },
    { keys: ["G", "B"], label: "Open Board" },
    { keys: ["G", "M"], label: "Open Moves" },
    { keys: ["G", "L"], label: "Open Timeline" },
    { keys: ["G", "A"], label: "Open Analytics" },
  ] },
  { group: "Tasks and Board", items: [
    { keys: ["J"], label: "Select the next task" },
    { keys: ["K"], label: "Select the previous task" },
    { keys: ["↓"], label: "Select the next task" },
    { keys: ["↑"], label: "Select the previous task" },
    { keys: ["Enter"], label: "Open the selected task" },
    { keys: ["Tab"], label: "Move to the next control" },
  ] },
];

/**
 * Makes the global keydown handler. ⌘, opens Settings, and `/` and ⌘K open the command menu. Other keys act only when
 * `ignoresShortcuts` is false. A pending G waits `chordTimeout` ms; a key that completes no chord
 * clears it and keeps its own meaning. Enter needs no handler: the focused row or card is a link.
 */
export function createShortcutHandler(context: () => ShortcutContext): { handle: (event: KeyboardEvent) => void; dispose: () => void } {
  let goPending = false;
  let goTimer: ReturnType<typeof setTimeout> | undefined;
  const clearGo = (): void => { goPending = false; clearTimeout(goTimer); goTimer = undefined; };
  const handle = (event: KeyboardEvent): void => {
    const current = context();
    if (opensSettings(event)) {
      if (!inFieldOrDialog(event.target)) { event.preventDefault(); clearGo(); current.openSettings(); }
      return;
    }
    if (opensCommandMenu(event)) {
      // A field or a button keeps ⌘K and `/` for itself, as before.
      if (targetElement(event)?.matches(menuExempt)) return;
      clearGo();
      event.preventDefault(); current.openCommandMenu(); return;
    }
    if (event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") return;
    if (ignoresShortcuts(event)) { clearGo(); return; }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (goPending) {
      clearGo();
      const go = goTargets[key];
      if (go) {
        event.preventDefault();
        const path = key === "h" && current.todayPage ? "/today" : go;
        current.navigate(path === "/today" ? path : current.withCompany(path, current.companyId));
        return;
      }
    }
    if (key === "?") { event.preventDefault(); current.openReference(); return; }
    if (event.shiftKey) return;
    if (key === "g") { goPending = true; clearTimeout(goTimer); goTimer = setTimeout(clearGo, chordTimeout); return; }
    if (key === "c") { if (current.companyActive) { event.preventDefault(); current.newTask(); } return; }
    if (key === "j" || key === "k") { if (moveListFocus(key === "j" ? 1 : -1)) event.preventDefault(); return; }
    if (key === "ArrowDown" || key === "ArrowUp") {
      // Arrows keep their scroll and control behavior unless no control has focus or a row or card has it.
      const target = targetElement(event);
      if (target && target !== document.body && target !== document.documentElement && !target.closest(shortcutItemSelector)) return;
      if (moveListFocus(key === "ArrowDown" ? 1 : -1)) event.preventDefault();
    }
  };
  return { handle, dispose: clearGo };
}

/** Installs the global shortcuts on window while mounted. The handler always reads the latest context. */
export function useGlobalShortcuts(context: ShortcutContext): void {
  const latest = useRef(context);
  latest.current = context;
  useEffect(() => {
    const shortcuts = createShortcutHandler(() => latest.current);
    window.addEventListener("keydown", shortcuts.handle);
    return () => { window.removeEventListener("keydown", shortcuts.handle); shortcuts.dispose(); };
  }, []);
}

/** Opens the shortcut reference from a menu or a button. */
export function requestShortcutReference(): void {
  window.dispatchEvent(new Event("suplex:shortcut-reference"));
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
