import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

const root = fileURLToPath(new URL(".", import.meta.url));
const modules = ["agent-api", "auth", "avatars", "common", "github-triggers", "oauth", "projects", "providers", "system-events", "task-templates", "tasks", "update", "workflows"] as const;
const inputs = {
  missing: undefined,
  null: null,
  empty_object: {},
  unknown_field: { unexpected: true },
  empty_array: [],
} as const;
const projectBody = {
  name: "Project", repositoryPath: "/tmp/project", worktreeRoot: "/tmp/worktrees",
  repository: "team/project", baseBranch: "main", setupCommand: "pnpm install",
  verificationCommand: "pnpm test", rootProfileId: "root", workerProfileId: "worker",
};
const projectPolicy = {
  workflowIds: ["workflow"], defaultWorkflowId: "workflow", rootProfileIds: ["root"], workerProfileIds: ["worker"],
};
const mcpServer = {
  name: "context7", transport: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "CONTEXT7_TOKEN" } },
  grants: { root: ["query_docs"], advisor: [], worker: ["query_docs"] },
};
const workflowRecord = { name: "  Build  ", engine: "standard", id: "workflow", archivedAt: null, createdAt: "now", updatedAt: "now" };
const taskBody = { projectId: "project", title: "  Build  ", idempotencyKey: "task-0001" };
const githubIssue = { kind: "github", repository: "team/repo", number: 12, id: "123", key: "GH-12", title: "Issue", url: "https://github.com/team/repo/issues/12" };
const jiraIssue = { kind: "jira", site: "https://team.atlassian.net", id: "123", key: "APP-12", title: "Issue", url: "https://team.atlassian.net/browse/APP-12" };
const taskTemplate = { name: "  Build  " };
const taskTemplateResponse = { name: "Build", description: "", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", workflow: "standard", advisorProfileIds: {}, id: "template", projectId: "project", createdAt: "now", updatedAt: "now" };
const semanticInputs: Record<string, Record<string, unknown>> = {
  "task-templates.TaskTemplateParamsSchema": { valid_strip: { templateId: "template", extra: true }, empty_id: { templateId: "" }, astral_id: { templateId: "😀" } },
  "task-templates.ProjectTaskTemplatesParamsSchema": { valid_strip: { projectId: "project", extra: true }, empty_id: { projectId: "" } },
  "task-templates.SaveTaskAsTemplateParamsSchema": { valid_strip: { taskId: "task", extra: true }, empty_id: { taskId: "" } },
  "task-templates.SaveTaskAsTemplateBodySchema": { trimmed: { name: "  Build  " }, blank: { name: " \t " }, unknown: { name: "Build", extra: true } },
  "task-templates.CreateTaskTemplateBodySchema": {
    defaults: taskTemplate,
    full: { ...taskTemplate, description: "  Description  ", rootProfileId: "root", workerProfileId: "worker", deliveryTarget: "merged", runProjectTests: false, visualEvidence: "capture", workflow: "direct_build", advisorProfileIds: { reviewer: "reviewer" } },
    blank_name: { name: "  " },
    empty_description: { name: "Build", description: "  " },
    invalid_profiles: { name: "Build", rootProfileId: "", workerProfileId: "😀".repeat(129) },
    max_profile_id: { name: "Build", rootProfileId: "😀".repeat(128) },
    overlong_profile_id: { name: "Build", rootProfileId: "x".repeat(257) },
    array_name: { name: [] },
    invalid_enums: { name: "Build", deliveryTarget: "publish", visualEvidence: "screen", workflow: "other" },
    invalid_advisors_and_unknown: { name: "Build", advisorProfileIds: { reviewer: "", extra: true }, extra: true },
    null_defaults: { name: "Build", description: null, deliveryTarget: null, runProjectTests: null, visualEvidence: null, workflow: null, advisorProfileIds: null },
  },
  "task-templates.UpdateTaskTemplateBodySchema": {
    empty_patch: {},
    trim: { name: "  Rename  ", description: "  Detail  " },
    nullable_profiles: { rootProfileId: null, workerProfileId: null },
    unbounded_patch_profile_id: { rootProfileId: "x".repeat(257) },
    array_description: { description: [] },
    present_options: { deliveryTarget: "merged", runProjectTests: false, visualEvidence: "required", workflow: "refine_pull_request", advisorProfileIds: { planner_a: "planner" } },
    invalid_and_unknown: { name: " ", description: " ", rootProfileId: "", deliveryTarget: "other", advisorProfileIds: { extra: true }, extra: true },
    null_nonnullable: { deliveryTarget: null, workflow: null, runProjectTests: null },
  },
  "task-templates.TaskTemplateResponseSchema": {
    complete: taskTemplateResponse,
    stripped_unknown: { ...taskTemplateResponse, extra: true },
    missing_metadata: { name: "Build" },
    malformed_metadata: { ...taskTemplateResponse, id: null, createdAt: 1 },
  },
  "task-templates.TaskTemplateListResponseSchema": {
    empty_list: { templates: [] },
    one_template: { templates: [taskTemplateResponse], extra: true },
    invalid_item: { templates: [taskTemplateResponse, { ...taskTemplateResponse, workflow: "other" }] },
  },
  "tasks.TaskAnswerBodySchema": {
    trimmed_answer: { questionId: "question", answer: "  Yes  ", confirmCommandsStopped: true },
    blank_answer: { questionId: "question", answer: "  " },
    add_allowance: { questionId: "question", limitDecision: { kind: "add_allowance" } },
    cancel_task: { questionId: "question", limitDecision: { kind: "cancel_task" } },
    change_limits: { questionId: "question", limitDecision: { kind: "change_limits", limits: { budgetUsd: 0, maxTurns: 0 } } },
    change_limits_fractional_budget: { questionId: "question", limitDecision: { kind: "change_limits", limits: { budgetUsd: 1.5, maxTurns: 3 } } },
    change_limits_max_turns: { questionId: "question", limitDecision: { kind: "change_limits", limits: { budgetUsd: 0, maxTurns: Number.MAX_SAFE_INTEGER } } },
    change_limits_invalid: { questionId: "question", limitDecision: { kind: "change_limits", limits: { budgetUsd: -1, maxTurns: 1.5 } } },
    change_limits_unsafe: { questionId: "question", limitDecision: { kind: "change_limits", limits: { budgetUsd: 1, maxTurns: Number.MAX_SAFE_INTEGER + 1 } } },
    change_limits_unknown: { questionId: "question", limitDecision: { kind: "change_limits", limits: { budgetUsd: 1, maxTurns: 2, extra: true } } },
    change_limits_missing_budget: { questionId: "question", limitDecision: { kind: "change_limits", limits: { maxTurns: 2 } } },
    invalid_decision_kind: { questionId: "question", limitDecision: { kind: "other" } },
    both_branches: { questionId: "question", answer: "yes", limitDecision: { kind: "cancel_task" } },
    answer_wrong_type: { questionId: "question", answer: 1 },
    answer_null: { questionId: "question", answer: null },
    invalid_confirm: { questionId: "question", answer: "yes", confirmCommandsStopped: 1 },
    decision_unknown: { questionId: "question", limitDecision: { kind: "add_allowance", extra: true } },
    unknown_top: { questionId: "question", answer: "yes", extra: true },
  },
  "tasks.TaskWorkerReplacementBodySchema": {
    trimmed_optional: { sessionId: "session", reason: "  Replace  ", handoff: "  Context  ", workerProfileId: "worker" },
    blank_reason: { sessionId: "session", reason: " \t " },
    empty_handoff: { sessionId: "session", reason: "reason", handoff: "   " },
    invalid_and_unknown: { sessionId: "", reason: null, workerProfileId: "", extra: true },
  },
  "tasks.TaskCoordinatorReplacementBodySchema": {
    resume_false: { sessionId: "session", rootProfileId: "root", resume: false, handoff: "  Context  " },
    resume_true: { sessionId: "session", rootProfileId: "root", resume: true, questionId: "question" },
    missing_question: { sessionId: "session", rootProfileId: "root", resume: true },
    false_with_question_unknown: { sessionId: "session", rootProfileId: "root", resume: false, questionId: "question" },
    invalid_resume: { sessionId: "session", rootProfileId: "root", resume: "yes" },
    invalid_fields: { sessionId: "", rootProfileId: "", handoff: 1, resume: true, questionId: "", extra: true },
  },
  "tasks.TaskAgentSelectionBodySchema": {
    select_root: { role: "root", expectedProfileId: "old", expectedSessionId: null, profileId: "new", direction: "  Build  ", resume: false },
    resume_advisor: { role: "reviewer", expectedProfileId: "old", expectedSessionId: "session", profileId: "new", direction: "  ", resume: true, questionId: "question" },
    missing_question: { role: "worker", expectedProfileId: "old", expectedSessionId: null, profileId: "new", direction: "go", resume: true },
    invalid_role: { role: "advisor", expectedProfileId: "old", expectedSessionId: null, profileId: "new", direction: "go", resume: false },
    false_with_question_unknown: { role: "root", expectedProfileId: "old", expectedSessionId: null, profileId: "new", direction: "go", resume: false, questionId: "question" },
    invalid_fields: { role: "root", expectedProfileId: "", expectedSessionId: "", profileId: null, direction: 1, resume: true, questionId: "", extra: true },
  },
  "tasks.TaskIssueBodySchema": {
    github_issue: { issue: githubIssue },
    jira_issue: { issue: jiraIssue },
    null_issue: { issue: null },
    missing_issue_with_unknown: { extra: true },
    github_wrong_origin: { issue: { ...githubIssue, url: "https://example.com/x" } },
    github_invalid_url_throws: { issue: { ...githubIssue, url: "x" } },
    jira_invalid_site_throws: { issue: { ...jiraIssue, site: "x" } },
    nested_strict_unknown: { issue: { ...githubIssue, extra: true } },
  },
  "tasks.TaskDependenciesBodySchema": {
    both_defaults: {},
    both_lists: { dependsOn: ["one", "two"], blockedByPullRequests: [{ number: 1 }, { number: Number.MAX_SAFE_INTEGER }] },
    invalid_items: { dependsOn: ["", null], blockedByPullRequests: [{ number: 0, extra: true }] },
    max_depends_on: { dependsOn: Array.from({ length: 50 }, (_, index) => `task-${index}`) },
    too_many_depends_on: { dependsOn: Array.from({ length: 51 }, (_, index) => `task-${index}`) },
    too_many_pull_requests: { blockedByPullRequests: Array.from({ length: 51 }, (_, index) => ({ number: index + 1 })) },
    invalid_and_unknown: { dependsOn: null, blockedByPullRequests: "x", extra: true },
  },
  "tasks.TaskBodySchema": {
    defaults_trim: taskBody,
    all_fields: { ...taskBody, description: "  Description  ", images: [{ filename: "screen.png", mimeType: "image/png", base64: "eA==" }], rootProfileId: "root", workerProfileId: "worker", startImmediately: true, deliveryTarget: "merged", runProjectTests: false, visualEvidence: "capture", source: { kind: "branch", branch: "feature/x" }, issue: githubIssue, workflow: "direct_build", advisorProfileIds: { reviewer: "reviewer" }, dependsOn: ["task-1"], blockedByPullRequests: [{ number: 12 }] },
    jira_issue: { ...taskBody, issue: jiraIssue },
    null_issue: { ...taskBody, issue: null },
    issue_source: { ...taskBody, source: { kind: "issue", number: 1 } },
    pull_request_source: { ...taskBody, source: { kind: "pull_request", number: 1 } },
    blank_title: { ...taskBody, title: " \t " },
    invalid_idempotency: { ...taskBody, idempotencyKey: "bad key" },
    short_idempotency: { ...taskBody, idempotencyKey: "short" },
    astral_project_overlong: { ...taskBody, projectId: "😀".repeat(129) },
    image_bad_filename: { ...taskBody, images: [{ filename: "../secret", mimeType: "image/png", base64: "eA==" }] },
    image_slash_filename: { ...taskBody, images: [{ filename: "a/b", mimeType: "image/png", base64: "eA==" }] },
    image_backslash_filename: { ...taskBody, images: [{ filename: "a\\b", mimeType: "image/png", base64: "eA==" }] },
    image_max_filename: { ...taskBody, images: [{ filename: "x".repeat(255), mimeType: "image/png", base64: "x" }] },
    image_overlong_filename: { ...taskBody, images: [{ filename: "x".repeat(256), mimeType: "image/png", base64: "x" }] },
    image_overlong_slash_filename: { ...taskBody, images: [{ filename: `${"x".repeat(255)}/`, mimeType: "image/png", base64: "x" }] },
    image_empty_base64: { ...taskBody, images: [{ filename: "x", mimeType: "image/png", base64: "" }] },
    image_base64_max: { ...taskBody, images: [{ filename: "x", mimeType: "image/png", base64: "x".repeat(11_184_812) }] },
    image_base64_over_max: { ...taskBody, images: [{ filename: "x", mimeType: "image/png", base64: "x".repeat(11_184_813) }] },
    image_wrong_mime_unknown: { ...taskBody, images: [{ filename: "x", mimeType: "text/plain", base64: "x", extra: true }] },
    image_missing_fields: { ...taskBody, images: [{}] },
    too_many_images: { ...taskBody, images: Array.from({ length: 9 }, () => ({ filename: "x", mimeType: "image/png", base64: "x" })) },
    source_wrong_kind: { ...taskBody, source: { kind: "other", number: 1 } },
    source_invalid_number: { ...taskBody, source: { kind: "issue", number: 0, extra: true } },
    source_fractional_number: { ...taskBody, source: { kind: "pull_request", number: 1.5 } },
    source_max_safe_number: { ...taskBody, source: { kind: "issue", number: Number.MAX_SAFE_INTEGER } },
    source_unsafe_number: { ...taskBody, source: { kind: "issue", number: Number.MAX_SAFE_INTEGER + 1 } },
    source_empty_branch: { ...taskBody, source: { kind: "branch", branch: "" } },
    github_issue_mismatched_url: { ...taskBody, issue: { ...githubIssue, url: "https://github.com/team/repo/issues/13" } },
    github_issue_wrong_origin: { ...taskBody, issue: { ...githubIssue, url: "https://example.com/team/repo/issues/12" } },
    github_issue_invalid_url_throws: { ...taskBody, issue: { ...githubIssue, url: "x" } },
    github_issue_bad_repo: { ...taskBody, issue: { ...githubIssue, repository: "bad" } },
    github_issue_unicode_repo: { ...taskBody, issue: { ...githubIssue, repository: "tëam/repo" } },
    github_issue_case_insensitive_url: { ...taskBody, issue: { ...githubIssue, url: "https://github.com/TEAM/REPO/issues/12" } },
    github_issue_wrong_number: { ...taskBody, issue: { ...githubIssue, number: 0 } },
    jira_issue_bad_site: { ...taskBody, issue: { ...jiraIssue, site: "https://jira.example.com" } },
    jira_issue_invalid_site: { ...taskBody, issue: { ...jiraIssue, site: "x" } },
    jira_issue_wrong_url: { ...taskBody, issue: { ...jiraIssue, url: "https://team.atlassian.net/browse/APP-13" } },
    jira_issue_bad_key: { ...taskBody, issue: { ...jiraIssue, key: "bad" } },
    jira_issue_unicode_digit: { ...taskBody, issue: { ...jiraIssue, id: "١٢" } },
    jira_issue_case_sensitive_url: { ...taskBody, issue: { ...jiraIssue, url: "https://team.atlassian.net/browse/app-12" } },
    issue_unknown: { ...taskBody, issue: { ...githubIssue, extra: true } },
    issue_wrong_kind: { ...taskBody, issue: { kind: "other" } },
    invalid_advisor_and_dependencies: { ...taskBody, advisorProfileIds: { reviewer: "", extra: true }, dependsOn: [""], blockedByPullRequests: [{ number: -1, extra: true }] },
    too_many_dependencies: { ...taskBody, dependsOn: Array.from({ length: 51 }, (_, index) => `task-${index}`) },
    max_dependencies: { ...taskBody, dependsOn: Array.from({ length: 50 }, (_, index) => `task-${index}`) },
    too_many_blocked_prs: { ...taskBody, blockedByPullRequests: Array.from({ length: 51 }, (_, index) => ({ number: index + 1 })) },
    max_blocked_prs: { ...taskBody, blockedByPullRequests: Array.from({ length: 50 }, (_, index) => ({ number: index + 1 })) },
    invalid_enums: { ...taskBody, deliveryTarget: "publish", visualEvidence: "screen", workflow: "unknown" },
    invalid_booleans: { ...taskBody, startImmediately: "yes", runProjectTests: 1 },
  },
  "workflows.WorkflowRecordInputSchema": {
    trimmed_defaults: { name: "  Build  ", engine: "standard" },
    optional_fields: { name: "Build", description: "  A description  ", engine: "direct_build", rootProfileId: "root", workerProfileId: "worker", advisorProfileIds: { reviewer: "reviewer" }, deliveryTarget: "merged", runProjectTests: false, visualEvidence: "capture" },
    blank_name: { name: " \t ", engine: "standard" },
    empty_array_name: { name: [], engine: "standard" },
    bom_trim: { name: "\ufeffBuild\ufeff", description: "\ufeff Note \ufeff", engine: "standard" },
    overlong_astral_name: { name: "😀".repeat(41), engine: "standard" },
    invalid_advisor_and_unknown: { name: "Build", engine: "standard", advisorProfileIds: { reviewer: "", extra: true }, extra: true },
    invalid_engine: { name: "Build", engine: "other" },
  },
  "workflows.WorkflowRecordPatchSchema": {
    nullable_settings: { rootProfileId: null, workerProfileId: null, deliveryTarget: null, runProjectTests: null, visualEvidence: null },
    trim_present_fields: { name: "  Build  ", description: "  Description  ", archived: true },
    invalid_and_unknown: { name: " ", engine: "other", advisorProfileIds: { rater: "", extra: true }, extra: true },
    null_description: { description: null },
    empty_array_name: { name: [] },
  },
  "workflows.WorkflowRecordSchema": {
    response_defaults_and_strip: { ...workflowRecord, extra: true },
    invalid_response_fields: { ...workflowRecord, archivedAt: 1, updatedAt: null },
  },
  "workflows.WorkflowRecordParamsSchema": {
    valid_strips_unknown: { workflowId: "flow", extra: true },
    empty_workflow_id: { workflowId: "" },
  },
  "workflows.WorkflowListQuerySchema": {
    include_archived: { includeArchived: "true" },
    invalid_literal_and_unknown: { includeArchived: "false", extra: true },
  },
  "workflows.WorkflowListResponseSchema": {
    one_stripped_record: { workflows: [{ ...workflowRecord, extra: true }], extra: true },
    invalid_second_record: { workflows: [workflowRecord, { ...workflowRecord, engine: "other" }] },
  },
  "common.IdSchema": {
    empty_string: "",
    max_length: "x".repeat(256),
    over_max_length: "x".repeat(257),
    astral_at_max: "😀".repeat(128),
    astral_over_max: "😀".repeat(129),
  },
  "common.CompanyIdParamsSchema": {
    empty_id: { companyId: "" },
    over_max_id: { companyId: "x".repeat(257) },
    astral_over_max_id: { companyId: "😀".repeat(129) },
  },
  "common.TaskArtifactParamsSchema": {
    both_ids_empty: { taskId: "", artifactId: "" },
    second_id_missing: { taskId: "task" },
  },
  "common.CompanyStatusParamsSchema": {
    invalid_status: { companyId: "company", status: "inactive" },
    valid_status: { companyId: "company", status: "paused", extra: true },
  },
  "common.TokenBodySchema": {
    explicit_empty: { token: "" },
    invalid_token: { token: null },
  },
  "common.RegistrationVerificationBodySchema": {
    null_response: { response: null },
    nested_response: { response: { id: "credential", extension: [1, null] }, token: "token" },
  },
  "common.AuthenticationVerificationBodySchema": {
    null_response: { response: null },
    nested_response: { response: [1, "x"] },
  },
  "common.EmptyBodySchema": {
    nested_unknown: { nested: { value: [1, null] } },
  },
  "common.ExpectedRevisionBodySchema": {
    null_revision: { expectedRevision: null },
    boolean_revision: { expectedRevision: true },
    numeric_string_revision: { expectedRevision: " 12 " },
    empty_string_revision: { expectedRevision: "" },
    hex_string_revision: { expectedRevision: "0x10" },
    binary_string_revision: { expectedRevision: "0b1010" },
    large_hex_string_revision: { expectedRevision: "0x10000000000000000" },
    invalid_inf_string_revision: { expectedRevision: "inf" },
    nested_array_revision: { expectedRevision: [[2]] },
    null_array_revision: { expectedRevision: [null] },
    empty_array_revision: { expectedRevision: [] },
    singleton_array_revision: { expectedRevision: [2] },
    multi_array_revision: { expectedRevision: [1, 2] },
    object_revision: { expectedRevision: {} },
    negative_revision: { expectedRevision: -1 },
    fractional_revision: { expectedRevision: 1.5 },
    unsafe_revision: { expectedRevision: 9_007_199_254_740_992 },
    infinity_string_revision: { expectedRevision: "Infinity" },
    negative_infinity_string_revision: { expectedRevision: "-Infinity" },
    byte_order_mark_revision: { expectedRevision: "\ufeff3\ufeff" },
    optional_limits: { expectedRevision: 1, commandId: "x", idempotencyKey: "y", automatic: true, extra: true },
    empty_command_id: { expectedRevision: 1, commandId: "" },
    array_command_id: { expectedRevision: 1, commandId: [] },
    long_idempotency_key: { expectedRevision: 1, idempotencyKey: "x".repeat(257) },
  },
  "common.ExpectedRevisionNoteBodySchema": {
    optional_note: { expectedRevision: "2", note: "" },
    invalid_note: { expectedRevision: 1, note: null },
  },
  "common.RequiredRevisionNoteBodySchema": {
    trimmed_note: { expectedRevision: 1, note: "  Ready  " },
    empty_trimmed_note: { expectedRevision: 1, note: " \t " },
    wrong_note_type: { expectedRevision: 1, note: [] },
  },
  "common.HttpPlanDecisionBodySchema": {
    valid_key: { note: "  Yes  ", idempotencyKey: "A_b:c-123" },
    short_key: { note: "Yes", idempotencyKey: "short" },
    long_key: { note: "Yes", idempotencyKey: "a".repeat(129) },
    invalid_first_character: { note: "Yes", idempotencyKey: "_abcdefg" },
    invalid_key_character: { note: "Yes", idempotencyKey: "abc defgh" },
    short_invalid_key: { note: "Yes", idempotencyKey: "bad key" },
    empty_array_key: { note: "Yes", idempotencyKey: [] },
    empty_array_note: { note: [], idempotencyKey: "abcdefgh" },
    empty_note: { note: "  ", idempotencyKey: "abcdefghi" },
  },
  "common.HttpSupplementalReviewBodySchema": {
    null_revision: { expectedRevision: null, idempotencyKey: "abcdefghi" },
    negative_revision: { expectedRevision: -1, idempotencyKey: "abcdefghi" },
    fractional_revision: { expectedRevision: 1.5, idempotencyKey: "abcdefghi" },
  },
  "common.HttpPlanBlockerResponseBodySchema": {
    wrong_revision_type: { expectedWorkflowRevision: "1", answer: "Yes", idempotencyKey: "abcdefghi" },
    negative_revision: { expectedWorkflowRevision: -1, answer: "Yes", idempotencyKey: "abcdefghi" },
    trimmed_answer: { expectedWorkflowRevision: 1, answer: "  Yes  ", idempotencyKey: "abcdefghi" },
    unsafe_revision: { expectedWorkflowRevision: 9_007_199_254_740_992, answer: "Yes", idempotencyKey: "abcdefghi" },
  },
  "common.ResolveDecisionBlockerBodySchema": {
    empty_answer: { expectedRevision: 1, answer: "" },
    whitespace_answer: { expectedRevision: 1, answer: "  " },
    numeric_answer: { expectedRevision: 1, answer: 1 },
  },
  "providers.ProviderConnectionSchema": {
    optional_account: { status: "connected", summary: "Ready", account: "user@example.test", extra: true },
    invalid_status: { status: "ready", summary: "Ready" },
    null_account: { status: "unknown", summary: "Unknown", account: null },
  },
  "providers.NativeProviderSummarySchema": {
    negative_model_count: { id: "opencode", label: "OpenCode", modelCount: -1, models: [], status: "configured" },
    fractional_model_count: { id: "codex", label: "Codex", modelCount: 1.5, models: [], status: "configured" },
    unsafe_model_count: { id: "codex", label: "Codex", modelCount: 9_007_199_254_740_992, models: [], status: "configured" },
    nested_model_error: { id: "codex", label: "Codex", modelCount: 1, models: [{ id: "model", label: null }], status: "configured" },
    nested_model_strip: { id: "codex", label: "Codex", modelCount: 1, models: [{ id: "model", label: "Model", extra: true }], status: "configured", extra: true },
    models_wrong_type: { id: "codex", label: "Codex", modelCount: 0, models: {}, status: "configured" },
  },
  "providers.ProviderSummarySchema": {
    nested_connection_error: { id: "devin", label: "Devin", modelCount: 0, models: [], status: "missing", connection: { status: "ready", summary: 1 } },
  },
  "providers.ProviderListResponseSchema": {
    nested_provider_error: { directory: "/tmp", observedAt: "now", providers: [{ id: "bad", label: "Bad", modelCount: -1, models: [], status: "missing", connection: { status: "unknown", summary: "?" } }] },
  },
  "providers.ProviderInstanceSchema": {
    invalid_provider: { id: "1", provider: "other", label: "Other", homeDirectory: "/tmp", createdAt: "now", updatedAt: "now" },
    unknown_on_valid_nested: { id: "1", provider: "codex", label: "Codex", homeDirectory: "/tmp", createdAt: "now", updatedAt: "now", extra: true },
  },
  "providers.ProviderInstanceReadinessSchema": {
    invalid_status: { status: "ready", summary: "Ready" },
  },
  "providers.ProviderInstanceListResponseSchema": {
    nested_instance_error: { instances: [{ id: "1", provider: "codex", label: "Codex", homeDirectory: "/tmp", createdAt: "now", updatedAt: "now", readiness: { status: "wrong", summary: "" }, connection: { status: "unknown", summary: "?" } }] },
  },
  "providers.ProviderInstanceCreateBodySchema": {
    trim_label: { provider: "codex", label: "  Codex  " },
    empty_trimmed_label: { provider: "codex", label: " \t " },
    max_label: { provider: "codex", label: "x".repeat(128) },
    over_max_label: { provider: "codex", label: "x".repeat(129) },
    astral_over_max_label: { provider: "codex", label: "😀".repeat(65) },
    byte_order_mark_trim: { provider: "codex", label: "\ufeffCodex\ufeff" },
    next_line_not_trimmed: { provider: "codex", label: "\u0085Codex\u0085" },
    wrong_provider: { provider: "other", label: "Codex" },
    label_empty_array: { provider: "codex", label: [] },
    label_large_array: { provider: "codex", label: Array(129).fill("x") },
  },
  "providers.ProviderLoginResponseSchema": {
    invalid_pane: { paneId: 1 },
  },
  "tasks.TaskDetailsBodySchema": {
    all_fields: { title: "  Rename  ", description: "  Description  ", rootProfileId: "root", workerProfileId: "worker", deliveryTarget: "remote_branch", runProjectTests: false, visualEvidence: "capture", workflow: "direct_build", advisorProfileIds: { reviewer: "reviewer" } },
    empty_partial: {},
    trimmed_empty_title: { title: "  " },
    trimmed_empty_description: { description: "  " },
    invalid_enums: { deliveryTarget: "publish", visualEvidence: "screenshots", workflow: "unknown" },
    invalid_nested_advisor: { advisorProfileIds: { reviewer: "", planner_a: "😀".repeat(129), extra: true } },
    unknown_top_level: { description: "valid", extra: true },
    invalid_boolean: { runProjectTests: "false" },
    empty_array_profile: { rootProfileId: [] },
  },
  "tasks.TaskAgentsBatchQuerySchema": {
    one: { taskId: "task-b", extra: true },
    sorted_deduplicated: { taskId: ["task-b", "task-a", "task-b"] },
    empty_string: { taskId: "" },
    empty_task_id_array: { taskId: [] },
    too_many: { taskId: Array.from({ length: 11 }, (_, index) => `task-${index}`) },
    null_task_id: { taskId: null },
    invalid_array_item: { taskId: ["task-a", null] },
    overlong_string: { taskId: "x".repeat(257) },
    astral_sort: { taskId: ["😀", "\ue000", "😀"] },
  },
  "projects.ProjectAgentTaskPolicySchema": {
    defaults: { workflowIds: ["workflow"], defaultWorkflowId: "workflow", rootProfileIds: ["root"], workerProfileIds: ["worker"] },
    all_fields: { workflowIds: ["workflow"], defaultWorkflowId: "workflow", templateIds: ["template"], rootProfileIds: ["root"], workerProfileIds: ["worker"], advisorProfileIds: { reviewer: ["reviewer"], planner_a: [], planner_b: [], rater: [], extra: true }, deliveryTarget: "local_worktree", runProjectTests: false, visualEvidence: "required" },
    empty_required_arrays: { workflowIds: [], defaultWorkflowId: "workflow", rootProfileIds: [], workerProfileIds: [] },
    empty_default_workflow: { workflowIds: ["workflow"], defaultWorkflowId: "", rootProfileIds: ["root"], workerProfileIds: ["worker"] },
    invalid_nested_advisor: { workflowIds: ["workflow"], defaultWorkflowId: "workflow", rootProfileIds: ["root"], workerProfileIds: ["worker"], advisorProfileIds: { reviewer: [null] } },
    astral_overlong_id: { workflowIds: ["😀".repeat(129)], defaultWorkflowId: "workflow", rootProfileIds: ["root"], workerProfileIds: ["worker"] },
    wrong_enum_and_unknown: { workflowIds: ["workflow"], defaultWorkflowId: "workflow", rootProfileIds: ["root"], workerProfileIds: ["worker"], deliveryTarget: "publish", visualEvidence: "screenshots", extra: true },
    empty_array_workflow_id: { workflowIds: [[]], defaultWorkflowId: "workflow", rootProfileIds: ["root"], workerProfileIds: ["worker"] },
  },
  "projects.ProjectRepositoryBodySchema": {
    valid_bitbucket_and_jira: { repositoryUrl: "git@bitbucket.org:team/repo.git", integration: { repository: { kind: "bitbucket", tokenEnvironment: "BITBUCKET_TOKEN", usernameEnvironment: "BITBUCKET_USER" }, tracker: { kind: "jira", site: "https://team.atlassian.net/", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } }, baseBranch: "main" },
    default_integration: { repositoryUrl: "repo", integration: {} },
    empty_repository_url: { repositoryUrl: "" },
    invalid_base_branch: { repositoryUrl: "repo", baseBranch: "" },
    invalid_repository_kind: { repositoryUrl: "repo", integration: { repository: { kind: "gitlab" } } },
    invalid_jira_host: { repositoryUrl: "repo", integration: { tracker: { kind: "jira", site: "https://attacker.example/", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } } },
    malformed_jira_url: { repositoryUrl: "repo", integration: { tracker: { kind: "jira", site: "x", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } } },
    nested_unknown: { repositoryUrl: "repo", integration: { repository: { kind: "github", extra: true }, extra: true } },
    github_tracker_repository_pattern: { repositoryUrl: "repo", integration: { tracker: { kind: "github", repository: "bad" } } },
    invalid_bitbucket_environment: { repositoryUrl: "repo", integration: { repository: { kind: "bitbucket", tokenEnvironment: "bad" } } },
  },
  "projects.ProjectNewRepositoryBodySchema": {
    valid_with_branch: { repositoryName: "new-repo", baseBranch: "main" },
    overlong_name: { repositoryName: "x".repeat(201) },
    astral_overlong_name: { repositoryName: "😀".repeat(101) },
    nested_integration: { repositoryName: "new-repo", integration: { repository: { kind: "github" }, tracker: null } },
    invalid_branch_and_unknown: { repositoryName: "repo", baseBranch: "", extra: true },
  },
  "projects.ProjectBodySchema": {
    valid_nested_defaults: { ...projectBody, integration: {}, execution: {}, agentTaskPolicy: projectPolicy, providerPolicy: { allowedProviders: ["codex"], allowedInstanceIds: [] } },
    valid_mcp: { ...projectBody, execution: { mcp: [mcpServer], environment: { CUSTOM_TOKEN: "value" }, skillDirectories: ["/tmp/skills"] } },
    duplicate_mcp_name: { ...projectBody, execution: { mcp: [mcpServer, mcpServer] } },
    reserved_mcp_name: { ...projectBody, execution: { mcp: [{ ...mcpServer, name: "suplex_bad" }] } },
    invalid_mcp_url: { ...projectBody, execution: { mcp: [{ ...mcpServer, transport: { type: "http", url: "not a URL" } }] } },
    invalid_mcp_grant: { ...projectBody, execution: { mcp: [{ ...mcpServer, grants: { root: ["*"], advisor: [], worker: [] } }] } },
    invalid_environment_key: { ...projectBody, execution: { environment: { HOME: "bad" } } },
    invalid_environment_value: { ...projectBody, execution: { environment: { CUSTOM: 1 } } },
    too_many_skill_directories: { ...projectBody, execution: { skillDirectories: Array(51).fill("/tmp/skill") } },
    empty_skill_directory: { ...projectBody, execution: { skillDirectories: [""] } },
    invalid_policy: { ...projectBody, agentTaskPolicy: { ...projectPolicy, defaultWorkflowId: "" } },
    invalid_provider_policy: { ...projectBody, providerPolicy: { allowedProviders: ["bad"], allowedInstanceIds: [""] } },
    unknown_top_level: { ...projectBody, extra: true },
    empty_name_and_profile: { ...projectBody, name: "", rootProfileId: "" },
  },
  "projects.ProjectPatchBodySchema": {
    empty_patch: {},
    one_name: { name: "Renamed" },
    execution_partial_no_defaults: { execution: { environment: { CUSTOM: "value" } } },
    execution_empty_object: { execution: {} },
    execution_invalid: { execution: { skillDirectories: [""] } },
    policy_defaults: { agentTaskPolicy: projectPolicy },
    null_provider_policy: { providerPolicy: null },
    unknown_patch: { extra: true },
    invalid_and_unknown: { name: "", extra: true },
  },
  "projects.ProjectCreateBodySchema": {
    existing_repository: { repositoryUrl: "https://github.com/team/repo.git" },
    new_repository: { repositoryName: "repo" },
    full_project: projectBody,
    ambiguous_repository_fields: { repositoryUrl: "repo", repositoryName: "repo" },
    all_branch_errors: { repositoryUrl: "", repositoryName: "", name: "" },
  },
  "projects.ProjectResponseSchema": {
    stripped_top_and_nested: { ...projectBody, id: "project", companyId: "company", createdAt: "now", updatedAt: "now", execution: { instructions: "run", extra: true }, extra: true },
    missing_optional_repository: { ...projectBody, repository: undefined, id: "project", companyId: "company", createdAt: "now", updatedAt: "now" },
    invalid_id_and_nested: { ...projectBody, id: null, companyId: "company", createdAt: "now", updatedAt: "now", execution: { skillDirectories: [""] } },
  },
  "projects.ProjectListResponseSchema": {
    one_stripped_project: { projects: [{ ...projectBody, id: "project", companyId: "company", createdAt: "now", updatedAt: "now", extra: true }], extra: true },
    invalid_second_project: { projects: [{ ...projectBody, id: "one", companyId: "company", createdAt: "now", updatedAt: "now" }, { ...projectBody, id: "two", companyId: "company", createdAt: "now", updatedAt: "now", rootProfileId: null }] },
  },
  "projects.ProfileBodySchema": {
    trimmed_fields: { provider: "codex", model: "  codex/gpt-6  ", reasoningLevel: "high", serviceTier: "priority", name: "  Profile  ", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", providerInstanceId: null },
    bad_model_pattern: { provider: "codex", model: "bad model", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
    bad_avatar_pattern: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "ABCDEF" },
    empty_name: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "  ", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
    empty_model: { provider: "codex", model: "  ", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
    overlong_model: { provider: "codex", model: "x".repeat(257), reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
    wrong_nullable_id: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", providerInstanceId: "" },
    multiple_unknown: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", extraA: true, extraB: 1 },
    invalid_and_unknown: { provider: "bad", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", extra: true },
    model_array: { provider: "codex", model: [], reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
    astral_model: { provider: "codex", model: "😀".repeat(129), reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
    byte_order_mark_name: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "\ufeffProfile\ufeff", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef" },
  },
  "projects.ProfilePatchBodySchema": {
    empty_patch: {},
    partial_name: { name: "  New  " },
    archived_only: { archived: true },
    invalid_archived: { archived: "true" },
    null_provider_id: { providerInstanceId: null },
    bad_partial_model: { model: "/bad" },
    unknown_patch: { extra: true },
    invalid_and_unknown: { archived: null, extra: true },
  },
  "projects.ProfileResponseSchema": {
    stripped_unknown: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", id: "profile", archivedAt: null, createdAt: "now", updatedAt: "now", extra: true },
    invalid_archived_at: { provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", id: "profile", archivedAt: false, createdAt: "now", updatedAt: "now" },
  },
  "projects.ProfileListQuerySchema": {
    included: { includeArchived: "true" },
    false_string: { includeArchived: "false" },
    boolean_true: { includeArchived: true },
    unknown_query: { extra: "x" },
    invalid_and_unknown: { includeArchived: "false", extra: "x" },
  },
  "projects.ProfileListResponseSchema": {
    nested_profile_error: { profiles: [{ provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "bad", id: "profile", archivedAt: null, createdAt: "now", updatedAt: "now" }] },
    nested_profile_strip: { profiles: [{ provider: "codex", model: "gpt-6", reasoningLevel: "high", serviceTier: "priority", name: "Profile", role: "worker", avatarSeed: "0123456789abcdef0123456789abcdef", id: "profile", archivedAt: null, createdAt: "now", updatedAt: "now", extra: true }] },
  },
  "projects.ProjectRepositoryDefaultsResponseSchema": {
    empty_commands: { setupCommand: "", verificationCommand: "" },
    stripped_unknown: { setupCommand: "pnpm install", verificationCommand: "pnpm test", extra: true },
    wrong_command: { setupCommand: null, verificationCommand: 1 },
  },
  "projects.ProjectProviderInstanceSchema": {
    invalid_provider: { id: "one", provider: "other", label: "Other" },
    stripped_unknown: { id: "one", provider: "codex", label: "Codex", homeDirectory: "/tmp" },
  },
  "projects.ProjectProviderInstanceListResponseSchema": {
    nested_invalid_provider: { instances: [{ id: "one", provider: "other", label: "Other" }] },
    nested_strip: { instances: [{ id: "one", provider: "codex", label: "Codex", homeDirectory: "/tmp" }], extra: true },
  },
  "projects.ModelResponseSchema": {
    invalid_status: { id: "one", provider: "codex", providerLabel: "Codex", providerStatus: "ready", displayName: "GPT" },
    stripped_unknown: { id: "one", provider: "codex", providerLabel: "Codex", providerStatus: "configured", displayName: "GPT", extra: true },
  },
  "projects.ModelListResponseSchema": {
    nested_invalid_model: { models: [{ id: "one", provider: "other", providerLabel: "Other", providerStatus: "ready", displayName: "GPT" }] },
    nested_strip: { models: [{ id: "one", provider: "codex", providerLabel: "Codex", providerStatus: "configured", displayName: "GPT", extra: true }] },
  },
  "projects.TaskSourceQuerySchema": {
    branch_kind: { kind: "branch" },
    invalid_kind: { kind: "other" },
    stripped_unknown: { kind: "issue", extra: true },
  },
  "tasks.TaskRenameBodySchema": {
    trimmed_title: { title: "  New title  " },
    empty_title: { title: " \t " },
    unknown_on_valid_title: { title: "Title", extra: true },
    title_array: { title: [] },
  },
  "tasks.TaskNoteBodySchema": {
    trimmed_note: { note: "  Note  " },
    empty_note: { note: " \t " },
    max_note: { note: "x".repeat(20_000) },
    over_max_note: { note: "x".repeat(20_001) },
    astral_over_max_note: { note: "😀".repeat(10_001) },
    array_note: { note: [] },
  },
  "tasks.TaskArchiveBodySchema": {
    confirm_true: { confirmDiscardDirty: true },
    confirm_null: { confirmDiscardDirty: null },
    unknown_archive: { extra: true },
  },
  "tasks.TaskContinueDeliveryBodySchema": {
    merged_target: { deliveryTarget: "merged" },
    invalid_target: { deliveryTarget: "pull_request_draft" },
    unknown_target: { deliveryTarget: "merged", extra: true },
  },
  "tasks.TaskSessionHistoryParamsSchema": {
    empty_ids: { taskId: "", sessionId: "" },
    array_ids: { taskId: [], sessionId: [] },
    stripped_unknown: { taskId: "task", sessionId: "session", extra: true },
  },
  "tasks.TaskSessionHistoryQuerySchema": {
    before_max: { before: "x".repeat(512) },
    before_over_max: { before: "x".repeat(513) },
    before_empty: { before: "" },
    before_array: { before: [] },
    stripped_unknown: { before: "cursor", extra: true },
  },
  "tasks.TaskDiffResponseSchema": {
    valid_empty_patch: { available: false, patch: "", truncated: false, extra: true },
    invalid_fields: { available: "no", patch: null, truncated: 0 },
  },
  "tasks.TaskDiffSummaryResponseSchema": {
    negative_files: { available: true, files: -1 },
    fractional_files: { available: true, files: 1.5 },
    unsafe_files: { available: true, files: 9_007_199_254_740_992 },
  },
  "tasks.TaskAgentStatusSchema": { invalid_status: "started", known_status: "waiting_human" },
  "tasks.TaskHarnessKindSchema": { invalid_kind: "other", known_kind: "codex" },
  "tasks.WorktreeAppSchema": { invalid_app: "browser", known_app: "ghostty" },
  "tasks.WorktreeAppsResponseSchema": {
    nested_invalid_app: { apps: [{ id: "browser", label: "Browser" }] },
    nested_strip: { apps: [{ id: "ghostty", label: "Ghostty", extra: true }], extra: true },
  },
};

type Fixture = { contract: string; case: string; input?: unknown; expected: { accepted: true; value: unknown } | { accepted: false; error: unknown } };
const rawInputs: Record<string, Record<string, string>> = {
  "task-templates.TaskTemplateParamsSchema": { surrogate_id: String.raw`{"templateId":"\ud800"}` },
  "task-templates.ProjectTaskTemplatesParamsSchema": { surrogate_id: String.raw`{"projectId":"\ud800"}` },
  "task-templates.SaveTaskAsTemplateParamsSchema": { surrogate_id: String.raw`{"taskId":"\ud800"}` },
  "task-templates.SaveTaskAsTemplateBodySchema": { surrogate_name: String.raw`{"name":"\ud800"}`, strict_surrogate: String.raw`{"name":"Build","\ud800":1}` },
  "task-templates.CreateTaskTemplateBodySchema": { surrogate_name: String.raw`{"name":"\ud800"}`, surrogate_advisor: String.raw`{"name":"Build","advisorProfileIds":{"reviewer":"\ud800"}}`, strict_surrogate: String.raw`{"name":"Build","\ud800":1}` },
  "task-templates.UpdateTaskTemplateBodySchema": { surrogate_description: String.raw`{"description":"\ud800"}`, strict_surrogate: String.raw`{"\ud800":1}` },
  "task-templates.TaskTemplateResponseSchema": { surrogate_metadata: String.raw`{"name":"Build","id":"\ud800","projectId":"project","createdAt":"now","updatedAt":"now"}`, strict_surrogate: String.raw`{"name":"Build","id":"id","projectId":"project","createdAt":"now","updatedAt":"now","\ud800":1}` },
  "task-templates.TaskTemplateListResponseSchema": { surrogate_nested: String.raw`{"templates":[{"name":"Build","id":"\ud800","projectId":"project","createdAt":"now","updatedAt":"now"}]}` },
  "tasks.TaskAnswerBodySchema": {
    lone_surrogate_answer: String.raw`{"questionId":"question","answer":"\ud800"}`,
    strict_surrogate_key: String.raw`{"questionId":"question","answer":"yes","\ud800":1}`,
    overflow_budget: String.raw`{"questionId":"question","limitDecision":{"kind":"change_limits","limits":{"budgetUsd":1e400,"maxTurns":1}}}`,
    nested_strict_surrogate: String.raw`{"questionId":"question","limitDecision":{"kind":"change_limits","limits":{"budgetUsd":1,"maxTurns":2,"\ud800":1}}}`,
  },
  "tasks.TaskWorkerReplacementBodySchema": {
    surrogate_reason: String.raw`{"sessionId":"session","reason":"\ud800"}`,
    strict_surrogate_key: String.raw`{"sessionId":"session","reason":"reason","\ud800":1}`,
  },
  "tasks.TaskCoordinatorReplacementBodySchema": {
    surrogate_handoff: String.raw`{"sessionId":"session","rootProfileId":"root","handoff":"\ud800","resume":false}`,
    strict_surrogate_key: String.raw`{"sessionId":"session","rootProfileId":"root","resume":false,"\ud800":1}`,
  },
  "tasks.TaskAgentSelectionBodySchema": {
    surrogate_direction: String.raw`{"role":"root","expectedProfileId":"old","expectedSessionId":null,"profileId":"new","direction":"\ud800","resume":false}`,
    strict_surrogate_key: String.raw`{"role":"root","expectedProfileId":"old","expectedSessionId":null,"profileId":"new","direction":"go","resume":false,"\ud800":1}`,
  },
  "tasks.TaskIssueBodySchema": {
    lone_surrogate_title: String.raw`{"issue":{"kind":"github","repository":"team/repo","number":12,"id":"123","key":"GH-12","title":"\ud800","url":"https://github.com/team/repo/issues/12"}}`,
    lone_surrogate_url_throw: String.raw`{"issue":{"kind":"github","repository":"team/repo","number":12,"id":"123","key":"GH-12","title":"Issue","url":"\ud800"}}`,
    nested_strict_surrogate: String.raw`{"issue":{"kind":"github","repository":"team/repo","number":12,"id":"123","key":"GH-12","title":"Issue","url":"https://github.com/team/repo/issues/12","\ud800":1}}`,
  },
  "tasks.TaskDependenciesBodySchema": {
    surrogate_task_id: String.raw`{"dependsOn":["\ud800"],"blockedByPullRequests":[]}`,
    overflow_pr_number: String.raw`{"blockedByPullRequests":[{"number":1e400}]}`,
    strict_surrogate: String.raw`{"\ud800":1}`,
  },
  "tasks.TaskBodySchema": {
    lone_surrogate_title: String.raw`{"projectId":"project","title":"\ud800","idempotencyKey":"task-0001"}`,
    strict_surrogate_key: String.raw`{"projectId":"project","title":"Build","idempotencyKey":"task-0001","\ud800":1}`,
    issue_lone_surrogate_title: String.raw`{"projectId":"project","title":"Build","idempotencyKey":"task-0001","issue":{"kind":"github","repository":"team/repo","number":12,"id":"123","key":"GH-12","title":"\ud800","url":"https://github.com/team/repo/issues/12"}}`,
    issue_strict_surrogate_key: String.raw`{"projectId":"project","title":"Build","idempotencyKey":"task-0001","issue":{"kind":"github","repository":"team/repo","number":12,"id":"123","key":"GH-12","title":"Issue","url":"https://github.com/team/repo/issues/12","\ud800":1}}`,
    issue_invalid_surrogate_url: String.raw`{"projectId":"project","title":"Build","idempotencyKey":"task-0001","issue":{"kind":"github","repository":"team/repo","number":12,"id":"123","key":"GH-12","title":"Issue","url":"\ud800"}}`,
    issue_overflow_number: String.raw`{"projectId":"project","title":"Build","idempotencyKey":"task-0001","issue":{"kind":"github","repository":"team/repo","number":1e400,"id":"123","key":"GH-12","title":"Issue","url":"https://github.com/team/repo/issues/12"}}`,
    source_overflow_number: String.raw`{"projectId":"project","title":"Build","idempotencyKey":"task-0001","source":{"kind":"issue","number":1e400}}`,
  },
  "workflows.WorkflowRecordInputSchema": {
    lone_surrogate_description: String.raw`{"name":"Build","engine":"standard","description":"\ud800"}`,
    strict_surrogate_key: String.raw`{"name":"Build","engine":"standard","\ud800":1}`,
  },
  "workflows.WorkflowListResponseSchema": {
    stripped_overflow: String.raw`{"workflows":[{"name":"Build","engine":"standard","id":"flow","archivedAt":null,"createdAt":"now","updatedAt":"now","extra":1e400}],"extra":1e400}`,
  },
  "common.EmptyBodySchema": {
    surrogate_and_overflow: String.raw`{"x":"\ud800","count":1e400}`,
    deep_passthrough: `{"nested":${"[".repeat(20_000)}0${"]".repeat(20_000)}}`,
  },
  "common.TokenBodySchema": {
    lone_surrogate: String.raw`{"token":"\ud800"}`,
  },
  "common.RegistrationVerificationBodySchema": {
    response_special_values: String.raw`{"response":{"surrogate":"\ud800","count":1e400}}`,
  },
  "common.AuthenticationVerificationBodySchema": {
    response_special_values: String.raw`{"response":{"surrogate":"\udfff","count":1e400}}`,
  },
  "auth.CompanyNameBodySchema": {
    lone_surrogate: String.raw`{"name":"\ud800"}`,
    overflow_name: String.raw`{"name":1e400}`,
  },
  "auth.DisplayNameBodySchema": {
    lone_surrogate: String.raw`{"displayName":"\udfff"}`,
  },
  "auth.MembershipBodySchema": {
    lone_surrogate: String.raw`{"userId":"\ud800"}`,
  },
  "auth.CompanyIssueCodeBodySchema": {
    lone_surrogate: String.raw`{"issueCode":"\ud800"}`,
    overflow_issue_code: String.raw`{"issueCode":1e400}`,
  },
  "auth.ProfileBodySchema": {
    surrogate_and_overflow_unknown: String.raw`{"displayName":"\ud800","unknown":1e400}`,
    deep_unknown: `{"displayName":"Deep","unknown":${"[".repeat(20_000)}0${"]".repeat(20_000)}}`,
  },
  "projects.ProjectRepositoryBodySchema": {
    strict_surrogate_key: String.raw`{"repositoryUrl":"repo","\ud800":1}`,
    malformed_jira_url: String.raw`{"repositoryUrl":"repo","integration":{"tracker":{"kind":"jira","site":"x","project":"APP","emailEnvironment":"JIRA_EMAIL","tokenEnvironment":"JIRA_TOKEN"}}}`,
  },
  "projects.ProjectAgentTaskPolicySchema": {
    lone_surrogate_profile: String.raw`{"workflowIds":["flow"],"defaultWorkflowId":"flow","rootProfileIds":["\ud800"],"workerProfileIds":["worker"]}`,
  },
  "projects.ProjectBodySchema": {
    strict_surrogate_key: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"\ud800":1}`}`,
    nested_strict_surrogate_key: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"integration":{"repository":{"kind":"github","\ud800":1}}}`}`,
    environment_surrogate_key_issue: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"execution":{"environment":{"\ud800":"x"}}}`}`,
    environment_colliding_surrogate_keys: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"execution":{"environment":{"\ud800":"x","\udfff":"y"}}}`}`,
    environment_surrogate_value_issue: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"execution":{"environment":{"\ud800":1}}}`}`,
    stripped_nested_overflow: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"execution":{"unknown":1e400}}`}`,
  },
  "projects.ProjectCreateBodySchema": {
    malformed_jira_url: String.raw`{"repositoryUrl":"repo","integration":{"tracker":{"kind":"jira","site":"x","project":"APP","emailEnvironment":"JIRA_EMAIL","tokenEnvironment":"JIRA_TOKEN"}}}`,
    strict_surrogate_key_union: String.raw`{"repositoryUrl":"repo","\ud800":1}`,
    environment_colliding_surrogate_keys_union: `${JSON.stringify(projectBody).slice(0, -1)}${String.raw`,"execution":{"environment":{"\ud800":"x","\udfff":"y"}}}`}`,
  },
  "projects.ProjectResponseSchema": {
    stripped_surrogate_unknown: `${JSON.stringify({ ...projectBody, id: "project", companyId: "company", createdAt: "now", updatedAt: "now" }).slice(0, -1)}${String.raw`,"\ud800":1}`}`,
  },
};
type Definition = { type: string; innerType?: z.ZodType; element?: z.ZodType; shape?: Record<string, z.ZodType>; options?: z.ZodType[]; entries?: Record<string, string>; values?: unknown[]; keyType?: z.ZodType; valueType?: z.ZodType; items?: z.ZodType[]; in?: z.ZodType; checks?: Array<{ _zod: { def: { check?: string; minimum?: number; value?: number; inclusive?: boolean } } }> };
const definition = (schema: z.ZodType): Definition => schema._zod.def as Definition;
const accepted = (schema: z.ZodType, input: unknown): boolean => schema.safeParse(input).success;

