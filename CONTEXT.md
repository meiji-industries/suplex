# Forge

Forge is a local-first software-delivery control plane that durably coordinates agentic engineering work across company-scoped projects.

## Language

**Tailscale-only access**:
The Forge service binds to the host's Tailscale address and is reachable only through the authenticated Tailscale network, never through public or LAN exposure.
_Avoid_: Public access, LAN access, all-interface bind

**Forge user**:
An authenticated application identity using a passkey and explicit company-scoped membership. Membership grants full administration of every project in that company, but no visibility or authority in a company where they lack membership. The user can create tasks and configure companies or projects through Forge's responsive mobile web UI; provider issue import and the duplicate operator CLI are deferred. Initial host setup and service startup use a documented local command; all day-to-day operation is web-only. Forge documents optional manual macOS background-service setup rather than automating installation or service registration. The normal task form requires company, project, title, and description, with project defaults; priority, role-specific profiles, and supplemental review are optional advanced controls. New tasks enter backlog until a company member explicitly starts Lead planning. The same UI supports approvals, releases, blocker handling, and issue-status checks. Forge surfaces attention through “Action required” task badges and a visible count in the task index rather than a separate inbox or push notifications. A badge means a human must act now: an approval, final acceptance, missing local provider authentication, capacity exhaustion, or a terminal failure; ordinary waiting and automatic retries do not trigger it. The index shows a short next action and expands to relevant, redacted error detail.
_Avoid_: Device identity, anonymous operator

**Sanitized evidence**:
Logs, artifacts, and UI error details after package-based masking of structured fields and free-form text. Failed agent turns and provider errors are retained as sanitized evidence artifacts. Sanitization is defense in depth and never permits intentional storage of credential-bearing payloads.
_Avoid_: Raw error payload, credential-bearing log

**Temporal history**:
Durable orchestration records containing only small IDs, hashes, summaries, and artifact references. Raw plans, source code, prompts, logs, and attachments remain outside history.
_Avoid_: Content-bearing workflow payload, durable raw transcript

**Issue evidence**:
Immutable final plans, reviews, verification reports, and promotion receipts displayed directly on an issue. Raw agent transcripts and process logs remain expandable supporting evidence; later work creates new artifacts rather than overwriting evidence.
_Avoid_: Transcript-first issue page, hidden delivery evidence

**Manual retention**:
The owner-controlled MVP retains sanitized artifacts, agent transcripts, and process logs without automatic expiration or rotation. The instance administrator removes retained data explicitly; configurable retention and deletion controls are deferred to productization.
_Avoid_: Automatic rotation, retention scheduler

**Issue collaboration**:
Explicit revision requests, approval notes, and immutable workflow evidence. Forge does not provide issue comments or chat in the MVP.
_Avoid_: Issue chat, discussion thread

**Task brief**:
The company-scoped Markdown description and immutable image attachments supplied when creating an issue. Images are automatically available to the Lead as planning evidence and reach the Developer only when the final plan explicitly requires them.
_Avoid_: Plain-text-only intake, mutable task attachment

**Kanban**:
A read-only, derived view of issue workflow state inside an active company context. It exposes explicit legal action buttons but does not use drag-and-drop to change state in the MVP. The instance administrator also has an agency-wide, cross-company overview with one row per company showing active-issue count, action-required count, and recent activity; ordinary members remain limited to their assigned companies.
_Avoid_: Editable board column, drag-and-drop transition, cross-company member access

**Host health**:
A compact web view of Temporal, the database, artifact storage, workers, and provider authentication, available from a mobile device.
_Avoid_: CLI-only diagnostics, hidden host readiness

**Manual backup**:
A web-triggered snapshot action with visible last-backup age. It includes the Forge database, artifacts, and non-secret Temporal Cloud connection configuration while Workflow history remains in Temporal Cloud; provider, agent, and Temporal credentials are excluded. Automatic backup scheduling is deferred in the pilot.
_Avoid_: Unobservable backup age, MVP backup scheduler

**Active project**:
A project is exactly one repository, whose local path may belong to only one company and project. Its local repository, worktree root, role agents, and configured delivery-provider login must pass Forge’s web validation. Configuration changes apply to new issues only; each active issue remains pinned to its starting configuration revision.
_Avoid_: Unvalidated project, first-task setup failure, mid-flight configuration mutation, cross-company repository reuse

**Local GitHub login**:
The host OS user's existing GitHub CLI OAuth session, used by Forge only through `gh` commands and validated by Forge health checks. Forge does not copy its token into configuration, artifacts, prompts, or workflow history.
_Avoid_: Stored PAT, GitHub App for the pilot, UI-collected GitHub credential

