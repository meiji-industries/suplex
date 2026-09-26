//! Task-specific prompt text shared by the Root host and controller.

use serde_json::Value;

use super::workflows::Workflow;
use crate::shared::js_json;
use crate::tasks::control::{DependencyRow, TaskControlRow, TaskStatus};

const STANDARD_INITIAL_PROMPT: &str = include_str!("root_standard_initial_prompt.txt");
const CAPTURED_CONTEXT_SUFFIX: &str = include_str!("root_standard_context_suffix.txt");
const STANDARD_CONTEXT_PREFIX: &str =
    "Inspect the repository yourself before deciding whether Worker setup is needed. ";
const COORDINATOR_SYSTEM_PROMPT: &str = include_str!("prompts/coordinator_system.txt");
const CONFIGURED_CHECK_EVIDENCE_POLICY: &str =
    include_str!("prompts/configured_check_evidence_policy.txt");
/// Static outputs of TypeScript `taskRolePrompt` for the non-Standard roles.
pub const ROOT_WORKFLOW_ROLE_PROMPT: &str = include_str!("prompts/role_root_workflow.txt");
pub const ADVISOR_ROLE_PROMPT: &str = include_str!("prompts/role_advisor.txt");
pub const WORKER_DIRECT_ROLE_PROMPT: &str =
    include_str!("prompts/role_worker_direct_implementation.txt");
pub const STANDARD_WORKER_RESULT_WAKE: &str = "You own independent review. Read the changed source yourself, compare it with acceptedAssignment and the acceptance criteria, and assess the native command evidence. A completed turn or tool call is not proof that the assignment or check passed. Worker summary text is routing context, not a gate. If work remains, diagnose the assignment, scope, or fixture and delegate one coherent repair. Observe current state and decide the next action. If repeated continuations do not advance the accepted behavior, inspect why execution stopped and change strategy. Use replace_worker for a fresh session; it keeps the task's configured Worker profile. Supply the remaining work and verification evidence in the handoff. Do not repeat an ineffective assignment merely because the previous turn ended. This is a judgment about progress, not a fixed retry count.";

fn visual_evidence_instruction(value: &str) -> &'static str {
    match value {
        "off" => {
            "Screenshots are off for this task. Do not capture, request, or require browser screenshots or any other browser evidence; verify with source reading and the configured checks instead. Missing browser evidence is never a finding."
        }
        "capture" => {
            "Screenshots are on for this task. Capture browser screenshots of user-visible changes when practical and review them. Missing screenshots are advisory, not blocking."
        }
        _ => {
            "Screenshots are necessary for this task. User-visible changes need browser screenshots as evidence. Missing screenshots are a missing check."
        }
    }
}

pub fn initial_coordinator_prompt(
    control: &TaskControlRow,
    context: &Value,
    dependencies: &[DependencyRow],
) -> String {
    let intent = &control.delivery_intent;
    let visual_evidence = context
        .get("configuration")
        .and_then(|value| value.get("visualEvidence"))
        .and_then(Value::as_str)
        .unwrap_or("required");
    let identity = format!(
        "Objective: {}\nDelivery target: {}\nRepository: {}\nBranch: {}",
        control.objective, control.delivery_target, intent.repository, intent.head_branch,
    );
    let instructions = match control.workflow {
        Workflow::Standard => None,
        Workflow::DirectBuild => Some(include_str!("prompts/workflow_direct_build.txt")),
        Workflow::IndependentReview => {
            Some(include_str!("prompts/workflow_independent_review.txt"))
        }
        Workflow::CompetingPlans => Some(include_str!("prompts/workflow_competing_plans.txt")),
        Workflow::RefinePullRequest => {
            Some(include_str!("prompts/workflow_refine_pull_request.txt"))
        }
    };
    let mut prompt = if let Some(instructions) = instructions {
        let base_branch = &intent.base_branch;
        let pull = intent
            .pull_request_number
            .map(|number| {
                format!(
                    "\nPull request: #{number} ({} into {base_branch})",
                    intent.head_branch
                )
            })
            .unwrap_or_default();
        let suffix = CAPTURED_CONTEXT_SUFFIX
            .strip_prefix(STANDARD_CONTEXT_PREFIX)
            .unwrap_or(CAPTURED_CONTEXT_SUFFIX);
        format!(
            "{COORDINATOR_SYSTEM_PROMPT}\n\n{instructions}\n\n{identity}\nBase branch: {base_branch}{pull}\n\nCaptured task configuration:\n{}\n\n{suffix}\n\n{}",
            js_json::stringify(context),
            visual_evidence_instruction(visual_evidence),
        )
    } else {
        format!(
            "{STANDARD_INITIAL_PROMPT}\n\n{identity}\n\nCaptured task configuration:\n{}\n\n{CAPTURED_CONTEXT_SUFFIX}\n\n{}",
            js_json::stringify(context),
            visual_evidence_instruction(visual_evidence),
        )
    };
    let pending = dependencies
        .iter()
        .filter(|dependency| dependency.status != TaskStatus::Delivered)
        .map(DependencyRow::describe)
        .collect::<Vec<_>>();
    if !pending.is_empty() {
        prompt.push_str(&format!(
            "\n\nThis task depends on these tasks: {}. The dependencies constrain execution and delivery ordering. Suplex does not admit new work for this task until every dependency is delivered. After release, observe the actual Git and GitHub state for {}. Integrate prerequisite work only when the current repository state requires it. Suplex resumes this task when every dependency is delivered.",
            pending.join(", "),
            intent.base_branch,
        ));
    }
    prompt
}

