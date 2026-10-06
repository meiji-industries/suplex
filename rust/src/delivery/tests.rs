//! Standard delivery against real Git repositories and a loopback GitHub API.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    extract::{Path as UrlPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use git2::{Repository, Signature};
use serde_json::{Value, json};

use super::{
    DeliveryOperation,
    inspection::ReviewRange,
    operations::{DeliveryOperations, DeliveryRequest},
};
use crate::{
    coordination::{root_bridge::RootIdentity, root_session_store},
    identity::auth,
    integrations::{
        github::Access,
        github_delivery::{Github, MergeResult},
    },
    platform::database::{OpenMode, SuplexDatabase},
    tasks::repository::{self, PreparedTask, TaskCreator},
};

#[derive(Default)]
struct Fake {
    origin: PathBuf,
    pulls: Vec<Value>,
    merge_refusal: bool,
    observation_gate: Option<Arc<tokio::sync::Barrier>>,
}

type Shared = Arc<Mutex<Fake>>;

fn rest_pull(pull: &Value) -> Value {
    let side = |branch: &Value, sha: &Value| json!({"ref": branch, "sha": sha, "repo": {"full_name": "owner/repo"}});
    json!({
        "number": pull["number"], "html_url": format!("https://github.com/owner/repo/pull/{}", pull["number"]),
        "node_id": format!("PR_{}", pull["number"]), "state": if pull["state"] == "open" { "open" } else { "closed" },
        "draft": pull["draft"], "merged_at": pull["mergedAt"], "auto_merge": null,
        "head": side(&pull["head"], &pull["headSha"]), "base": side(&pull["base"], &pull["baseSha"]),
        "title": pull["title"], "body": pull["body"], "user": {"login": "suplex"}, "updated_at": "2026-09-25T00:00:00Z",
    })
}

fn gh_state(pull: &Value) -> &'static str {
    if !pull["mergedAt"].is_null() {
        "MERGED"
    } else if pull["state"] == "open" {
        "OPEN"
    } else {
        "CLOSED"
    }
}

fn branch_sha(origin: &Path, branch: &str) -> Option<String> {
    let repository = Repository::open_bare(origin).ok()?;
    let reference = repository
        .find_reference(&format!("refs/heads/{branch}"))
        .ok()?;
    Some(reference.peel_to_commit().ok()?.id().to_string())
}

async fn branch(State(fake): State<Shared>, UrlPath(branch): UrlPath<String>) -> Response {
    let origin = fake.lock().unwrap().origin.clone();
    match branch_sha(&origin, &branch) {
        Some(sha) => Json(json!({"commit": {"sha": sha}})).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"message": "Branch not found"})),
        )
            .into_response(),
    }
}

async fn create_pull(State(fake): State<Shared>, Json(body): Json<Value>) -> Response {
    let mut fake = fake.lock().unwrap();
    let head = body["head"].as_str().unwrap_or("");
    let Some(head_sha) = branch_sha(&fake.origin, head) else {
        return (StatusCode::NOT_FOUND, Json(json!({"message": "Not Found"}))).into_response();
    };
    let base_sha = branch_sha(&fake.origin, body["base"].as_str().unwrap_or("")).unwrap();
    let pull = json!({"number": fake.pulls.len() + 1, "state": "open", "draft": body["draft"], "mergedAt": null,
        "head": head, "headSha": head_sha, "base": body["base"], "baseSha": base_sha, "title": body["title"], "body": body["body"]});
    fake.pulls.push(pull.clone());
    (StatusCode::CREATED, Json(rest_pull(&pull))).into_response()
}

async fn get_pull(State(fake): State<Shared>, UrlPath(number): UrlPath<usize>) -> Response {
    let fake = fake.lock().unwrap();
    match fake.pulls.get(number.wrapping_sub(1)) {
        Some(pull) => Json(rest_pull(pull)).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"message": "Not Found"}))).into_response(),
    }
}

async fn patch_pull(
    State(fake): State<Shared>,
    UrlPath(number): UrlPath<usize>,
    Json(body): Json<Value>,
) -> Response {
    let mut fake = fake.lock().unwrap();
    let pull = &mut fake.pulls[number - 1];
    pull["title"] = body["title"].clone();
    pull["body"] = body["body"].clone();
    Json(rest_pull(pull)).into_response()
}

async fn merge_pull(
    State(fake): State<Shared>,
    UrlPath(number): UrlPath<usize>,
    Json(body): Json<Value>,
) -> Response {
    let mut fake = fake.lock().unwrap();
    if fake.merge_refusal {
        return (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"message": "Pull Request is not mergeable", "documentation_url": "https://docs.github.com/rest", "status": "405"}))).into_response();
    }
    let pull = &mut fake.pulls[number - 1];
    assert_eq!(
        body["sha"], pull["headSha"],
        "the merge is conditional on the reviewed head"
    );
    pull["state"] = json!("closed");
    pull["mergedAt"] = json!("2026-09-25T01:00:00Z");
    Json(json!({"merged": true, "message": "Merged", "sha": "c".repeat(40)})).into_response()
}

