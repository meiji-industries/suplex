// @vitest-environment happy-dom
import { act, useRef, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ShortcutReference } from "../shell/shortcut-reference.js";

import { AppSidebar } from "../shell/navigation.js";
import { chordTimeout, opensCommandMenu, requestShortcutReference, settingsShortcutLabel, useCommandKFocus, useGlobalShortcuts } from "../shell/shortcuts.js";

const sidebar = vi.hoisted(() => ({ role: "admin" as "admin" | "member", navigate: vi.fn<(href: string) => void>() }));

vi.mock("../components/ui/sidebar.js", async () => {
  const React = await import("react");
  const box = ({ children }: { children?: ReactNode }) => React.createElement("div", null, children);
  return {
    Sidebar: box, SidebarContent: box, SidebarFooter: box, SidebarGroup: box, SidebarGroupContent: box, SidebarHeader: box, SidebarMenu: box, SidebarMenuItem: box,
    SidebarMenuButton: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => React.createElement("div", null, render ?? children),
    SidebarTrigger: () => null,
    useSidebar: () => ({ isMobile: false, setOpenMobile: () => undefined }),
  };
});
vi.mock("../shell/navigation-state.js", () => ({ navigate: sidebar.navigate }));
vi.mock("../shell/company-context.js", () => ({
  useOptionalCompanyContext: () => ({ user: { id: "user-a", role: sidebar.role, displayName: "Ada", username: "ada", avatarSeed: null }, currentCompany: { id: "company-a", status: "active" } }),
}));
vi.mock("../shell/experiments-api.js", () => ({ useExperiments: () => undefined }));
vi.mock("../shell/global-new-task-dialog.js", () => ({ requestNewTask: () => undefined, useHasProjects: () => true }));
vi.mock("../shell/company-switcher.js", () => ({ CompanySwitcher: () => null }));
vi.mock("../shell/server-state.js", () => ({ useSignOut: () => async () => undefined }));
vi.mock("../features/tasks/recent-tasks.js", () => ({ RecentTasks: () => null }));
vi.mock("../components/app/system-health.js", () => ({ SystemHealthIndicator: () => null }));
vi.mock("../components/app/entity-avatar.js", () => ({ EntityAvatar: () => null }));

function Filter(): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useCommandKFocus(ref);
  return <><input ref={ref} aria-label="Filter tasks" /><input aria-label="Other field" /></>;
}

let root: Root | undefined;
beforeEach(() => { sidebar.role = "admin"; sidebar.navigate.mockClear(); });
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

type Calls = { navigate: string[]; newTask: number; menu: number; reference: number };

function Shortcuts({ calls, active = true, todayPage = false }: { calls: Calls; active?: boolean; todayPage?: boolean }): null {
  useGlobalShortcuts({
    companyId: "company_1",
    companyActive: active,
    todayPage,
    navigate: href => calls.navigate.push(href),
    withCompany: (path, companyId) => `${path}?company=${companyId}`,
    newTask: () => { calls.newTask += 1; },
    openCommandMenu: () => { calls.menu += 1; },
    openReference: () => { calls.reference += 1; },
    openSettings: () => { calls.navigate.push("settings"); },
  });
  return null;
}

const newCalls = (): Calls => ({ navigate: [], newTask: 0, menu: 0, reference: 0 });

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function List({ count }: { count: number }): ReactElement {
  return <ul>{Array.from({ length: count }, (_, index) => <li key={index}><a data-shortcut-item href={`/tasks/task_${index}`}>Task {index}</a></li>)}</ul>;
}

test("C starts a new task only in an active company", async () => {
  const calls = newCalls();
  await mount(<Shortcuts calls={calls} />);
  expect(key(document.body, { key: "c" }).defaultPrevented).toBe(true);
  expect(calls.newTask).toBe(1);
  act(() => root?.unmount());
  const inactive = newCalls();
  await mount(<Shortcuts calls={inactive} active={false} />);
  key(document.body, { key: "c" });
  expect(inactive.newTask).toBe(0);
});

