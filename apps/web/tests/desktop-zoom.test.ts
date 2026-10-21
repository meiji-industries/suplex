// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";

import { installDesktopZoom, type DesktopZoomStep } from "../shell/desktop-zoom.js";

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; document.body.replaceChildren(); });

/** Presses a key in a text field and reports whether the field still received it. */
function press(init: KeyboardEventInit): { event: KeyboardEvent; reached: boolean } {
  const field = document.createElement("textarea");
  document.body.append(field);
  let reached = false;
  field.addEventListener("keydown", () => { reached = true; });
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  field.dispatchEvent(event);
  return { event, reached };
}

test("in the desktop app the zoom keys go to the shell and nowhere else", () => {
  const steps: DesktopZoomStep[] = [];
  uninstall = installDesktopZoom({ platform: "linux", zoom: async (step) => { steps.push(step); } });
  for (const key of ["=", "+", "-", "_", "0"]) {
    const { event, reached } = press({ key, ctrlKey: true, shiftKey: key === "+" || key === "_" });
    expect(event.defaultPrevented, key).toBe(true);
    expect(reached, key).toBe(false);
  }
  expect(steps).toEqual(["in", "in", "out", "out", "reset"]);
  for (const init of [{ key: "=" }, { key: "=", metaKey: true }, { key: "=", ctrlKey: true, altKey: true }, { key: "k", ctrlKey: true }]) {
    const { event, reached } = press(init);
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    expect(reached).toBe(true);
  }
  expect(steps).toHaveLength(5);
});

test("on macOS and in an older shell without a platform the zoom keys use ⌘", () => {
  for (const platform of ["macos", undefined]) {
    const steps: DesktopZoomStep[] = [];
    const zoom = async (step: DesktopZoomStep): Promise<void> => { steps.push(step); };
    uninstall = installDesktopZoom(platform ? { platform, zoom } : { zoom });
    expect(press({ key: "+", metaKey: true, shiftKey: true }).event.defaultPrevented).toBe(true);
    expect(press({ key: "-", metaKey: true }).event.defaultPrevented).toBe(true);
    expect(press({ key: "0", ctrlKey: true }).event.defaultPrevented).toBe(false);
    expect(steps).toEqual(["in", "out"]);
    uninstall();
  }
  uninstall = undefined;
});

test("in a browser, or a shell without zoom, the browser keeps its own zoom keys", () => {
  for (const app of [undefined, { platform: "windows" }]) {
    uninstall = installDesktopZoom(app);
    for (const init of [{ key: "=", ctrlKey: true }, { key: "-", metaKey: true }, { key: "0", ctrlKey: true }]) {
      const { event, reached } = press(init);
      expect(event.defaultPrevented).toBe(false);
      expect(reached).toBe(true);
    }
    uninstall();
  }
  uninstall = undefined;
});