async fn graphql(State(fake): State<Shared>, Json(body): Json<Value>) -> Response {
    let query = body["query"].as_str().unwrap_or("");
    if query.contains("p0: repository") {
        let gate = fake.lock().unwrap().observation_gate.clone();
        if let Some(gate) = gate {
            gate.wait().await;
            gate.wait().await;
        }
    }
    let mut fake = fake.lock().unwrap();
    let variables = &body["variables"];
    let number = variables["number"].as_u64().unwrap_or(0) as usize;
    let data = if query.contains("markPullRequestReadyForReview") {
        let id = variables["id"].as_str().unwrap_or("");
        let pull = fake
            .pulls
            .iter_mut()
            .find(|pull| format!("PR_{}", pull["number"]) == id)
            .unwrap();
        pull["draft"] = json!(false);
        json!({"markPullRequestReadyForReview": {"pullRequest": {"isDraft": false}}})
    } else if query.contains("p0: repository") {
        let mut aliases = serde_json::Map::new();
        for (index, pull) in fake.pulls.iter().enumerate() {
            aliases.insert(
                format!("p{index}"),
                json!({"pullRequest": {
                    "number": pull["number"],
                    "url": format!("https://github.com/owner/repo/pull/{}", pull["number"]),
                    "headRefOid": pull["headSha"],
                    "state": gh_state(pull),
                    "mergedAt": pull["mergedAt"],
                }}),
            );
        }
        Value::Object(aliases)
    } else if query.contains("pullRequests(") {
        let head = variables["head"].as_str();
        let nodes = fake.pulls.iter().filter(|pull| head.is_none_or(|head| pull["head"] == head)).map(|pull| json!({
            "number": pull["number"], "url": format!("https://github.com/owner/repo/pull/{}", pull["number"]),
            "isDraft": pull["draft"], "state": gh_state(pull), "headRefName": pull["head"], "headRefOid": pull["headSha"],
            "baseRefName": pull["base"], "baseRefOid": pull["baseSha"], "title": pull["title"], "body": pull["body"],
            "author": {"login": "suplex"}, "updatedAt": "2026-09-25T00:00:00Z", "isCrossRepository": false,
        })).collect::<Vec<_>>();
        json!({"repository": {"pullRequests": {"nodes": nodes}}})
    } else if query.contains("isRequired") {
        json!({"repository": {"pullRequest": {"commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": []}}}}]}}}})
    } else {
        let Some(pull) = fake.pulls.get(number.wrapping_sub(1)) else {
            return Json(json!({"data": {"repository": {"pullRequest": null}}})).into_response();
        };
        let run = json!({"__typename": "CheckRun", "name": "unit", "status": "COMPLETED", "conclusion": pull.get("checkConclusion").cloned().unwrap_or(json!("SUCCESS")), "detailsUrl": "https://github.com/owner/repo/actions/runs/1", "startedAt": "2026-09-25T00:00:00Z", "completedAt": "2026-09-25T00:01:00Z", "workflowName": "CI"});
        let rollup = json!({"statusCheckRollup": {"contexts": {"nodes": [run]}}});
        let pull = json!({
            "id": format!("PR_{number}"), "number": number, "url": format!("https://github.com/owner/repo/pull/{number}"),
            "state": gh_state(pull), "isDraft": pull["draft"], "headRefOid": pull["headSha"], "baseRefOid": pull["baseSha"],
            "baseRefName": pull["base"], "mergeable": pull.get("mergeable").cloned().unwrap_or(json!("MERGEABLE")), "mergeStateStatus": pull.get("mergeStateStatus").cloned().unwrap_or(json!("CLEAN")), "autoMergeRequest": null,
            "reviewDecision": pull.get("reviewDecision").cloned().unwrap_or(json!("APPROVED")), "author": {"login": "suplex", "avatarUrl": "https://avatars.githubusercontent.com/suplex"},
            "changedFiles": 1, "additions": 1, "deletions": 0, "title": pull["title"],
            "commits": {"nodes": [{"commit": rollup}]},
        });
        json!({"repository": {"pullRequest": pull}})
    };
    Json(json!({"data": data})).into_response()
}

async fn fake_github(origin: PathBuf) -> (String, Shared) {
    let fake: Shared = Arc::new(Mutex::new(Fake {
        origin,
        ..Fake::default()
    }));
    let app = Router::new()
        .route("/repos/owner/repo", get(|| async { Json(json!({"allow_squash_merge": true, "allow_merge_commit": true, "allow_rebase_merge": true})) }))
        .route("/repos/owner/repo/branches/{*branch}", get(branch))
        .route("/repos/owner/repo/rules/branches/{*branch}", get(|| async { Json(json!([])) }))
        .route("/repos/owner/repo/pulls", post(create_pull))
        .route("/repos/owner/repo/pulls/{number}", get(get_pull).patch(patch_pull))
        .route("/repos/owner/repo/pulls/{number}/merge", put(merge_pull))
        .route("/graphql", post(graphql))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, fake)
}

