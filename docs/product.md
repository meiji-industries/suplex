# Suplex product guide

Start here for product research, requirements discovery, and landing-page copy.
This guide translates Adam's walkthrough into claims checked against this
checkout on 2026-09-27. Implementation links establish what the code supports;
they do not establish successful live operation, availability in a released
build, or a provider's subscription entitlement.

## Audience and problem

Suplex is an orchestration layer for software-development professionals and solo
agency owners using their existing coding agents and developer tools. It reduces
the work of copying plans between agents, brokering revisions, and shepherding
branches and checks through delivery.

A Coordinator investigates and specifies a task, delegates implementation to a
Worker, reviews the result, and requests delivery operations. Projects organize
repositories and configuration. Task worktrees let independent tasks progress
in parallel. The current trust boundary is owner-controlled repositories and
trusted local tools. Project organization and credential policies do not provide
host-level isolation between clients.

Positioning to test: **Your agents do the work. Suplex runs the workflow.**

## Product direction: a copilot that steers

[Engineering principles](architecture/principles.md) make this direction
concrete for guards, blockers, recovery, and human escalation.

People remain in control. They can edit code, change a branch, adjust the work,
or merge a pull request themselves. Suplex should observe what happened,
preserve their work, and continue from the actual state. It should not demand
that they repeat an action through Suplex or repair its bookkeeping first.

A delivery target expresses the requested outcome for agent work. It is not a
fence around what the user may do. Do not turn target selection into new refusal
rules or prevent manual intervention because it differs from a saved target.
When intent changes, adapt the work instead of forcing the original sequence.

The product value is less coordination work with the tools people already use.
Logs, tests, reviews, and screenshots help people understand the work. An
"evidence packet" or client receipt is not a product focus, a required output,
or a launch prerequisite. Do not infer a receipt UI, mandatory export, or
"reviewed before anything ships" promise from internal verification records.

The workflow checks described below record current implementation behavior,
not instructions to add more enforcement. Authentication, project permissions,
and safeguards against destructive actions retain their specific purposes;
they do not justify turning ordinary development changes into approval gates.

## Capabilities and limits

The rows below describe implemented support. Limits and publication checks are
part of each claim, not optional qualifications.

