import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TaskProgress } from "../src/frontend/components/app/task-progress.js";

const base = { allowedCommands: ["cancel_development"], createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z", timeline: [], agentInvocations: [] };

test("Build animation requires a fresh Developer heartbeat", () => {
  const fresh = renderToStaticMarkup(<TaskProgress {...base} phase="development" developerLiveness={{ status: "running", lastHeartbeatAt: new Date().toISOString() }} />);
  const stale = renderToStaticMarkup(<TaskProgress {...base} phase="development" developerLiveness={{ status: "active", lastHeartbeatAt: "2026-08-13T00:00:00.000Z" }} />);
  const blocked = renderToStaticMarkup(<TaskProgress {...base} phase="delivery_blocked" allowedCommands={["retry_development"]} developerLiveness={{ status: "active", lastHeartbeatAt: new Date().toISOString() }} />);
  expect(fresh).toContain("animate-spin");
  expect(stale).not.toContain("animate-spin");
  expect(blocked).not.toContain("animate-spin");
});
