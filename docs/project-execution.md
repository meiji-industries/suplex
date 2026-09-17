# Project execution

Project settings can capture project instructions, local skill directories,
non-secret environment values, and approved Claude MCP servers. Tasks snapshot
these settings when created. Skills and setup output are copied to Forge's
task runtime directory, outside the repository. Existing worktree instructions
are preserved. Every agent receives the project context before its prompt.

Configured setup runs before the first native session for projects with
execution or integration settings. Setup must be idempotent: after an
interrupted startup Forge can wait for an existing command and run setup
again. A successful native session is retained across restart. Failed setup
is supplied to the Coordinator as repair work, with a path to full output.
Setup does not inherit provider tokens or routing overrides.

## Shared verification resources

macOS and Linux need Python 3 with its standard `fcntl` module. Wrap every
command that uses the shared database with the same resource name:

```sh
python3 /path/to/forge/scripts/shared-resource-command.py \
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
Forge composes these definitions with its own bridge under strict MCP
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
   Basic authentication; without it, Forge uses a bearer token. Git clone and
   push use your Git transport configuration, separately from these API tokens.
3. Select the issue tracker independently. Jira needs the Cloud site, project
   key, and email/token references. GitHub Issues needs its own owner/repository.
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
task's generated evidence directory. Forge retains the files as task artifacts,
updates the draft description, and posts an evidence comment on the associated
issue. The comment does not change issue status, Sprint, or Fix Version.
Retries use the destination captured when publication began. Later association
edits do not redirect a partially published comment.

Screenshots use Jira attachments, Bitbucket Downloads, or GitHub CLI media
attachments. GitHub media requires a CLI that supports `--attach`. Forge checks
capability before uploading. Reviewers still need access to the provider's
private project/repository; a local artifact URL is not an external share link.

If another application puts an older GitHub CLI first on `PATH`, select the
supported executable for the Forge process. For example, a local Homebrew
installation can use `FORGE_GH_COMMAND=/opt/homebrew/bin/gh mise run dev`.
Keep this machine-specific selection out of shared project configuration.

Before using a client project, separately verify the dedicated model login,
approved MCP tools, Git clone/push, issue reads, and draft/comment/attachment
writes in an authorized test project. Then open the published evidence with a
reviewer's account. Local tests cannot prove client access or inline rendering.
