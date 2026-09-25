//! Task-specific prompt text shared by the Root host and controller.

use serde_json::Value;

use crate::shared::js_json;

const STANDARD_INITIAL_PROMPT: &str = include_str!("root_standard_initial_prompt.txt");
const CAPTURED_CONTEXT_SUFFIX: &str = include_str!("root_standard_context_suffix.txt");
pub const STANDARD_WORKER_RESULT_WAKE: &str = "You own independent review. Read the changed source yourself, compare it with acceptedAssignment and the acceptance criteria, and assess the native command evidence. A completed turn or tool call is not proof that the assignment or check passed. Worker summary text is routing context, not a gate. If work remains, diagnose the assignment, scope, or fixture and delegate one coherent repair. Observe current state and decide the next action. If repeated continuations do not advance the accepted behavior, inspect why execution stopped and change strategy. Use replace_worker for a fresh session; it keeps the task's configured Worker profile. Supply the remaining work and verification evidence in the handoff. Do not repeat an ineffective assignment merely because the previous turn ended. This is a judgment about progress, not a fixed retry count.";

fn string_field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} is missing from task intent"))
}

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
    control: &Value,
    context: &Value,
    dependencies: &[Value],
) -> Result<String, String> {
    if string_field(control, "workflow")? != "standard" {
        return Err("Only the Standard Root prompt is implemented".into());
    }
    let intent = control
        .get("deliveryIntent")
        .ok_or("deliveryIntent is missing from task intent")?;
    let visual_evidence = context
        .get("configuration")
        .and_then(|value| value.get("visualEvidence"))
        .and_then(Value::as_str)
        .unwrap_or("required");
    let identity = format!(
        "Objective: {}\nDelivery target: {}\nRepository: {}\nBranch: {}",
        string_field(control, "objective")?,
        string_field(control, "deliveryTarget")?,
        string_field(intent, "repository")?,
        string_field(intent, "headBranch")?,
    );
    let mut prompt = format!(
        "{STANDARD_INITIAL_PROMPT}\n\n{identity}\n\nCaptured task configuration:\n{}\n\n{CAPTURED_CONTEXT_SUFFIX}\n\n{}",
        js_json::stringify(context),
        visual_evidence_instruction(visual_evidence),
    );
    let pending = dependencies
        .iter()
        .filter(|dependency| dependency.get("status").and_then(Value::as_str) != Some("delivered"))
        .map(|dependency| {
            Ok(format!(
                "{} \"{}\" ({})",
                string_field(dependency, "id")?,
                string_field(dependency, "title")?,
                string_field(dependency, "status")?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if !pending.is_empty() {
        prompt.push_str(&format!(
            "\n\nThis task depends on these tasks: {}. The dependencies constrain execution and delivery ordering. Suplex does not admit new work for this task until every dependency is delivered. After release, observe the actual Git and GitHub state for {}. Integrate prerequisite work only when the current repository state requires it. Suplex resumes this task when every dependency is delivered.",
            pending.join(", "),
            string_field(intent, "baseBranch")?,
        ));
    }
    Ok(prompt)
}

pub struct WorkerAssignmentText<'a> {
    pub mode: &'a str,
    pub purpose: &'a str,
    pub plan: Option<&'a str>,
    pub acceptance_criteria: &'a [String],
    pub instruction: &'a str,
    pub visual_evidence: &'a str,
    pub verification_range: Option<(&'a str, &'a str)>,
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

pub fn standard_worker_prompt(assignment_text: &str, purpose: &str) -> Result<String, String> {
    let preamble = match purpose {
        "implementation" => include_str!("root_standard_worker_implementation_preamble.txt"),
        "verification" => include_str!("root_standard_worker_verification_preamble.txt"),
        _ => return Err("Worker assignment purpose is invalid".into()),
    };
    Ok(format!("{preamble}\n\nAssignment:\n{assignment_text}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn standard_prompt_includes_intent_and_live_dependencies() {
        let control = json!({"objective":"Complete the change","deliveryTarget":"local_worktree","deliveryIntent":{"repository":"owner/repo","headBranch":"task","baseBranch":"main"},"workflow":"standard"});
        let context = json!({"configuration":{"visualEvidence":"off"},"images":[]});
        let prompt = initial_coordinator_prompt(
            &control,
            &context,
            &[json!({"id":"first","title":"Prior task","status":"active"})],
        )
        .unwrap();
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
        })
        .unwrap();
        assert_eq!(text, include_str!("root_worker_assignment_example.txt"));
        let prompt = standard_worker_prompt(&text, "implementation").unwrap();
        assert!(prompt.ends_with(&format!("\n\nAssignment:\n{text}")));
    }
}