test.each([["b", "/board?company=company_1"], ["t", "/tasks?company=company_1"], ["a", "/analytics?company=company_1"], ["h", "/tasks?company=company_1"], ["m", "/moves?company=company_1"], ["l", "/timeline?company=company_1"]])("G then %s opens %s", async (second, href) => {
  const calls = newCalls();
  await mount(<Shortcuts calls={calls} />);
  key(document.body, { key: "g" });
  expect(key(document.body, { key: second }).defaultPrevented).toBe(true);
  expect(calls.navigate).toEqual([href]);
});

test("G then H opens Today when the Today view is on", async () => {
  const calls = newCalls();
  await mount(<Shortcuts calls={calls} todayPage />);
  key(document.body, { key: "g" });
  key(document.body, { key: "h" });
  expect(calls.navigate).toEqual(["/today"]);
});

test("a pending G expires and does not take an unrelated key", async () => {
  vi.useFakeTimers();
  try {
    const calls = newCalls();
    await mount(<><Shortcuts calls={calls} /><List count={2} /></>);
    key(document.body, { key: "g" });
    vi.advanceTimersByTime(chordTimeout + 1);
    key(document.body, { key: "b" });
    expect(calls.navigate).toEqual([]);
    key(document.body, { key: "g" });
    // J completes no chord, so it keeps its own meaning and clears the pending G.
    expect(key(document.body, { key: "j" }).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("Task 0");
    key(document.activeElement!, { key: "b" });
    expect(calls.navigate).toEqual([]);
    key(document.body, { key: "g" });
    key(document.body, { key: "Shift" });
    key(document.body, { key: "B", shiftKey: true });
    expect(calls.navigate).toEqual(["/board?company=company_1"]);
  } finally { vi.useRealTimers(); }
});

test("? opens the shortcut reference, and the reference dialog shows the keys", async () => {
  const calls = newCalls();
  await mount(<Shortcuts calls={calls} />);
  expect(key(document.body, { key: "?", shiftKey: true }).defaultPrevented).toBe(true);
  expect(calls.reference).toBe(1);
  act(() => root?.unmount());
  await mount(<ShortcutReference />);
  await act(async () => { requestShortcutReference(); });
  const dialog = document.querySelector("[role=dialog]")!;
  expect(dialog.textContent).toContain("Keyboard shortcuts");
  expect(dialog.textContent).toContain("Open Board");
  expect(dialog.querySelectorAll("[data-slot=kbd]").length).toBeGreaterThan(10);
});

test("/ and ⌘K open the command menu, and a field keeps them", async () => {
  const calls = newCalls();
  await mount(<><Shortcuts calls={calls} /><input aria-label="Field" /></>);
  key(document.body, { key: "/" });
  key(document.body, { key: "k", metaKey: true });
  expect(calls.menu).toBe(2);
  const field = document.querySelector("input")!;
  expect(key(field, { key: "/" }).defaultPrevented).toBe(false);
  expect(calls.menu).toBe(2);
});

test.each([
  ["an input", <input key="field" aria-label="Field" />],
  ["a textarea", <textarea key="field" aria-label="Field" />],
  ["editable content", <div key="field" aria-label="Field" contentEditable suppressContentEditableWarning>Text</div>],
  ["a dialog", <div key="field" role="dialog"><button type="button" aria-label="Field">Inside</button></div>],
  ["an alert dialog", <div key="field" role="alertdialog"><button type="button" aria-label="Field">Inside</button></div>],
  ["a menu", <div key="field" role="menu"><div role="menuitem" tabIndex={-1} aria-label="Field">Item</div></div>],
])("letter keys, chords, J, K, and ? do nothing in %s", async (_name, field) => {
  const calls = newCalls();
  await mount(<><Shortcuts calls={calls} /><List count={2} />{field}</>);
  const target = document.querySelector('[aria-label="Field"]')!;
  for (const init of [{ key: "c" }, { key: "g" }, { key: "b" }, { key: "?", shiftKey: true }, { key: "j" }, { key: "k" }]) expect(key(target, init).defaultPrevented).toBe(false);
  expect(calls).toEqual(newCalls());
  expect(document.activeElement?.closest("[data-shortcut-item]")).toBeNull();
});

test("shortcuts do nothing while a dialog or sheet is open, even with focus outside it", async () => {
  const calls = newCalls();
  await mount(<><Shortcuts calls={calls} /><List count={2} /><div data-slot="sheet-content" /></>);
  for (const init of [{ key: "c" }, { key: "j" }, { key: "?", shiftKey: true }]) key(document.body, init);
  key(document.body, { key: "g" }); key(document.body, { key: "b" });
  expect(calls).toEqual(newCalls());
});

test("meta, Ctrl, and Alt turn off the letter shortcuts", async () => {
  const calls = newCalls();
  await mount(<><Shortcuts calls={calls} /><List count={2} /></>);
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    key(document.body, { key: "c", ...modifier });
    key(document.body, { key: "j", ...modifier });
    key(document.body, { key: "g", ...modifier }); key(document.body, { key: "b" });
  }
  expect(calls).toEqual(newCalls());
  expect(document.activeElement).toBe(document.body);
});