**Provider credential**: An OpenRouter API key is stored locally, excluded from backups, and passed to omp through a protected environment file.

**Instance administrator**:
The single setup-and-recovery authority with visibility across all companies and power to manage users and system configuration. It is not the normal path for company work.
_Avoid_: Company member, default operator

**Owner-controlled pilot**:
The first live Forge operating boundary, in which every configured company and repository is controlled by the instance administrator. Client-owned repositories and data are excluded until agent sandbox isolation is proven.
_Avoid_: Multi-client pilot, unsandboxed client rollout

**Material plan decision**:
A Lead plan decision that requires human approval before development: architecture or dependency changes, schema/data migrations, security or permission changes, new external integrations, production-affecting operations, or user-visible behavior changes. Routine plans proceed automatically after readiness validation.
_Avoid_: Routine plan, implementation detail

**Plan revision request**:
An auditable request to reconsider a plan after work has begun. It cancels any active Developer turn, records and preserves its worktree state without automatic cleanup, resumes the Lead session with the changed intent, and produces a new plan revision rather than editing an existing plan. If the Lead rejects partial work, the revised plan uses a fresh isolated worktree rather than trying to clean the original.
_Avoid_: Direct plan edit, silent instruction change, automatic worktree cleanup

**Continue**:
An action available only on cancelled or terminally failed issues that creates a successor execution. The successor carries forward the task brief and relevant evidence but starts with a fresh Lead session and isolated worktree; the original execution remains immutable history.
_Avoid_: Resume cancelled process, overwrite historical run

**Task split**:
A company member creates a separate issue when work needs an independent delivery boundary. Forge does not create or orchestrate child issues automatically in the MVP.
_Avoid_: Automatic child issue, hierarchical task orchestration

**Task dependency**:
A dependency is expressed as an explicit blocker note and separate task, not a graph or automated wait relationship in the MVP.
_Avoid_: Dependency graph, automatic task wait

**Plan approval**:
An auditable human decision by any authenticated member of the issue's company that permits a material plan to enter development. The issue creator may approve their own issue; no separation-of-duties rule applies in the pilot.
_Avoid_: Agent approval, implicit approval

**Decision blocker**:
A blocked state used when the Lead cannot establish a root cause or make a required design choice. It asks a company member one concise question with supporting evidence and one response field that returns the decision to the Lead, rather than passing ambiguity to the Developer.
_Avoid_: Ambiguous implementation plan, Developer-led design exploration

**Plan contradiction**:
Repository evidence that conflicts with a prescribed plan. The Developer stops before editing and returns the evidence to the Lead for correction rather than improvising a design.
_Avoid_: Silent Developer redesign, edit-before-clarification

**Delivery report**:
The Developer’s evidence record mapping changed files and verification results to the numbered Lead-plan steps they fulfill.
_Avoid_: Untraceable delivery, unstructured completion claim

**Agent turn result**:
A schema-validated status outcome—such as delivered, needs input, or failed—returned alongside each role’s human-readable artifact. A malformed result keeps the current stage and returns to the same role session for format correction before Forge continues.
_Avoid_: Prose-inferred transition, unvalidated agent completion

**Pragmatic review**:
Analyst review that targets roughly a nine-out-of-ten quality bar and returns work only for blocking correctness, acceptance, security, compatibility, or operational-safety findings. Nits and minor polish do not reopen implementation; advisory observations stay in the review artifact and never create follow-up work automatically.
_Avoid_: Perfection loop, nit-driven rework

**Agent**:
A named identity with an Analyst, Implementer, or Reviewer role and an avatar, assigned to an Agent profile. Projects and tasks select agents for each role; reassignment affects future turns while preserving the selected profile settings for each admitted turn.
_Avoid_: Profile identity without role, silent agent reassignment

**Agent profile**:
A named preset in an uncapped global catalog, managed through Forge web settings and stored in the database, that fixes an agent provider, model, reasoning level, and service priority for a role turn. Profiles do not carry avatars or task assignment. The MVP begins with seeded Codex examples but permits the administrator to create and tune additional profiles. Custom role prompts are not part of profiles. Projects select role agents, and each agent is assigned one profile. Profiles are editable without version-history management; each turn records the resolved settings it actually used. An unavailable profile retries through the configured durable capacity policy, then pauses with a typed blocker if that policy is exhausted; it never falls back silently.
_Avoid_: Ad hoc model override, profile-version management