function representative(schema: z.ZodType, includeOptional = false): unknown {
  const def = definition(schema);
  switch (def.type) {
    case "default": return undefined;
    case "optional": return includeOptional ? representative(def.innerType!, true) : undefined;
    case "nullable": return null;
    case "readonly": return representative(def.innerType!, includeOptional);
    case "pipe": return representative(def.in!, includeOptional);
    case "literal": return def.values![0];
    case "enum": return Object.values(def.entries!)[0];
    case "boolean": return true;
    case "number": {
      const minimum = def.checks?.find(check => check._zod.def.check === "greater_than")?._zod.def;
      const first = minimum?.value === undefined ? 1 : Math.max(1, Math.ceil(minimum.value + (minimum.inclusive ? 0 : 1)));
      return [first, 0, 2, 50].find(value => accepted(schema, value)) ?? first;
    }
    case "string": {
      const min = def.checks?.find(check => check._zod.def.check === "min_length")?._zod.def.minimum ?? 1;
      const options = ["x".repeat(Math.max(1, min)), "sample-001", "00000000-0000-4000-8000-000000000001", "2026-09-24T00:00:00.000Z", "https://github.com/example/repo/issues/1", "https://example.atlassian.net/", "example/repo", "ABC-123", "a".repeat(32), "a".repeat(40), "a".repeat(64), "A", "aGVsbG8="];
      return options.find(value => accepted(schema, value)) ?? options[0];
    }
    case "array": {
      const item = representative(def.element!, includeOptional);
      return [[], [item], [item, item]].find(value => accepted(schema, value)) ?? [];
    }
    case "tuple": return def.items!.map(item => representative(item, includeOptional));
    case "record": return {};
    case "object": {
      const value = Object.fromEntries(Object.entries(def.shape!).flatMap(([key, field]) => {
        const generated = representative(field, includeOptional);
        return generated === undefined ? [] : [[key, generated]];
      }));
      if (accepted(schema, value)) return value;
      if (!includeOptional) return representative(schema, true);
      return value;
    }
    case "union": {
      for (const option of def.options ?? []) {
        const generated = representative(option, includeOptional);
        if (accepted(schema, generated)) return generated;
      }
      return representative(def.options![0]!, includeOptional);
    }
    case "unknown": case "any": return null;
    default: throw new Error(`Unsupported Zod fixture shape: ${def.type}`);
  }
}

