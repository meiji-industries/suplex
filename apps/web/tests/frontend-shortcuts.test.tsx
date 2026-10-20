// @vitest-environment happy-dom
import { act, useRef, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { AppSidebar } from "../shell/navigation.js";
import { opensCommandMenu, settingsShortcutLabel, useCommandKFocus } from "../shell/shortcuts.js";

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
  let menus = 0;
  const count = (): void => { menus += 1; };
  window.addEventListener("suplex:command-menu", count);
  act(() => { press(document.body, { key: "k", metaKey: true }); press(document.body, { key: "/" }); });
  window.removeEventListener("suplex:command-menu", count);
  expect(menus).toBe(2);
  press(document.body, { key: "g" });
  press(document.body, { key: "b" });
  expect(sidebar.navigate).toHaveBeenLastCalledWith("/board?company=company-a");
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