test("J, K, and the arrow keys move focus through the rows, and the focused row is the link that Enter opens", async () => {
  const calls = newCalls();
  await mount(<><Shortcuts calls={calls} /><List count={3} /><button type="button">Other</button></>);
  const focused = (): string | undefined => document.activeElement?.textContent ?? undefined;
  key(document.body, { key: "j" });
  expect(focused()).toBe("Task 0");
  key(document.activeElement!, { key: "j" });
  key(document.activeElement!, { key: "ArrowDown" });
  expect(focused()).toBe("Task 2");
  // The last row stays focused at the end of the list.
  key(document.activeElement!, { key: "j" });
  expect(focused()).toBe("Task 2");
  key(document.activeElement!, { key: "k" });
  expect(focused()).toBe("Task 1");
  expect(key(document.activeElement!, { key: "ArrowUp" }).defaultPrevented).toBe(true);
  expect(focused()).toBe("Task 0");
  expect(document.activeElement).toBeInstanceOf(HTMLAnchorElement);
  expect(document.activeElement?.getAttribute("href")).toBe("/tasks/task_0");
  // Arrows on another control keep their own behavior.
  const other = document.querySelector("button")!;
  other.focus();
  expect(key(other, { key: "ArrowDown" }).defaultPrevented).toBe(false);
  expect(focused()).toBe("Other");
  // K with no focused row goes to the last row.
  other.blur();
  key(document.body, { key: "k" });
  expect(focused()).toBe("Task 2");
});

test("⌘, opens Settings from the shared handler and clears a pending G", async () => {
  const calls = newCalls();
  await mount(<><Shortcuts calls={calls} /><input aria-label="Field" /></>);
  key(document.body, { key: "g" });
  expect(key(document.body, { key: ",", metaKey: true }).defaultPrevented).toBe(true);
  key(document.body, { key: "b" });
  expect(calls.navigate).toEqual(["settings"]);
  expect(key(document.querySelector("input")!, { key: ",", ctrlKey: true }).defaultPrevented).toBe(false);
  expect(calls.navigate).toEqual(["settings"]);
});

test("J and K do nothing in a view without rows", async () => {
  const calls = newCalls();
  await mount(<Shortcuts calls={calls} />);
  expect(key(document.body, { key: "j" }).defaultPrevented).toBe(false);
  expect(key(document.body, { key: "ArrowDown" }).defaultPrevented).toBe(false);
});

const companySettings = "/companies/company-a/settings?company=company-a";