let schemas = 0;
let fixtures = 0;
const check = process.argv.includes("--check");
for (const moduleName of modules) {
  const exports = await import(`../../src/http/contracts/${moduleName}.js`) as Record<string, unknown>;
  for (const [name, candidate] of Object.entries(exports).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.endsWith("Schema") || !candidate || typeof candidate !== "object" || !("safeParse" in candidate) || typeof candidate.safeParse !== "function") continue;
    const schema = candidate as z.ZodType;
    const contract = `${moduleName}.${name}`;
    const directory = join(root, contract);
    if (!check) await mkdir(directory, { recursive: true });
    schemas++;
    for (const [caseName, input] of Object.entries(inputs)) {
      const parsed = schema.safeParse(input);
      const fixture: Fixture = { contract, case: caseName, ...(caseName === "missing" ? {} : { input }), expected: parsed.success ? { accepted: true, value: parsed.data } : { accepted: false, error: parsed.error.issues } };
      const path = join(directory, `${caseName}.json`);
      const content = `${JSON.stringify(fixture, null, 2)}\n`;
      if (check) {
        if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
      } else await writeFile(path, content);
      fixtures++;
    }
    for (const [caseName, input] of Object.entries(semanticInputs[contract] ?? {})) {
      let expected: Fixture["expected"];
      try {
        const parsed = schema.safeParse(input);
        expected = parsed.success ? { accepted: true, value: parsed.data } : { accepted: false, error: parsed.error.issues };
      } catch (reason) {
        if (!(reason instanceof Error)) throw reason;
        const thrown = reason as Error & { code?: string; input?: string };
        expected = { accepted: false, error: { kind: "thrown", name: thrown.name, code: thrown.code, message: thrown.message, input: thrown.input } };
      }
      const fixture: Fixture = { contract, case: caseName, input, expected };
      const path = join(directory, `${caseName}.json`);
      const content = `${JSON.stringify(fixture, null, 2)}\n`;
      if (check) {
        if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
      } else await writeFile(path, content);
      fixtures++;
    }
    for (const [caseName, inputJson] of Object.entries(rawInputs[contract] ?? {})) {
      const rawInput = JSON.parse(inputJson);
      let expected: { accepted: boolean; value?: string; error?: string };
      try {
        const parsed = schema.safeParse(rawInput);
        expected = parsed.success
          ? { accepted: true, value: JSON.stringify(parsed.data) }
          : { accepted: false, error: JSON.stringify(parsed.error.issues) };
      } catch (reason) {
        if (!(reason instanceof Error)) throw reason;
        const thrown = reason as Error & { code?: string; input?: string };
        expected = { accepted: false, error: JSON.stringify({ kind: "thrown", name: thrown.name, code: thrown.code, message: thrown.message, input: thrown.input }) };
      }
      const fixture = {
        contract,
        case: `raw_${caseName}`,
        encoding: "raw-json",
        input: inputJson,
        expected,
      };
      const path = join(directory, `raw_${caseName}.json`);
      const content = `${JSON.stringify(fixture, null, 2)}\n`;
      if (check) {
        if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
      } else await writeFile(path, content);
      fixtures++;
    }
    const input = representative(schema);
    if (!accepted(schema, input)) throw new Error(`No accepted representative for ${contract}: ${JSON.stringify(schema.safeParse(input))}`);
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(`Unexpected rejected representative for ${contract}`);
    const fixture: Fixture = { contract, case: "representative", input, expected: { accepted: true, value: parsed.data } };
    const path = join(directory, "representative.json");
    const content = `${JSON.stringify(fixture, null, 2)}\n`;
    if (check) {
      if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
    } else await writeFile(path, content);
    fixtures++;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const additions: Record<string, unknown> = {
        unknown_on_valid: { ...input, __parityUnknown: true },
      };
      const first = Object.keys(input)[0];
      if (first) {
        const without: Record<string, unknown> = { ...input };
        delete without[first];
        additions.first_field_missing = without;
        additions.first_field_null = { ...input, [first]: null };
      }
      for (const [caseName, candidate] of Object.entries(additions)) {
        const result = schema.safeParse(candidate);
        const fixture: Fixture = { contract, case: caseName, input: candidate, expected: result.success ? { accepted: true, value: result.data } : { accepted: false, error: result.error.issues } };
        const path = join(directory, `${caseName}.json`);
        const content = `${JSON.stringify(fixture, null, 2)}\n`;
        if (check) {
          if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
        } else await writeFile(path, content);
        fixtures++;
      }
    }
  }
}
console.log(`${check ? "Checked" : "Generated"} ${fixtures} Zod fixtures for ${schemas} exported HTTP schemas.`);

