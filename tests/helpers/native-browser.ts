import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chromium, webkit } from "playwright";
import { TaskSchema } from "../../src/frontend/contracts/tasks.js";

const git = promisify(execFile);

async function loopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => server.once("error", reject).listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No browser test port");
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}

type FixtureOptions = { providerMode?: "isolated" | "inherited" };

async function startRustServer(root: string, port: number, options: FixtureOptions): Promise<() => Promise<void>> {
  const executable = resolve(process.env.SUPLEX_BIN ?? "rust/target/debug/suplex");
  const assets = resolve(process.env.SUPLEX_ASSETS_DIR ?? "dist/web");
  await stat(executable);
  await stat(join(assets, "suplex-ui.js"));
  const isolated = options.providerMode !== "inherited";
  const fixtureBin = join(root, "fixture-bin");
  await mkdir(fixtureBin, { recursive: true });
  const unavailableHerdr = join(fixtureBin, "herdr");
  await writeFile(unavailableHerdr, "#!/bin/sh\nexit 127\n");
  await chmod(unavailableHerdr, 0o700);
  const data = join(root, "data");
  const child = spawn(executable, ["serve"], { detached: isolated, env: {
    ...process.env,
    PATH: `${fixtureBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    ...(isolated ? {
      SUPLEX_CODEX_COMMAND: "/usr/bin/false", SUPLEX_CLAUDE_COMMAND: "/usr/bin/false",
      SUPLEX_OPENCODE_COMMAND: "/usr/bin/false", SUPLEX_DEVIN_COMMAND: "/usr/bin/false",
    } : {}),
    SUPLEX_ENV_FILE: join(root, "suplex.env"), SUPLEX_ROOT: root,
    SUPLEX_PORT: String(port),
    SUPLEX_ACCESS_MODE: "local", SUPLEX_BIND_ADDRESS: "127.0.0.1",
    SUPLEX_DATA_ROOT: data, SUPLEX_DATABASE_PATH: join(data, "suplex.sqlite"),
    SUPLEX_ARTIFACT_ROOT: join(data, "artifacts"), SUPLEX_RUNTIME_ROOT: join(data, "runtime"),
    SUPLEX_REPOSITORY_ROOT: join(root, "repositories"), SUPLEX_WORKTREE_ROOT: join(root, "worktrees"),
    SUPLEX_ASSETS_DIR: assets,
    GH_CONFIG_DIR: join(root, "gh-config"), GH_TOKEN: "", GITHUB_TOKEN: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let failure: Error | undefined;
  child.once("error", error => { failure = error; });
  const outputFile = process.env.SUPLEX_OUTPUT_FILE;
  let listening = false;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(-8_000); listening ||= /^URL: /m.test(output); if (outputFile) appendFileSync(outputFile, chunk); });
  const exited = new Promise<void>(accept => child.once("close", () => accept()));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (isolated && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } else if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>(accept => setTimeout(accept, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      if (isolated && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      else child.kill("SIGKILL");
      await exited;
    }
  };
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Rust fixture exited: ${failure?.message ?? output}`);
      // The server prints its URL only after it binds. Without this, a parallel
      // fixture that won the same port can answer the probe instead.
      if (listening) try { if ((await fetch(`http://127.0.0.1:${port}/auth`, { signal: AbortSignal.timeout(500) })).ok) return stop; } catch { /* Waiting for the listener. */ }
      await new Promise(accept => setTimeout(accept, 100));
    }
    throw new Error(`Rust fixture did not listen on ${port}: ${output}`);
  } catch (error) { await stop(); throw error; }
}

