import { z } from "zod";
import { createHash } from "node:crypto";
import { createGithubReleasePort, type GithubPullRequest, type GithubPullRequestObservation, type GithubReleaseAdapter } from "./github/delivery.js";
import { environmentCredential, type RepositoryConnection } from "../projects/integration-configuration.js";
import { boundedProviderResponse, providerJson, ProviderHttpFailure } from "./provider-http.js";
import { runCommand } from "../platform/command-runner.js";
import { GithubReleaseFailure } from "./github/failure.js";
import { repositoryCoordinate } from "../projects/repository-coordinate.js";

const origin = "https://api.bitbucket.org";
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const end = z.object({ branch: z.object({ name: z.string() }), commit: z.object({ hash: sha }), repository: z.object({ full_name: z.string() }) });
const pullSchema = z.object({ id: z.number().int().positive(), title: z.string(), description: z.string().default(""), state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]), draft: z.boolean(), source: end, destination: end, links: z.object({ html: z.object({ href: z.string().url().refine(url => new URL(url).origin === "https://bitbucket.org") }) }), updated_on: z.string().optional() });
type Connection = Extract<RepositoryConnection, { kind: "bitbucket" }>;
function coordinate(repository: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("The repository identity is invalid");
  return `/2.0/repositories/${repository}`;
}
function pull(value: unknown): GithubPullRequest {
  const row = pullSchema.parse(value);
  return { number: row.id, url: row.links.html.href, repository: row.destination.repository.full_name.toLowerCase(), headBranch: row.source.branch.name, baseBranch: row.destination.branch.name, headSha: row.source.commit.hash, baseSha: row.destination.commit.hash, isDraft: row.draft, state: row.state === "OPEN" ? "open" : row.state === "MERGED" ? "merged" : "closed", mergedAt: row.state === "MERGED" ? row.updated_on ?? null : null, title: row.title, body: row.description, isCrossRepository: row.source.repository.full_name.toLowerCase() !== row.destination.repository.full_name.toLowerCase() };
}

