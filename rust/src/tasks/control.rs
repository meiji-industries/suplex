//! TypeScript `tasks/control-contracts.ts`: the persisted task control vocabulary.

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
}
