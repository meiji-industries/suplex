import { chromium } from "playwright";
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import type { GithubAdapter } from "../src/github.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { queryIssueWorkflow, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture, ImmediateClock } from "./helpers/engine-harness.js";

const webauthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "engine-browser", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "engine-browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: engineFixture.base, targetSha: engineFixture.commit }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.test/${input.nameWithOwner}` }; } };

test("the task detail remains backed by the engine snapshot after a host restart", async () => {
  class BrowserClock extends ImmediateClock { override async wait(milliseconds: number, signal: AbortSignal) { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); } }
  const h = await createEngineHarness({}, new BrowserClock()); h.seedTask("browser-engine");
  h.activities.projectIssueState = async (event) => { h.database.projectIssueEvents([event]); return event.state; };
  const auth = new AuthService(h.database, h.config, { webAuthn: webauthn });
  const projects = new ProjectService(h.database, auth, h.config, { localRepository, github });
  const tasks = new TaskService(h.database, auth, projects, h.config);
  const healthy = <T extends "engine" | "database" | "artifact-root" | "worker" | "codex-auth" | "gh-auth">(id: T) => async () => ({ id, label: id, status: "healthy" as const, summary: "Ready", details: {} });
  const app = createApp({ config: h.config, auth, projects, tasks, health: { engine: healthy("engine"), database: healthy("database"), artifactRoot: healthy("artifact-root"), worker: healthy("worker"), codexAuth: healthy("codex-auth"), ghAuth: healthy("gh-auth") } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address(); if (!address || typeof address !== "object") throw new Error("Engine browser server has no port");
  try {
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "browser-engine", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false });
    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: h.config.installationId });
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "engine-browser-admin", type: "public-key" } } });
    const cookies = (Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""]).map((value) => value.split(";", 1)[0]!);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies(cookies.map((cookie) => { const [name, value] = cookie.split("=", 2); return { name: name!, value: value!, domain: "127.0.0.1", path: "/" }; }).filter((cookie) => cookie.name === SESSION_COOKIE_NAME || cookie.name === CSRF_COOKIE_NAME));
      const page = await context.newPage(); const url = `http://127.0.0.1:${address.port}/tasks?company=${engineFixture.companyId}`;
      await page.goto(url); const list = page.locator("[data-task-list]"); await list.waitFor({ timeout: 5_000 }); await list.getByText("browser-engine", { exact: true }).waitFor({ timeout: 5_000 });
      await h.restart(); expect(await queryIssueWorkflow(h.config, started.workflowId)).toMatchObject({ phase: "backlog", revision: 1 });
      await page.setViewportSize({ width: 390, height: 844 }); expect(await list.getByText("browser-engine", { exact: true }).isVisible()).toBe(true); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); await h.stop(); }
});
