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

use super::{inspection::ReviewRange, operations::DeliveryOperations};
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
    let mut fake = fake.lock().unwrap();
    let query = body["query"].as_str().unwrap_or("");
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
        let run = json!({"__typename": "CheckRun", "name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://github.com/owner/repo/actions/runs/1", "startedAt": "2026-09-25T00:00:00Z", "completedAt": "2026-09-25T00:01:00Z", "workflowName": "CI"});
        let rollup = json!({"statusCheckRollup": {"contexts": {"nodes": [run]}}});
        let pull = json!({
            "id": format!("PR_{number}"), "number": number, "url": format!("https://github.com/owner/repo/pull/{number}"),
            "state": gh_state(pull), "isDraft": pull["draft"], "headRefOid": pull["headSha"], "baseRefOid": pull["baseSha"],
            "baseRefName": pull["base"], "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "autoMergeRequest": null,
            "reviewDecision": "APPROVED", "author": {"login": "suplex", "avatarUrl": "https://avatars.githubusercontent.com/suplex"},
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
        delivery_intent: json!({"repository":"owner/repo","headBranch":branch,"baseBranch":"main","baselineSha":seed.to_string(),"pullRequestNumber":null}),
        root_profile: profile.clone(),
        worker_profile: profile,
        advisor_profiles: json!({}),
        issue: None,
        start_queued: true,
        copied_from_task_id: None,
        depends_on: vec![],
        pull_request_dependencies: vec![],
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
    let worktree = json!({"path": work, "branch": branch, "baseSha": seed.to_string(), "headSha": head.to_string(), "dirty": false});
    root_session_store::set_worktree(&mut database, &task_id, &worktree, now).unwrap();
    let root = root_session_store::reserve_root(&mut database, &task_id, now).unwrap();
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

fn control(fixture: &Fixture) -> Value {
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

async fn reviewed(operations: &DeliveryOperations, root: &RootIdentity) -> (String, ReviewRange) {
    let diff = operations
        .execute(root, None, "inspect_delivery_diff", None, None, None, None)
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
        .execute(root, None, "push_branch", Some(&head), None, None, None)
        .await
        .unwrap_err();
    assert!(unreviewed.to_string().contains("inspect_delivery_diff"));
    let pushed = operations
        .execute(
            root,
            None,
            "push_branch",
            Some(&head),
            Some(&review),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(pushed, json!({"kind":"pushed","headSha":head}));
    // A second push adopts the published exact head without pushing again.
    let adopted = operations
        .execute(
            root,
            None,
            "push_branch",
            Some(&head),
            Some(&review),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(adopted["kind"], "adopted");
    let untitled = operations
        .execute(
            root,
            None,
            "create_or_adopt_pull_request",
            Some(&head),
            Some(&review),
            None,
            Some(BODY),
        )
        .await
        .unwrap_err();
    assert!(untitled.to_string().starts_with("Supply a concise title"));
    let created = operations
        .execute(
            root,
            None,
            "create_or_adopt_pull_request",
            Some(&head),
            Some(&review),
            Some("  Add a verified line  "),
            Some(BODY),
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
    assert_eq!(control["status"], "delivered");
    assert_eq!(control["pullRequest"]["number"], 1);
    assert_eq!(
        control["workflowState"]["acceptedDelivery"]["headSha"],
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
            "push_branch",
            Some(&head),
            Some(&review),
            None,
            None,
        )
        .await
        .unwrap();
    let created = operations
        .execute(
            root,
            None,
            "create_or_adopt_pull_request",
            Some(&head),
            Some(&review),
            Some("Add line"),
            Some(BODY),
        )
        .await
        .unwrap();
    assert_eq!(created["state"], "open");
    assert_eq!(
        control(&fixture)["status"],
        "active",
        "an open draft does not reach the merged target"
    );
    let checks = operations
        .execute(root, None, "observe_checks", None, None, None, None)
        .await
        .unwrap();
    assert_eq!(checks["checkSummary"], "1 successful, 0 pending, 0 failing");
    let ready = operations
        .execute(
            root,
            None,
            "request_review",
            Some(&head),
            Some(&review),
            None,
            None,
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
            "merge_pull_request",
            Some(&head),
            Some(&review),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(waiting["kind"], "merge_requested");
    assert_eq!(
        control(&fixture)["workflowState"]["deliveryWait"]["reason"],
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
    assert_eq!(control["status"], "delivered");
    assert_eq!(control["pullRequest"]["state"], "merged");
    assert!(control["workflowState"]["deliveryWait"].is_null());
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
            "push_branch",
            Some(&head),
            Some(&review),
            None,
            None,
        )
        .await
        .unwrap();
    operations
        .execute(
            root,
            None,
            "create_or_adopt_pull_request",
            Some(&head),
            Some(&review),
            Some("Add line"),
            Some(BODY),
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
            "merge_pull_request",
            Some(&head),
            Some(&review),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(merged["state"], "merged");
    assert_eq!(merged["reviewedHead"], head.as_str());
    assert_eq!(control(&fixture)["status"], "delivered");
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
async fn observing_a_pull_request_another_task_names_records_the_observation() {
    let fixture = fixture("merged");
    let (operations, _fake) = operations(&fixture).await;
    let root = &fixture.root;
    let (head, review) = reviewed(&operations, root).await;
    for operation in ["push_branch", "create_or_adopt_pull_request"] {
        operations
            .execute(
                root,
                None,
                operation,
                Some(&head),
                Some(&review),
                Some("Add line"),
                Some(BODY),
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
            delivery_intent: json!({"repository":"owner/repo","headBranch":"task-other","baseBranch":"main","pullRequestNumber":null}),
            root_profile: profile.clone(),
            worker_profile: profile,
            advisor_profiles: json!({}),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![],
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
    assert_eq!(control(&fixture)["pullRequest"]["number"], 1);
    std::fs::remove_dir_all(&fixture.base).unwrap();
}