test("⌘, and Ctrl+, open the same Settings as the sidebar icon", async () => {
  await mount(<AppSidebar />);
  expect(document.querySelector('[aria-label="Settings"]')?.getAttribute("href")).toBe(companySettings);
  expect(press(document.body, { key: ",", metaKey: true }).event.defaultPrevented).toBe(true);
  expect(sidebar.navigate).toHaveBeenLastCalledWith(companySettings);
  press(document.body, { key: ",", ctrlKey: true });
  expect(sidebar.navigate).toHaveBeenCalledTimes(2);
  press(document.body, { key: ",", ctrlKey: true, altKey: true });
  press(document.body, { key: "," });
  expect(sidebar.navigate).toHaveBeenCalledTimes(2);
});

test("⌘, opens the profile for a member", async () => {
  sidebar.role = "member";
  await mount(<AppSidebar />);
  press(document.body, { key: ",", metaKey: true });
  expect(sidebar.navigate).toHaveBeenLastCalledWith("/profile?company=company-a");
  expect(document.querySelector('[aria-label="Settings"]')?.getAttribute("href")).toBe("/profile?company=company-a");
});

test("⌘, typed in a field or a dialog keeps its normal behavior", async () => {
  await mount(<><AppSidebar /><input aria-label="Field" /><textarea aria-label="Notes" /><select aria-label="Choice" /><div contentEditable="true" aria-label="Editor" /><div role="dialog"><button type="button">Inside</button></div><div role="alertdialog"><span>Alert</span></div></>);
  for (const selector of ["input", "textarea", "select", "[contenteditable]", "[role=dialog] button", "[role=alertdialog] span"]) {
    const target = document.querySelector(selector)!;
    expect(press(target, { key: ",", metaKey: true }).event.defaultPrevented).toBe(false);
  }
  expect(sidebar.navigate).not.toHaveBeenCalled();
});

test("a view that claims ⌘, first keeps it", async () => {
  await mount(<AppSidebar />);
  const claim = (event: KeyboardEvent): void => event.preventDefault();
  window.addEventListener("keydown", claim, true);
  press(document.body, { key: ",", metaKey: true });
  window.removeEventListener("keydown", claim, true);
  expect(sidebar.navigate).not.toHaveBeenCalled();
});

test("the other global shortcuts keep their behavior", async () => {
  await mount(<AppSidebar />);
  press(document.body, { key: "g" });
  press(document.body, { key: "b" });
  expect(sidebar.navigate).toHaveBeenLastCalledWith("/board?company=company-a");
  let menus = 0;
  const count = (): void => { menus += 1; };
  window.addEventListener("suplex:command-menu", count);
  act(() => { press(document.body, { key: "k", metaKey: true }); press(document.body, { key: "/" }); });
  window.removeEventListener("suplex:command-menu", count);
  expect(menus).toBe(2);
  // The open command menu keeps the letter shortcuts for itself.
  press(document.body, { key: "g" });
  press(document.body, { key: "t" });
  expect(sidebar.navigate).toHaveBeenCalledTimes(1);
});

test("the Settings shortcut label follows the platform", () => {
  const platform = vi.spyOn(navigator, "platform", "get");
  platform.mockReturnValue("MacIntel");
  expect(settingsShortcutLabel()).toBe("⌘,");
  platform.mockReturnValue("Win32");
  expect(settingsShortcutLabel()).toBe("Ctrl+,");
  platform.mockRestore();
  Object.assign(window, { suplexApp: { platform: "macos" } });
  expect(settingsShortcutLabel()).toBe("⌘,");
  Reflect.deleteProperty(window, "suplexApp");
});

test("the command menu lists Settings with its shortcut", async () => {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await mount(<AppSidebar />);
  await act(async () => { window.dispatchEvent(new Event("suplex:command-menu")); });
  const entry = Array.from(document.querySelectorAll<HTMLAnchorElement>("[role=dialog] a")).find(link => link.textContent?.startsWith("Settings"));
  expect(entry?.getAttribute("href")).toBe(companySettings);
  expect(entry?.querySelector("kbd")?.textContent).toBe("Ctrl+,");
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("Ctrl+, opens Settings.");
  platform.mockRestore();
});
