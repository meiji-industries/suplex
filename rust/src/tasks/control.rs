//! TypeScript `tasks/control-contracts.ts`: the persisted task control vocabulary.

use serde::{Deserialize, Deserializer, Serialize};

use crate::shared::wire_enum;

wire_enum! {
    /// TypeScript `TaskControlStatus`, which is also the public task status.
    pub enum TaskStatus {
        Backlog = "backlog",
        Queued = "queued",
        Active = "active",
        WaitingHuman = "waiting_human",
        Cancelled = "cancelled",
        Delivered = "delivered",
    }
}

impl TaskStatus {
    /// Archive keeps a task that is not running and not waiting on a person.
    pub fn archivable(self) -> bool {
        matches!(
            self,
            Self::Backlog | Self::Queued | Self::Cancelled | Self::Delivered
        )
    }
}

wire_enum! {
    pub enum TurnStatus {
        PendingPrompt = "pending_prompt",
        Prompted = "prompted",
        Unknown = "unknown",
        Completed = "completed",
        Cancelled = "cancelled",
    }
}

wire_enum! {
    pub enum SessionKind {
        Root = "root",
        Worker = "worker",
    }
}

wire_enum! {
    pub enum SessionLifecycle {
        Reserved = "reserved",
        Live = "live",
        Stopped = "stopped",
        Unknown = "unknown",
        Cancelled = "cancelled",
    }
}

wire_enum! {
    /// Declared from the least to the most delivery, so `Ord` ranks targets.
    pub enum DeliveryTarget {
        LocalWorktree = "local_worktree",
        RemoteBranch = "remote_branch",
        PullRequestDraft = "pull_request_draft",
        PullRequestReady = "pull_request_ready",
        Merged = "merged",
    }
}

impl DeliveryTarget {
    /// A target that delivers through a pull request.
    pub fn uses_pull_request(self) -> bool {
        self >= Self::PullRequestDraft
    }

    /// Bitbucket delivers up to a draft pull request.
    pub fn bitbucket_supports(self) -> bool {
        self <= Self::PullRequestDraft
    }
}

/// A present JSON field, `null` included; a missing one stays `None`.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// TypeScript `TaskProfile`: the agent profile a task or session captured.
/// The instance fields are optional in older snapshots, and a snapshot
/// serializes with exactly the fields it was saved with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProfile {
    pub profile_id: String,
    pub provider: String,
    pub model: String,
    pub reasoning_level: String,
    pub service_tier: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub provider_instance_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub instance_home_directory: Option<Option<String>>,
}

impl TaskProfile {
    pub fn provider_instance_id(&self) -> Option<&str> {
        self.provider_instance_id.as_ref()?.as_deref()
    }

    pub fn instance_home_directory(&self) -> Option<&str> {
        self.instance_home_directory.as_ref()?.as_deref()
    }
}

/// TypeScript `DeliveryIntent`: where the task delivers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryIntent {
    pub repository: String,
    pub head_branch: String,
    pub base_branch: String,
    pub baseline_sha: String,
    pub pull_request_number: Option<u64>,
}

/// TypeScript `WorktreeReference`: the worktree Git last reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReference {
    pub path: String,
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub dirty: bool,
}

/// TypeScript `PullRequestReference`: the pull request GitHub last reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReference {
    pub repository: String,
    pub number: u64,
    pub url: String,
    pub head_sha: String,
    pub state: String,
    pub merged_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_round_trip_through_serde_and_sqlite() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        for target in [
            DeliveryTarget::LocalWorktree,
            DeliveryTarget::RemoteBranch,
            DeliveryTarget::PullRequestDraft,
            DeliveryTarget::PullRequestReady,
            DeliveryTarget::Merged,
        ] {
            assert_eq!(serde_json::to_value(target).unwrap(), target.as_str());
            let stored: DeliveryTarget = connection
                .query_row("SELECT ?1", [target], |row| row.get(0))
                .unwrap();
            assert_eq!(stored, target);
        }
        assert!(DeliveryTarget::PullRequestDraft < DeliveryTarget::Merged);
        assert!(!DeliveryTarget::Merged.bitbucket_supports());
        assert_eq!(
            TaskStatus::parse("waiting_human"),
            Some(TaskStatus::WaitingHuman)
        );
        assert!(
            connection
                .query_row("SELECT 'paused'", [], |row| row.get::<_, TaskStatus>(0))
                .is_err()
        );
    }

    #[test]
    fn a_profile_snapshot_serializes_with_the_fields_it_was_saved_with() {
        for saved in [
            r#"{"profileId":"p","provider":"codex","model":"m","reasoningLevel":"medium","serviceTier":"default"}"#,
            r#"{"profileId":"p","provider":"codex","model":"m","reasoningLevel":"medium","serviceTier":"default","providerInstanceId":null,"instanceHomeDirectory":"/home"}"#,
        ] {
            let profile: TaskProfile = serde_json::from_str(saved).unwrap();
            assert_eq!(serde_json::to_string(&profile).unwrap(), saved);
        }
        assert!(serde_json::from_str::<TaskProfile>(r#"{"profileId":"p"}"#).is_err());
    }
}
