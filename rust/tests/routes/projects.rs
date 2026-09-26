#[cfg(test)]
mod tests {
    use chrono::Utc;
    use std::{
        fs,
        path::Path as FilePath,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use axum::{
        body::to_bytes,
        http::{HeaderValue, header},
    };
    use chrono::DateTime;

    use super::*;
    use crate::{
        identity::{auth as identity_auth, companies},
        platform::database::{OpenMode, SuplexDatabase},
    };

    fn git(args: &[&str], cwd: &FilePath) {
        let output = std::process::Command::new("/usr/bin/git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn project_reads_serialize_normalized_configuration_and_enforce_scope() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::shared::ids::random_hex_id("suplex_project_http").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Projects", now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, integration_json, execution_json, provider_policy_json, agent_task_policy_json, created_at, updated_at) VALUES ('project_http', ?1, 'Project', '/tmp/repository', '/tmp/worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?2, NULL, '{}', ?3, ?3)",
            rusqlite::params![company.id, r#"{"instructions":"Build"}"#, now.to_rfc3339()],
        ).unwrap();
        let member_now = Utc::now();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('project_member', 'Member', 'user_v1_project_member', 'member', 'active', ?1, ?1, 1)",
            [member_now.to_rfc3339()],
        ).unwrap();
        let member_hash = crate::shared::hash::sha256_hex(b"project_member_token");
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('project_member_session', ?1, 'project_member', ?2, ?3, 1)",
            rusqlite::params![member_hash, (member_now + chrono::Duration::days(1)).to_rfc3339(), member_now.to_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let malformed = "x".repeat(257);
        let anonymous = get_one(
            State(state.clone()),
            Path(malformed.clone()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::BAD_REQUEST);
        let anonymous_body = to_bytes(anonymous.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&anonymous_body)
                .unwrap()
                .contains("projectId")
        );
        let mut member_headers = HeaderMap::new();
        member_headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=project_member_token"),
        );
        let member_malformed = get_one(
            State(state.clone()),
            Path(malformed),
            member_headers.clone(),
        )
        .await;
        assert_eq!(member_malformed.status(), StatusCode::BAD_REQUEST);
        let member_scoped = get_one(
            State(state.clone()),
            Path("project_http".to_owned()),
            member_headers,
        )
        .await;
        assert_eq!(member_scoped.status(), StatusCode::NOT_FOUND);
        let response = get_one(
            State(state.clone()),
            Path("project_http".to_owned()),
            headers.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains(r#""instructions":"Build""#));
        assert!(body.contains(r#""skillDirectories":[]"#));
        let defaults = repository_defaults(
            State(state.clone()),
            Path("project_http".to_owned()),
            headers.clone(),
        )
        .await;
        assert_eq!(defaults.status(), StatusCode::OK);
        let defaults_body = to_bytes(defaults.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(
            &defaults_body[..],
            br#"{"setupCommand":"pnpm install","verificationCommand":"pnpm test"}"#
        );
        let instances = provider_instances(
            State(state.clone()),
            Path("project_http".to_owned()),
            headers.clone(),
        )
        .await;
        assert_eq!(instances.status(), StatusCode::OK);
        let instances_body = to_bytes(instances.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(&instances_body[..], br#"{"instances":[]}"#);
        let response = list_company(State(state), Path(company.id), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&body)
                .unwrap()
                .contains(r#""instructions":"Build""#)
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn admitted_project_create_finishes_after_request_task_is_dropped() {
        let root = std::env::temp_dir()
            .join(crate::shared::ids::random_hex_id("suplex_project_drop").unwrap());
        let repositories = root.join("repositories");
        let worktrees = root.join("worktrees");
        let repository = repositories.join("owner/repo");
        let worktree = worktrees.join("owner/repo");
        let bare = root.join("bare.git");
        let new_bare = root.join("owner/new.git");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                new_bare.to_str().unwrap(),
            ],
            &root,
        );
        git(&["init", "--quiet", "--initial-branch=main"], &repository);
        git(
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "initial",
            ],
            &repository,
        );
        git(
            &["remote", "add", "origin", bare.to_str().unwrap()],
            &repository,
        );
        git(&["push", "--quiet", "origin", "main"], &repository);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        // GitHub stands in on loopback; Git reaches `https://github.com/` through
        // the file URLs under `root`.
        let github_calls = Arc::new(AtomicUsize::new(0));
        let counted = |calls: &Arc<AtomicUsize>| {
            calls.fetch_add(1, Ordering::SeqCst);
        };
        let api = axum::Router::new()
            .route(
                "/user",
                axum::routing::get({
                    let calls = github_calls.clone();
                    move || async move {
                        counted(&calls);
                        axum::Json(json!({"login": "owner"}))
                    }
                }),
            )
            .route("/user/orgs", axum::routing::get(|| async { axum::Json(json!([])) }))
            .route(
                "/graphql",
                axum::routing::post({
                    let calls = github_calls.clone();
                    move || async move {
                        counted(&calls);
                        axum::Json(json!({"data": {"repositoryOwner": {"repositories": {
                            "nodes": [{"name": "zeta", "defaultBranchRef": null}, {"name": "Alpha", "defaultBranchRef": {"name": "release"}}],
                            "pageInfo": {"hasNextPage": false, "endCursor": null}
                        }}}}))
                    }
                }),
            )
            .route(
                "/repos/{owner}/{name}",
                axum::routing::get({
                    let calls = github_calls.clone();
                    move |Path((owner, name)): Path<(String, String)>| async move {
                        counted(&calls);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        axum::Json(json!({
                            "full_name": format!("{owner}/{name}"),
                            "html_url": format!("https://github.com/{owner}/{name}")
                        }))
                    }
                }),
            )
            .route(
                "/user/repos",
                axum::routing::post(|| async { axum::Json(json!({})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
        let mut database =
            SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Create", now).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        )
        .with_project_roots(repositories, worktrees)
        .with_project_github(crate::projects::git::Github {
            api: Some((api_base, "fixture-token".to_owned())),
            git: Some(format!("file://{}/", root.display())),
        });
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "name": "Project", "repositoryPath": repository, "worktreeRoot": worktree,
                "repository": "owner/repo", "baseBranch": "main", "setupCommand": "pnpm install",
                "verificationCommand": "pnpm test", "rootProfileId": "profile_native_root",
                "workerProfileId": "profile_native_worker",
                "integration": {"repository": {"kind": "github"}},
                "execution": {"instructions": "Build carefully"}
            }))
            .unwrap(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let denied = create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            body.clone(),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call before authorization"
        );
        let malformed_company = "x".repeat(257);
        let malformed_create = create(
            State(state.clone()),
            Path(malformed_company.clone()),
            headers.clone(),
            body.clone(),
        )
        .await;
        assert_eq!(malformed_create.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call for invalid paths"
        );
        let malformed_picker = owner_repositories(
            State(state.clone()),
            Path((malformed_company, "bad_name".to_owned())),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(malformed_picker.status(), StatusCode::BAD_REQUEST);
        let malformed_picker_body = to_bytes(malformed_picker.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let malformed_picker_body = std::str::from_utf8(&malformed_picker_body).unwrap();
        assert!(
            malformed_picker_body.find(".companyId").unwrap()
                < malformed_picker_body.find(".owner").unwrap()
        );
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call for invalid paths"
        );
        let denied_owners = repository_owners(
            State(state.clone()),
            Path(company.id.clone()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(denied_owners.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call before authorization"
        );
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let owners = repository_owners(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(owners.status(), StatusCode::OK);
        let owner_body = to_bytes(owners.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(&owner_body[..], br#"{"owners":["owner"]}"#);
        let repositories = owner_repositories(
            State(state.clone()),
            Path((company.id.clone(), "owner".to_owned())),
            headers.clone(),
        )
        .await;
        assert_eq!(repositories.status(), StatusCode::OK);
        let repositories_body = to_bytes(repositories.into_body(), 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            &repositories_body[..],
            br#"{"repositories":[{"name":"Alpha","defaultBranch":"release"},{"name":"zeta","defaultBranch":"main"}]}"#
        );
        let bad_owner = owner_repositories(
            State(state.clone()),
            Path((company.id.clone(), "bad_name".to_owned())),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(bad_owner.status(), StatusCode::BAD_REQUEST);
        let before = github_calls.load(Ordering::SeqCst);
        let request = tokio::spawn(create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            body,
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while github_calls.load(Ordering::SeqCst) == before {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        let _ = request.await;
        let count = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let count: i64 = state.with_database(|database| database.connection().query_row("SELECT COUNT(*) FROM suplex_projects WHERE repository_identity = 'owner/repo'", [], |row| row.get(0)).unwrap());
                if count > 0 { break count; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.unwrap();
        assert_eq!(
            count, 1,
            "admitted create continues after handler cancellation"
        );
        let stored: (Option<String>, Option<String>) = state.with_database(|database| {
            database.connection().query_row(
                "SELECT integration_json, execution_json FROM suplex_projects WHERE repository_identity = 'owner/repo'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap()
        });
        assert!(stored.0.unwrap().contains(r#""kind":"github""#));
        assert!(
            stored
                .1
                .unwrap()
                .contains(r#""instructions":"Build carefully""#)
        );
        let url_body = Bytes::from(
            serde_json::to_vec(&json!({
                "repositoryUrl": "https://github.com/owner/repo",
                "integration": {"repository": {"kind": "github"}}
            }))
            .unwrap(),
        );
        let duplicate = create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            url_body,
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        let duplicate_body = to_bytes(duplicate.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&duplicate_body)
                .unwrap()
                .contains("already-assigned")
        );
        let new_body = Bytes::from_static(br#"{"repositoryName":"owner/new"}"#);
        let created = create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            new_body,
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let created_body = to_bytes(created.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&created_body)
                .unwrap()
                .contains(r#""repository":"owner/new""#)
        );
        assert!(root.join("repositories/owner/new/.git").is_dir());
        let short_name = Bytes::from_static(br#"{"repositoryName":"new"}"#);
        let duplicate = create(State(state.clone()), Path(company.id), headers, short_name).await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn issue_search_and_task_sources_follow_the_configured_tracker() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::shared::ids::random_hex_id("suplex_project_sources").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Sources", now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, integration_json, agent_task_policy_json, created_at, updated_at) VALUES ('project_sources', ?1, 'Project', '/tmp/repository', '/tmp/worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', '{}', ?2, ?2)",
            rusqlite::params![company.id, now.to_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let uri = |value: &str| axum::extract::OriginalUri(value.parse().unwrap());
        let body = |response: Response| async move {
            serde_json::from_slice::<serde_json::Value>(
                &to_bytes(response.into_body(), 1024 * 1024).await.unwrap(),
            )
            .unwrap()
        };
        let long = format!(
            "/api/projects/project_sources/issues?query={}",
            "x".repeat(201)
        );
        let rejected = issues(
            State(state.clone()),
            Path("project_sources".into()),
            uri(&long),
            headers.clone(),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        // An integration without a tracker searches nothing; it never falls back to GitHub Issues.
        let none = issues(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/issues?query=bug"),
            headers.clone(),
        )
        .await;
        assert_eq!(none.status(), StatusCode::OK);
        assert_eq!(body(none).await, json!({"issues": []}));
        let invalid = task_sources(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/task-sources?kind=tag"),
            headers.clone(),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let mismatch = task_sources(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/task-sources?kind=issue"),
            headers.clone(),
        )
        .await;
        assert_eq!(mismatch.status(), StatusCode::OK);
        assert_eq!(
            body(mismatch).await,
            json!({"available": false, "reason": "The source issue does not match the configured tracker.", "sources": []})
        );
        let anonymous = task_sources(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/task-sources?kind=issue"),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn project_patch_replaces_or_patches_and_checks_git_only_for_repository_changes() {
        let root = std::env::temp_dir()
            .join(crate::shared::ids::random_hex_id("suplex_project_patch").unwrap());
        let repositories = root.join("repositories");
        let worktrees = root.join("worktrees");
        let repository = repositories.join("owner/repo");
        let worktree = worktrees.join("owner/repo");
        let bare = root.join("bare.git");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(&["init", "--quiet", "--initial-branch=main"], &repository);
        git(
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "initial",
            ],
            &repository,
        );
        git(
            &["remote", "add", "origin", bare.to_str().unwrap()],
            &repository,
        );
        git(&["push", "--quiet", "origin", "main"], &repository);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        git(
            &[
                "config",
                "--local",
                &format!("url.file://{}.insteadOf", bare.display()),
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        let api_base = crate::projects::git::fixtures::github_api(
            axum::Router::new()
                .route(
                    "/user",
                    axum::routing::get(|| async { axum::Json(json!({"login": "owner"})) }),
                )
                .route(
                    "/repos/{owner}/{name}",
                    axum::routing::get(|Path((owner, name)): Path<(String, String)>| async move {
                        axum::Json(json!({
                            "full_name": format!("{owner}/{name}"),
                            "html_url": format!("https://github.com/{owner}/{name}")
                        }))
                    }),
                ),
        )
        .await;
        let repository = fs::canonicalize(&repository).unwrap();
        let worktree = fs::canonicalize(&worktree).unwrap();
        let mut database =
            SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Patch", now).unwrap();
        // The stored paths do not exist: a patch that leaves the repository alone must not read Git.
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_patch', ?1, 'Project', '/tmp/suplex-missing-repository', '/tmp/suplex-missing-worktrees', 'owner/repo', 'main', 'pnpm install', 'pnpm test', 'profile_native_root', 'profile_native_worker', '{}', ?2, ?2)",
            rusqlite::params![company.id, now.to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES ('instance_patch', 'claude-code', 'patch', '/private/patch', ?1, ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        let provider: String = database
            .connection()
            .query_row(
                "SELECT provider FROM suplex_profiles WHERE id = 'profile_native_root'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        )
        .with_project_roots(repositories, worktrees)
        .with_project_github(crate::projects::git::Github {
            api: Some((api_base, "fixture-token".to_owned())),
            git: None,
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let patch = |body: serde_json::Value, headers: HeaderMap| {
            update(
                State(state.clone()),
                Path("project_patch".to_owned()),
                headers,
                Bytes::from(serde_json::to_vec(&body).unwrap()),
            )
        };
        let read = |response: Response| async move {
            let status = response.status();
            let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            )
        };
        let (status, renamed) =
            read(patch(json!({"name": " Renamed again "}), headers.clone()).await).await;
        assert_eq!(status, StatusCode::OK, "{renamed}");
        assert_eq!(renamed["name"], "Renamed again");
        assert_eq!(renamed["repositoryPath"], "/tmp/suplex-missing-repository");
        let (status, empty) = read(patch(json!({}), headers.clone()).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(empty["findings"][0]["code"], "invalid-custom");
        let mut foreign = headers.clone();
        foreign.insert(
            "origin",
            HeaderValue::from_static("https://foreign.example"),
        );
        let (status, invalid) = read(patch(json!({"name": ""}), foreign.clone()).await).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "validation precedes the origin check"
        );
        assert_eq!(invalid["findings"][0]["field"], ".name");
        let (status, _) = read(patch(json!({"name": "Other"}), foreign).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, policy) = read(
            patch(
                json!({"providerPolicy": {"allowedProviders": [provider, "claude-code"], "allowedInstanceIds": ["instance_patch"]}}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{policy}");
        assert_eq!(
            policy["providerPolicy"]["allowedInstanceIds"],
            json!(["instance_patch"])
        );
        let (status, missing) = read(
            patch(
                json!({"providerPolicy": {"allowedProviders": [], "allowedInstanceIds": ["instance_missing"]}}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(missing["findings"][0]["code"], "instance-ineligible");
        let (status, execution) = read(
            patch(
                json!({"execution": {"instructions": "Build carefully"}}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            execution["execution"],
            json!({"instructions":"Build carefully","skillDirectories":[],"environment":{},"mcp":[]})
        );
        // A repository change reads Git and the repository host again.
        let (status, moved) = read(
            patch(
                json!({"repositoryPath": repository, "worktreeRoot": worktree}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{moved}");
        assert_eq!(moved["repositoryPath"], json!(repository));
        let (status, branch) =
            read(patch(json!({"baseBranch": "missing"}), headers.clone()).await).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(branch["findings"][0]["code"], "repository-unavailable");
        let full = json!({
            "name": "Replaced", "repositoryPath": repository, "worktreeRoot": worktree,
            "repository": "owner/repo", "baseBranch": "main", "setupCommand": "pnpm install",
            "verificationCommand": "pnpm test", "rootProfileId": "profile_native_root",
            "workerProfileId": "profile_native_worker"
        });
        let (status, replaced) = read(patch(full.clone(), headers.clone()).await).await;
        assert_eq!(status, StatusCode::OK, "{replaced}");
        assert_eq!(replaced["name"], "Replaced");
        assert_eq!(
            replaced["execution"]["instructions"], "Build carefully",
            "a full body without execution keeps the stored execution"
        );
        let mut ineligible = full;
        ineligible["rootProfileId"] = json!("profile_native_worker");
        let (status, ineligible) = read(patch(ineligible, headers.clone()).await).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(ineligible["findings"][0]["field"], "rootProfileId");
        let stored = state
            .with_database(|database| service::get(database, &admin.user.id, "project_patch"))
            .unwrap();
        assert_eq!(stored.name, "Replaced");
        let audits: i64 = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'project_updated'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(audits, 5);
        drop(state);
        let _ = fs::remove_dir_all(root);
    }
}
