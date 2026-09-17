// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);
import { IssuePicker } from "../src/frontend/features/tasks/issue-picker.js";

test("issue autocomplete queries the tracker and selects a qualified issue", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const issue = { kind: "github", repository: "client/repo", number: 420, id: "500", key: "#420", title: "Remote search result", url: "https://github.com/client/repo/issues/420" };
  api.readJson.mockResolvedValue({ issues: [issue] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  try {
    await act(async () => { root.render(<IssuePicker projectId="project" issue={null} onChange={onChange} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Select issue"]')!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search issues"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "420");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(api.readJson).toHaveBeenLastCalledWith("/api/projects/project/issues?query=420");
    const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Remote search result"))!;
    await act(async () => { result.click(); });
    expect(onChange).toHaveBeenCalledWith(issue);
  } finally { await act(async () => { root.unmount(); }); container.remove(); }
});
