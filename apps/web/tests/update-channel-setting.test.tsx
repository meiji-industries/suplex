// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { UpdateChannelSetting } from "../features/settings/update-settings.js";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const settings = (updateChannel: string) => ({ minFreeDiskGb: 5, defaultBudgetUsd: 15, defaultMaxTurns: 40, todayPageEnabled: false, hostTerminalEnabled: false, git2Enabled: false, telemetryEnabled: true, autoArchiveAfterDays: 30, updateChannel });

test("the update channel shows the stored channel and saves the selected one", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { updateChannel: string } : undefined;
    return new Response(JSON.stringify(settings(body?.updateChannel ?? "stable")), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const onChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<UpdateChannelSetting onChange={onChange} />));
  const trigger = container.querySelector<HTMLElement>("#update-channel")!;
  expect(trigger.textContent).toContain("Stable");
  expect(container.textContent).toContain("Suplex keeps the current build until a stable version is newer.");

  await act(async () => trigger.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(element => element.textContent === "Development")!;
  await act(async () => option.click());

  const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch?.[0]).toBe("/api/admin/environment");
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ updateChannel: "dev" });
  expect(trigger.textContent).toContain("Development");
  expect(onChange).toHaveBeenCalledOnce();
});