export async function nativeFixture(host = "127.0.0.1", reachableAddress?: string, options: FixtureOptions = {}) {
  if (host !== "127.0.0.1") throw new Error("Rust browser fixtures require loopback");
  const directory = await mkdtemp(join(tmpdir(), "suplex-browser-"));
  let port = reachableAddress ? Number(new URL(reachableAddress).port) : await loopbackPort();
  let stopRust: (() => Promise<void>) | undefined;
  let database: DatabaseSync | undefined;
  try {
    // Another parallel fixture can take a probed free port before this server binds.
    for (let attempt = 1; !stopRust; attempt++) {
      try { stopRust = await startRustServer(directory, port, options); }
      catch (error) { if (reachableAddress || attempt === 3 || !String(error).includes("AddrInUse")) throw error; port = await loopbackPort(); }
    }
    const base = `http://127.0.0.1:${port}`;
    const signIn = await fetch(`${base}/api/auth/me`);
    if (!signIn.ok) throw new Error(`Fixture sign-in failed: ${signIn.status} ${await signIn.text()}`);
    const user = (await signIn.json() as { user: { id: string } }).user;
    const cookies = signIn.headers.getSetCookie().map(value => value.split(";", 1)[0]!);
    const headers = { cookie: cookies.join("; "), origin: base };
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    const listed = await api("GET", "/api/companies");
    if (listed.status !== 200) throw new Error(`Fixture company lookup failed: ${JSON.stringify(listed)}`);
    const company = (listed.body as { companies: Array<{ id: string; name: string }> }).companies[0];
    if (!company) throw new Error("Fixture has no company");
    const createTask = async (input: Record<string, unknown>) => {
      const created = await api("POST", `/api/companies/${company.id}/tasks`, { projectId: "project_browser", ...input });
      if (created.status !== 201) throw new Error(`Fixture task creation failed: ${JSON.stringify(created.body)}`);
      return TaskSchema.parse(created.body);
    };
    const databasePath = join(directory, "data", "suplex.sqlite");
    const repositoryPath = join(directory, "repositories", "repo");
    const worktreeRoot = join(directory, "worktrees", "repo");
    const bare = join(directory, "origin.git");
    await git("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
    await git("git", ["init", "--quiet", "--initial-branch=main", repositoryPath]);
    await git("git", ["-C", repositoryPath, "config", "user.name", "Suplex fixture"]);
    await git("git", ["-C", repositoryPath, "config", "user.email", "fixture@example.invalid"]);
    await git("git", ["-C", repositoryPath, "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
    await git("git", ["-C", repositoryPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    await git("git", ["-C", repositoryPath, "config", `url.file://${bare}.insteadOf`, "https://github.com/owner/repo.git"]);
    await git("git", ["-C", repositoryPath, "push", "--quiet", "origin", "main"]);
    database = new DatabaseSync(databasePath);
    const project = { id: "project_browser", companyId: company.id, name: "Repository", repository: "owner/repo", repositoryPath, worktreeRoot, rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" };
    const now = new Date().toISOString();
    database.prepare("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'main','','',?,?,'{}',?,?)")
      .run(project.id, company.id, project.name, repositoryPath, worktreeRoot, project.repository, project.rootProfileId, project.workerProfileId, now, now);
    const openedDatabase = database;
    return { directory, config: { port, databasePath, artifactRoot: join(directory, "data", "artifacts") }, database, userId: user.id, company, project, headers, api, createTask, base,
      async restartRust() { await stopRust?.(); stopRust = await startRustServer(directory, port, options); },
      async close(options: { preserveData?: boolean } = {}) { openedDatabase.close(); await stopRust?.(); if (!options.preserveData) await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { database?.close(); await stopRust?.(); await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function nativeBrowser(width = 1280, host = "127.0.0.1", reachableAddress?: string, options: FixtureOptions = {}) {
  const fixture = await nativeFixture(host, reachableAddress, options);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // The desktop app renders in WebKit (Tauri); SUPLEX_BROWSER=webkit runs the suite in that engine.
    browser = await (process.env.SUPLEX_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addCookies(fixture.headers.cookie.split("; ").map(pair => { const index = pair.indexOf("="); return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: host, path: "/" }; }));
    const page = await context.newPage();
    const errors: string[] = [];
    // WebKit reports same-origin requests cancelled by a navigation as access-control errors; Chromium drops them silently.
    const cancelled = `${new URL(fixture.base).host}/`;
    page.on("pageerror", error => { if (!(error.message.includes(cancelled) && error.message.endsWith("due to access control checks."))) errors.push(error.message); });
    const openedBrowser = browser;
    return { ...fixture, browser, page, errors,
      async close(options: { preserveData?: boolean } = {}) { try { await openedBrowser.close(); } finally { await fixture.close(options); } },
    };
  } catch (error) { await browser?.close(); await fixture.close(); throw error; }
}