fn commit(
    repository: &Repository,
    reference: &str,
    file: &str,
    content: &str,
    parents: &[&git2::Commit<'_>],
) -> git2::Oid {
    let signature = Signature::now("Fixture", "fixture@example.invalid").unwrap();
    std::fs::write(repository.workdir().unwrap().join(file), content).unwrap();
    let mut index = repository.index().unwrap();
    index.add_path(Path::new(file)).unwrap();
    index.write().unwrap();
    let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
    repository
        .commit(
            Some(reference),
            &signature,
            &signature,
            &format!("Change {file}"),
            &tree,
            parents,
        )
        .unwrap()
}

struct Fixture {
    base: PathBuf,
    database_path: PathBuf,
    task_id: String,
    root: RootIdentity,
    origin: PathBuf,
}

/// An active Standard task whose worktree has one reviewed commit on its branch.
fn fixture(target: &str) -> Fixture {
    let base = std::env::temp_dir().join(format!("suplex-delivery-{}", uuid::Uuid::new_v4()));
    let origin = base.join("origin.git");
    let work = base.join("work");
    std::fs::create_dir_all(&work).unwrap();
    Repository::init_bare(&origin).unwrap();
    let repository = Repository::init(&work).unwrap();
    repository.set_head("refs/heads/main").unwrap();
    let seed = commit(&repository, "HEAD", "README.md", "# Seed\n", &[]);
    let url = format!("file://{}", origin.display());
    let mut config = repository.config().unwrap();
    config
        .set_str(
            &format!("url.{url}.insteadOf"),
            "https://github.com/owner/repo.git",
        )
        .unwrap();
    repository
        .remote("origin", "https://github.com/owner/repo.git")
        .unwrap();
    repository
        .find_remote("origin")
        .unwrap()
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();
    let branch = format!("task-{target}");
    let seed_commit = repository.find_commit(seed).unwrap();
    repository.branch(&branch, &seed_commit, false).unwrap();
    repository
        .set_head(&format!("refs/heads/{branch}"))
        .unwrap();
    repository
        .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    let head = commit(
        &repository,
        "HEAD",
        "README.md",
        "# Seed\nVerified.\n",
        &[&seed_commit],
    );
    let database_path = base.join("suplex.sqlite");
    let now = Utc::now();
    let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
    let user = auth::development_sign_in(&mut database, now).unwrap().user;
    let time = now.to_rfc3339();
    database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('delivery_company','Delivery','active',?1)", [&time]).unwrap();
    database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('delivery_project','delivery_company','Project','/tmp/repo','/tmp/worktrees',NULL,'main','','','root_profile','worker_profile','{}',?1,?1)", [&time]).unwrap();
    let profile = json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
    let prepared = PreparedTask {
        id: repository::new_task_id(),
        company_id: "delivery_company".into(),
        project_id: "delivery_project".into(),
        title: "Deliver".into(),
        description: "Deliver the change".into(),
        configuration: json!({"repository":"owner/repo","branch":branch,"baseBranch":"main","source":null}),
        idempotency_key: format!("delivery-{target}"),
        request_hash: "delivery-request".into(),
        creator: TaskCreator::User(user.id),
        delivery_target: target.into(),
        delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":branch,"baseBranch":"main","baselineSha":seed.to_string(),"pullRequestNumber":null})).unwrap(),
        root_profile: serde_json::from_value(profile.clone()).unwrap(),
        worker_profile: serde_json::from_value(profile).unwrap(),
        advisor_profiles: serde_json::from_value(json!({})).unwrap(),
        issue: None,
        start_queued: true,
        copied_from_task_id: None,
        depends_on: vec![],
        pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
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
    let worktree = serde_json::from_value(json!({"path": work, "branch": branch, "baseSha": seed.to_string(), "headSha": head.to_string(), "dirty": false})).unwrap();
    root_session_store::set_worktree(&mut database, &task_id, &worktree, now).unwrap();
    let root = root_session_store::reserve_root(&mut database, &task_id, now).unwrap();
    let turn = root_session_store::ensure_initial_prompt(&mut database, &root, "Deliver", now)
        .unwrap()
        .unwrap();
    root_session_store::complete_root_turn(&mut database, &turn.id, "done", None, now).unwrap();
    let root = RootIdentity {
        task_id: task_id.clone(),
        session_id: root.id,
        generation: root.generation,
    };
    Fixture {
        base,
        database_path,
        task_id,
        root,
        origin,
    }
}

fn control(fixture: &Fixture) -> crate::tasks::control::TaskControlRow {
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadOnly).unwrap();
    root_session_store::root_observation_rows(&database, &fixture.task_id)
        .unwrap()
        .control
}

async fn operations(fixture: &Fixture) -> (DeliveryOperations, Shared) {
    let (api, fake) = fake_github(fixture.origin.clone()).await;
    let mut github = Github::new(Access::for_api(&api, None).unwrap());
    github.retry_pauses = vec![];
    (
        DeliveryOperations::with_github(
            &fixture.database_path,
            &fixture.base.join("artifacts"),
            github,
        ),
        fake,
    )
}

#[tokio::test]
async fn delivered_task_recovery_leaves_pull_request_reads_to_the_batch_poller() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let fixture = fixture("pull_request_ready");
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    let pull = json!({"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","headSha":"a".repeat(40),"state":"open","mergedAt":null});
    database.connection().execute("UPDATE suplex_task_controls SET status='delivered', pull_request_json=?1 WHERE task_id=?2", rusqlite::params![pull.to_string(), fixture.task_id]).unwrap();
    drop(database);
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let app = Router::new().route("/graphql", post(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        async { Json(json!({"data":{"p0":{"pullRequest":{"number":7,"url":"https://github.com/owner/repo/pull/7","headRefOid":"a".repeat(40),"state":"MERGED","mergedAt":"2026-10-05T02:32:47Z"}}}})) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let github = Github::new(Access::for_api(&origin, None).unwrap());
    let operations = DeliveryOperations::with_github(
        &fixture.database_path,
        &fixture.base.join("artifacts"),
        Github::new(Access::for_api(&origin, None).unwrap()),
    );
    for _ in 0..3 {
        operations
            .observe_host_task(&fixture.task_id)
            .await
            .unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    super::completed_pull_requests::refresh(&fixture.database_path, Some(&github))
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let control = control(&fixture);
    assert_eq!(control.status, crate::tasks::control::TaskStatus::Delivered);
    assert_eq!(control.pull_request.unwrap().state.as_str(), "merged");
    operations
        .observe_host_task(&fixture.task_id)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
    std::fs::remove_dir_all(fixture.base).unwrap();
}

async fn reviewed(operations: &DeliveryOperations, root: &RootIdentity) -> (String, ReviewRange) {
    let diff = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::InspectDeliveryDiff,
                expected_head: None,
                review: None,
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(diff["files"], json!(["README.md"]));
    assert_eq!(diff["baseBranch"], "main");
    (
        diff["headSha"].as_str().unwrap().to_owned(),
        serde_json::from_value(diff).unwrap(),
    )
}

const BODY: &str = "## Summary\n- Add a line\n## Why\nRequested.\n## Validation\n- pnpm test\n## Review notes\nNone.";

#[tokio::test]
async fn standard_task_pushes_and_opens_a_draft_pull_request() {
    let fixture = fixture("pull_request_draft");
    let (operations, fake) = operations(&fixture).await;
    let root = &fixture.root;
    let (head, review) = reviewed(&operations, root).await;
    let unreviewed = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::PushBranch,
                expected_head: Some(&head),
                review: None,
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap_err();
    assert!(unreviewed.to_string().contains("inspect_delivery_diff"));
    let pushed = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::PushBranch,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(pushed, json!({"kind":"pushed","headSha":head}));
    // A second push adopts the published exact head without pushing again.
    let adopted = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::PushBranch,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(adopted["kind"], "adopted");
    let untitled = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::CreateOrAdoptPullRequest,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: Some(BODY),
            },
        )
        .await
        .unwrap_err();
    assert!(untitled.to_string().starts_with("Supply a concise title"));
    let created = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::CreateOrAdoptPullRequest,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: Some("  Add a verified line  "),
                pull_request_body: Some(BODY),
            },
        )
        .await
        .unwrap();
    assert_eq!(created["number"], 1);
    assert_eq!(created["headSha"], head.as_str());
    assert_eq!(
        fake.lock().unwrap().pulls[0]["title"],
        "Add a verified line"
    );
    assert_eq!(fake.lock().unwrap().pulls[0]["draft"], true);
    let control = control(&fixture);
    assert_eq!(control.status, crate::tasks::control::TaskStatus::Delivered);
    assert_eq!(serde_json::json!(control)["pullRequest"]["number"], 1);
    assert_eq!(
        serde_json::json!(control.workflow_state)["acceptedDelivery"]["headSha"],
        head.as_str()
    );
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn ready_and_merged_targets_complete_through_github_state() {
    let fixture = fixture("merged");
    let (operations, fake) = operations(&fixture).await;
    let root = &fixture.root;
    let (head, review) = reviewed(&operations, root).await;
    operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::PushBranch,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    let created = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::CreateOrAdoptPullRequest,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: Some("Add line"),
                pull_request_body: Some(BODY),
            },
        )
        .await
        .unwrap();
    assert_eq!(created["state"], "open");
    assert_eq!(
        control(&fixture).status,
        crate::tasks::control::TaskStatus::Active,
        "an open draft does not reach the merged target"
    );
    let checks = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::ObserveChecks,
                expected_head: None,
                review: None,
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(checks["checkSummary"], "1 successful, 0 pending, 0 failing");
    let ready = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::RequestReview,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(ready["isDraft"], false);
    assert_eq!(fake.lock().unwrap().pulls[0]["draft"], false);
    fake.lock().unwrap().merge_refusal = true;
    let waiting = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::MergePullRequest,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(waiting["kind"], "merge_requested");
    assert_eq!(
        serde_json::json!(control(&fixture).workflow_state)["deliveryWait"]["reason"],
        "merge_queue"
    );
    // GitHub merges while Suplex waits; the wait observation adopts it without a Suplex receipt.
    {
        let mut fake = fake.lock().unwrap();
        fake.pulls[0]["state"] = json!("closed");
        fake.pulls[0]["mergedAt"] = json!("2026-09-25T02:00:00Z");
    }
    assert_eq!(
        operations
            .observe_delivery_wait(&fixture.task_id)
            .await
            .unwrap(),
        "finished"
    );
    let control = control(&fixture);
    assert_eq!(control.status, crate::tasks::control::TaskStatus::Delivered);
    assert_eq!(serde_json::json!(control)["pullRequest"]["state"], "merged");
    assert!(serde_json::json!(control.workflow_state)["deliveryWait"].is_null());
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn direct_merge_completes_and_stale_local_pull_request_is_replaced() {
    let fixture = fixture("merged");
    let (operations, fake) = operations(&fixture).await;
    let root = &fixture.root;
    let (head, review) = reviewed(&operations, root).await;
    operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::PushBranch,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::CreateOrAdoptPullRequest,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: Some("Add line"),
                pull_request_body: Some(BODY),
            },
        )
        .await
        .unwrap();
    // A stale cached pull request never blocks: GitHub's current match replaces it.
    operations.set_pull_request(&fixture.task_id, Some(&json!({"repository":"owner/repo","number":1,"url":"https://github.com/owner/repo/pull/1","headSha":"f".repeat(40),"state":"closed","mergedAt":null})), true).unwrap();
    let observed = operations.observe(&fixture.task_id).await.unwrap();
    assert_eq!(observed["state"], "open");
    assert_eq!(observed["headSha"], head.as_str());
    let merged = operations
        .execute(
            root,
            None,
            &DeliveryRequest {
                operation: DeliveryOperation::MergePullRequest,
                expected_head: Some(&head),
                review: Some(&review),
                pull_request_title: None,
                pull_request_body: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(merged["state"], "merged");
    assert_eq!(merged["reviewedHead"], head.as_str());
    assert_eq!(
        control(&fixture).status,
        crate::tasks::control::TaskStatus::Delivered
    );
    assert_eq!(
        fake.lock().unwrap().pulls[0]["mergedAt"],
        "2026-09-25T01:00:00Z"
    );
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn refused_merge_reports_github_evidence_and_merge_input_is_checked() {
    let fixture = fixture("merged");
    let (api, fake) = fake_github(fixture.origin.clone()).await;
    let mut github = Github::new(Access::for_api(&api, None).unwrap());
    github.retry_pauses = vec![];
    fake.lock().unwrap().pulls.push(json!({"number":1,"state":"open","draft":false,"mergedAt":null,"head":"x","headSha":"a".repeat(40),"base":"main","baseSha":"b".repeat(40),"title":"t","body":""}));
    fake.lock().unwrap().merge_refusal = true;
    let refused = github
        .merge_conditionally("owner/repo", 1, &"a".repeat(40), false)
        .await
        .unwrap();
    assert!(
        matches!(refused, MergeResult::Disposition { disposition: "blocked", ref message } if message.contains("no pending required checks"))
    );
    let changed = github
        .merge_conditionally("owner/repo", 1, &"d".repeat(40), false)
        .await
        .unwrap();
    assert!(
        matches!(changed, MergeResult::Disposition { disposition: "blocked", ref message } if message.contains("head changed"))
    );
    assert_eq!(
        github
            .merge_conditionally("owner/repo", 1, "short", false)
            .await
            .unwrap_err()
            .code,
        "invalid-provider-response"
    );
    assert_eq!(
        github
            .get_branch_head("owner/repo", "absent")
            .await
            .unwrap(),
        None
    );
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn a_pull_request_at_its_target_waits_for_the_first_coordinator_turn() {
    let fixture = fixture("pull_request_ready");
    let (operations, fake) = operations(&fixture).await;
    let root = &fixture.root;
    let (head, review) = reviewed(&operations, root).await;
    for operation in [
        DeliveryOperation::PushBranch,
        DeliveryOperation::CreateOrAdoptPullRequest,
    ] {
        operations
            .execute(
                root,
                None,
                &DeliveryRequest {
                    operation,
                    expected_head: Some(&head),
                    review: Some(&review),
                    pull_request_title: Some("Add line"),
                    pull_request_body: Some(BODY),
                },
            )
            .await
            .unwrap();
    }
    // The pull request already meets the target when a new task opens on it.
    fake.lock().unwrap().pulls[0]["draft"] = json!(false);
    let set_turns = |status: &str| {
        SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite)
            .unwrap()
            .connection()
            .execute(
                "UPDATE suplex_task_turns SET status = ?1 WHERE task_id = ?2",
                [status, fixture.task_id.as_str()],
            )
            .unwrap();
    };
    set_turns("prompted");
    operations.observe(&fixture.task_id).await.unwrap();
    assert_eq!(
        control(&fixture).status,
        crate::tasks::control::TaskStatus::Active,
        "the Coordinator reads the description before the task completes"
    );
    set_turns("completed");
    operations.observe(&fixture.task_id).await.unwrap();
    assert_eq!(
        control(&fixture).status,
        crate::tasks::control::TaskStatus::Delivered
    );
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn observing_a_pull_request_another_task_names_records_the_observation() {
    let fixture = fixture("merged");
    let (operations, _fake) = operations(&fixture).await;
    let root = &fixture.root;
    let (head, review) = reviewed(&operations, root).await;
    for operation in [
        DeliveryOperation::PushBranch,
        DeliveryOperation::CreateOrAdoptPullRequest,
    ] {
        operations
            .execute(
                root,
                None,
                &DeliveryRequest {
                    operation,
                    expected_head: Some(&head),
                    review: Some(&review),
                    pull_request_title: Some("Add line"),
                    pull_request_body: Some(BODY),
                },
            )
            .await
            .unwrap();
    }
    // Another live task names the same pull request, and this task's cached
    // reference is gone after a restart. GitHub still reports the pull request
    // on this task's branch.
    let mut database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    let user = auth::development_sign_in(&mut database, Utc::now())
        .unwrap()
        .user;
    let profile = json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
    let other = repository::create(
        &mut database,
        &PreparedTask {
            id: repository::new_task_id(),
            company_id: "delivery_company".into(),
            project_id: "delivery_project".into(),
            title: "Other".into(),
            description: "Other".into(),
            configuration: json!({"repository":"owner/repo","branch":"task-other","baseBranch":"main","source":null}),
            idempotency_key: "delivery-other".into(),
            request_hash: "delivery-other".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "merged".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-other","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(profile.clone()).unwrap(),
            worker_profile: serde_json::from_value(profile).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        },
        Utc::now(),
    )
    .unwrap()
    .task
    .id;
    database.connection().execute(
        "UPDATE suplex_task_controls SET status = 'active', delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 1) WHERE task_id = ?1",
        [&other],
    ).unwrap();
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET pull_request_json = NULL WHERE task_id = ?1",
            [&fixture.task_id],
        )
        .unwrap();
    drop(database);
    let observed = operations.observe(&fixture.task_id).await.unwrap();
    assert_eq!(observed["number"], 1);
    assert_eq!(control(&fixture).pull_request.unwrap().number, 1);
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn delivered_pull_refresh_updates_only_current_facts_and_rediscovers_missing_receipts() {
    let fixture = fixture("merged");
    let (api, fake) = fake_github(fixture.origin.clone()).await;
    let head = Repository::open(fixture.base.join("work"))
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string();
    let base = branch_sha(&fixture.origin, "main").unwrap();
    let pull = json!({
        "number": 1, "state": "open", "draft": false, "mergedAt": null,
        "head": "task-merged", "headSha": head, "base": "main", "baseSha": base,
        "title": "Delivered", "body": "Reviewed",
    });
    fake.lock().unwrap().pulls.push(pull);
    let github = Github::new(Access::for_api(&api, None).unwrap());
    let observed_open = json!({
        "repository": "owner/repo", "number": 1,
        "url": "https://github.com/owner/repo/pull/1",
        "headSha": head, "state": "open", "mergedAt": null,
    });
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    database.connection().execute(
        "UPDATE suplex_task_controls SET status = 'delivered', pull_request_json = ?1, delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 1) WHERE task_id = ?2",
        rusqlite::params![crate::shared::js_json::stringify(&observed_open), fixture.task_id],
    ).unwrap();
    drop(database);
    fake.lock().unwrap().pulls[0]["state"] = json!("closed");
    super::completed_pull_requests::refresh(&fixture.database_path, Some(&github))
        .await
        .unwrap();
    let read_state = || {
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadOnly).unwrap();
        let raw: String = database
            .connection()
            .query_row(
                "SELECT pull_request_json FROM suplex_task_controls WHERE task_id = ?1",
                [&fixture.task_id],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["state"].clone()
    };
    assert_eq!(read_state(), "closed");
    fake.lock().unwrap().pulls[0]["state"] = json!("open");
    super::completed_pull_requests::refresh(&fixture.database_path, Some(&github))
        .await
        .unwrap();
    assert_eq!(read_state(), "open");
    fake.lock().unwrap().pulls[0]["state"] = json!("closed");
    fake.lock().unwrap().pulls[0]["mergedAt"] = json!("2026-09-25T01:00:00Z");
    super::completed_pull_requests::refresh(&fixture.database_path, Some(&github))
        .await
        .unwrap();
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    let (status, raw): (String, Option<String>) = database
        .connection()
        .query_row(
            "SELECT status,pull_request_json FROM suplex_task_controls WHERE task_id = ?1",
            [&fixture.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "delivered");
    let merged: Value = serde_json::from_str(raw.as_deref().unwrap()).unwrap();
    assert_eq!(merged["state"], "merged");
    assert_eq!(merged["headSha"], head);
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET pull_request_json = NULL WHERE task_id = ?1",
            [&fixture.task_id],
        )
        .unwrap();
    drop(database);
    super::completed_pull_requests::refresh(&fixture.database_path, Some(&github))
        .await
        .unwrap();
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    let rediscovered: String = database
        .connection()
        .query_row(
            "SELECT pull_request_json FROM suplex_task_controls WHERE task_id = ?1",
            [&fixture.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&rediscovered).unwrap(),
        merged
    );
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET pull_request_json = ?1 WHERE task_id = ?2",
            rusqlite::params![
                crate::shared::js_json::stringify(&observed_open),
                fixture.task_id
            ],
        )
        .unwrap();
    drop(database);
    fake.lock().unwrap().pulls.clear();
    super::completed_pull_requests::refresh(&fixture.database_path, Some(&github))
        .await
        .unwrap();
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadOnly).unwrap();
    let preserved: String = database
        .connection()
        .query_row(
            "SELECT pull_request_json FROM suplex_task_controls WHERE task_id = ?1",
            [&fixture.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&preserved).unwrap(),
        observed_open
    );
    drop(database);
    let gate = Arc::new(tokio::sync::Barrier::new(2));
    {
        let mut fake = fake.lock().unwrap();
        fake.pulls.push(json!({
            "number": 1, "state": "closed", "draft": false,
            "mergedAt": "2026-09-25T01:00:00Z", "head": "task-merged",
            "headSha": head, "base": "main", "baseSha": base,
            "title": "Delivered", "body": "Reviewed",
        }));
        fake.observation_gate = Some(gate.clone());
    }
    let race_path = fixture.database_path.clone();
    let race_github = Github::new(Access::for_api(&api, None).unwrap());
    let pending = tokio::task::spawn_blocking(move || {
        crate::shared::blocking::block_on(|| async move {
            super::completed_pull_requests::refresh(&race_path, Some(&race_github))
                .await
                .map_err(|error| error.to_string())
        })
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), gate.wait())
        .await
        .unwrap();
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
            [&fixture.task_id],
        )
        .unwrap();
    drop(database);
    tokio::time::timeout(std::time::Duration::from_secs(10), gate.wait())
        .await
        .unwrap();
    pending.await.unwrap().unwrap();
    fake.lock().unwrap().observation_gate = None;
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadOnly).unwrap();
    let (status, raw): (String, String) = database
        .connection()
        .query_row(
            "SELECT status,pull_request_json FROM suplex_task_controls WHERE task_id = ?1",
            [&fixture.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "active");
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), observed_open);
    drop(database);
    std::fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test]
