// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { readJson } from "../src/frontend/lib/api.js";
import { GithubDeviceSignIn } from "../src/frontend/components/app/github-device-sign-in.js";

vi.mock("../src/frontend/lib/api.js", () => ({
  readJson: vi.fn().mockResolvedValue({
    flowId: "00000000-0000-4000-8000-000000000001",
    userCode: "1CFE-18E1",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2099-01-01T00:00:00Z",
    intervalSeconds: 3600,
  }),
}));

test("copies the complete code before showing the GitHub link and allows a failed copy to be retried", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const writeText = vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("Clipboard denied"))
    .mockResolvedValue(undefined);
  const click = async (label: string): Promise<void> => {
    const button = Array.from(document.querySelectorAll("button")).find(element => element.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () => root.render(<GithubDeviceSignIn onConnected={async () => {}} />));
    await click("Sign in to GitHub");
    expect(document.querySelector("code")?.textContent).toBe("1CFE-18E1");
    expect(document.querySelectorAll("code span")).toHaveLength(9);
    await click("Copy the code");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Select the code and copy it.");
    expect(document.querySelector('a[href="https://github.com/login/device"]')).toBeNull();
    await click("Copy the code");
    expect(writeText).toHaveBeenLastCalledWith("1CFE-18E1");
    expect(document.querySelector('a[href="https://github.com/login/device"]')?.textContent).toBe("Continue to Github");
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="https://github.com/login/device"]')?.click());
    const waiting = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Testing connection");
    expect(waiting?.disabled).toBe(true);
    expect(waiting?.querySelector("svg")).not.toBeNull();
    expect(document.querySelector('a[href="https://github.com/login/device"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});


test("retries a failed poll automatically and refreshes after connection", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const connected = vi.fn().mockResolvedValue(undefined);
  const api = vi.mocked(readJson);
  api.mockReset();
  api.mockResolvedValueOnce({
    flowId: "00000000-0000-4000-8000-000000000001", userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00Z", intervalSeconds: 5,
  }).mockRejectedValueOnce(new Error("Network failure"))
    .mockResolvedValueOnce({ method: "device", source: "none", status: "sign_in_required" })
    .mockImplementationOnce(async () => ({ status: "pending", nextPollAt: new Date(Date.now() + 5000).toISOString() }))
    .mockResolvedValueOnce({ status: "connected", login: "fixture" });
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const click = async (label: string): Promise<void> => {
    const button = Array.from(document.querySelectorAll("button")).find(element => element.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () => root.render(<GithubDeviceSignIn onConnected={connected} />));
    await click("Sign in to GitHub");
    await click("Copy the code");
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="https://github.com/login/device"]')?.click());
    for (let tick = 0; tick < 5; tick++) {
      expect(document.body.textContent).toContain("Testing connection");
      await act(async () => vi.advanceTimersByTimeAsync(1000));
    }
    expect(document.body.textContent).toContain("Suplex will retry.");
    expect(document.body.textContent).toContain("Testing connection");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(document.body.textContent).not.toContain("Suplex will retry.");
    expect(document.body.textContent).toContain("Testing connection");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(connected).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("GitHub is connected as fixture.");
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api).toHaveBeenCalledTimes(5);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
