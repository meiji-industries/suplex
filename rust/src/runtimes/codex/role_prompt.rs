/// Static output of TypeScript `taskRolePrompt("root", { workflow: "standard" })`.
/// Keeping the source text embedded lets the native host launch without Node.
pub const ROOT_STANDARD: &str = include_str!("root_standard_role_prompt.txt");
const WORKER_PLANNED_IMPLEMENTATION: &str =
    include_str!("worker_planned_implementation_role_prompt.txt");
const WORKER_VERIFICATION: &str = include_str!("worker_planned_verification_role_prompt.txt");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerPurpose {
    Implementation,
    Verification,
}

pub fn root_standard_prompt(intent: &str) -> String {
    format!("{ROOT_STANDARD}\n\n{intent}")
}

/// TypeScript `taskRolePrompt("worker", { workflow: "standard", workerMode: "planned", purpose })`.
pub fn worker_standard_role(purpose: WorkerPurpose) -> &'static str {
    match purpose {
        WorkerPurpose::Verification => WORKER_VERIFICATION,
        WorkerPurpose::Implementation => WORKER_PLANNED_IMPLEMENTATION,
    }
}

pub fn worker_standard_prompt(purpose: WorkerPurpose, intent: &str) -> String {
    format!("{}\n\n{intent}", worker_standard_role(purpose))
}