| Capability | Current support and limits | Implementation |
| --- | --- | --- |
| Existing agent tools | OpenCode, Claude Code, Devin CLI, Codex CLI, and Pi have native runtimes. Pi also runs models on a local OpenAI-compatible server that its own `models.json` configures. Other tools need a runtime integration; compatibility is not automatic. | [Runtime selection](../apps/server/src/runtimes/task_harness_registry.rs) |
| Existing accounts and subscriptions | Agent tools own model authentication. Suplex can use their configured access, but executable discovery and sign-in checks do not prove model access or subscription eligibility. Verify each advertised provider/account combination live. | [Provider configuration](../apps/server/src/profiles) |
| Project credential policies | Projects can allow or deny system provider logins and dedicated login instances. Dedicated instances currently support Claude Code only. Integration secrets use environment-variable references. This is not an OS sandbox or a general API-key vault. | [Profile eligibility](../apps/server/src/profiles/agent_profiles.rs), [login instances](../apps/server/src/profiles/provider_instances.rs), [project execution](project-execution.md) |
| Multiple projects | Projects hold repository, agent, execution, and integration settings within companies. Tasks capture their configuration. | [Project service](../apps/server/src/projects/service.rs), [task creation](../apps/server/src/tasks/creation.rs) |
| Specification, implementation, and review | Coordinator plans and reviews; Worker edits and verifies. Roles can use different profiles, matching the senior/junior handoff in the brief without promising a model's seniority. | [Task controller](../apps/server/src/coordination/root_controller.rs) |
| Moves | Project-scoped saved prompts and scripts with typed inputs. A prompt opens the selected Worker agent (Claude Code or Codex) in an interactive host terminal at a fresh worktree, a script runs in that terminal, or a move starts a queued Pull request repair task for each open pull request you do not exclude. The agent keeps its own permission prompts. Run history records each start. There is no scheduling. | [Moves and tests](../apps/server/src/moves/mod.rs), [HTTP routes](../apps/server/src/http/routes/moves.rs) |
| Plans and team access | Free, Pro (one seat, 14-day trial on joining), and Team (per seat). Team lets an admin choose which companies each member sees and make a member read-only. When Pro ends the host is Free and keeps all work editable; when Team ends work is read-only until Team is selected again. | [Billing](billing.md), [member access](accounts.md#member-access) |
| Quick shell | An admin opens a persistent login shell on the host from a console that drops from the top of the window (Ctrl+` or the sidebar button). Closing the console keeps the shell; a restart ends it. | [Quick shell route](../apps/server/src/http/routes/quick_shell.rs), [console](../apps/web/shell/quick-shell.tsx) |
| Phone access and notifications | The web app installs to the Home Screen from any host it serves over HTTPS or loopback. Web Push tells the task creator and admins when a task needs input: iOS and iPadOS 16.4 or later only from the Home Screen app; Chrome, Edge, and Firefox on Android and desktop. The desktop app and the iOS and Android shells do not receive Web Push. | [Web Push](../apps/server/src/web_push/mod.rs), [phone shells](../apps/mobile) |
| Voice dictation | In a browser with speech recognition, a microphone button appends spoken text to the Coordinator message and the New Task description. The browser vendor, not Suplex, processes the audio. The desktop app does not show the button. | [Dictation hook](../apps/web/features/tasks/use-dictation.ts) |
| Reusable task templates | Project-scoped templates save task configuration and can be created from an existing task. | [Templates and tests](../apps/server/src/tasks/templates.rs), [HTTP routes](../apps/server/src/http/routes/task_templates.rs) |
| Customizable workflows | Named, editable presets select a built-in workflow and agent, delivery, and check defaults. Project instructions and task descriptions customize the work. There is no arbitrary step-graph editor. | [Workflow presets](../apps/server/src/coordination/workflow_records.rs), [workflow catalog](../apps/server/src/coordination/workflows.rs) |
| GitHub triggers | Enabled project rules poll labelled open pull requests and create tasks using a selected workflow. Each rule has a setting for draft pull requests and one for ready pull requests: ignore, review only, or deliver. Review only creates a task that targets the draft pull request: it pushes repairs and observes checks, but does not request review or merge. When a reviewed draft becomes ready and keeps its label, the next check continues the task to the rule's delivery target. Existing rules ignore drafts and deliver ready pull requests. A conditional request every 15 seconds detects a newly labelled pull request; a full check runs every minute. This is a specific PR-label trigger, not a general GitHub event or Actions workflow system. | [Trigger implementation and tests](../apps/server/src/integrations/github_triggers.rs), [HTTP routes](../apps/server/src/http/routes/github_triggers.rs) |
| Parallel work | Tasks use separate Git worktrees and branches. Combined planning can run Plan A and Plan B independently; other delegated work uses the shared Worker/Advisor slot. Worktrees separate files, not host credentials or shared services. | [Worktrees and tests](../apps/server/src/tasks/worktree.rs), [task controller](../apps/server/src/coordination/root_controller.rs) |
| Dependency-aware task chains | Queued tasks wait for prerequisite tasks or GitHub pull requests. Backlog tasks do not start automatically. Pull request prerequisites, and prerequisite tasks with a pull request delivery target, require a merge. | [Task dependencies](../apps/server/src/tasks/dependencies.rs), [PR dependencies](../apps/server/src/tasks/pull_request_dependencies.rs), [queue](../apps/server/src/tasks/commands.rs) |
| Repository and delivery operations | Coordinator can request publication, observe checks, and pursue the selected delivery target. Agents can repair code and integration conflicts. Available targets depend on the repository host; see below. | [Delivery operations and tests](../apps/server/src/delivery/operations.rs) |
| Paired bots | A paired external agent such as Hermes can create and follow tasks within its grants. A bot can supply meeting notes as task input; Suplex does not implement meeting capture or transcription. | [Agent routes](../apps/server/src/http/routes/agent_api.rs), [agent authorization and tests](../apps/server/src/tasks/agent_api.rs) |

## Integrations

| Integration | Implemented scope | Boundary |
| --- | --- | --- |
| Git | Repository and task worktree operations. | Git transport authentication is separate from issue-tracker and repository API credentials. Validate clone and push with the actual host account. |
| GitHub | Repository onboarding, issues, pull requests, check observation, delivery, and PR-label triggers. | Repository permissions, required checks, reviews, and merge policy still apply. See [GitHub delivery](../apps/server/src/integrations/github_delivery.rs). |
| Bitbucket Cloud | Repository/PR API access and delivery to a local worktree, remote branch, or draft PR. | Automatic ready and merged targets are unsupported. See [Bitbucket integration](../apps/server/src/integrations/bitbucket.rs) and [target support](../apps/server/src/tasks/control.rs). |
| Jira Cloud | A project can select Jira independently of its repository host, read issue context, and publish task artifacts/comments. | Configuration targets an Atlassian Cloud site and project. Publication does not change issue status, Sprint, or Fix Version. See [issue tracker](../apps/server/src/integrations/issue_tracker/jira.rs) and [issue publication](../apps/server/src/delivery/issue_evidence.rs). |
| MCP clients connecting to Suplex | HTTP MCP with approved project access and an advanced local stdio bridge expose task tools. | MCP task tools do not expose runtime delivery/merge commands. They answer a Coordinator question only for an agent that an administrator lets answer on their behalf. See [connection guide](agent-mcp.md) and [route implementation](../apps/server/src/http/routes/mcp.rs). |
| Project MCP tools for agents | Project configuration grants exact tools by role and resolves credential references. | This project-managed configuration currently supports Claude Code agents only. It is distinct from MCP settings inherited by other native providers. See [project execution](project-execution.md) and [role grants](../apps/server/src/runtimes/project_mcp.rs). |
| Linear | A project can select Linear independently of its repository host, scoped to one team. Suplex searches and reads team issues with their comments and publishes task evidence comments and screenshot uploads. | Uses a personal API key from an environment variable. Issues from other teams are refused. Publication does not change issue state. Automated tests use a local GraphQL fixture; validate search, comments, and uploads with a real workspace before client use. See [Linear tracker](../apps/server/src/integrations/issue_tracker/linear.rs) and [issue publication](../apps/server/src/delivery/issue_evidence.rs). |
| Herdr | Displays native sessions or provider output through task panes. | Pane availability is not task completion or authorization. The spelling is **Herdr**. See [integration guide](herdr-integration.md). |

## Workflows and delivery

The six built-in workflows are:

- **Plan and build** (`standard`): Coordinator plans, Worker implements, Coordinator reviews.
- **Simple task** (`direct_build`): Worker chooses the approach from the task instructions;
  Coordinator reviews the result.
- **Double reviews** (`independent_review`): a read-only Reviewer checks the current change before delivery.
- **Double plans** (`competing_plans`): Plan A and Plan B produce independent plans; Coordinator
  combines them before implementation.
- **Review and repair** (`refine_pull_request`): a Rater reviews an existing open PR, Worker repairs it,
  and rating repeats until the current change earns at least 9 with no blocking
  findings. Delivery then pursues merging that PR subject to GitHub checks and policy.
- **Approve then build** (`approve_then_build`): Coordinator plans and asks you to
  approve the complete plan or request changes. Suplex records the approved plan and
  refuses the first Worker build unless it uses that exact plan. Repairs after
  that build need no new approval. Coordinator then reviews and delivers.

Named presets reuse these sequences; they do not introduce new step types.
See [workflows and templates](architecture/workflows-and-templates.md) for
how presets, project templates, and intake differ, and
[parallel work and dependencies](architecture/parallel-work-and-dependencies.md)
for worktree isolation and prerequisite semantics.
The code and wire fields call Coordinator `root`. That is an implementation name
for the same role, not another agent. Advisors are read-only. Individual Advisors share the delegated slot with
Worker; Combined planning reserves separate Plan A and Plan B slots.

Delivery targets are local worktree, remote branch, draft PR, ready PR, and
merged PR. GitHub supports all five; Bitbucket supports the first three. A
completed task means its selected target was reached, which need not mean a
production deployment. Suplex observes CI and requests delivery operations;
project automation owns any deployment triggered by those operations.

People can intervene directly in Git and the repository host. Suplex observes
that work rather than requiring every change to pass through its own commands.
For operations Suplex performs, the current implementation checks workflow
reviews and configured verification; the repository host applies its own policy.
These checks do not establish a product promise that nothing can ship without
Suplex's approval. A specific unresolved decision can require a human answer.
The separate paired-agent API's authorization exchange is documented in
[the agent API guide](agent-api.md).

Restart recovery reads native sessions and current Git/provider state. A missing
Herdr pane does not block task progress. Some uncertain execution after a hard
crash requires explicit cleanup confirmation. See [recovery](recovery-hardening.md).
Checks, review records, command output, and optional screenshots remain useful
verification artifacts. Their presence is not a second source of truth for Git
or provider state.

Usage and outcome reporting is described in [task analytics](analytics.md).

## Before publishing a claim

- Confirm the target release contains the linked implementation. This is a
  source-checkout guide, not a release certification.
- Verify the advertised provider, model, and subscription or API account with a
  real authorized task. Configuration and login detection are insufficient.
- For each integration, verify the required reads and writes with the intended
  credentials. Check published artifacts from a reviewer's account.
- Demonstrate the advertised delivery target, including CI failures, repair,
  review requirements, and any human approval. Do not equate a merged PR with a
  deployed application or promise automatic conflict resolution in every case.
- Keep proposed capabilities separate from implemented claims. The walkthrough's
  broad integration list, arbitrary workflows, and meeting-to-task story need the
  qualifications above. This repository is `meiji-industries/suplex`; the unrelated
  Python/Supabase/Reflex project is not a source for its features.

## Market questions and positioning to test

Potential themes are less agent babysitting, explicit planning and review,
parallel tasks with prerequisites, existing tools and accounts, and project
credential controls. Agency use must retain the owner-controlled trust boundary.

- Which solo developers and small agencies already coordinate multiple coding agents?
- How much time do they spend on handoffs, review, and CI/rebase cleanup?
- Which integrations are must-have versus table stakes?
- How do users want to pay when they already have agent subscriptions?
- What credential-isolation or client-governance requirements block adoption?
- Which delivery steps do buyers trust only after seeing a demo?

## Reading the repository

Use this guide for product claims, [CONTEXT.md](../CONTEXT.md) for terminology,
and [README](../README.md) for setup. The [current architecture](architecture/README.md)
records runtime and Herdr behavior. Follow implementation links to resolve
behavior questions. [ADRs](adr/) explain retained engineering decisions; their
dated observations are not current feature or release claims. Completed plans,
superseded designs, and old reviews belong in Git history. The top-level
[legacy prompt templates](../prompts/README.md) are not product requirements. New proposals must
identify their unimplemented scope and must not be used as shipped requirements.
A generated market or launch memo is a proposal, not an approved roadmap. It
cannot establish launch dates, blockers, mandatory features, or product policy.
