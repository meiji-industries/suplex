//! Why GitHub blocks the merge of an open pull request.
//!
//! GitHub reports `mergeStateStatus: BLOCKED` without a cause. When no check
//! fails and no check is pending, the cause is a branch rule. Suplex reads the
//! rules that apply to the base branch and the facts each rule tests, and names
//! each rule that the pull request does not satisfy. A rule that Suplex could
//! not read is reported as unreadable, never guessed.
//!
//! The diagnosis is an observation. It never fails the pull request observation
//! and never gates a user action by itself.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use super::{
    github_delivery::{Github, GithubResult, Observation, failure},
    provider_http::lenient,
};
use crate::tasks::response::HumanQuestionOption;

/// One branch rule that blocks the merge. `branch` is the base branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MergeBlockReason {
    /// The branch requires signed commits and these commits are not verified.
    UnsignedCommits { branch: String, shas: Vec<String> },
    /// GitHub requires a review decision before the merge.
    RequiredReview {
        branch: String,
        /// The number of approving reviews that the branch rules require, when Suplex read them.
        needed: Option<u32>,
        /// The branch rules require a code owner review.
        code_owner_review: bool,
        /// Open code owner review requests.
        code_owners: Vec<String>,
        changes_requested: bool,
    },
    /// A required check context has no result on the head commit.
    MissingRequiredCheck { branch: String, context: String },
    /// The branch requires resolved review conversations.
    UnresolvedConversations { branch: String, count: u32 },
    /// The branch accepts merges only through the merge queue.
    MergeQueueRequired { branch: String },
    /// The branch requires linear history and the repository allows only merge commits.
    LinearHistory { branch: String },
    /// The branch requires a successful deployment of the head commit.
    DeploymentRequired { branch: String, environment: String },
    /// The branch is locked.
    BranchLocked { branch: String },
    /// Suplex could not read every branch rule.
    RulesUnreadable { branch: String },
    /// Suplex read the branch rules and none of them explains the block.
    Unknown { branch: String },
}

impl MergeBlockReason {
    fn branch(&self) -> &str {
        match self {
            Self::UnsignedCommits { branch, .. }
            | Self::RequiredReview { branch, .. }
            | Self::MissingRequiredCheck { branch, .. }
            | Self::UnresolvedConversations { branch, .. }
            | Self::MergeQueueRequired { branch }
            | Self::LinearHistory { branch }
            | Self::DeploymentRequired { branch, .. }
            | Self::BranchLocked { branch }
            | Self::RulesUnreadable { branch }
            | Self::Unknown { branch } => branch,
        }
    }

    /// A Worker can remove this block with a change to the task branch.
    pub fn repairable_by_code(&self, abilities: MergeAbilities) -> bool {
        match self {
            Self::UnsignedCommits { .. } => abilities.can_sign,
            Self::MissingRequiredCheck { .. } => true,
            _ => false,
        }
    }

    /// The name of the branch rule a person can turn off, if this is a rule.
    fn rule_name(&self) -> Option<&'static str> {
        Some(match self {
            Self::UnsignedCommits { .. } => "signed commits",
            Self::MissingRequiredCheck { .. } => "required check",
            Self::UnresolvedConversations { .. } => "conversation resolution",
            Self::MergeQueueRequired { .. } => "merge queue",
            Self::LinearHistory { .. } => "linear history",
            Self::DeploymentRequired { .. } => "deployment",
            Self::BranchLocked { .. } => "branch lock",
            Self::RequiredReview { .. } | Self::RulesUnreadable { .. } | Self::Unknown { .. } => {
                return None;
            }
        })
    }
}

/// What the runner and the GitHub token can do about a block.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MergeAbilities {
    /// The task worktree has a configured commit signing key.
    pub can_sign: bool,
    /// GitHub reports that the token can merge as an administrator.
    pub can_merge_as_admin: bool,
}

