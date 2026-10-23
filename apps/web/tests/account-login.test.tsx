// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccountLoginView } from "../features/account/account-login.js";
import { getAccount, pollAccountLogin, startAccountLogin } from "../features/account/lib/account-api.js";

vi.mock("../features/account/lib/account-api.js", () => ({
  getAccount: vi.fn(),
  pollAccountLogin: vi.fn(),
  startAccountLogin: vi.fn(),
}));

const LOGIN_URL = "https://suplex.sh/auth/start?attempt=a1&provider=google";
let container: HTMLDivElement;
let root: Root;
let assign: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, search: "", assign } as unknown as Location);
  vi.mocked(getAccount).mockResolvedValue({ account: null, configured: true, canManage: true } as never);
  vi.mocked(startAccountLogin).mockResolvedValue({ attemptId: "a1", url: LOGIN_URL } as never);
  vi.mocked(pollAccountLogin).mockResolvedValue({ status: "pending" } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<AccountLoginView />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const loginTab = (): { closed: boolean; close: ReturnType<typeof vi.fn> } => {
  const tab = { closed: false, close: vi.fn(() => { tab.closed = true; }) };
  return tab;
};

const click = async (label: string): Promise<void> => {
  const control = Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(element => element.textContent === label);
  expect(control).toBeDefined();
  await act(async () => control?.click());
};

const poll = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); };

test("opens the login tab with its opener and closes it when the login completes", async () => {
  const tab = loginTab();
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  await click("Continue with Google");
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toBe(LOGIN_URL);
  expect(open.mock.calls[0]?.slice(2).join(",")).not.toContain("noopener");
  await poll();
  expect(tab.close).not.toHaveBeenCalled();
  vi.mocked(pollAccountLogin).mockResolvedValue({ status: "complete" } as never);
  await poll();
  expect(tab.close).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("/");
});

test("continues the login when the browser blocks the login tab", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await click("Continue with GitHub");
  vi.mocked(pollAccountLogin).mockResolvedValue({ status: "complete" } as never);
  await poll();
  expect(assign).toHaveBeenCalledWith("/");
});

test("continues the login when the user already closed the login tab or the browser refuses to close it", async () => {
  const tab = { closed: false, close: vi.fn(() => { throw new Error("refused"); }) };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  await click("Continue with Google");
  vi.mocked(pollAccountLogin).mockResolvedValue({ status: "complete" } as never);
  await poll();
  expect(tab.close).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("/");
});

test("Open the browser keeps the new login tab and Cancel closes it", async () => {
  const blocked = vi.spyOn(window, "open").mockReturnValue(null);
  await click("Continue with Google");
  const tab = loginTab();
  blocked.mockReturnValue(tab as unknown as Window);
  await click("Open the browser");
  expect(blocked).toHaveBeenCalledTimes(2);
  expect(blocked.mock.calls[1]?.[0]).toBe(LOGIN_URL);
  expect(blocked.mock.calls[1]?.slice(2).join(",")).not.toContain("noopener");
  await click("Cancel");
  expect(tab.close).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Continue with Google");
});

test("the iOS shell offers only the email login, and the Android shell keeps Google and GitHub", async () => {
  const buttons = (): string[] => Array.from(document.querySelectorAll("button")).map(button => button.textContent ?? "");
  expect(buttons()).toEqual(expect.arrayContaining(["Continue with Google", "Continue with GitHub", "Continue with email"]));
  window.suplexMobile = { openHostPicker: async () => {} };
  try {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15");
    await act(async () => root.render(<AccountLoginView key="ios" />));
    expect(buttons()).not.toContain("Continue with Google");
    expect(buttons()).not.toContain("Continue with GitHub");
    expect(buttons()).toContain("Continue with email");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36");
    await act(async () => root.render(<AccountLoginView key="android" />));
    expect(buttons()).toEqual(expect.arrayContaining(["Continue with Google", "Continue with GitHub", "Continue with email"]));
  } finally {
    delete window.suplexMobile;
  }
});
