// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJson: vi.fn(), readJsonUnchecked: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", async importOriginal => ({ ...(await importOriginal()), ...api }));
vi.mock("../src/frontend/features/projects/project-connections.js", () => ({
  ProjectConnections: () => null,
  REPOSITORY_HOSTS: [{ kind: "github", label: "GitHub" }, { kind: "bitbucket", label: "Bitbucket" }],
  withRepositoryHost: (value: unknown) => value,
}));
vi.mock("../src/frontend/components/app/github-device-sign-in.js", () => ({ GithubDeviceSignIn: ({ onConnected }: { onConnected: () => Promise<void> }) => <button type="button" onClick={() => void onConnected()}>Sign in to GitHub</button> }));
vi.mock("../src/frontend/components/ui/dialog.js", () => ({ Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null, DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2> }));
vi.mock("../src/frontend/components/ui/combobox.js", () => ({ Combobox: ({ children }: { children: ReactNode }) => <>{children}</>, ComboboxContent: ({ children }: { children: ReactNode }) => <>{children}</>, ComboboxEmpty: ({ children }: { children: ReactNode }) => <>{children}</>, ComboboxInput: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <>{children}<input {...props} /></>, ComboboxItem: ({ children }: { children: ReactNode }) => <>{children}</>, ComboboxList: () => null }));
vi.mock("../src/frontend/components/ui/dropdown-menu.js", () => ({ DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>, DropdownMenuContent: () => null, DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>, DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <>{children}</>, DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button> }));
vi.mock("../src/frontend/components/ui/input-group.js", () => ({ InputGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, InputGroupAddon: ({ children }: { children: ReactNode }) => <div>{children}</div>, InputGroupButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />, InputGroupInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />, InputGroupText: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../src/frontend/components/ui/radio-group.js", () => ({ RadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>, RadioGroupItem: () => <input type="radio" /> }));

import { ApiError } from "../src/frontend/lib/api.js";
import { CreateProjectDialog } from "../src/frontend/features/projects/create-project-dialog.js";

const authFinding = new ApiError("Repository provisioning failed", 422, [{ code: "github-auth-unavailable", field: "repositoryName", message: "GitHub identity failed" }]);
const roots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); }); }

function mount(onOpenChange = vi.fn(), onCreated = vi.fn().mockResolvedValue(undefined)) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<CreateProjectDialog open onOpenChange={onOpenChange} companyId="company-1" companyStatus="active" canSignInToGitHub onCreated={onCreated} reloadCompanies={vi.fn().mockResolvedValue(undefined)} />));
  return { container, root, onOpenChange, onCreated };
}

beforeEach(() => { api.readJson.mockReset(); api.readJsonUnchecked.mockReset(); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test("confirmed signed-out state offers sign-in and preserves the manual clone draft", async () => {
  let ownerReads = 0;
  api.readJsonUnchecked.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/repository-owners")) {
      ownerReads++;
      if (ownerReads === 1) throw authFinding;
      return { owners: ["octocat"] };
    }
    if (url.includes("/repository-owners/octocat/repositories")) return { repositories: [] };
    if (url === "/api/companies/company-1/projects" && init?.method === "POST") return { id: "project-1" };
    throw new Error(`Unexpected request: ${url}`);
  });
  const view = mount();
  await flush();
  expect(view.container.textContent).toContain("GitHub is not signed in.");
  const repository = view.container.querySelector<HTMLInputElement>("#project-repository")!;
  const branch = view.container.querySelector<HTMLInputElement>("#create-base-branch")!;
  await act(async () => { setInput(repository, "https://github.com/octocat/Hello-World"); setInput(branch, "master"); });
  const signIn = Array.from(view.container.querySelectorAll("button")).find(button => button.textContent === "Sign in to GitHub")!;
  await act(async () => { signIn.click(); });
  await flush();
  expect(ownerReads).toBe(2);
  const preservedRepository = view.container.querySelector<HTMLInputElement>("#project-repository")!;
  const preservedBranch = view.container.querySelector<HTMLInputElement>("#create-base-branch")!;
  expect(preservedRepository.value).toBe("https://github.com/octocat/Hello-World");
  expect(preservedBranch.value).toBe("master");
  await act(async () => view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  const post = api.readJsonUnchecked.mock.calls.find(([url, init]) => url === "/api/companies/company-1/projects" && init?.method === "POST")!;
  expect(JSON.parse(post[1].body)).toMatchObject({ repositoryUrl: "https://github.com/octocat/Hello-World", baseBranch: "master" });
  expect(view.onOpenChange).toHaveBeenCalledWith(false);
});

test("network auth uncertainty does not claim that GitHub is signed out", async () => {
  api.readJsonUnchecked.mockRejectedValue(new ApiError("Repository provisioning failed", 422, [{ code: "github-repository-unavailable", field: "repositoryName", message: "GitHub could not list repository owners" }]));
  const view = mount();
  await flush();
  expect(view.container.textContent).not.toContain("GitHub is not signed in.");
  expect(view.container.textContent).toContain("Suplex could not load GitHub repositories.");
});

test("successful creation closes before a failed refresh, while failed creation keeps the draft", async () => {
  api.readJsonUnchecked.mockResolvedValueOnce({ owners: [] }).mockResolvedValueOnce({ id: "project-1" });
  const closed = mount(vi.fn(), vi.fn().mockRejectedValue(new Error("refresh failed")));
  await flush();
  const firstRepository = closed.container.querySelector<HTMLInputElement>("#project-repository")!;
  await act(async () => { setInput(firstRepository, "https://github.com/octocat/Hello-World"); firstRepository.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(closed.onOpenChange).toHaveBeenCalledWith(false);
  expect(closed.container.textContent).not.toContain("refresh failed");

  api.readJsonUnchecked.mockReset();
  api.readJsonUnchecked.mockResolvedValueOnce({ owners: [] }).mockRejectedValueOnce(new Error("Clone failed"));
  const failed = mount();
  await flush();
  const secondRepository = failed.container.querySelector<HTMLInputElement>("#project-repository")!;
  await act(async () => { setInput(secondRepository, "https://github.com/octocat/Hello-World"); secondRepository.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(failed.onOpenChange).not.toHaveBeenCalledWith(false);
  expect(secondRepository.value).toBe("https://github.com/octocat/Hello-World");
  expect(failed.container.textContent).toContain("Clone failed");
});