/// Git configuration of the task worktree has a signing key. Suplex does not
/// assume that a runner can sign.
pub fn worktree_can_sign(worktree: Option<&str>) -> bool {
    let Some(config) = worktree
        .and_then(|path| git2::Repository::open(path).ok())
        .and_then(|repository| repository.config().ok())
    else {
        return false;
    };
    config
        .get_string("user.signingkey")
        .is_ok_and(|key| !key.trim().is_empty())
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

fn branch_subject(branch: &str) -> String {
    if branch.is_empty() {
        "The base branch".into()
    } else {
        format!("Branch `{branch}`")
    }
}

fn branch_target(branch: &str) -> String {
    if branch.is_empty() {
        "the base branch".into()
    } else {
        format!("branch `{branch}`")
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

fn list(items: &[String]) -> String {
    const SHOWN: usize = 5;
    let mut text = items.iter().take(SHOWN).cloned().collect::<Vec<_>>().join(", ");
    if items.len() > SHOWN {
        text.push_str(&format!(", and {} more", items.len() - SHOWN));
    }
    text
}

/// The Simplified Technical English sentence for one reason.
pub fn describe(reason: &MergeBlockReason) -> String {
    let subject = branch_subject(reason.branch());
    match reason {
        MergeBlockReason::UnsignedCommits { shas, .. } => {
            let shorts = shas.iter().map(|sha| short(sha).to_owned()).collect::<Vec<_>>();
            let verb = if shas.len() == 1 { "is" } else { "are" };
            format!(
                "{subject} requires signed commits and {} {verb} unsigned ({}).",
                plural(shas.len(), "commit", "commits"),
                list(&shorts)
            )
        }
        MergeBlockReason::RequiredReview {
            needed,
            code_owner_review,
            code_owners,
            changes_requested,
            ..
        } => {
            if *changes_requested {
                format!("A reviewer requested changes. {subject} requires an approving review.")
            } else if !code_owners.is_empty() {
                format!(
                    "{subject} requires a code owner review from {}.",
                    list(code_owners)
                )
            } else if *code_owner_review {
                format!("{subject} requires an approving review from a code owner.")
            } else {
                match needed {
                    Some(count) if *count > 1 => {
                        format!("{subject} requires {count} approving reviews.")
                    }
                    _ => format!("{subject} requires an approving review."),
                }
            }
        }
        MergeBlockReason::MissingRequiredCheck { context, .. } => format!(
            "{subject} requires the check `{context}`, and GitHub has no result for it on the head commit."
        ),
        MergeBlockReason::UnresolvedConversations { count, .. } => {
            let verb = if *count == 1 { "is" } else { "are" };
            format!(
                "{subject} requires resolved conversations, and {} {verb} open.",
                plural(*count as usize, "review conversation", "review conversations")
            )
        }
        MergeBlockReason::MergeQueueRequired { .. } => {
            format!("{subject} accepts a merge only through the merge queue.")
        }
        MergeBlockReason::LinearHistory { .. } => format!(
            "{subject} requires linear history, and the repository allows only merge commits."
        ),
        MergeBlockReason::DeploymentRequired { environment, .. } => format!(
            "{subject} requires a successful deployment to `{environment}` before a merge."
        ),
        MergeBlockReason::BranchLocked { .. } => {
            format!("{subject} is locked, so GitHub accepts no merge into it.")
        }
        MergeBlockReason::RulesUnreadable { branch } => {
            let target = branch_target(branch);
            format!(
                "Suplex could not read branch rules for {target}. The GitHub token possibly does not have admin or read permission for them."
            )
        }
        MergeBlockReason::Unknown { branch } => {
            let target = branch_target(branch);
            format!(
                "GitHub blocks the merge into {target}, and the branch rules that Suplex read do not explain it."
            )
        }
    }
}

/// Every reason as one text, in diagnosis order.
pub fn describe_all(reasons: &[MergeBlockReason]) -> String {
    reasons.iter().map(describe).collect::<Vec<_>>().join(" ")
}

fn lower_first(sentence: &str) -> String {
    if sentence.starts_with("Suplex") || sentence.starts_with("GitHub") {
        return sentence.to_owned();
    }
    let mut characters = sentence.chars();
    characters.next().map_or_else(String::new, |first| {
        first.to_lowercase().chain(characters).collect()
    })
}

/// The `ask_human` input for a blocked merge: the observed cause and options that match it.
#[derive(Clone, Debug, Serialize)]
pub struct BlockQuestion {
    pub question: String,
    pub options: Vec<HumanQuestionOption>,
}

fn option(label: &str, description: String) -> HumanQuestionOption {
    HumanQuestionOption {
        label: label.to_owned(),
        description,
        recommended: false,
    }
}

/// The question sentence and the cause-matched options for a blocked merge.
pub fn block_question(
    number: u64,
    reasons: &[MergeBlockReason],
    abilities: MergeAbilities,
) -> BlockQuestion {
    let cause = match reasons {
        [only] => format!(
            "GitHub blocks pull request {number}: {}",
            lower_first(&describe(only))
        ),
        _ => format!(
            "GitHub blocks pull request {number} for {} reasons. {}",
            reasons.len(),
            describe_all(reasons)
        ),
    };
    let question = format!("{cause} How do you want to continue?");
    let retry = "The Coordinator then tries the merge again.";
    let mut repairs = Vec::new();
    for reason in reasons {
        let repair = match reason {
            MergeBlockReason::UnsignedCommits { shas, .. } if abilities.can_sign => Some(option(
                "Repair the commit signatures",
                format!(
                    "The Worker signs the {} again and force-pushes the task branch. GitHub then checks the new signatures.",
                    plural(shas.len(), "commit", "commits")
                ),
            )),
            MergeBlockReason::RequiredReview { .. } => Some(option(
                "Request a review",
                format!("You ask a reviewer to approve pull request {number} on GitHub. {retry}"),
            )),
            MergeBlockReason::MissingRequiredCheck { context, .. } => Some(option(
                "Repair the missing check",
                format!(
                    "The Coordinator finds why `{context}` did not report on the head commit and repairs it. {retry}"
                ),
            )),
            MergeBlockReason::UnresolvedConversations { .. } => Some(option(
                "Resolve the conversations",
                format!("You resolve the open review conversations on GitHub. {retry}"),
            )),
            MergeBlockReason::DeploymentRequired { environment, .. } => Some(option(
                "Start the deployment",
                format!("You deploy the head commit to `{environment}` on GitHub. {retry}"),
            )),
            MergeBlockReason::MergeQueueRequired { .. } => Some(option(
                "Move the pull request to the merge queue",
                format!(
                    "You add pull request {number} to the merge queue on GitHub. GitHub merges it after the queue checks pass."
                ),
            )),
            MergeBlockReason::RulesUnreadable { .. } | MergeBlockReason::Unknown { .. } => {
                Some(option(
                    "Check the branch rules",
                    format!(
                        "You read the branch rules on GitHub and repair the cause of the block. {retry}"
                    ),
                ))
            }
            _ => None,
        };
        if let Some(repair) = repair
            && !repairs
                .iter()
                .any(|known: &HumanQuestionOption| known.label == repair.label)
        {
            repairs.push(repair);
        }
    }
    if abilities.can_merge_as_admin {
        repairs.push(option(
            "Continue with an administrator merge",
            format!(
                "You merge pull request {number} on GitHub as an administrator. GitHub ignores the branch rules for this merge, and Suplex records it."
            ),
        ));
    }
    let rules = reasons
        .iter()
        .filter_map(MergeBlockReason::rule_name)
        .collect::<BTreeSet<_>>();
    if !rules.is_empty() {
        let target = branch_target(reasons.first().map_or("", MergeBlockReason::branch));
        repairs.push(option(
            "Continue after a rule change",
            format!(
                "You turn off the {} rule for {target} on GitHub. {retry}",
                rules.into_iter().collect::<Vec<_>>().join(" and "),
            ),
        ));
    }
    if repairs.is_empty() {
        repairs.push(option(
            "Retry the merge",
            format!("The Coordinator requests the merge of pull request {number} again."),
        ));
    }
    repairs.truncate(3);
    repairs.push(option(
        "Cancel the task",
        "The Coordinator stops the task. The pull request and the branch stay on GitHub as they are."
            .into(),
    ));
    repairs[0].recommended = true;
    BlockQuestion {
        question,
        options: repairs,
    }
}

/// The instruction to the Coordinator for a blocked merge: the named cause,
/// what a code change can repair, and the `ask_human` input for the rest.
pub fn coordinator_instruction(
    number: u64,
    reasons: &[MergeBlockReason],
    abilities: MergeAbilities,
) -> String {
    let question = block_question(number, reasons, abilities);
    let input = serde_json::to_string(&json!({
        "kind": "ask_human", "question": question.question, "options": question.options,
    }))
    .expect("question serializes");
    let repair = if reasons
        .iter()
        .all(|reason| !reason.repairable_by_code(abilities))
    {
        "A code change cannot repair this block. Do not integrate the base branch or change code for it."
    } else {
        "Repair only the causes that a change to the task branch can repair."
    };
    format!(
        "GitHub blocks the merge: {} {repair} Ask the person with this ask_human input, and keep its question and options: {input}",
        describe_all(reasons)
    )
}

/// The review part of the diagnosis. GitHub requires a review before it
/// merges this pull request. A repository can require code owner review with
/// zero required approvals: GitHub then reports a null decision and holds the
/// merge state at `BLOCKED`, or at `UNKNOWN` while it recomputes. A null
/// decision by itself says nothing about whether a review is necessary. After
/// one owner approves, other requests can stay open, but the merge state
/// leaves `BLOCKED`.
///
/// A diagnosed reason in `reasons` carries the counts Suplex read from the
/// branch rules. Without one, the reason comes from the observed fields.
pub fn review_block(
    reasons: &[MergeBlockReason],
    branch: &str,
    review_decision: Option<&str>,
    merge_state: Option<&str>,
    code_owner_reviewers: &[String],
) -> Option<MergeBlockReason> {
    let blocks = match review_decision {
        Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED") => true,
        None => {
            !code_owner_reviewers.is_empty() && matches!(merge_state, Some("BLOCKED" | "UNKNOWN"))
        }
        Some(_) => false,
    };
    if !blocks {
        return None;
    }
    reasons
        .iter()
        .find(|reason| matches!(reason, MergeBlockReason::RequiredReview { .. }))
        .cloned()
        .or_else(|| {
            Some(MergeBlockReason::RequiredReview {
                branch: branch.to_owned(),
                needed: None,
                code_owner_review: !code_owner_reviewers.is_empty(),
                code_owners: code_owner_reviewers.to_vec(),
                changes_requested: review_decision == Some("CHANGES_REQUESTED"),
            })
        })
}

/// The review part of the diagnosis for an observation.
pub fn observed_review_block(observed: &Observation) -> Option<MergeBlockReason> {
    review_block(
        &observed.block_reasons,
        observed.base_branch.as_deref().unwrap_or_default(),
        observed.review_decision.as_deref(),
        observed.merge_state_status.as_deref(),
        &observed.code_owner_reviewers,
    )
}

/// Diagnose only an open pull request that GitHub blocks for no check: no
/// check fails and no check is pending.
pub fn needs_diagnosis(observed: &Observation) -> bool {
    observed.exists
        && observed.state.as_deref() == Some("open")
        && matches!(
            observed.merge_state_status.as_deref(),
            Some("BLOCKED" | "UNKNOWN")
        )
        && observed.checks.failing == 0
        && observed.checks.pending == 0
}

/// One answer from GitHub for a diagnosis fact.
#[derive(Clone, Debug, PartialEq)]
pub enum Fetched<T> {
    Read(T),
    /// GitHub did not answer, or the token cannot read the fact.
    Unreadable,
    /// No rule needs the fact.
    Skipped,
}

impl<T> Fetched<T> {
    fn read(&self) -> Option<&T> {
        match self {
            Self::Read(value) => Some(value),
            Self::Unreadable | Self::Skipped => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Enabled {
    #[serde(default, deserialize_with = "lenient")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RequiredStatusChecks {
    #[serde(default, deserialize_with = "lenient")]
    pub contexts: Vec<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub checks: Vec<CheckContext>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct CheckContext {
    #[serde(default, deserialize_with = "lenient")]
    pub context: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RequiredReviews {
    #[serde(default, deserialize_with = "lenient")]
    pub required_approving_review_count: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub require_code_owner_reviews: bool,
}

/// `GET /repos/{owner}/{repo}/branches/{branch}/protection`. A missing
/// section is a rule that is off.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ClassicProtection {
    #[serde(default, deserialize_with = "lenient")]
    pub required_signatures: Option<Enabled>,
    #[serde(default, deserialize_with = "lenient")]
    pub required_status_checks: Option<RequiredStatusChecks>,
    #[serde(default, deserialize_with = "lenient")]
    pub required_pull_request_reviews: Option<RequiredReviews>,
    #[serde(default, deserialize_with = "lenient")]
    pub required_conversation_resolution: Option<Enabled>,
    #[serde(default, deserialize_with = "lenient")]
    pub required_linear_history: Option<Enabled>,
    #[serde(default, deserialize_with = "lenient")]
    pub lock_branch: Option<Enabled>,
}

/// One rule of `GET /repos/{owner}/{repo}/rules/branches/{branch}`. Each rule
/// type has its own parameters; an unknown type decodes with defaults.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct BranchRule {
    pub r#type: String,
    #[serde(default, deserialize_with = "lenient")]
    pub parameters: RuleParameters,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RuleParameters {
    #[serde(default, deserialize_with = "lenient")]
    pub required_approving_review_count: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub require_code_owner_review: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub required_review_thread_resolution: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub required_status_checks: Vec<CheckContext>,
    #[serde(default, deserialize_with = "lenient")]
    pub required_deployment_environments: Vec<String>,
}

/// One commit of `GET /repos/{owner}/{repo}/pulls/{number}/commits`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PullCommit {
    pub sha: String,
    pub commit: PullCommitDetail,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PullCommitDetail {
    pub verification: Verification,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Verification {
    pub verified: bool,
}

/// The rules that apply to the base branch, from both sources.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Requirements {
    pub signatures: bool,
    pub approvals: u32,
    pub code_owner_review: bool,
    pub contexts: BTreeSet<String>,
    pub conversation_resolution: bool,
    pub linear_history: bool,
    pub merge_queue: bool,
    pub locked: bool,
    pub deployments: BTreeSet<String>,
}

/// Combine classic branch protection and the branch rulesets.
pub fn requirements(
    classic: Option<&ClassicProtection>,
    rules: Option<&[BranchRule]>,
) -> Requirements {
    let mut required = Requirements::default();
    let on = |rule: &Option<Enabled>| rule.as_ref().is_some_and(|rule| rule.enabled);
    if let Some(classic) = classic {
        required.signatures |= on(&classic.required_signatures);
        required.conversation_resolution |= on(&classic.required_conversation_resolution);
        required.linear_history |= on(&classic.required_linear_history);
        required.locked |= on(&classic.lock_branch);
        if let Some(reviews) = &classic.required_pull_request_reviews {
            required.approvals = required.approvals.max(reviews.required_approving_review_count);
            required.code_owner_review |= reviews.require_code_owner_reviews;
        }
        if let Some(checks) = &classic.required_status_checks {
            required.contexts.extend(checks.contexts.iter().cloned());
            required
                .contexts
                .extend(checks.checks.iter().map(|check| check.context.clone()));
        }
    }
    for rule in rules.unwrap_or_default() {
        let parameters = &rule.parameters;
        match rule.r#type.as_str() {
            "required_signatures" => required.signatures = true,
            "required_linear_history" => required.linear_history = true,
            "merge_queue" => required.merge_queue = true,
            "update" => required.locked = true,
            "pull_request" => {
                required.approvals = required
                    .approvals
                    .max(parameters.required_approving_review_count);
                required.code_owner_review |= parameters.require_code_owner_review;
                required.conversation_resolution |= parameters.required_review_thread_resolution;
            }
            "required_status_checks" => required.contexts.extend(
                parameters
                    .required_status_checks
                    .iter()
                    .map(|check| check.context.clone()),
            ),
            "required_deployments" => required
                .deployments
                .extend(parameters.required_deployment_environments.iter().cloned()),
            _ => {}
        }
    }
    required.contexts.retain(|context| !context.is_empty());
    required.deployments.retain(|environment| !environment.is_empty());
    required
}

/// Everything Suplex read from GitHub for one diagnosis.
#[derive(Clone, Debug, PartialEq)]
pub struct BlockFacts {
    pub branch: String,
    /// `Read(default)` when GitHub reports that the branch is not protected.
    pub classic: Fetched<ClassicProtection>,
    pub rules: Fetched<Vec<BranchRule>>,
    pub commits: Fetched<Vec<PullCommit>>,
    pub unresolved_threads: Fetched<u32>,
    /// Each required environment and whether a deployment of the head succeeded.
    pub deployments: Vec<(String, Fetched<bool>)>,
    /// The repository allows a squash or rebase merge.
    pub linear_merge_allowed: Fetched<bool>,
}

impl BlockFacts {
    /// Facts for a pull request whose base branch Suplex does not know.
    pub fn unreadable(branch: &str) -> Self {
        Self {
            branch: branch.to_owned(),
            classic: Fetched::Unreadable,
            rules: Fetched::Unreadable,
            commits: Fetched::Skipped,
            unresolved_threads: Fetched::Skipped,
            deployments: Vec::new(),
            linear_merge_allowed: Fetched::Skipped,
        }
    }
}

/// The pure diagnosis: each rule the pull request does not satisfy, in a
/// stable order. A fact Suplex could not read makes the picture incomplete;
/// Suplex then adds `rules_unreadable` and never guesses the rule.
pub fn diagnose(observed: &Observation, facts: &BlockFacts) -> Vec<MergeBlockReason> {
    let branch = facts.branch.clone();
    let required = requirements(
        facts.classic.read(),
        facts.rules.read().map(Vec::as_slice),
    );
    let mut incomplete = matches!(facts.classic, Fetched::Unreadable)
        || matches!(facts.rules, Fetched::Unreadable);
    let mut reasons = Vec::new();
    if required.signatures {
        match facts.commits.read() {
            Some(commits) => {
                let shas = commits
                    .iter()
                    .filter(|commit| !commit.commit.verification.verified)
                    .map(|commit| commit.sha.clone())
                    .collect::<Vec<_>>();
                if !shas.is_empty() {
                    reasons.push(MergeBlockReason::UnsignedCommits {
                        branch: branch.clone(),
                        shas,
                    });
                }
            }
            None => incomplete = true,
        }
    }
    let review = review_block(
        &[],
        &branch,
        observed.review_decision.as_deref(),
        observed.merge_state_status.as_deref(),
        &observed.code_owner_reviewers,
    );
    if let Some(MergeBlockReason::RequiredReview {
        branch,
        code_owner_review,
        code_owners,
        changes_requested,
        ..
    }) = review
    {
        reasons.push(MergeBlockReason::RequiredReview {
            branch,
            needed: (required.approvals > 0).then_some(required.approvals),
            code_owner_review: code_owner_review || required.code_owner_review,
            code_owners,
            changes_requested,
        });
    }
    let reported = observed
        .checks
        .runs
        .iter()
        .filter_map(|run| run["name"].as_str())
        .collect::<BTreeSet<_>>();
    for context in &required.contexts {
        if !reported.contains(context.as_str()) {
            reasons.push(MergeBlockReason::MissingRequiredCheck {
                branch: branch.clone(),
                context: context.clone(),
            });
        }
    }
    if required.conversation_resolution {
        match facts.unresolved_threads.read() {
            Some(0) => {}
            Some(count) => reasons.push(MergeBlockReason::UnresolvedConversations {
                branch: branch.clone(),
                count: *count,
            }),
            None => incomplete = true,
        }
    }
    for environment in &required.deployments {
        match facts
            .deployments
            .iter()
            .find(|(name, _)| name == environment)
            .and_then(|(_, fetched)| fetched.read())
        {
            Some(true) => {}
            Some(false) => reasons.push(MergeBlockReason::DeploymentRequired {
                branch: branch.clone(),
                environment: environment.clone(),
            }),
            None => incomplete = true,
        }
    }
    if required.merge_queue {
        reasons.push(MergeBlockReason::MergeQueueRequired {
            branch: branch.clone(),
        });
    }
    if required.linear_history {
        match facts.linear_merge_allowed.read() {
            Some(true) => {}
            Some(false) => reasons.push(MergeBlockReason::LinearHistory {
                branch: branch.clone(),
            }),
            None => incomplete = true,
        }
    }
    if required.locked {
        reasons.push(MergeBlockReason::BranchLocked {
            branch: branch.clone(),
        });
    }
    if incomplete {
        reasons.push(MergeBlockReason::RulesUnreadable { branch });
    } else if reasons.is_empty() && observed.merge_state_status.as_deref() != Some("UNKNOWN") {
        // An `UNKNOWN` state can be GitHub recomputing, not a block.
        reasons.push(MergeBlockReason::Unknown { branch });
    }
    reasons
}

fn query(path: &str, pairs: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    format!("{path}?{}", serializer.finish())
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPage {
    data: Option<ThreadRepository>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRepository {
    repository: Option<ThreadPull>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPull {
    pull_request: Option<ThreadConnection>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadConnection {
    review_threads: Threads,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Threads {
    nodes: Vec<Thread>,
    page_info: PageInfo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    is_resolved: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

const THREADS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}";

#[derive(Deserialize)]
struct Deployment {
    id: u64,
}

#[derive(Deserialize)]
struct DeploymentStatus {
    state: String,
}

#[derive(Deserialize)]
struct MergeMethods {
    #[serde(default, deserialize_with = "lenient")]
    allow_squash_merge: bool,
    #[serde(default, deserialize_with = "lenient")]
    allow_rebase_merge: bool,
}

fn repo_path(repository: &str, tail: &[&str]) -> String {
    let mut url = url::Url::parse("https://api.github.com").expect("static URL");
    {
        let mut segments = url.path_segments_mut().expect("base URL");
        segments.push("repos");
        segments.extend(repository.split('/'));
        segments.extend(tail);
    }
    url.path().to_owned()
}

impl Github {
    async fn read_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Fetched<T> {
        match self.raw("GET", path, None).await {
            Ok((200..=299, body)) => serde_json::from_str(&body).map_or(Fetched::Unreadable, Fetched::Read),
            _ => Fetched::Unreadable,
        }
    }

    /// Classic branch protection. GitHub answers 404 "Branch not protected"
    /// for a branch without protection. Any other 404 or a 403 is unreadable.
    async fn classic_protection(&self, repository: &str, branch: &str) -> Fetched<ClassicProtection> {
        let path = repo_path(repository, &["branches", branch, "protection"]);
        match self.raw("GET", &path, None).await {
            Ok((200..=299, body)) => {
                serde_json::from_str(&body).map_or(Fetched::Unreadable, Fetched::Read)
            }
            Ok((404, body))
                if serde_json::from_str::<Message>(&body)
                    .is_ok_and(|message| message.message == "Branch not protected") =>
            {
                Fetched::Read(ClassicProtection::default())
            }
            _ => Fetched::Unreadable,
        }
    }

    /// The rulesets that apply to a branch. GitHub Free answers a private
    /// repository with 403 ("Upgrade to GitHub Pro"). That is not a token
    /// problem: the repository has no rules.
    pub(crate) async fn branch_rules(
        &self,
        repository: &str,
        branch: &str,
    ) -> GithubResult<Vec<BranchRule>> {
        let path = repo_path(repository, &["rules", "branches", branch]);
        let (status, body) = self.raw("GET", &path, None).await?;
        match status {
            200..=299 => serde_json::from_str(&body).map_err(|_| {
                failure(
                    "invalid-provider-response",
                    "GitHub branch rules are malformed",
                )
            }),
            403 => Ok(Vec::new()),
            _ => Err(failure(
                "provider-unavailable",
                format!("branch rules failed: HTTP {status}"),
            )),
        }
    }

    async fn pull_commits(&self, repository: &str, number: u64) -> Fetched<Vec<PullCommit>> {
        const PAGE: usize = 100;
        let base = repo_path(repository, &["pulls", &number.to_string(), "commits"]);
        let mut commits = Vec::new();
        // GitHub lists at most 250 commits of a pull request.
        for page in 1..=3 {
            let path = query(&base, &[("per_page", "100"), ("page", &page.to_string())]);
            match self.read_json::<Vec<PullCommit>>(&path).await {
                Fetched::Read(batch) => {
                    let last = batch.len() < PAGE;
                    commits.extend(batch);
                    if last {
                        return Fetched::Read(commits);
                    }
                }
                _ => return Fetched::Unreadable,
            }
        }
        Fetched::Read(commits)
    }

    async fn unresolved_threads(&self, repository: &str, number: u64) -> Fetched<u32> {
        let Some((owner, name)) = repository.split_once('/') else {
            return Fetched::Unreadable;
        };
        let mut unresolved = 0;
        let mut after: Option<String> = None;
        for _ in 0..10 {
            let page = self
                .graphql::<ThreadPage>(
                    THREADS_QUERY,
                    json!({"owner": owner, "name": name, "number": number, "after": after}),
                    "review thread observation",
                )
                .await;
            let Some(threads) = page.ok().and_then(|page| {
                page.data?
                    .repository?
                    .pull_request
                    .map(|pull| pull.review_threads)
            }) else {
                return Fetched::Unreadable;
            };
            unresolved += threads
                .nodes
                .iter()
                .filter(|thread| !thread.is_resolved)
                .count() as u32;
            if !threads.page_info.has_next_page {
                return Fetched::Read(unresolved);
            }
            after = threads.page_info.end_cursor;
        }
        Fetched::Unreadable
    }

    async fn deployment_succeeded(
        &self,
        repository: &str,
        head_sha: &str,
        environment: &str,
    ) -> Fetched<bool> {
        let path = query(
            &repo_path(repository, &["deployments"]),
            &[("sha", head_sha), ("environment", environment), ("per_page", "1")],
        );
        let deployments = match self.read_json::<Vec<Deployment>>(&path).await {
            Fetched::Read(deployments) => deployments,
            _ => return Fetched::Unreadable,
        };
        let Some(deployment) = deployments.first() else {
            return Fetched::Read(false);
        };
        let path = query(
            &repo_path(
                repository,
                &["deployments", &deployment.id.to_string(), "statuses"],
            ),
            &[("per_page", "1")],
        );
        match self.read_json::<Vec<DeploymentStatus>>(&path).await {
            Fetched::Read(statuses) => Fetched::Read(
                statuses
                    .first()
                    .is_some_and(|status| status.state == "success"),
            ),
            _ => Fetched::Unreadable,
        }
    }

    /// Read the facts each applicable rule tests. A failed read degrades to
    /// `Unreadable`; it never fails the observation.
    pub async fn block_facts(&self, repository: &str, observed: &Observation) -> BlockFacts {
        let Some(branch) = observed.base_branch.as_deref().filter(|branch| !branch.is_empty())
        else {
            return BlockFacts::unreadable("");
        };
        let classic = self.classic_protection(repository, branch).await;
        let rules = match self.branch_rules(repository, branch).await {
            Ok(rules) => Fetched::Read(rules),
            Err(_) => Fetched::Unreadable,
        };
        let required = requirements(classic.read(), rules.read().map(Vec::as_slice));
        let number = observed.number.unwrap_or_default();
        let commits = if required.signatures {
            self.pull_commits(repository, number).await
        } else {
            Fetched::Skipped
        };
        let unresolved_threads = if required.conversation_resolution {
            self.unresolved_threads(repository, number).await
        } else {
            Fetched::Skipped
        };
        let mut deployments = Vec::new();
        for environment in &required.deployments {
            let fetched = match observed.head_sha.as_deref() {
                Some(head) => self.deployment_succeeded(repository, head, environment).await,
                None => Fetched::Unreadable,
            };
            deployments.push((environment.clone(), fetched));
        }
        let linear_merge_allowed = if required.linear_history {
            match self.read_json::<MergeMethods>(&repo_path(repository, &[])).await {
                Fetched::Read(methods) => {
                    Fetched::Read(methods.allow_squash_merge || methods.allow_rebase_merge)
                }
                _ => Fetched::Unreadable,
            }
        } else {
            Fetched::Skipped
        };
        BlockFacts {
            branch: branch.to_owned(),
            classic,
            rules,
            commits,
            unresolved_threads,
            deployments,
            linear_merge_allowed,
        }
    }

    /// Fetch the facts and diagnose. Used by every pull request observation
    /// that `needs_diagnosis`, and by a refused merge.
    pub async fn diagnose_merge_block(
        &self,
        repository: &str,
        observed: &Observation,
    ) -> Vec<MergeBlockReason> {
        let facts = self.block_facts(repository, observed).await;
        diagnose(observed, &facts)
    }
}