export class BitbucketClient {
  constructor(private readonly connection: Connection, private readonly request: typeof fetch = fetch) {}
  private async download(repository: string, filename: string): Promise<Buffer> {
    const token = environmentCredential(this.connection.tokenEnvironment);
    const authorization = this.connection.usernameEnvironment ? `Basic ${Buffer.from(`${environmentCredential(this.connection.usernameEnvironment)}:${token}`).toString("base64")}` : `Bearer ${token}`;
    let url = new URL(`${coordinate(repository)}/downloads/${encodeURIComponent(filename)}`, origin);
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.request(url, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { Accept: "*/*", ...(url.origin === origin ? { Authorization: authorization } : {}) } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return boundedProviderResponse(response);
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Bitbucket returned a redirect without a download location");
      url = new URL(location, url);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !["api.bitbucket.org", "bitbucket.org", "bbuseruploads.s3.amazonaws.com", "api.media.atlassian.com"].includes(url.hostname)) throw new Error("Bitbucket returned an unsafe download URL");
    }
    throw new Error("Bitbucket download redirects did not complete");
  }
  async api(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const token = environmentCredential(this.connection.tokenEnvironment);
    const authorization = this.connection.usernameEnvironment ? `Basic ${Buffer.from(`${environmentCredential(this.connection.usernameEnvironment)}:${token}`).toString("base64")}` : `Bearer ${token}`;
    try { return await providerJson(new URL(path, origin), origin, authorization, { method, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) }, this.request); }
    catch (error) {
      if (error instanceof ProviderHttpFailure && (error.status === 401 || error.status === 403)) throw new GithubReleaseFailure("authentication-required", "Bitbucket access is unavailable. Check the project's credential references and repository permissions.");
      if (error instanceof ProviderHttpFailure && error.status === 429) throw new GithubReleaseFailure("provider-rate-limited", "Bitbucket rate limit reached");
      if (error instanceof ProviderHttpFailure && error.status >= 500) throw new GithubReleaseFailure("provider-unavailable", "Bitbucket is unavailable");
      throw error;
    }
  }
  async repository(repository: string): Promise<{ nameWithOwner: string; url: string }> {
    const row = z.object({ full_name: z.string(), links: z.object({ html: z.object({ href: z.string().url() }) }) }).parse(await this.api(coordinate(repository)));
    if (row.full_name.toLowerCase() !== repository.toLowerCase() || new URL(row.links.html.href).origin !== "https://bitbucket.org") throw new Error("Bitbucket returned another repository");
    return { nameWithOwner: row.full_name, url: row.links.html.href };
  }
  async list(repository: string, state?: string): Promise<GithubPullRequest[]> {
    let next: string | undefined = `${coordinate(repository)}/pullrequests?pagelen=50&${state ? `state=${state}` : "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED"}`;
    const result: GithubPullRequest[] = [];
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next) || seen.size >= 100) throw new Error("Bitbucket pagination did not complete");
      seen.add(next);
      const page = z.object({ values: z.array(z.unknown()), next: z.string().optional() }).parse(await this.api(next));
      result.push(...page.values.map(pull)); next = page.next;
    }
    return result;
  }
  async upload(repository: string, filename: string, bytes: Uint8Array, mimeType: string, beforeWrite: () => Promise<void> = async () => {}): Promise<string> {
    if (!/^suplex-[A-Za-z0-9._-]+$/.test(filename)) throw new Error("The evidence filename is invalid");
    const present = async () => {
      let next: string | undefined = `${coordinate(repository)}/downloads?pagelen=100`;
      const seen = new Set<string>();
      while (next) {
        if (seen.has(next) || seen.size >= 100) throw new Error("Bitbucket Downloads pagination did not complete");
        seen.add(next);
        const page = z.object({ values: z.array(z.object({ name: z.string(), size: z.number() })), next: z.string().optional() }).parse(await this.api(next));
        const existing = page.values.find(item => item.name === filename);
        if (existing) {
          if (existing.size !== bytes.byteLength) throw new Error("The existing evidence download has a different size");
          const downloaded = await this.download(repository, filename);
          if (createHash("sha256").update(downloaded).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error("The Bitbucket download does not match the task evidence");
          return true;
        }
        next = page.next;
      }
      return false;
    };
    const url = `https://bitbucket.org/${repository}/downloads/${encodeURIComponent(filename)}`;
    if (await present()) return url;
    const form = new FormData(); form.set("files", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    await beforeWrite();
    await this.api(`${coordinate(repository)}/downloads`, "POST", form);
    if (!await present()) throw new Error("Bitbucket has not confirmed the evidence upload");
    return url;
  }
}

export function createBitbucketReleasePort(connection: Connection, request: typeof fetch = fetch): GithubReleaseAdapter & Required<Pick<GithubReleaseAdapter, "observePullRequest" | "mergePullRequest" | "getPullRequestStates">> {
  const client = new BitbucketClient(connection, request);
  const local = createGithubReleasePort();
  const getPullRequest: GithubReleaseAdapter["getPullRequest"] = async input => pull(await client.api(`${coordinate(input.repository)}/pullrequests/${input.number}`));
  return {
    async checkAuthentication() { await client.api("/2.0/user"); },
    async getRemoteRepository({ cwd }) {
      const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["remote", "get-url", "origin"], cwd });
      const remote = repositoryCoordinate(result.stdout);
      if (result.exitCode !== 0 || remote?.host !== "bitbucket") throw new GithubReleaseFailure("wrong-remote", "Git origin is not a Bitbucket repository");
      return remote.repository;
    },
    async getBranchHead(input) {
      try { return z.object({ target: z.object({ hash: sha }) }).parse(await client.api(`${coordinate(input.repository)}/refs/branches/${encodeURIComponent(input.branch)}`)).target.hash; }
      catch (error) { if (error instanceof ProviderHttpFailure && error.status === 404) return null; throw error; }
    },
    inspectLocalRevision: local.inspectLocalRevision,
    pushNormal: local.pushNormal,
    async listPullRequests(input) { return (await client.list(input.repository)).filter(row => row.headBranch === input.headBranch && row.baseBranch === input.baseBranch && !row.isCrossRepository); },
    async listOpenPullRequests(input) { return (await client.list(input.repository, "OPEN")).slice(0, input.limit); },
    async createDraftPullRequest(input) { return pull(await client.api(`${coordinate(input.repository)}/pullrequests`, "POST", { title: input.title, description: input.body, draft: true, close_source_branch: false, source: { branch: { name: input.headBranch } }, destination: { branch: { name: input.baseBranch } } })); },
    async updateDraftPullRequest(input) { return pull(await client.api(`${coordinate(input.repository)}/pullrequests/${input.number}`, "PUT", { title: input.title, description: input.body })); },
    getPullRequest,
    async getPullRequestStates(inputs) { return Promise.all(inputs.map(async input => { const row = await getPullRequest(input); return { repository: row.repository, number: row.number, url: row.url, headSha: row.headSha, state: row.state, mergedAt: row.mergedAt }; })); },
    async observePullRequest(input) {
      const row = input.pullRequestNumber ? await getPullRequest({ repository: input.repository, number: input.pullRequestNumber }) : (await client.list(input.repository)).find(row => row.headBranch === input.branch && !row.isCrossRepository);
      let checks: GithubPullRequestObservation["checks"] = { total: 0, pending: 0, failing: 0, successful: 0, runs: [] };
      if (row) {
        const runs: GithubPullRequestObservation["checks"]["runs"] = [];
        let next: string | undefined = `${coordinate(input.repository)}/commit/${row.headSha}/statuses?pagelen=100`;
        const seen = new Set<string>();
        while (next) {
          if (seen.has(next) || seen.size >= 100) throw new Error("Bitbucket checks pagination did not complete");
          seen.add(next);
          const statuses = z.object({ values: z.array(z.object({ name: z.string(), state: z.string(), url: z.string().nullable().optional() })), next: z.string().optional() }).parse(await client.api(next));
          runs.push(...statuses.values.map(value => ({ name: value.name, status: value.state === "SUCCESSFUL" ? "successful" as const : value.state === "FAILED" || value.state === "STOPPED" ? "failing" as const : "pending" as const, url: value.url ?? null })));
          next = statuses.next;
        }
        checks = { total: runs.length, pending: runs.filter(r => r.status === "pending").length, failing: runs.filter(r => r.status === "failing").length, successful: runs.filter(r => r.status === "successful").length, runs };
      }
      return { exists: Boolean(row), number: row?.number ?? null, url: row?.url ?? null, state: row?.state ?? null, isDraft: row?.isDraft ?? null, headSha: row?.headSha ?? null, baseSha: row?.baseSha ?? null, mergeable: null, mergeStateStatus: null, checks, autoMergeEnabled: false, reviewDecision: null };
    },
    async markReadyForReview() { throw new Error("Bitbucket delivery supports draft pull requests only"); },
    async mergePullRequest() { throw new Error("Bitbucket delivery supports draft pull requests only"); },
  };
}
