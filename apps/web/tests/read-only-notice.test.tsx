// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const context = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../shell/company-context.js", () => ({ useOptionalCompanyContext: () => context.value }));

import { ReadOnlyNotice } from "../shell/read-only-notice.js";

afterEach(() => { document.body.replaceChildren(); });

async function render(company: Record<string, unknown>, role = "member"): Promise<string> {
  context.value = { currentCompany: { id: "c1", name: "Acme", ...company }, user: { role } };
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ReadOnlyNotice />); });
  return container.textContent ?? "";
}

test("a read-only member, a lapsed Team, and edit access", async () => {
  expect(await render({ access: "read" })).toContain("You can read work in Acme.");
  expect(await render({ access: "read", teamLapsed: true }, "admin")).toContain("Team endedWork is read-only until an administrator selects Team again.Select Team");
  expect(await render({ access: "read", teamLapsed: true })).not.toContain("Select Team");
  expect(await render({ access: "edit" })).toBe("");
});
