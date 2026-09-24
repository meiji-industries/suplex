// @vitest-environment happy-dom
import { act, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

import { opensCommandMenu, useCommandKFocus } from "../src/frontend/shell/shortcuts.js";

function Filter(): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useCommandKFocus(ref);
  return <><input ref={ref} aria-label="Filter tasks" /><input aria-label="Other field" /></>;
}

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); });

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(element); });
}

/** Mirrors the global handler: it listens on window in the bubble phase. */
function press(target: EventTarget, init: KeyboardEventInit): { event: KeyboardEvent; menu: boolean } {
  let menu = false;
  const listener = (event: KeyboardEvent): void => { menu = opensCommandMenu(event); };
  window.addEventListener("keydown", listener);
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  window.removeEventListener("keydown", listener);
  return { event, menu };
}

const filter = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[aria-label="Filter tasks"]')!;

test("⌘K and Ctrl+K focus the task filter instead of opening the command menu", async () => {
  await mount(<Filter />);
  const mac = press(document.body, { key: "k", metaKey: true });
  expect(mac.event.defaultPrevented).toBe(true);
  expect(mac.menu).toBe(false);
  expect(document.activeElement).toBe(filter());
  filter().blur();
  const other = press(document.body, { key: "K", ctrlKey: true });
  expect(other.menu).toBe(false);
  expect(document.activeElement).toBe(filter());
});

test("/ still opens the command menu while the task filter is shown", async () => {
  await mount(<Filter />);
  const slash = press(document.body, { key: "/" });
  expect(slash.menu).toBe(true);
  expect(document.activeElement).not.toBe(filter());
});

test("⌘K typed in another field or a dialog keeps its normal behavior", async () => {
  await mount(<><Filter /><div role="dialog"><button type="button">Inside</button></div></>);
  const field = document.querySelector<HTMLInputElement>('[aria-label="Other field"]')!;
  field.focus();
  expect(press(field, { key: "k", metaKey: true }).event.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(field);
  const inside = document.querySelector("[role=dialog] button")!;
  expect(press(inside, { key: "k", metaKey: true }).event.defaultPrevented).toBe(false);
});

test("⌘K opens the command menu when no task filter is shown", async () => {
  await mount(<p>Other view</p>);
  expect(press(document.body, { key: "k", metaKey: true }).menu).toBe(true);
  expect(press(document.body, { key: "k", ctrlKey: true, altKey: true }).menu).toBe(false);
});
