import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, type WebAuthnAdapter } from "../../src/auth.js";
import { AgentProfileService } from "../../src/agent-profiles.js";
import { createApp } from "../../src/app.js";
import { createTestConfig } from "../../src/config.js";
import { createTestDatabase } from "./test-database.js";
import { ProjectService } from "../../src/projects.js";
import { TaskService } from "../../src/tasks.js";
import { TaskTemplateService } from "../../src/task-templates.js";
import { WorkflowRecordService } from "../../src/workflow-records.js";
import { HermesAgentService } from "../../src/hermes-agents.js";
import type { HostHealthDependencies } from "../../src/health.js";

export const healthyHost: HostHealthDependencies = {
  database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
  opencode: async () => ({ id: "opencode", label: "OpenCode", status: "healthy", summary: "Configured", details: {} }),
  ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
};

const webAuthn: WebAuthnAdapter = {
  async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "native-app", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
  async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; },
  async generateAuthenticationOptions() { return { challenge: "native-app", rpId: "localhost", allowCredentials: [], userVerification: "required" }; },
  async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
};

export async function nativeApp() {
  const directory = await mkdtemp(join(tmpdir(), "forge-native-app-"));
  const config = createTestConfig(directory, { reachableAddress: "http://127.0.0.1:4111" });
  const database = createTestDatabase(config.databasePath);
  const auth = new AuthService(database, config, { webAuthn });
  const profiles = new AgentProfileService(database, auth);
  const projects = new ProjectService(database, auth, config, {
    validateProjectConfiguration: true,
    localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "owner/repo", clean: false, baseSha: "a".repeat(40) }; } },
    github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } },
    readProviders: async () => ({ directory, observedAt: new Date().toISOString(), providers: [{ id: "openai", label: "OpenAI", status: "configured", modelCount: 2, models: [{ id: "gpt-5.6-sol", label: "Sol" }, { id: "gpt-5.6-luna", label: "Luna" }] }] }),
  });
  const tasks = new TaskService(database, auth, projects, config);
  const templates = new TaskTemplateService(database, auth, tasks);
  const workflows = new WorkflowRecordService(database, auth);
  const hermes = new HermesAgentService(database, auth);
  const wakes: string[] = [];
  const app = createApp({ config, database, auth, profiles, projects, tasks, taskTemplates: templates, workflows, hermes, health: healthyHost, readUpdate: async () => ({ available: false }), host: { async recover(id) { wakes.push(id); } } });
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
  return { directory, config, database, auth, profiles, projects, tasks, templates, workflows, hermes, app, headers, userId, company, project, wakes,
    async close() { await app.close(); database.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
