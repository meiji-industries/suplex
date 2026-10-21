export type DesktopZoomStep = "in" | "out" | "reset";

type ZoomingApp = { platform?: string; zoom?: (step: DesktopZoomStep) => Promise<void> };

/**
 * The zoom step for ⌘+, ⌘=, ⌘-, and ⌘0 on macOS, or Ctrl with the same keys elsewhere. The numeric keypad
 * keys send the same `key` values. An older shell sends no platform and runs on a Mac.
 */
export function desktopZoomStep(event: KeyboardEvent, platform: string | undefined): DesktopZoomStep | null {
  const mac = !platform || platform === "macos";
  if (event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null;
  switch (event.key) {
    case "=": case "+": return "in";
    case "-": case "_": return "out";
    case "0": return "reset";
    default: return null;
  }
}

/**
 * Sends the zoom keys to the desktop shell, which zooms the whole app with the webview's native page zoom.
 * Windows and Linux have no menu bar to receive them. On macOS the page sees a key equivalent before the
 * View menu does, and a key the page prevents never reaches the menu, so each key zooms once.
 * In a browser there is no `window.suplexApp.zoom` and the browser keeps its own zoom.
 */
export function installDesktopZoom(app: ZoomingApp | undefined = window.suplexApp): () => void {
  const zoom = app?.zoom;
  if (!zoom) return () => undefined;
  const listener = (event: KeyboardEvent): void => {
    const step = desktopZoomStep(event, app.platform);
    if (!step) return;
    // Capture phase on window, so the terminal and other views never receive the key as input.
    event.preventDefault();
    event.stopPropagation();
    void zoom(step).catch(() => undefined);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}
