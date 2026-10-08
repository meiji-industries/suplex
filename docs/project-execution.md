# Project execution

Project settings can capture project instructions, local skill directories,
non-secret environment values, and approved Claude MCP servers. Tasks snapshot
these settings when created. Skills and setup output are copied to Suplex's
task runtime directory, outside the repository. Existing worktree instructions
are preserved. Every agent receives the project context before its prompt.

Configured setup runs before the first native session for projects with
execution or integration settings. Setup must be idempotent: after an
interrupted startup Suplex can wait for an existing command and run setup
again. A successful native session is retained across restart. Failed setup
is supplied to the Coordinator as repair work, with a path to full output.
Setup does not inherit provider tokens or routing overrides.

## Repository settings

Add `.suplex/settings.toml` at the root of the project's repository checkout
(`repositoryPath`) to provide repository-owned execution settings:

```toml
[scripts]
setup = "pnpm install"
verify = "pnpm check"

[tasks]
concurrency = 1

[agent]
instructions = """
Use the project conventions.
Run the verification command before reporting completed work.
"""
```

Every key is optional. Unknown keys are ignored. Concurrency must be a whole
number of 1 or more. Present values override stored project values, including
empty command or instruction strings. Suplex reads the file each time it loads
the project and when it admits queued tasks. It does not save a copy in SQLite.
Task creation snapshots the effective commands and instructions. Existing tasks
keep their snapshots; concurrency changes apply to subsequent admissions.

The project response includes `repositorySettings` with the file path, the
provided fields, and an optional error. Without the file, this value is null.
The Execution section disables provided fields. PATCH and PUT requests that
include those fields return 422 with finding code `repository-settings`.
Edit the file to change them. A malformed file applies no overrides and shows
an error in the Execution section. Stored values remain in effect.

## Project and credential boundaries

A company groups projects and controls application access. A project selects its
repository, instructions, integrations, and permitted agent credentials. These
boundaries organize client work; they do not create separate host users or
sandbox the native tools.

A profile identifies an agent provider, model, and optional dedicated login.
The project's provider policy permits system logins and dedicated instances
separately. For example, a project can allow one dedicated Claude instance while
leaving its allowed system-provider list empty. This prevents Suplex from
selecting the host's general provider login for that project. Dedicated instances
support Claude Code; the same credential-directory isolation is not implemented
for every provider. See [profile eligibility](../apps/server/src/profiles/agent_profiles.rs)
and [task profile selection](../apps/server/src/tasks/commands.rs).

Model authentication, Git transport, repository APIs, issue trackers, and MCP
servers have separate access paths. A successful model sign-in does not prove
that a task can push a branch or read a Jira issue. Environment-variable
references keep integration token values out of saved task configuration, but
do not establish host-level secret isolation. Provider sign-in also does not
prove subscription entitlement or successful model inference.

The paired-agent task policy is another boundary: it controls what an external
caller can request when creating work. It does not confer the human operator's
permissions or create a universal fence around manual repository actions.
See [external agent authorization](agent-api.md).

## Shared verification resources

macOS and Linux need Python 3 with its standard `fcntl` module. Wrap every
command that uses the shared database with the same resource name:

```sh
python3 /path/to/suplex/scripts/shared-resource-command.py \
  --resource postgres:localhost:5432:app-testing -- pnpm test
```

Put this command in the project's verification command. If setup uses the
same database, wrap its database operation with the same resource name too.
Manual runners must use the wrapper. Do not include credentials in the key.
Absolute path keys are canonicalized; other keys are matched exactly.

The wrapper holds a host OS lock for the command's process group. It keeps
the lock if the caller dies while children continue, forwards normal
interruptions, and releases the lock after the group exits. Independent
resources run concurrently. Commands that do not use the wrapper, and
commands that deliberately escape into another process group, are outside
this guarantee. No persistent queue or stale-lock deletion is necessary.

## Claude authentication and MCP

Dedicated Claude instances use their own Claude and Anthropic profile
directories for login, readiness, and dispatch. Inherited authentication and
routing overrides are removed. User, repository, and local Claude settings
are not loaded for these launches; managed policy remains effective.
Instructions and skill files are supplied explicitly as task context.

MCP definitions use environment-variable references for headers and process
environment values. Their grants list exact tool names separately for
Coordinator (`root`), Advisor, and Worker. Coordinator and Advisor grants
must name approved read tools; a server's name does not establish safety.
Suplex composes these definitions with its own bridge under strict MCP
configuration. Unlisted tools do not receive permission. Project MCP is
currently supported only for Claude agents.

Use scoped account onboarding to verify actual model access, MCP access,
and the effective managed policy. Local fixture tests do not establish
contractual data-retention guarantees or client account permissions.

## Issue-to-draft setup

1. Add a dedicated Claude login in Settings and sign in with the client account.
   Create the project's Coordinator, Worker, and Advisor profiles with that login.
   In Project settings, restrict provider access to those providers and logins.
2. Select the repository host and base branch. For Bitbucket, enter environment
   variable **names**, not token values. An email reference selects API-token
   Basic authentication; without it, Suplex uses a bearer token. Git clone and
   push use your Git transport configuration, separately from these API tokens.
3. Select the issue tracker independently. Jira needs the Cloud site, project
   key, and email/token references. Linear needs the team key and API key
   environment variable. GitHub Issues needs its own owner/repository.
   None disables issue search for this project. Existing projects without new
   connection settings retain their GitHub issue source behavior.
4. Add instructions, optional local skill directories, and setup/verification
   commands. Select Draft PR as the task delivery target. Bitbucket supports
   local work, pushed branches, and draft PRs, not automatic ready/merge actions.
5. Select an Issue in New Task, or click None beside Issue in task details.
   The first execution reads current issue context. Changing the association
   later does not replace task text or restart native work.

An example read-only Context7 grant for Claude profiles:

```json
[
  {
    "name": "context7",
    "transport": { "type": "http", "url": "https://mcp.context7.com/mcp", "headers": { "CONTEXT7_API_KEY": "CONTEXT7_API_KEY" } },
    "grants": {
      "root": ["resolve-library-id", "query-docs"],
      "advisor": ["resolve-library-id", "query-docs"],
      "worker": ["resolve-library-id", "query-docs"]
    }
  }
]
```

The Worker writes Before/After command output and optional screenshots to the
task's generated evidence directory. Suplex retains the files as task artifacts,
updates the draft description, and posts an evidence comment on the associated
issue. The comment does not change issue status, Sprint, or Fix Version.
Retries use the destination captured when publication began. Later association
edits do not redirect a partially published comment.

Screenshots use Jira or Linear attachments, Bitbucket Downloads, or GitHub CLI media
attachments. GitHub media requires a CLI that supports `--attach`. Suplex checks
capability before uploading. Reviewers still need access to the provider's
private project/repository; a local artifact URL is not an external share link.

If another application puts an older GitHub CLI first on `PATH`, select the
supported executable for the Suplex process. For example, a local Homebrew
installation can use `SUPLEX_GH_COMMAND=/opt/homebrew/bin/gh mise run dev`.
Keep this machine-specific selection out of shared project configuration.

Before using a client project, separately verify the dedicated model login,
approved MCP tools, Git clone/push, issue reads, and draft/comment/attachment
writes in an authorized test project. Then open the published evidence with a
reviewer's account. Local tests cannot prove client access or inline rendering.