**Capacity lane**:
A configurable admission limit for concurrent turns using an agent provider or profile. A lane may admit independent work in parallel but never concurrent turns for the same issue-role session or worktree. Its uncapped pilot queue is shared across companies and processes supplemental reviews and ordinary agent turns first-in, first-out; issue priority is not part of the MVP.
_Avoid_: Unlimited concurrency, global single-turn queue, reserved reviewer slot, company quota, no-op priority

**Issue worktree**:
The isolated Git worktree and branch assigned to one issue. Parallel issues targeting the same repository always use distinct issue worktrees, agent sessions, and commit boundaries. When the target base advances, Forge favors forward-merging the new base over rebasing at explicit review and release gates. A merge conflict blocks for an Analyst-owned, prescriptive resolution that reconciles the intent and invariants of both branches rather than mechanically choosing a side. Forge reruns the full original verification matrix, then repeats Analyst review for the resulting revision. A post-merge verification failure returns to the Analyst for a repair plan before the Implementer resumes.
_Avoid_: Shared working directory, reused issue branch, automatic conflict resolution

**Direct release**:
The delivery route for a direct-GitHub project. Forge creates or updates its draft pull request only after Analyst approval of the exact revision and immediately before external CI evidence is required. It remains a draft after CI until any authenticated company member explicitly accepts the final result, then becomes ready for review. Forge never merges it automatically; an authoritative GitHub merge event marks the issue done. Release uses normal pushes only and rejects force-pushes, rebases, and amended commits after Analyst approval. Cancelling after publication stops Forge but leaves the external draft unchanged and linked from the cancelled issue.
_Avoid_: Early draft publication, unreviewed external branch, automatic merge

**Mirrored human release**:
The delivery route for an Azure DevOps or Bitbucket project. Forge uses an authorized internal GitHub mirror for reviewed work and CI, then seals an immutable manifest for a named human release owner to promote the exact reviewed commit in the customer system. The owner approves through Forge's web UI; a local worker uses the provider login already present on the Forge host and returns a receipt. Missing provider authentication blocks the action until a local sign-in restores the exact configured session, then automatically resumes only if the manifest, target, and approval are unchanged. A successful promotion records its receipt and enters a visible, non-alerting “Handed off externally” state because Forge does not presume the client’s downstream workflow is complete. A company member later marks the issue done once completion in that downstream system is known, with optional completion note and downstream-record URL.
_Avoid_: Agent-owned customer release, unsealed promotion, substituted commit, approver CLI requirement, credential entry in Forge

**Supplemental review**:
An optional independent agent opinion requested for an original implementation plan after the primary Lead has drafted it. It uses an independently selected allowed agent profile and a fresh session, which may use the same or a different provider/model from the primary Lead. It is never triggered by a mandatory criticality flag and may be requested at issue creation or after the initial draft, but only before the plan is final. The reviewer receives the complete draft plan and the same project-scoped evidence as the primary Lead. Its findings return to the primary Lead, which reconsiders the plan as a whole and records a concise response before finalizing it; any required human approval applies only to that consolidated final plan. The pilot permits one supplemental review per original-plan revision; a material revision may receive one fresh review. It does not review implementation or repair plans.
_Avoid_: Required critical review, automatic escalation

**Role session**:
A resumable agent conversation scoped to one issue and role. The Lead retains one session through planning, technical review, and repair planning; the Developer retains a separate session for prescribed implementation.
_Avoid_: Shared role conversation, new Lead session per phase

**Release automation**:
Deterministic provider operations that publish and reconcile an exact reviewed revision. It is the default release path; a Release-agent session is created only for exceptional interpretation, while technical judgment remains with the Lead. The Developer remains local-only: it edits, tests, and commits inside an issue worktree but never publishes branches or calls providers. The Tailscale-only MVP polls configured providers only for issues awaiting pull-request, CI, or release status rather than accepting public webhooks or running broad background sync. A polling outage retries as provider connectivity and is never treated as CI failure; exhausted connectivity retry becomes an action-required blocker. CI success requires every configured check to pass on the exact reviewed pull-request head.
_Avoid_: Default release-agent turn, agent feature QA

**Bootstrap administrator**:
The first local Forge user, created by enrolling a passkey through a one-time, 72-hour administrator invite and granted instance administration to configure all later users and authority. Only the invite hash is stored; replacing an unused invite revokes its predecessor, and later recovery requires an explicit operator action.
_Avoid_: Default account, anonymous board owner
