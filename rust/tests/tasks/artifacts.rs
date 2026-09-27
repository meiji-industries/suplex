pub(crate) mod tests {
    use super::*;
    use crate::{
        coordination::workflows::Workflow,
        platform::{
            artifacts::{self, ArtifactInput},
            database::{OpenMode, SuplexDatabase},
        },
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use serde_json::json;
    use uuid::Uuid;

    fn settle(path: &Path) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(2)),
        )
        .unwrap();
    }

    pub(crate) fn fixture() -> (PathBuf, PathBuf, SuplexDatabase, String) {
        let directory = std::env::temp_dir().join(format!("suplex-task-media-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let database_path = directory.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let user = crate::identity::auth::development_sign_in(&mut database, now)
            .unwrap()
            .user;
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_media','Media','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('project_media','company_media','Media','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        let task = repository::create(
            &mut database,
            &PreparedTask {
                id: repository::new_task_id(),
                company_id: "company_media".into(),
                project_id: "project_media".into(),
                title: "Media task".into(),
                description: String::new(),
                configuration: json!({
                    "repository":"owner/repo",
                    "repositoryPath":"/tmp/repo",
                    "worktreeRoot":"/tmp/worktrees",
                    "branch":"task-media",
                    "baseBranch":"main",
                    "baselineSha":"head",
                    "startingSha":"head",
                    "visualEvidence":"off",
                    "source":null,
                    "capturedAt":now.to_rfc3339()
                }),
                idempotency_key: Uuid::new_v4().to_string(),
                request_hash: "media-hash".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "merged".into(),
                delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-media","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(profile.clone()).unwrap(),
                worker_profile: serde_json::from_value(profile).unwrap(),
                advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![],
                workflow: Workflow::Standard,
            },
            now,
        )
        .unwrap()
        .task;
        (directory.clone(), database_path, database, task.id)
    }

    #[test]
    fn collection_keeps_good_nested_media_and_retries_bad_neighbors() {
        let (directory, database_path, mut database, task_id) = fixture();
        let generated = generated_directory(&database_path, &task_id).unwrap();
        fs::create_dir_all(generated.join("recordings")).unwrap();
        fs::write(
            generated.join("shot.png"),
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        settle(&generated.join("shot.png"));
        fs::write(
            generated.join("recordings/demo.mp4"),
            [0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
        )
        .unwrap();
        settle(&generated.join("recordings/demo.mp4"));
        fs::write(generated.join("delivery-evidence.json"), b"not media").unwrap();
        fs::write(generated.join("bad.webp"), b"not webp").unwrap();
        settle(&generated.join("bad.webp"));
        let oversized = fs::File::create(generated.join("large.gif")).unwrap();
        oversized
            .set_len(artifacts::MAX_ARTIFACT_BYTES as u64 + 1)
            .unwrap();
        settle(&generated.join("large.gif"));
        let outside = directory.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("outside.png"),
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, generated.join("linked-media")).unwrap();

        let root = directory.join("artifacts");
        let first = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(first.imported, 2);
        assert_eq!(first.duplicates, 0);
        assert_eq!(first.diagnostics.len(), 3);

        let repeated = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(repeated.imported, 0);
        assert_eq!(repeated.duplicates, 2);
        assert_eq!(repeated.diagnostics.len(), 3);

        database
            .transaction(false, |database| {
                artifacts::put_in_transaction(
                    database,
                    &root,
                    "company_media",
                    "delivery-evidence",
                    &ArtifactInput {
                        filename: "delivery-evidence.json",
                        mime_type: "application/json",
                        bytes: b"{}",
                        task_id: &task_id,
                    },
                    Utc::now(),
                )?;
                Ok(())
            })
            .unwrap();

        let response = serde_json::to_value(
            repository::task_response(&database, &task_id)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["artifacts"].as_array().unwrap().len(), 3);
        assert!(
            response["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|artifact| {
                    artifact["filename"] == "recordings--demo.mp4"
                        && artifact["mimeType"] == "video/mp4"
                })
        );
        assert!(
            response["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|artifact| artifact["mimeType"] == "application/json")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn newly_modified_media_waits_for_a_later_sweep() {
        let (directory, database_path, mut database, task_id) = fixture();
        let generated = generated_directory(&database_path, &task_id).unwrap();
        fs::create_dir_all(&generated).unwrap();
        let video = generated.join("demo.webm");
        fs::write(&video, [0x1a, 0x45, 0xdf, 0xa3]).unwrap();
        let root = directory.join("artifacts");

        let fresh = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(fresh.imported, 0);
        assert!(
            fresh
                .diagnostics
                .iter()
                .any(|item| item.contains("settling"))
        );

        settle(&video);
        let settled = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(settled.imported, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn media_signatures_cover_the_supported_allowlist() {
        assert!(MediaType::Png.matches(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        assert!(MediaType::Jpeg.matches(&[0xff, 0xd8, 0xff]));
        assert!(MediaType::WebP.matches(b"RIFF0000WEBP"));
        assert!(MediaType::Gif.matches(b"GIF89a"));
        assert!(MediaType::Mp4.matches(b"0000ftypisom"));
        assert!(MediaType::WebM.matches(&[0x1a, 0x45, 0xdf, 0xa3]));
        assert!(!MediaType::WebM.matches(b"<svg"));
    }
}
