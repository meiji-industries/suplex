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
            Self::RequiredReview { .. }
            | Self::UnresolvedConversations { .. }
            | Self::MergeQueueRequired { .. }
            | Self::LinearHistory { .. }
            | Self::DeploymentRequired { .. }
            | Self::BranchLocked { .. }
            | Self::RulesUnreadable { .. }
            | Self::Unknown { .. } => false,
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
    let mut text = items
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
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
            let shorts = shas
                .iter()
                .map(|sha| short(sha).to_owned())
                .collect::<Vec<_>>();
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
                plural(
                    *count as usize,
                    "review conversation",
                    "review conversations"
                )
            )
        }
        MergeBlockReason::MergeQueueRequired { .. } => {
            format!("{subject} accepts a merge only through the merge queue.")
        }
        MergeBlockReason::LinearHistory { .. } => format!(
            "{subject} requires linear history, and the repository allows only merge commits."
        ),
        MergeBlockReason::DeploymentRequired { environment, .. } => {
            format!("{subject} requires a successful deployment to `{environment}` before a merge.")
        }
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
            MergeBlockReason::UnsignedCommits { .. }
            | MergeBlockReason::LinearHistory { .. }
            | MergeBlockReason::BranchLocked { .. } => None,
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
            required.approvals = required
                .approvals
                .max(reviews.required_approving_review_count);
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
    required
        .deployments
        .retain(|environment| !environment.is_empty());
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
    let required = requirements(facts.classic.read(), facts.rules.read().map(Vec::as_slice));
    let mut incomplete =
        matches!(facts.classic, Fetched::Unreadable) || matches!(facts.rules, Fetched::Unreadable);
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
            Ok((200..=299, body)) => {
                serde_json::from_str(&body).map_or(Fetched::Unreadable, Fetched::Read)
            }
            Ok(_) | Err(_) => Fetched::Unreadable,
        }
    }

    /// Classic branch protection. GitHub answers 404 "Branch not protected"
    /// for a branch without protection. Any other 404 or a 403 is unreadable.
    async fn classic_protection(
        &self,
        repository: &str,
        branch: &str,
    ) -> Fetched<ClassicProtection> {
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
            Ok(_) | Err(_) => Fetched::Unreadable,
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
                Fetched::Unreadable | Fetched::Skipped => return Fetched::Unreadable,
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
            &[
                ("sha", head_sha),
                ("environment", environment),
                ("per_page", "1"),
            ],
        );
        let Fetched::Read(deployments) = self.read_json::<Vec<Deployment>>(&path).await else {
            return Fetched::Unreadable;
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
            Fetched::Unreadable | Fetched::Skipped => Fetched::Unreadable,
        }
    }

    /// Read the facts each applicable rule tests. A failed read degrades to
    /// `Unreadable`; it never fails the observation.
    pub async fn block_facts(&self, repository: &str, observed: &Observation) -> BlockFacts {
        let Some(branch) = observed
            .base_branch
            .as_deref()
            .filter(|branch| !branch.is_empty())
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
                Some(head) => {
                    self.deployment_succeeded(repository, head, environment)
                        .await
                }
                None => Fetched::Unreadable,
            };
            deployments.push((environment.clone(), fetched));
        }
        let linear_merge_allowed = if required.linear_history {
            match self
                .read_json::<MergeMethods>(&repo_path(repository, &[]))
                .await
            {
                Fetched::Read(methods) => {
                    Fetched::Read(methods.allow_squash_merge || methods.allow_rebase_merge)
                }
                Fetched::Unreadable | Fetched::Skipped => Fetched::Unreadable,
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

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::integrations::github_delivery::{Checks, MergeDisposition, MergeResult};

    const MAIN: &str = "main";

    fn sha(prefix: &str) -> String {
        format!("{prefix}{}", "0".repeat(40 - prefix.len()))
    }

    fn blocked() -> Observation {
        Observation {
            exists: true,
            number: Some(12),
            state: Some("open".into()),
            is_draft: Some(false),
            head_sha: Some(sha("aaaa")),
            mergeable: Some("MERGEABLE".into()),
            merge_state_status: Some("BLOCKED".into()),
            base_branch: Some(MAIN.into()),
            checks: Checks {
                total: 1,
                successful: 1,
                runs: vec![json!({"name": "unit", "status": "successful"})],
                ..Checks::default()
            },
            ..Observation::default()
        }
    }

    fn facts() -> BlockFacts {
        BlockFacts {
            branch: MAIN.into(),
            classic: Fetched::Read(ClassicProtection::default()),
            rules: Fetched::Read(Vec::new()),
            commits: Fetched::Skipped,
            unresolved_threads: Fetched::Skipped,
            deployments: Vec::new(),
            linear_merge_allowed: Fetched::Skipped,
        }
    }

    fn classic(value: Value) -> Fetched<ClassicProtection> {
        Fetched::Read(serde_json::from_value(value).unwrap())
    }

    fn rules(value: Value) -> Fetched<Vec<BranchRule>> {
        Fetched::Read(serde_json::from_value(value).unwrap())
    }

    fn commits(entries: &[(&str, bool)]) -> Fetched<Vec<PullCommit>> {
        Fetched::Read(
            serde_json::from_value(Value::Array(
                entries
                    .iter()
                    .map(|(sha, verified)| {
                        json!({"sha": sha, "commit": {"verification": {"verified": verified, "reason": if *verified { "valid" } else { "unsigned" }}}})
                    })
                    .collect(),
            ))
            .unwrap(),
        )
    }

    fn kinds(reasons: &[MergeBlockReason]) -> Vec<String> {
        reasons
            .iter()
            .map(|reason| {
                serde_json::to_value(reason).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn unsigned_commits_come_from_classic_protection_and_rulesets() {
        let (signed, unsigned) = (sha("1111"), sha("2222"));
        for (classic_rules, ruleset) in [
            (json!({"required_signatures": {"enabled": true}}), json!([])),
            (json!({}), json!([{"type": "required_signatures"}])),
        ] {
            let mut facts = facts();
            facts.classic = classic(classic_rules);
            facts.rules = rules(ruleset);
            facts.commits = commits(&[(&signed, true), (&unsigned, false)]);
            assert_eq!(
                diagnose(&blocked(), &facts),
                [MergeBlockReason::UnsignedCommits {
                    branch: MAIN.into(),
                    shas: vec![unsigned.clone()]
                }]
            );
            facts.commits = commits(&[(&signed, true)]);
            assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["unknown"]);
            facts.commits = Fetched::Unreadable;
            assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["rules_unreadable"]);
        }
        let mut facts = facts();
        facts.classic = classic(json!({"required_signatures": {"enabled": false}}));
        assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["unknown"]);
    }

    #[test]
    fn required_reviews_keep_the_observed_decision_and_read_the_counts() {
        let mut observed = blocked();
        observed.review_decision = Some("REVIEW_REQUIRED".into());
        let mut facts = facts();
        facts.classic = classic(
            json!({"required_pull_request_reviews": {"required_approving_review_count": 2, "require_code_owner_reviews": false}}),
        );
        let reasons = diagnose(&observed, &facts);
        assert_eq!(
            reasons,
            [MergeBlockReason::RequiredReview {
                branch: MAIN.into(),
                needed: Some(2),
                code_owner_review: false,
                code_owners: vec![],
                changes_requested: false,
            }]
        );
        assert_eq!(
            describe(&reasons[0]),
            "Branch `main` requires 2 approving reviews."
        );
        // Code owner review with zero approvals: a null decision, an open request, BLOCKED.
        observed.review_decision = None;
        observed.code_owner_reviewers = vec!["octo".into()];
        facts.classic = Fetched::Read(ClassicProtection::default());
        facts.rules = rules(
            json!([{"type": "pull_request", "parameters": {"required_approving_review_count": 0, "require_code_owner_review": true, "allowed_merge_methods": ["squash"]}}]),
        );
        let reasons = diagnose(&observed, &facts);
        assert_eq!(
            reasons,
            [MergeBlockReason::RequiredReview {
                branch: MAIN.into(),
                needed: None,
                code_owner_review: true,
                code_owners: vec!["octo".into()],
                changes_requested: false,
            }]
        );
        assert_eq!(
            describe(&reasons[0]),
            "Branch `main` requires a code owner review from octo."
        );
        // A null decision without a code owner request is not a review block.
        observed.code_owner_reviewers.clear();
        assert_eq!(kinds(&diagnose(&observed, &facts)), ["unknown"]);
        observed.review_decision = Some("CHANGES_REQUESTED".into());
        let reasons = diagnose(&observed, &facts);
        assert!(describe(&reasons[0]).starts_with("A reviewer requested changes."));
        observed.review_decision = Some("APPROVED".into());
        assert_eq!(kinds(&diagnose(&observed, &facts)), ["unknown"]);
    }

    #[test]
    fn review_block_matches_the_observed_review_rule() {
        let owners = vec!["octo".to_owned()];
        let blocks = |decision, state, owners: &[String]| {
            review_block(&[], MAIN, decision, state, owners).is_some()
        };
        assert!(blocks(Some("REVIEW_REQUIRED"), None, &[]));
        assert!(blocks(Some("CHANGES_REQUESTED"), Some("CLEAN"), &[]));
        assert!(!blocks(Some("APPROVED"), Some("BLOCKED"), &owners));
        assert!(!blocks(None, Some("BLOCKED"), &[]));
        assert!(blocks(None, Some("BLOCKED"), &owners));
        assert!(blocks(None, Some("UNKNOWN"), &owners));
        assert!(!blocks(None, Some("CLEAN"), &owners));
        // A diagnosed reason carries the counts.
        let diagnosed = MergeBlockReason::RequiredReview {
            branch: MAIN.into(),
            needed: Some(3),
            code_owner_review: false,
            code_owners: vec![],
            changes_requested: false,
        };
        assert_eq!(
            review_block(
                std::slice::from_ref(&diagnosed),
                MAIN,
                Some("REVIEW_REQUIRED"),
                None,
                &[]
            ),
            Some(diagnosed)
        );
    }

    #[test]
    fn missing_required_checks_name_each_context_without_a_result() {
        let mut observed = blocked();
        observed
            .checks
            .runs
            .push(json!({"name": "docs", "status": "successful", "conclusion": "SKIPPED"}));
        let mut facts = facts();
        facts.classic = classic(
            json!({"required_status_checks": {"contexts": ["unit", "build"], "checks": [{"context": "lint", "app_id": 1}]}}),
        );
        facts.rules = rules(
            json!([{"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "docs"}, {"context": "e2e", "integration_id": 2}], "strict_required_status_checks_policy": false}}]),
        );
        let reasons = diagnose(&observed, &facts);
        let contexts = reasons
            .iter()
            .map(|reason| match reason {
                MergeBlockReason::MissingRequiredCheck { context, .. } => context.as_str(),
                other @ (MergeBlockReason::UnsignedCommits { .. }
                | MergeBlockReason::RequiredReview { .. }
                | MergeBlockReason::UnresolvedConversations { .. }
                | MergeBlockReason::MergeQueueRequired { .. }
                | MergeBlockReason::LinearHistory { .. }
                | MergeBlockReason::DeploymentRequired { .. }
                | MergeBlockReason::BranchLocked { .. }
                | MergeBlockReason::RulesUnreadable { .. }
                | MergeBlockReason::Unknown { .. }) => panic!("{other:?}"),
            })
            .collect::<Vec<_>>();
        // A skipped required check reported a result; GitHub accepts it.
        assert_eq!(contexts, ["build", "e2e", "lint"]);
    }

    #[test]
    fn conversations_deployments_queue_history_and_lock_are_named() {
        let mut facts = facts();
        facts.classic = classic(json!({"required_conversation_resolution": {"enabled": true}}));
        facts.unresolved_threads = Fetched::Read(2);
        assert_eq!(
            diagnose(&blocked(), &facts),
            [MergeBlockReason::UnresolvedConversations {
                branch: MAIN.into(),
                count: 2
            }]
        );
        facts.classic = Fetched::Read(ClassicProtection::default());
        facts.rules = rules(
            json!([{"type": "pull_request", "parameters": {"required_review_thread_resolution": true}}]),
        );
        assert_eq!(
            kinds(&diagnose(&blocked(), &facts)),
            ["unresolved_conversations"]
        );
        facts.unresolved_threads = Fetched::Read(0);
        assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["unknown"]);

        let mut facts = super::tests::facts();
        facts.rules = rules(
            json!([{"type": "required_deployments", "parameters": {"required_deployment_environments": ["production"]}}]),
        );
        facts.deployments = vec![("production".into(), Fetched::Read(false))];
        assert_eq!(
            diagnose(&blocked(), &facts),
            [MergeBlockReason::DeploymentRequired {
                branch: MAIN.into(),
                environment: "production".into()
            }]
        );
        facts.deployments = vec![("production".into(), Fetched::Read(true))];
        assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["unknown"]);

        let mut facts = super::tests::facts();
        facts.rules =
            rules(json!([{"type": "merge_queue", "parameters": {"merge_method": "SQUASH"}}]));
        assert_eq!(
            kinds(&diagnose(&blocked(), &facts)),
            ["merge_queue_required"]
        );

        for (classic_rules, ruleset) in [
            (
                json!({"required_linear_history": {"enabled": true}}),
                json!([]),
            ),
            (json!({}), json!([{"type": "required_linear_history"}])),
        ] {
            let mut facts = super::tests::facts();
            facts.classic = classic(classic_rules);
            facts.rules = rules(ruleset);
            facts.linear_merge_allowed = Fetched::Read(false);
            assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["linear_history"]);
            facts.linear_merge_allowed = Fetched::Read(true);
            assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["unknown"]);
        }

        for (classic_rules, ruleset) in [
            (json!({"lock_branch": {"enabled": true}}), json!([])),
            (
                json!({}),
                json!([{"type": "update", "parameters": {"update_allows_fetch_and_merge": false}}]),
            ),
        ] {
            let mut facts = super::tests::facts();
            facts.classic = classic(classic_rules);
            facts.rules = rules(ruleset);
            assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["branch_locked"]);
        }
    }

    #[test]
    fn unknown_rule_types_decode_and_explain_nothing() {
        let mut facts = facts();
        facts.rules = rules(json!([
            {"type": "non_fast_forward"},
            {"type": "code_scanning", "parameters": {"code_scanning_tools": [{"tool": "x"}]}},
            {"type": "future_rule", "parameters": {"required_status_checks": "not a list"}},
        ]));
        assert_eq!(kinds(&diagnose(&blocked(), &facts)), ["unknown"]);
        let mut recomputing = blocked();
        recomputing.merge_state_status = Some("UNKNOWN".into());
        assert!(
            diagnose(&recomputing, &facts).is_empty(),
            "UNKNOWN can be a recomputation"
        );
    }

    #[test]
    fn unreadable_rules_are_reported_and_never_guessed() {
        let mut facts = facts();
        facts.classic = Fetched::Unreadable;
        let reasons = diagnose(&blocked(), &facts);
        assert_eq!(
            reasons,
            [MergeBlockReason::RulesUnreadable {
                branch: MAIN.into()
            }]
        );
        assert!(
            describe(&reasons[0])
                .starts_with("Suplex could not read branch rules for branch `main`.")
        );
        // A concrete rule from the readable source stays, and the gap is named.
        facts.rules = rules(json!([{"type": "merge_queue"}]));
        assert_eq!(
            kinds(&diagnose(&blocked(), &facts)),
            ["merge_queue_required", "rules_unreadable"]
        );
        assert_eq!(
            kinds(&diagnose(&blocked(), &BlockFacts::unreadable(""))),
            ["rules_unreadable"]
        );
    }

    #[test]
    fn several_reasons_are_reported_in_a_stable_order_and_all_named() {
        let mut observed = blocked();
        observed.review_decision = Some("REVIEW_REQUIRED".into());
        let mut facts = facts();
        facts.classic = classic(json!({
            "required_signatures": {"enabled": true},
            "lock_branch": {"enabled": true},
            "required_status_checks": {"contexts": ["build"]},
            "required_conversation_resolution": {"enabled": true},
        }));
        facts.rules = rules(
            json!([{"type": "merge_queue"}, {"type": "required_linear_history"}, {"type": "required_deployments", "parameters": {"required_deployment_environments": ["staging"]}}]),
        );
        facts.commits = commits(&[(&sha("3333"), false)]);
        facts.unresolved_threads = Fetched::Read(1);
        facts.deployments = vec![("staging".into(), Fetched::Read(false))];
        facts.linear_merge_allowed = Fetched::Read(false);
        let reasons = diagnose(&observed, &facts);
        assert_eq!(
            kinds(&reasons),
            [
                "unsigned_commits",
                "required_review",
                "missing_required_check",
                "unresolved_conversations",
                "deployment_required",
                "merge_queue_required",
                "linear_history",
                "branch_locked"
            ]
        );
        let question = block_question(12, &reasons, MergeAbilities::default());
        assert!(
            question
                .question
                .starts_with("GitHub blocks pull request 12 for 8 reasons.")
        );
        for reason in &reasons {
            assert!(question.question.contains(&describe(reason)), "{reason:?}");
        }
        assert!(question.question.ends_with("How do you want to continue?"));
        assert!((2..=4).contains(&question.options.len()));
        assert_eq!(
            question
                .options
                .iter()
                .filter(|option| option.recommended)
                .count(),
            1
        );
        assert_eq!(question.options.last().unwrap().label, "Cancel the task");
    }

    #[test]
    fn unsigned_commit_options_follow_what_the_runner_and_token_can_do() {
        let reasons = [MergeBlockReason::UnsignedCommits {
            branch: MAIN.into(),
            shas: vec![sha("abc1234"), sha("def5678")],
        }];
        let labels = |abilities| {
            block_question(12, &reasons, abilities)
                .options
                .into_iter()
                .map(|option| (option.label, option.recommended))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            labels(MergeAbilities {
                can_sign: true,
                can_merge_as_admin: true
            }),
            [
                ("Repair the commit signatures".to_owned(), true),
                ("Continue with an administrator merge".to_owned(), false),
                ("Continue after a rule change".to_owned(), false),
                ("Cancel the task".to_owned(), false),
            ]
        );
        assert_eq!(
            labels(MergeAbilities::default()),
            [
                ("Continue after a rule change".to_owned(), true),
                ("Cancel the task".to_owned(), false),
            ]
        );
        let question = block_question(12, &reasons, MergeAbilities::default());
        assert_eq!(
            question.question,
            "GitHub blocks pull request 12: branch `main` requires signed commits and 2 commits are unsigned (abc1234, def5678). How do you want to continue?"
        );
        assert!(
            question.options[0]
                .description
                .contains("signed commits rule for branch `main`")
        );
        // No code change repairs it without a signing key.
        let instruction = coordinator_instruction(12, &reasons, MergeAbilities::default());
        assert!(instruction.contains("A code change cannot repair this block."));
        assert!(instruction.contains("\"kind\":\"ask_human\""));
        let instruction = coordinator_instruction(
            12,
            &reasons,
            MergeAbilities {
                can_sign: true,
                can_merge_as_admin: false,
            },
        );
        assert!(!instruction.contains("cannot repair"));
    }

    #[test]
    fn a_missing_review_offers_a_review_request() {
        let reasons = [MergeBlockReason::RequiredReview {
            branch: MAIN.into(),
            needed: Some(1),
            code_owner_review: false,
            code_owners: vec![],
            changes_requested: false,
        }];
        let question = block_question(12, &reasons, MergeAbilities::default());
        assert_eq!(question.options[0].label, "Request a review");
        assert!(question.options[0].recommended);
        assert_eq!(
            question.question,
            "GitHub blocks pull request 12: branch `main` requires an approving review. How do you want to continue?"
        );
    }

    fn observation(merge_state: &str, checks: Value) -> Value {
        json!({"data": {"repository": {"pullRequest": {
            "number": 12, "url": "https://github.com/owner/repo/pull/12", "state": "OPEN", "isDraft": false,
            "headRefOid": sha("aaaa"), "baseRefOid": sha("bbbb"), "baseRefName": MAIN,
            "mergeable": "MERGEABLE", "mergeStateStatus": merge_state, "autoMergeRequest": null,
            "reviewDecision": null, "viewerCanMergeAsAdmin": false, "reviewRequests": {"nodes": []},
            "author": {"login": "octo"}, "changedFiles": 1, "additions": 1, "deletions": 0,
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": checks}}}}]},
        }}}})
    }

    fn check(name: &str, conclusion: &str) -> Value {
        json!({"__typename": "CheckRun", "name": name, "status": "COMPLETED", "conclusion": conclusion,
            "startedAt": "2026-09-01T00:00:00Z", "completedAt": "2026-09-01T00:01:00Z"})
    }

    /// A pull request blocked only by unsigned commits. A skipped deployment
    /// check is a successful check and never a reason.
    fn motivating_checks() -> Value {
        json!([
            check("build", "SUCCESS"),
            check("unit", "SUCCESS"),
            check("lint", "SUCCESS"),
            check("Mintlify Deployment", "SKIPPED"),
        ])
    }

    const COMMITS_PATH: &str = "/repos/owner/repo/pulls/12/commits?per_page=100&page=1";
    const PROTECTION_PATH: &str = "/repos/owner/repo/branches/main/protection";
    const RULES_PATH: &str = "/repos/owner/repo/rules/branches/main";

    #[tokio::test]
    async fn the_signatures_only_shape_names_unsigned_commits_and_nothing_else() {
        use crate::integrations::github_delivery::tests::counted_fake_api;
        let (first, second) = (sha("abc1234"), sha("def5678"));
        let (github, server, requests) = counted_fake_api(
            vec![
                (PROTECTION_PATH, 200, json!({
                    "url": "https://api.github.com/repos/owner/repo/branches/main/protection",
                    "required_signatures": {"url": "https://api.github.com/repos/owner/repo/branches/main/protection/required_signatures", "enabled": true},
                    "enforce_admins": {"enabled": false},
                    "required_linear_history": {"enabled": false},
                    "allow_force_pushes": {"enabled": false},
                    "required_conversation_resolution": {"enabled": false},
                    "lock_branch": {"enabled": false},
                })),
                (RULES_PATH, 200, json!([])),
                (COMMITS_PATH, 200, json!([
                    {"sha": first, "commit": {"verification": {"verified": false, "reason": "unsigned", "signature": null, "payload": null}}},
                    {"sha": second, "commit": {"verification": {"verified": false, "reason": "unsigned", "signature": null, "payload": null}}},
                ])),
            ],
            vec![("reviewRequests", observation("BLOCKED", motivating_checks()))],
        )
        .await;
        let observed = github
            .observe_pull_request("owner/repo", "task", Some(12))
            .await
            .unwrap();
        assert_eq!(
            (
                observed.checks.total,
                observed.checks.successful,
                observed.checks.failing,
                observed.checks.pending
            ),
            (4, 4, 0, 0)
        );
        assert_eq!(
            observed.block_reasons,
            [MergeBlockReason::UnsignedCommits {
                branch: MAIN.into(),
                shas: vec![first, second]
            }]
        );
        let question = block_question(12, &observed.block_reasons, MergeAbilities::default());
        assert!(question.question.contains("signed commits"));
        assert!(question.question.contains("abc1234") && question.question.contains("def5678"));
        let text = format!(
            "{} {} {}",
            serde_json::to_string(&observed.block_reasons).unwrap(),
            question.question,
            serde_json::to_string(&question.options).unwrap()
        );
        assert!(!text.contains("Mintlify"), "{text}");
        assert_eq!(
            serde_json::to_value(&observed).unwrap()["blockReasons"][0]["kind"],
            "unsigned_commits"
        );
        assert_eq!(
            requests.lock().unwrap().len(),
            4,
            "{:?}",
            requests.lock().unwrap()
        );
        server.abort();
    }

    #[tokio::test]
    async fn an_unprotected_branch_has_no_classic_rules_and_needs_no_commit_read() {
        use crate::integrations::github_delivery::tests::counted_fake_api;
        let (github, server, requests) = counted_fake_api(
            vec![
                (PROTECTION_PATH, 404, json!({"message": "Branch not protected", "documentation_url": "https://docs.github.com/rest", "status": "404"})),
                (RULES_PATH, 200, json!([])),
            ],
            vec![("reviewRequests", observation("BLOCKED", motivating_checks()))],
        )
        .await;
        let observed = github
            .observe_pull_request("owner/repo", "task", Some(12))
            .await
            .unwrap();
        assert_eq!(kinds(&observed.block_reasons), ["unknown"]);
        assert!(
            !requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.contains("/commits"))
        );
        server.abort();
    }

    #[tokio::test]
    async fn unreadable_protection_and_failed_reads_degrade_without_failing_the_observation() {
        use crate::integrations::github_delivery::tests::counted_fake_api;
        for (status, body, rules_status) in [
            (
                403,
                json!({"message": "Must have admin rights to Repository."}),
                200,
            ),
            (404, json!({"message": "Not Found"}), 200),
            (500, json!({"message": "Server Error"}), 500),
        ] {
            let (github, server, _) = counted_fake_api(
                vec![
                    (PROTECTION_PATH, status, body),
                    (RULES_PATH, rules_status, json!([])),
                ],
                vec![(
                    "reviewRequests",
                    observation("BLOCKED", motivating_checks()),
                )],
            )
            .await;
            let observed = github
                .observe_pull_request("owner/repo", "task", Some(12))
                .await
                .unwrap();
            assert!(observed.exists);
            assert_eq!(
                kinds(&observed.block_reasons),
                ["rules_unreadable"],
                "{status}"
            );
            assert!(merge_block_text(&observed).contains("could not read branch rules"));
            server.abort();
        }
    }

    fn merge_block_text(observed: &Observation) -> String {
        describe_all(&observed.block_reasons)
    }

    #[tokio::test]
    async fn only_a_blocked_pull_request_with_settled_passing_checks_is_diagnosed() {
        use crate::integrations::github_delivery::tests::counted_fake_api;
        let pending = json!([check("unit", "SUCCESS"), {"__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS"}]);
        let failing = json!([check("unit", "FAILURE")]);
        for (state, checks) in [
            ("CLEAN", motivating_checks()),
            ("BEHIND", motivating_checks()),
            ("BLOCKED", pending),
            ("BLOCKED", failing),
        ] {
            let (github, server, requests) = counted_fake_api(
                vec![
                    (
                        PROTECTION_PATH,
                        200,
                        json!({"required_signatures": {"enabled": true}}),
                    ),
                    (RULES_PATH, 200, json!([])),
                ],
                vec![("reviewRequests", observation(state, checks))],
            )
            .await;
            let observed = github
                .observe_pull_request("owner/repo", "task", Some(12))
                .await
                .unwrap();
            assert!(observed.block_reasons.is_empty());
            assert_eq!(
                requests.lock().unwrap().len(),
                1,
                "{state}: only the observation"
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn conversations_and_deployments_are_read_only_when_a_rule_requires_them() {
        use crate::integrations::github_delivery::tests::counted_fake_api;
        let (github, server, requests) = counted_fake_api(
            vec![
                (PROTECTION_PATH, 200, json!({"required_conversation_resolution": {"enabled": true}})),
                (RULES_PATH, 200, json!([{"type": "required_deployments", "parameters": {"required_deployment_environments": ["production"]}}])),
                ("/repos/owner/repo/deployments?sha=aaaa000000000000000000000000000000000000&environment=production&per_page=1", 200, json!([{"id": 5}])),
                ("/repos/owner/repo/deployments/5/statuses?per_page=1", 200, json!([{"state": "failure"}])),
            ],
            vec![
                ("reviewThreads", json!({"data": {"repository": {"pullRequest": {"reviewThreads": {
                    "nodes": [{"isResolved": true}, {"isResolved": false}, {"isResolved": false}],
                    "pageInfo": {"hasNextPage": false, "endCursor": null}}}}}})),
                ("reviewRequests", observation("BLOCKED", motivating_checks())),
            ],
        )
        .await;
        let observed = github
            .observe_pull_request("owner/repo", "task", Some(12))
            .await
            .unwrap();
        assert_eq!(
            observed.block_reasons,
            [
                MergeBlockReason::UnresolvedConversations {
                    branch: MAIN.into(),
                    count: 2
                },
                MergeBlockReason::DeploymentRequired {
                    branch: MAIN.into(),
                    environment: "production".into()
                },
            ]
        );
        assert!(
            !requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.contains("/commits"))
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_refused_merge_names_the_rule_instead_of_the_merge_state() {
        use crate::integrations::github_delivery::tests::counted_fake_api;
        let head = sha("aaaa");
        let (github, server, _) = counted_fake_api(
            vec![
                ("/repos/owner/repo", 200, json!({"allow_squash_merge": true, "allow_merge_commit": false, "allow_rebase_merge": false})),
                ("/repos/owner/repo/pulls/12/merge", 405, json!({"message": "Base branch was modified. Review and try the merge again."})),
                (PROTECTION_PATH, 200, json!({"required_signatures": {"enabled": true}})),
                (RULES_PATH, 200, json!([])),
                (COMMITS_PATH, 200, json!([{"sha": sha("abc1234"), "commit": {"verification": {"verified": false, "reason": "unsigned"}}}])),
            ],
            vec![
                ("reviewRequests", observation("BLOCKED", motivating_checks())),
                ("isRequired", json!({"data": {"repository": {"pullRequest": {"commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": []}}}}]}}}}})),
                ("mergeStateStatus", json!({"data": {"repository": {"pullRequest": {"id": "PR_12", "headRefOid": head, "baseRefName": MAIN, "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED"}}}})),
            ],
        )
        .await;
        let MergeResult::Disposition {
            disposition,
            message,
            reasons,
        } = github
            .merge_conditionally("owner/repo", 12, &head, false)
            .await
            .unwrap()
        else {
            panic!("the merge is refused");
        };
        assert_eq!(disposition, MergeDisposition::Blocked);
        assert_eq!(kinds(&reasons), ["unsigned_commits"]);
        assert!(
            message.contains(
                "Branch `main` requires signed commits and 1 commit is unsigned (abc1234)."
            ),
            "{message}"
        );
        assert!(!message.contains("Merge state is"));
        server.abort();
    }
}