// These schemas are also parsed directly from stored project JSON. They are
// separate from the exported HTTP-contract inventory above.
const projectDependencies = {
  "projects.ProjectIntegrationSchema": {
    schema: (await import("../../src/projects/integration-contracts.js")).ProjectIntegrationSchema,
    cases: {
      defaults: {},
      nested_strip: { repository: { kind: "github", extra: true }, tracker: null },
      invalid_repository: { repository: { kind: "bitbucket", tokenEnvironment: "bad" } },
      invalid_tracker: { tracker: { kind: "jira", site: "https://other.example/", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } },
      invalid_site_type: { tracker: { kind: "jira", site: 1, project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } },
      strict_unknown: { extra: true },
    },
  },
  "projects.ProjectExecutionSchema": {
    schema: (await import("../../src/projects/execution-contracts.js")).ProjectExecutionSchema,
    cases: {
      defaults: {},
      nested_mcp_strip: { mcp: [{ ...mcpServer, extra: true, transport: { ...mcpServer.transport, extra: true }, grants: { ...mcpServer.grants, extra: true } }] },
      invalid_environment_key: { environment: { HOME: "value" } },
      invalid_environment_value: { environment: { KEY: 1 } },
      invalid_mcp: { mcp: [{ ...mcpServer, name: "suplex" }] },
      strict_unknown: { extra: true },
    },
  },
  "projects.ProjectProviderPolicySchema": {
    schema: (await import("../../src/projects/provider-policy-contracts.js")).ProjectProviderPolicySchema,
    cases: {
      empty: { allowedProviders: [], allowedInstanceIds: [] },
      valid: { allowedProviders: ["codex"], allowedInstanceIds: ["instance"] },
      invalid_provider: { allowedProviders: ["other"], allowedInstanceIds: [] },
      invalid_instance: { allowedProviders: [], allowedInstanceIds: [""] },
      missing_fields: {},
      strict_unknown: { allowedProviders: [], allowedInstanceIds: [], extra: true },
    },
  },
} as const;
let dependencyFixtures = 0;
for (const [contract, { schema, cases }] of Object.entries(projectDependencies)) {
  const directory = join(root, contract);
  if (!check) await mkdir(directory, { recursive: true });
  for (const [caseName, input] of Object.entries(cases)) {
    const parsed = schema.safeParse(input);
    const fixture = { contract, case: caseName, input, expected: parsed.success ? { accepted: true, value: parsed.data } : { accepted: false, error: parsed.error.issues } };
    const path = join(directory, `${caseName}.json`);
    const content = `${JSON.stringify(fixture, null, 2)}\n`;
    if (check) {
      if (await readFile(path, "utf8") !== content) throw new Error(`Stale project dependency fixture: ${path}`);
    } else await writeFile(path, content);
    dependencyFixtures++;
  }
}
console.log(`${check ? "Checked" : "Generated"} ${dependencyFixtures} stored-project fixtures for ${Object.keys(projectDependencies).length} nested schemas.`);