async fn paired_agent_delivery_keeps_authority_dependencies_receipts_and_provenance() {
    use super::agent_delivery::{AgentDelivery, AgentPrincipal};
    let fixture = fixture("merged");
    let (operations, fake) = operations(&fixture).await;
    let (head, review) = reviewed(&operations, &fixture.root).await;
    for operation in [
        DeliveryOperation::PushBranch,
        DeliveryOperation::CreateOrAdoptPullRequest,
        DeliveryOperation::RequestReview,
    ] {
        operations
            .execute(
                &fixture.root,
                None,
                &DeliveryRequest {
                    operation,
                    expected_head: Some(&head),
                    review: Some(&review),
                    pull_request_title: Some("Agent delivery"),
                    pull_request_body: Some(BODY),
                },
            )
            .await
            .unwrap();
    }
    let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
    database.connection().execute_batch("INSERT INTO suplex_agents (id,kind,name,avatar_seed,created_at,updated_at) VALUES ('train-agent','external','Train','seed','now','now'); INSERT INTO suplex_external_agents (id,company_id,status,created_at,updated_at) VALUES ('train-agent','delivery_company','paired','now','now');").unwrap();
    database.connection().execute("UPDATE suplex_tasks SET creator_user_id=NULL,creator_agent_id='train-agent' WHERE id=?1", [&fixture.task_id]).unwrap();
    database.connection().execute("UPDATE suplex_task_controls SET workflow_state_json=json_set(workflow_state_json,'$.acceptedDelivery',json(?1)) WHERE task_id=?2", rusqlite::params![serde_json::to_string(&review).unwrap(),fixture.task_id]).unwrap();
    let delivery = AgentDelivery::with_operations(operations);
    let principal = AgentPrincipal {
        agent_id: "train-agent".into(),
        company_id: "delivery_company".into(),
    };
    let foreign = AgentPrincipal {
        agent_id: "another-agent".into(),
        company_id: principal.company_id.clone(),
    };
    assert!(delivery.refresh(&foreign, &fixture.task_id).await.is_err());
    assert!(
        delivery
            .request_reconciliation(&foreign, &fixture.task_id)
            .await
            .is_err()
    );
    assert!(
        delivery
            .issue_approval(&foreign, &fixture.task_id, 1, &head)
            .await
            .is_err()
    );
    assert!(
        delivery
            .request_reconciliation(&principal, &fixture.task_id)
            .await
            .is_err()
    );
    for (field, value, reason) in [
        ("draft", json!(true), "draft"),
        ("reviewDecision", Value::Null, "approved review"),
        ("headSha", json!("f".repeat(40)), "not accepted"),
        ("checkConclusion", json!("FAILURE"), "check failed"),
        ("mergeable", json!("CONFLICTING"), "conflicts"),
    ] {
        let old = fake.lock().unwrap().pulls[0].get(field).cloned();
        fake.lock().unwrap().pulls[0][field] = value;
        let error = delivery
            .issue_approval(&principal, &fixture.task_id, 1, &head)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(reason), "{field}: {error}");
        if let Some(old) = old {
            fake.lock().unwrap().pulls[0][field] = old;
        } else {
            fake.lock().unwrap().pulls[0]
                .as_object_mut()
                .unwrap()
                .remove(field);
        }
    }
    database.connection().execute("UPDATE suplex_task_controls SET workflow_state_json=json_set(workflow_state_json,'$.acceptedDelivery',NULL) WHERE task_id=?1", [&fixture.task_id]).unwrap();
    assert!(
        delivery
            .issue_approval(&principal, &fixture.task_id, 1, &head)
            .await
            .unwrap_err()
            .to_string()
            .contains("not accepted")
    );
    database.connection().execute("UPDATE suplex_task_controls SET workflow_state_json=json_set(workflow_state_json,'$.acceptedDelivery',json(?1)) WHERE task_id=?2", rusqlite::params![serde_json::to_string(&review).unwrap(),fixture.task_id]).unwrap();
    // The human dependency editor and paired API write the same dependency rows.
    database.connection().execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_agent_id,created_at,updated_at) SELECT 'upstream',company_id,project_id,'Upstream',description,configuration_json,'upstream-key',request_hash,creator_agent_id,created_at,updated_at FROM suplex_tasks WHERE id=?1", [&fixture.task_id]).unwrap();
    database.connection().execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at) SELECT 'upstream',objective,delivery_target,delivery_intent_json,'active',root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at FROM suplex_task_controls WHERE task_id=?1", [&fixture.task_id]).unwrap();
    database.connection().execute("INSERT INTO suplex_task_dependencies (task_id,depends_on_task_id,created_at) VALUES (?1,'upstream','now')", [&fixture.task_id]).unwrap();
    assert_eq!(
        delivery
            .decide(&principal, &fixture.task_id, "wait_for_dependency")
            .unwrap()["blockingTaskIds"],
        json!(["upstream"])
    );
    assert!(
        delivery
            .decide(&principal, &fixture.task_id, "resume")
            .is_err()
    );
    assert!(
        delivery
            .issue_approval(&principal, &fixture.task_id, 1, &head)
            .await
            .unwrap_err()
            .to_string()
            .contains("upstream")
    );
    assert!(
        delivery
            .request_reconciliation(&principal, &fixture.task_id)
            .await
            .unwrap_err()
            .to_string()
            .contains("upstream")
    );
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET status='delivered' WHERE task_id='upstream'",
            [],
        )
        .unwrap();
    assert!(
        delivery
            .decide(&principal, &fixture.task_id, "wait_for_dependency")
            .is_err()
    );
    assert_eq!(
        delivery
            .decide(&principal, &fixture.task_id, "resume")
            .unwrap()["blockingTaskIds"],
        json!([])
    );
    fake.lock().unwrap().pulls[0]["mergeable"] = json!("CONFLICTING");
    let repair = delivery
        .request_reconciliation(&principal, &fixture.task_id)
        .await
        .unwrap();
    assert!(repair["attemptId"].as_str().unwrap().starts_with("dpr_"));
    fake.lock().unwrap().pulls[0]["mergeable"] = json!("MERGEABLE");
    let before = control(&fixture).status;
    delivery
        .refresh(&principal, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(control(&fixture).status, before);
    let provenance = delivery.provenance(&principal, &fixture.task_id).unwrap();
    assert_eq!(
        provenance
            .iter()
            .map(|row| row["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["reconciliation", "observation"]
    );
    assert!(
        database
            .connection()
            .execute(
                "UPDATE suplex_delivery_provenance SET head_sha='changed' WHERE task_id=?1",
                [&fixture.task_id]
            )
            .is_err()
    );
    let receipt = delivery
        .issue_approval(&principal, &fixture.task_id, 1, &head)
        .await
        .unwrap()["receipt"]
        .as_str()
        .unwrap()
        .to_owned();
    for (number, expected, token) in [
        (999, head.as_str(), receipt.as_str()),
        (1, "stale-head", receipt.as_str()),
        (
            1,
            head.as_str(),
            "fma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    ] {
        assert!(
            delivery
                .merge(
                    &principal,
                    &fixture.task_id,
                    number,
                    expected,
                    &review.base_sha,
                    token
                )
                .await
                .is_err()
        );
    }
    let consumed: Option<String> = database
        .connection()
        .query_row(
            "SELECT consumed_at FROM suplex_merge_approvals WHERE task_id=?1",
            [&fixture.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(consumed.is_none());
    delivery
        .merge(
            &principal,
            &fixture.task_id,
            1,
            &head,
            &review.base_sha,
            &receipt,
        )
        .await
        .unwrap();
    assert_eq!(
        control(&fixture).status,
        crate::tasks::control::TaskStatus::Delivered
    );
    assert!(
        delivery
            .merge(
                &principal,
                &fixture.task_id,
                1,
                &head,
                &review.base_sha,
                &receipt
            )
            .await
            .is_err()
    );
    let provenance = delivery.provenance(&principal, &fixture.task_id).unwrap();
    assert_eq!(
        provenance
            .iter()
            .map(|row| row["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["reconciliation", "observation", "merge"]
    );
    let audit: i64 = database.connection().query_row("SELECT COUNT(*) FROM suplex_audit_events WHERE actor_agent_id='train-agent' AND action='agent_api_pull_request_merged'", [], |row| row.get(0)).unwrap();
    assert_eq!(audit, 1);
    drop(database);
    std::fs::remove_dir_all(fixture.base).unwrap();
}
