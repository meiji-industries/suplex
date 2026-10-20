use super::*;
use crate::coordination::root_session_store::{
    self, IDLE_ROOT_PROMPT, mark_prompted, pending_turns, reserve_root, wake_idle_root,
};
use crate::identity::auth;
use crate::platform::database::OpenMode;
use crate::tasks::repository::{self, PreparedTask, TaskCreator};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .with_timezone(&Utc)
}

/// An active Standard task with a reserved Root session and no turns.
fn active_task() -> (PathBuf, SuplexDatabase, String, String) {
    let base = std::env::temp_dir().join(format!("suplex-dispatch-notice-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let path = base.join("suplex.sqlite");
    let now = at("2026-10-20T12:00:00Z");
    let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
    let user = auth::development_sign_in(&mut database, now).unwrap().user;
    database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('notice_company','Notice','active',?1)", [rfc3339_millis(now)]).unwrap();
    database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('notice_project','notice_company','Notice','/tmp/notice-repo','/tmp/notice-worktrees',NULL,'main','','','root','worker',?1,?1)", [rfc3339_millis(now)]).unwrap();
    let prepared = PreparedTask {
        id: repository::new_task_id(),
        company_id: "notice_company".into(),
        project_id: "notice_project".into(),
        title: "Notice".into(),
        description: String::new(),
        configuration: serde_json::json!({"repository":"owner/repo","branch":"task-notice","baseBranch":"main","baselineSha":"head"}),
        idempotency_key: "notice-key".into(),
        request_hash: "notice-hash".into(),
        creator: TaskCreator::User(user.id),
        delivery_target: "local_worktree".into(),
        delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-notice","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
        root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
        worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
        advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
        issue: None,
        start_queued: true,
        copied_from_task_id: None,
        depends_on: vec![],
        pull_request_dependencies: vec![],
        workflow: crate::coordination::workflows::Workflow::Standard,
    };
    let task_id = repository::create(&mut database, &prepared, now)
        .unwrap()
        .task
        .id;
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
            [&task_id],
        )
        .unwrap();
    let root = reserve_root(&mut database, &task_id, now).unwrap();
    (base, database, task_id, root.id)
}

fn stored(database: &SuplexDatabase, task_id: &str) -> Option<String> {
    database
        .connection()
        .query_row(
            "SELECT dispatch_notice_json FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn a_failed_attempt_is_recorded_once_and_an_unchanged_notice_writes_nothing() {
    let (base, database, task_id, _) = active_task();
    let first = DispatchNotice::not_admitted(
        DispatchAgent::Coordinator,
        HarnessKind::Opencode,
        "native_status_unavailable",
        at("2026-10-20T12:00:00Z"),
    );
    assert_eq!(
        first.text,
        "Suplex could not start the Coordinator. OpenCode is not connected. Suplex tries again."
    );
    assert!(record(&database, &task_id, &first).unwrap());
    assert_eq!(read(&database, &task_id).unwrap(), Some(first.clone()));

    // The same failure 15 seconds later keeps the stored row and its time.
    let total_changes = || database.connection().total_changes();
    let before = total_changes();
    let again = DispatchNotice {
        observed_at: "2026-10-20T12:00:15.000Z".into(),
        ..first.clone()
    };
    assert!(!record(&database, &task_id, &again).unwrap());
    assert_eq!(total_changes(), before);
    assert_eq!(
        read(&database, &task_id).unwrap().unwrap().observed_at,
        "2026-10-20T12:00:00.000Z"
    );

    // A different reason replaces the notice.
    let worker = DispatchNotice::not_admitted(
        DispatchAgent::Worker,
        HarnessKind::ClaudeCode,
        "dispatch_process_stopped",
        at("2026-10-20T12:00:30Z"),
    );
    assert!(record(&database, &task_id, &worker).unwrap());
    assert_eq!(read(&database, &task_id).unwrap(), Some(worker));

    // Only the sweep kind is cleared by a successful sweep.
    assert!(!clear(&database, &task_id, Some(DispatchNoticeKind::Sweep)).unwrap());
    assert!(read(&database, &task_id).unwrap().is_some());
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn a_status_change_clears_the_notice_and_an_inactive_task_records_none() {
    let (base, mut database, task_id, _) = active_task();
    let notice = DispatchNotice::sweep_failed("worktree is missing.", at("2026-10-20T12:00:00Z"));
    assert_eq!(
        notice.text,
        "Suplex could not prepare the next Coordinator turn: worktree is missing. Suplex tries again."
    );
    assert!(record(&database, &task_id, &notice).unwrap());
    assert!(
        root_session_store::ask_human(
            &mut database,
            &task_id,
            "Answer the question.",
            &serde_json::json!([]),
            at("2026-10-20T12:00:05Z"),
        )
        .unwrap()
    );
    assert_eq!(stored(&database, &task_id), None);
    assert!(!record(&database, &task_id, &notice).unwrap());
    assert_eq!(stored(&database, &task_id), None);
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn idle_wake_backoff_reports_the_next_wake_and_admission_clears_it() {
    let (base, mut database, task_id, root_id) = active_task();
    database
        .connection()
        .execute(
            "UPDATE suplex_task_sessions SET lifecycle = 'live', native_session_id = 'native-root' WHERE id = ?1",
            [&root_id],
        )
        .unwrap();
    database.connection().execute(
        "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,completed_at,updated_at) VALUES ('msg_idle_1',?1,?2,1,'h',?3,'completed',?4,?4,?4)",
        rusqlite::params![task_id, root_id, IDLE_ROOT_PROMPT, "2026-10-20T12:00:00.000Z"],
    ).unwrap();

    // One idle turn: the next wake waits 30 seconds from its completion.
    assert!(
        wake_idle_root(
            &mut database,
            &task_id,
            IDLE_ROOT_PROMPT,
            at("2026-10-20T12:00:10Z")
        )
        .unwrap()
        .is_none()
    );
    let notice = read(&database, &task_id).unwrap().unwrap();
    assert_eq!(notice.kind, DispatchNoticeKind::IdleWait);
    assert_eq!(notice.agent, DispatchAgent::Coordinator);
    assert_eq!(
        notice.text,
        "The Coordinator is idle. Suplex waits 30 seconds between idle Coordinator wakes."
    );
    assert_eq!(
        notice.next_wake_at.as_deref(),
        Some("2026-10-20T12:00:30.000Z")
    );
    assert_eq!(notice.observed_at, "2026-10-20T12:00:10.000Z");

    // A later sweep in the same wait keeps the notice as it is.
    assert!(
        wake_idle_root(
            &mut database,
            &task_id,
            IDLE_ROOT_PROMPT,
            at("2026-10-20T12:00:25Z")
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(read(&database, &task_id).unwrap(), Some(notice));

    // After the wait the wake is queued and the wait notice is gone.
    let wake = wake_idle_root(
        &mut database,
        &task_id,
        IDLE_ROOT_PROMPT,
        at("2026-10-20T12:00:31Z"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(stored(&database, &task_id), None);

    // A failed dispatch of that wake stays until its admission clears it.
    let failed = DispatchNotice::not_admitted(
        DispatchAgent::Coordinator,
        HarnessKind::Opencode,
        "final_response_not_observed",
        at("2026-10-20T12:00:31Z"),
    );
    assert!(record(&database, &task_id, &failed).unwrap());
    assert!(
        wake_idle_root(
            &mut database,
            &task_id,
            IDLE_ROOT_PROMPT,
            at("2026-10-20T12:00:32Z"),
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(read(&database, &task_id).unwrap(), Some(failed));
    assert!(mark_prompted(&mut database, &wake, None, at("2026-10-20T12:00:33Z")).unwrap());
    assert_eq!(stored(&database, &task_id), None);
    std::fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn a_claim_another_live_process_holds_is_shown_and_dispatch_still_retries() {
    let (base, mut database, task_id, root_id) = active_task();
    crate::coordination::root_controller::prepare_root(&mut database, &task_id).unwrap();
    database
        .connection()
        .execute(
            "UPDATE suplex_task_sessions SET launch_owner = 'other-host', launch_owner_pid = ?1, launch_owner_start_time = NULL WHERE id = ?2",
            rusqlite::params![i64::from(std::process::id()), root_id],
        )
        .unwrap();
    let path = base.join("suplex.sqlite");
    let recovered = crate::coordination::session_recovery::recover_prepared_root(
        &path,
        &base,
        &task_id,
        None,
        &HashMap::new(),
    )
    .await
    .unwrap();
    assert!(recovered.is_none());
    let notice = read(&database, &task_id).unwrap().unwrap();
    assert_eq!(notice.kind, DispatchNoticeKind::Dispatch);
    assert_eq!(
        notice.text,
        "Another Suplex process holds the Coordinator session. Suplex tries again."
    );
    // The notice changes nothing that dispatch reads.
    let control = root_session_store::task_control(&database, &task_id)
        .unwrap()
        .unwrap();
    assert_eq!(control.status, crate::tasks::control::TaskStatus::Active);
    assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 1);
    std::fs::remove_dir_all(base).unwrap();
}
