// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { planLabel } from "../features/onboarding/onboarding-you.js";
import { backlogText } from "../features/tasks/task-details.js";
import { inAppStoreShell } from "../shell/app-store.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36";
const planLimited: Parameters<typeof backlogText>[0] = { status: "queued", queue: { waitingOn: [], projectConcurrencyLimited: false, planConcurrencyLimited: true } };
const trial = { plan: "free", trialAvailable: true } as Parameters<typeof planLabel>[0];

afterEach(() => { delete window.suplexMobile; vi.restoreAllMocks(); });

test("the iOS shell names no paid plan; Android and browsers do", () => {
  expect(inAppStoreShell()).toBe(false);
  expect(backlogText(planLimited)).toContain("Pro");
  expect(planLabel(trial)).toBe("Pro trial · 14 days");

  window.suplexMobile = { openHostPicker: async () => {} };
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
  expect(inAppStoreShell()).toBe(true);
  expect(backlogText(planLimited)).toBe("Queued. This host runs 3 tasks at a time. Suplex starts this task when a running task stops.");
  expect(planLabel(trial)).toBeUndefined();

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
  expect(inAppStoreShell()).toBe(false);
  expect(backlogText(planLimited)).toContain("Pro");
});
