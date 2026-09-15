import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuthService, type WebAuthnAdapter } from "../../src/identity/auth.js";
import { AgentProfileService } from "../../src/profiles/agent-profiles.js";
import { createApp } from "../../src/app.js";
import { createFastifyLogger } from "../../src/platform/logging.js";
import { createTestConfig } from "../../src/platform/config.js";
import { createTestDatabase } from "./test-database.js";
import { ProjectService } from "../../src/projects/projects.js";
import { TaskService } from "../../src/tasks/tasks.js";
import { TaskTemplateService } from "../../src/tasks/templates.js";
import { WorkflowRecordService } from "../../src/coordination/workflow-records.js";
import { HermesAgentService } from "../../src/identity/hermes-agents.js";
import { GithubTriggerService } from "../../src/integrations/github/triggers.js";
import type { GithubTriggerPort } from "../../src/integrations/github/trigger-inspection.js";
import { providerCheckId, providerCheckLabel } from "../../src/platform/health-contract.js";
import type { HostHealthDependencies } from "../../src/platform/health.js";
import type { TaskPanePort } from "../../src/runtimes/task-display.js";

export const healthyHost: HostHealthDependencies = {
  database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
  git: async () => ({ id: "git", label: "Git", status: "healthy", summary: "Ready", details: {} }),
  herdrReadiness: async () => ({ id: "herdr-readiness", label: "Herdr", status: "healthy", summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  provider: async (kind) => ({ id: providerCheckId(kind), label: providerCheckLabel(kind), status: "healthy", summary: "Signed in", details: {}, provider: kind }),
};

const webAuthn: WebAuthnAdapter = {
  async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "native-app", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
  async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; },
  async generateAuthenticationOptions() { return { challenge: "native-app", rpId: "localhost", allowCredentials: [], userVerification: "required" }; },
  async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
};

export async function nativeApp(fixtureOptions: { githubTrigger?: GithubTriggerPort; herdr?: TaskPanePort; logSink?: (line: string) => void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-native-app-"));
  const config = createTestConfig(directory, { reachableAddress: "http://127.0.0.1:4111" });
  const database = createTestDatabase(config.databasePath);
  const auth = new AuthService(database, config, { webAuthn });
  const profiles = new AgentProfileService(database, auth);
  const projects = new ProjectService(database, auth, config, {
    validateProjectConfiguration: true,
    // The remote identity follows the directory name, so a fixture can hold more than one project.
    localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: `owner/${basename(input.repositoryPath)}`, clean: false, baseSha: "a".repeat(40) }; } },
    github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } },
    readProviders: async () => ({ directory, observedAt: new Date().toISOString(), providers: [
      { id: "opencode" as const, label: "OpenCode", status: "configured" as const, modelCount: 2, models: [{ id: "openai/gpt-5.6-sol", label: "Sol (OpenAI)" }, { id: "openai/gpt-5.6-luna", label: "Luna (OpenAI)" }], connection: { status: "connected" as const, summary: "Signed in" } },
      { id: "codex" as const, label: "Codex CLI", status: "configured" as const, modelCount: 2, models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }], connection: { status: "connected" as const, summary: "Signed in" } },
      { id: "claude-code" as const, label: "Claude Code", status: "configured" as const, modelCount: 1, models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }], connection: { status: "connected" as const, summary: "Signed in" } },
    ] }),
  });
  const tasks = new TaskService(database, auth, projects, config, fixtureOptions.herdr ? { herdr: fixtureOptions.herdr } : {});
  const templates = new TaskTemplateService(database, auth, tasks);
  const workflows = new WorkflowRecordService(database, auth);
  const hermes = new HermesAgentService(database, auth);
  const githubTrigger = fixtureOptions.githubTrigger ?? {
    async observeRepository(input) { return { id: 1, fullName: input.repository }; },
    async validateLabel() {},
    async listOpenPullRequestsByLabel() { return []; },
    async inspectPullRequest() { throw new Error("No pull request"); },
  } satisfies GithubTriggerPort;
  const githubTriggers = new GithubTriggerService(database, auth, projects, workflows, githubTrigger, tasks);
  const wakes: string[] = [];
  const app = createApp({ ...(fixtureOptions.logSink ? { logger: createFastifyLogger(fixtureOptions.logSink) } : {}), config, database, auth, profiles, projects, tasks, taskTemplates: templates, workflows, githubTriggers, hermes, health: healthyHost, readUpdate: async () => ({ status: { kind: "current" }, canRestart: false }), host: { async recover(id) { wakes.push(id); } } });
  const invitation = auth.ensureBootstrapInvitation();
  if (!invitation) throw new Error("Fresh database did not create an invitation");
  const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "native-admin", type: "public-key" } } });
  if (enrolled.statusCode !== 200) throw new Error(enrolled.body);
  const cookies = enrolled.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies ?? ""]).map(value => value.split(";")[0]).join("; ");
  const headers = { cookie, origin: config.reachableAddress };
  const userId = auth.listUsers(enrolled.json().user.id)[0]!.id;
  const company = auth.createCompany(userId, "Native");
  const repositoryPath = join(config.repositoryRoot, "repo");
  const worktreeRoot = join(config.worktreeRoot, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const project = await projects.createProject(userId, company.id, { name: "Repository", repositoryPath, worktreeRoot, repository: "owner/repo", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
  return { directory, config, database, auth, profiles, projects, tasks, templates, workflows, githubTriggers, hermes, app, headers, userId, company, project, wakes,
    async close() { await app.close(); database.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