pub struct WorkerAssignmentText<'a> {
    pub mode: &'a str,
    pub purpose: &'a str,
    pub plan: Option<&'a str>,
    pub acceptance_criteria: &'a [String],
    pub instruction: &'a str,
    pub visual_evidence: &'a str,
    pub verification_range: Option<(&'a str, &'a str)>,
    /// `(label, report text)` of the Advisor report a repair implements.
    pub advisor_report: Option<(&'a str, &'a str)>,
}

pub fn compose_worker_assignment(assignment: &WorkerAssignmentText<'_>) -> Result<String, String> {
    let criteria = assignment
        .acceptance_criteria
        .iter()
        .enumerate()
        .map(|(index, criterion)| format!("{}. {criterion}", index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let mut sections = Vec::new();
    match assignment.mode {
        "planned" => sections.push(format!("Coordinator plan:\n{}", assignment.plan.unwrap_or(""))),
        "direct" => sections.push("Direct build: choose the implementation approach yourself within the objective and constraints below.".into()),
        _ => return Err("Worker assignment mode is invalid".into()),
    }
    if let Some((label, text)) = assignment.advisor_report {
        sections.push(format!("{label} report and repair constraints:\n{text}"));
    }
    sections.push(format!("Acceptance criteria:\n{criteria}"));
    sections.push(format!("Worker instructions:\n{}", assignment.instruction));
    sections.push(format!(
        "Screenshots:\n{}",
        visual_evidence_instruction(assignment.visual_evidence)
    ));
    if assignment.purpose == "verification" {
        if let Some((base, head)) = assignment.verification_range {
            sections.push(format!("Verification source: base {base}, head {head}. Verify this revision without intentional source edits."));
        }
    } else if assignment.purpose != "implementation" {
        return Err("Worker assignment purpose is invalid".into());
    }
    Ok(sections.join("\n\n"))
}

/// TypeScript `workerAssignmentPreamble` followed by the saved assignment.
pub fn worker_prompt(mode: &str, purpose: &str, assignment_text: &str) -> Result<String, String> {
    let preamble = match (mode, purpose) {
        (_, "verification") => include_str!("root_standard_worker_verification_preamble.txt"),
        ("direct", "implementation") => {
            include_str!("prompts/worker_direct_implementation_preamble.txt")
        }
        (_, "implementation") => include_str!("root_standard_worker_implementation_preamble.txt"),
        _ => return Err("Worker assignment purpose is invalid".into()),
    };
    Ok(format!("{preamble}\n\nAssignment:\n{assignment_text}"))
}

pub struct AdvisorAssignment<'a> {
    pub role: &'a str,
    pub objective: &'a str,
    pub configuration: &'a Value,
    pub visual_evidence: &'a str,
    pub repository: &'a str,
    pub head_branch: &'a str,
    pub base_branch: &'a str,
    pub pull_request_number: Option<u64>,
    pub range: &'a super::workflows::ReviewRange,
    pub evidence_directory: &'a str,
    pub attachments: &'a [super::workflow_evidence::ManifestAttachment],
    pub brief: Option<&'a str>,
    pub prior_findings: Option<&'a [String]>,
    pub repair_evidence: Option<&'a [String]>,
}

/// TypeScript `composeAdvisorAssignment`.
pub fn compose_advisor_assignment(input: &AdvisorAssignment<'_>) -> String {
    let source = match input.pull_request_number {
        None => format!(
            "Repository {}, branch {}, base branch {}.",
            input.repository, input.head_branch, input.base_branch
        ),
        Some(number) => format!(
            "Repository {}, pull request #{number} ({} into {}).",
            input.repository, input.head_branch, input.base_branch
        ),
    };
    let attachments = if input.attachments.is_empty() {
        String::new()
    } else {
        let items = input
            .attachments
            .iter()
            .map(|item| match &item.path {
                Some(path) => format!("{path} (artifact {})", item.artifact_id),
                None => format!(
                    "artifact {} missing: {}",
                    item.artifact_id,
                    item.error.as_deref().unwrap_or("null")
                ),
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("\nTask images: {items}. A missing image is missing input; say so.")
    };
    let prompt = match input.role {
        "reviewer" => include_str!("prompts/advisor_reviewer.txt"),
        "rater" => include_str!("prompts/advisor_rater.txt"),
        _ => include_str!("prompts/advisor_planner.txt"),
    };
    let or_none = |values: &[String]| {
        if values.is_empty() {
            "none".to_owned()
        } else {
            values.join(", ")
        }
    };
    let directory = input.evidence_directory;
    let mut sections = vec![
        format!(
            "Role: {}.\n\n{prompt}",
            super::workflows::advisor_label(input.role)
        ),
        format!("Objective:\n{}", input.objective),
        format!(
            "Captured task configuration:\n{}",
            js_json::stringify(input.configuration)
        ),
        format!("Configured project check evidence:\n{CONFIGURED_CHECK_EVIDENCE_POLICY}"),
        format!(
            "Screenshots:\n{}",
            visual_evidence_instruction(input.visual_evidence)
        ),
        format!(
            "{source}\nPinned base {}, head {}.\nChanged files ({}): {}\nCommits ({}): {}",
            input.range.base_sha,
            input.range.head_sha,
            input.range.files.len(),
            or_none(&input.range.files),
            input.range.commits.len(),
            or_none(&input.range.commits),
        ),
        format!(
            "Evidence directory: {directory}\nRead {directory}/patch.diff with file-read ranges until you have read it completely; it is the entire base-to-head patch. {directory}/manifest.json lists the files, commits, and attachments. {directory}/verification.json contains the actual Worker command inputs, outputs, and errors, the task configuration, and the current pull request check observation. A check-only Worker turn's matching verificationRange.valid is a direct shortcut proving its committed source stayed unchanged. Missing verificationRange is not proof that a check is invalid: checks from implementation or historical turns may establish coverage when actual native command inputs and outputs plus Git source-state evidence establish that the checked source is this pinned range. Do not infer that merely from an implementation turn's final HEAD. Reject successful checks run on older or different source, and account for commits or dirty edits after a check. Request a check-only assignment only when the existing evidence cannot establish that the reviewed range was tested. Binary changes require inspecting the corresponding source and assets; a binary notice is not a reviewed binary.{attachments}"
        ),
    ];
    if let Some(brief) = input.brief.filter(|brief| !brief.is_empty()) {
        sections.push(format!(
            "Coordinator brief (plan and acceptance criteria):\n{brief}"
        ));
    }
    if input.role == "rater" {
        if let Some(findings) = input.prior_findings.filter(|findings| !findings.is_empty()) {
            let findings = findings
                .iter()
                .map(|finding| format!("- {finding}"))
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("Prior findings from the previous rating (assess the current source first, then check that these were resolved):\n{findings}"));
        }
        if let Some(evidence) = input
            .repair_evidence
            .filter(|evidence| !evidence.is_empty())
        {
            sections.push(format!(
                "Worker repair evidence since the previous rating:\n{}",
                evidence.join("\n\n")
            ));
        }
    }
    sections.join("\n\n")
}

/// JavaScript `text.trim().slice(0, units)` over UTF-16 code units.
pub fn js_trim_slice(text: &str, units: usize) -> String {
    let mut used = 0;
    crate::identity::auth::js_trim(text)
        .chars()
        .take_while(|character| {
            used += character.len_utf16();
            used <= units
        })
        .collect()
}

pub struct WorkerResult<'a> {
    pub turn_id: &'a str,
    pub state: &'a str,
    pub text: &'a str,
    /// `(valid, invalidReason)` of a recorded check-only source range.
    pub verification_range: Option<(bool, Option<&'a str>)>,
}

/// TypeScript `workerResultWake`.
pub fn worker_result_wake(
    workflow: Workflow,
    receipt_id: &str,
    result: &WorkerResult<'_>,
    purpose: &str,
) -> String {
    let summary = js_trim_slice(result.text, 1_200);
    let summary = if summary.is_empty() {
        "(no Worker summary)"
    } else {
        &summary
    };
    let access = format!(
        "Worker reported ({}): {summary}\nCall suplex_root read_worker_evidence with turnId {} for the compact tool index. Then select the exact toolId, field, and position tail to read its final evidence. Use position head and the returned field cursor only when you need earlier content. Do not rerun commands only to obtain logs.",
        result.state, result.turn_id
    );
    let range = match (purpose, result.verification_range) {
        ("verification", Some((true, _))) => {
            " Suplex recorded a valid unchanged check-only source range.".to_owned()
        }
        ("verification", Some((false, reason))) => format!(
            " Suplex recorded a source-range limitation: {}. Inspect the existing native command and Git evidence; rerun only when it shows that the reviewed source was not tested or was invalidated.",
            reason.unwrap_or("the range was invalid")
        ),
        ("verification", None) => " No check-only range shortcut was recorded. This alone does not invalidate implementation or historical command evidence; inspect native command and Git evidence before deciding whether a check is missing.".to_owned(),
        _ => String::new(),
    };
    let next = match workflow {
        Workflow::Standard => {
            return format!(
                "Worker result {receipt_id}. {STANDARD_WORKER_RESULT_WAKE}{range} {access}"
            );
        }
        Workflow::IndependentReview => {
            "When the implementation and its checks satisfy you, request Reviewer with delegate_advisor. Reviewer approval for the current range is necessary before delivery."
        }
        Workflow::RefinePullRequest => {
            "Rater owns quality assessment. Inspect only delivery integrity: objective scope, unrelated or unpublished work, real check evidence, and teammate or base integration. Do not delegate source repairs from your own code-quality opinion. Source repairs require a Rater report and its advisorTurnId. If you suspect Rater missed a serious defect, request a fresh Rater assessment. After a passing rating, delegate Worker only for teammate pushes, base conflicts, or CI failures, then request a fresh Rater assessment for the complete current range. Do not request delivery on an earlier rating."
        }
        Workflow::CompetingPlans => {
            "Compare the result with the accepted combined assignment. Request coherent repairs if necessary, then request the selected delivery target."
        }
        Workflow::DirectBuild => {
            "Compare the result with the accepted assignment and acceptance outcomes. Request coherent repairs or missing checks if necessary, then request the selected delivery target."
        }
    };
    let kind = if purpose == "verification" {
        "Verification result"
    } else {
        "Worker result"
    };
    format!(
        "{kind} {receipt_id}. Inspect the changed source and the actual command evidence yourself. A completed turn, completed tool call, or Worker claim alone is not verification.{range} {access} {next}"
    )
}

/// TypeScript `advisorResultWake`, including its single double-space collapse.
pub fn advisor_result_wake(
    role: &str,
    receipt_id: &str,
    valid: bool,
    summary: &str,
    observation: &str,
) -> String {
    let label = super::workflows::advisor_label(role);
    let next = if !valid {
        format!(
            "The {label} report was not accepted: {summary}. Diagnose the report input or evidence, then request a fresh {label}."
        )
    } else {
        match role {
            "reviewer" => "If Reviewer approved the current range, request delivery. If only current-head CI evidence is missing, inspect and push the branch, collect the checks, and request a fresh Reviewer assessment. Otherwise delegate a coherent Worker repair for every blocking finding, inspect the result, and request a new Reviewer assessment.",
            "rater" => "Rater owns quality assessment. If the rating is at least 9 with no blocking findings and adequate verification, inspect only delivery integrity: objective scope, unrelated or unpublished work, real check evidence, and teammate or base integration. Do not delegate source repairs from your own code-quality opinion. Source repairs require a Rater report and its advisorTurnId. If you suspect Rater missed a serious defect, request a fresh Rater assessment. After a passing rating, delegate Worker only for teammate pushes, base conflicts, or CI failures, then request a fresh Rater assessment. Otherwise delegate planned Worker implementation only for this Rater report's findings, with advisorTurnId set to this Rater report turn. If only verification is missing, delegate a bounded verification assignment first.",
            _ => "This individual planner result is available for a retry or historical session. When a Combined pair settles, read both complete plan reports and relevant source, write one combined plan, and delegate Worker with both candidateTurnIds.",
        }
        .to_owned()
    };
    format!(
        "{label} result {receipt_id}. {} {next}\n\n{observation}",
        if valid { summary } else { "" }
    )
    .replacen("  ", " ", 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn standard_prompt_includes_intent_and_live_dependencies() {
        let mut control = TaskControlRow::fixture();
        control.objective = "Complete the change".into();
        control.delivery_intent.head_branch = "task".into();
        let context = json!({"configuration":{"visualEvidence":"off"},"images":[]});
        let prompt = initial_coordinator_prompt(
            &control,
            &context,
            &[DependencyRow {
                id: "first".into(),
                title: "Prior task".into(),
                status: TaskStatus::Active,
            }],
        );
        assert_eq!(prompt, include_str!("root_standard_initial_example.txt"));
    }

    #[test]
    fn planned_worker_assignment_keeps_source_sections() {
        let criteria = vec!["The button changes".to_owned()];
        let text = compose_worker_assignment(&WorkerAssignmentText {
            mode: "planned",
            purpose: "implementation",
            plan: Some("Make the update"),
            acceptance_criteria: &criteria,
            instruction: "Implement the plan.",
            visual_evidence: "off",
            verification_range: None,
            advisor_report: None,
        })
        .unwrap();
        assert_eq!(text, include_str!("root_worker_assignment_example.txt"));
        let prompt = worker_prompt("planned", "implementation", &text).unwrap();
        assert!(prompt.ends_with(&format!("\n\nAssignment:\n{text}")));
    }

    fn range() -> crate::coordination::workflows::ReviewRange {
        crate::coordination::workflows::ReviewRange {
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            files: vec!["src/a.ts".into(), "src/b.ts".into()],
            commits: vec!["b".repeat(40)],
            patch_digest: None,
        }
    }

    #[test]
    fn workflow_prompts_match_pinned_typescript_bytes() {
        let mut control = TaskControlRow::fixture();
        control.objective = "Repair it".into();
        control.delivery_target = crate::tasks::control::DeliveryTarget::Merged;
        control.delivery_intent.head_branch = "feature".into();
        control.delivery_intent.pull_request_number = Some(7);
        control.workflow = Workflow::RefinePullRequest;
        let context = json!({"configuration":{"visualEvidence":"capture"},"images":[]});
        let dependency = DependencyRow {
            id: "task_dep".into(),
            title: "Dep".into(),
            status: TaskStatus::Active,
        };
        assert_eq!(
            initial_coordinator_prompt(&control, &context, &[dependency]),
            include_str!("prompts/example_initial_refine.txt")
        );
        let range = range();
        let attachments = [
            crate::coordination::workflow_evidence::ManifestAttachment {
                artifact_id: "img_1".into(),
                path: Some("attachments/img_1.png".into()),
                error: None,
            },
            crate::coordination::workflow_evidence::ManifestAttachment {
                artifact_id: "img_2".into(),
                path: None,
                error: Some("gone".into()),
            },
        ];
        let findings = ["src/a.ts: bug".to_owned()];
        let repairs = ["Turn t1: fixed".to_owned()];
        let rater = compose_advisor_assignment(&AdvisorAssignment {
            role: "rater",
            objective: "Repair it",
            configuration: &json!({"runProjectTests":true}),
            visual_evidence: "off",
            repository: "owner/repo",
            head_branch: "feature",
            base_branch: "main",
            pull_request_number: Some(7),
            range: &range,
            evidence_directory: "/tmp/evidence_1",
            attachments: &attachments,
            brief: None,
            prior_findings: Some(&findings),
            repair_evidence: Some(&repairs),
        });
        assert_eq!(rater, include_str!("prompts/example_advisor_rater.txt"));
        let empty = crate::coordination::workflows::ReviewRange {
            files: vec![],
            commits: vec![],
            ..range.clone()
        };
        let reviewer = compose_advisor_assignment(&AdvisorAssignment {
            role: "reviewer",
            objective: "Build it",
            configuration: &json!({}),
            visual_evidence: "required",
            repository: "owner/repo",
            head_branch: "task",
            base_branch: "main",
            pull_request_number: None,
            range: &empty,
            evidence_directory: "/tmp/evidence_2",
            attachments: &[],
            brief: Some("Plan and criteria"),
            prior_findings: None,
            repair_evidence: None,
        });
        assert_eq!(
            reviewer,
            include_str!("prompts/example_advisor_reviewer.txt")
        );
        let criteria = ["One".to_owned(), "Two".to_owned()];
        let repair = compose_worker_assignment(&WorkerAssignmentText {
            mode: "planned",
            purpose: "implementation",
            plan: Some("Fix"),
            acceptance_criteria: &criteria,
            instruction: "Do it",
            visual_evidence: "capture",
            verification_range: Some((&range.base_sha, &range.head_sha)),
            advisor_report: Some(("Rater", "Rated 7")),
        })
        .unwrap();
        assert_eq!(
            repair,
            include_str!("prompts/example_worker_assignment_rater.txt")
        );
        let checks = ["Checks pass".to_owned()];
        let direct = compose_worker_assignment(&WorkerAssignmentText {
            mode: "direct",
            purpose: "verification",
            plan: None,
            acceptance_criteria: &checks,
            instruction: "Run checks",
            visual_evidence: "off",
            verification_range: Some((&range.base_sha, &range.head_sha)),
            advisor_report: None,
        })
        .unwrap();
        assert_eq!(
            direct,
            include_str!("prompts/example_worker_assignment_direct_verification.txt")
        );
    }

    #[test]
    fn result_wakes_match_pinned_typescript_bytes() {
        let result = |state, text, verification_range| WorkerResult {
            turn_id: "t1",
            state,
            text,
            verification_range,
        };
        let cases = [
            (
                worker_result_wake(
                    Workflow::IndependentReview,
                    "r1",
                    &result("completed", "  done  ", Some((true, None))),
                    "verification",
                ),
                include_str!("prompts/example_wake_worker_review_verification_valid.txt"),
            ),
            (
                worker_result_wake(
                    Workflow::RefinePullRequest,
                    "r1",
                    &result("error", "", Some((false, Some("moved")))),
                    "verification",
                ),
                include_str!("prompts/example_wake_worker_refine_verification_invalid.txt"),
            ),
            (
                worker_result_wake(
                    Workflow::CompetingPlans,
                    "r1",
                    &result("completed", "built", None),
                    "implementation",
                ),
                include_str!("prompts/example_wake_worker_plans_implementation.txt"),
            ),
            (
                worker_result_wake(
                    Workflow::DirectBuild,
                    "r1",
                    &result("completed", "checked", None),
                    "verification",
                ),
                include_str!("prompts/example_wake_worker_direct_verification_missing.txt"),
            ),
            (
                worker_result_wake(
                    Workflow::Standard,
                    "r1",
                    &result("completed", "checked", Some((true, None))),
                    "verification",
                ),
                include_str!("prompts/example_wake_worker_standard_verification_valid.txt"),
            ),
            (
                advisor_result_wake(
                    "reviewer",
                    "r2",
                    true,
                    "Approved with 0 blocking finding(s); verification passed.",
                    "{\"state\":\"completed\"}",
                ),
                include_str!("prompts/example_wake_advisor_reviewer_valid.txt"),
            ),
            (
                advisor_result_wake("rater", "r2", false, "bad json", "{}"),
                include_str!("prompts/example_wake_advisor_rater_invalid.txt"),
            ),
            (
                advisor_result_wake("planner_b", "r2", true, "Plan", "{}"),
                include_str!("prompts/example_wake_advisor_planner_valid.txt"),
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
    }
}
