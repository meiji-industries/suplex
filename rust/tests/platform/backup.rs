#[test]
fn oauth_backup_removes_secrets_and_reapproval_reuses_connection_identity() {
    use crate::identity::{
        auth, companies,
        oauth::{AuthorizationRequest, ClientMetadata, CodeExchange, OAuth},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use sha2::{Digest, Sha256};
    let root = root();
    let backups = service(&root);
    let mut database = SuplexDatabase::open(&backups.database_path, OpenMode::ReadWrite).unwrap();
    let now = Utc::now();
    let admin = auth::development_sign_in(&mut database, now).unwrap();
    let company = companies::create_company(&mut database, &admin.user.id, "Backup", now).unwrap();
    database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('project_backup',?1,'Backup','/repo','/worktrees','owner/repo','main','','','profile_native_root','profile_native_worker',?2,?2)", rusqlite::params![company.id, now.to_rfc3339()]).unwrap();
    let oauth = OAuth::new("http://127.0.0.1:4113");
    let callback = "http://127.0.0.1:9319/callback";
    let client = oauth
        .register_client(
            &mut database,
            ClientMetadata {
                client_name: "Backup client".into(),
                redirect_uris: vec![callback.into()],
                grant_types: None,
                response_types: None,
                token_endpoint_auth_method: None,
            },
            now,
        )
        .unwrap();
    let verifier = "b".repeat(43);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let approve = |database: &mut SuplexDatabase| {
        let request = oauth
            .begin_authorization(
                database,
                AuthorizationRequest {
                    client_id: &client.client_id,
                    redirect_uri: callback,
                    response_type: "code",
                    state: Some("backup"),
                    scope: Some("suplex:mcp"),
                    resource: &oauth.resource,
                    code_challenge: &challenge,
                    code_challenge_method: "S256",
                },
                now,
            )
            .unwrap();
        oauth
            .approve(
                database,
                &admin.user.id,
                &request,
                &company.id,
                &["project_backup".into()],
                now,
            )
            .unwrap()
    };
    let redirect = url::Url::parse(&approve(&mut database)).unwrap();
    let code = redirect
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .into_owned();
    oauth
        .exchange_code(
            &mut database,
            CodeExchange {
                code: &code,
                client_id: &client.client_id,
                redirect_uri: callback,
                resource: &oauth.resource,
                verifier: &verifier,
            },
            now,
        )
        .unwrap();
    let identity = |database: &SuplexDatabase| {
        database
            .connection()
            .query_row(
                "SELECT agent_id, cursor_key FROM suplex_oauth_grants",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap()
    };
    let before = identity(&database);
    let archive = root.join("oauth.tar.gz");
    backups.create(&archive).unwrap();
    let destination = root.join("restored");
    backups.restore(&archive, &destination).unwrap();
    let mut restored = SuplexDatabase::open(
        &destination.join("suplex-backup/app/suplex.sqlite"),
        OpenMode::ReadWrite,
    )
    .unwrap();
    for table in [
        "suplex_sessions",
        "suplex_oauth_access_tokens",
        "suplex_oauth_refresh_tokens",
        "suplex_oauth_authorization_codes",
        "suplex_oauth_token_families",
    ] {
        let count: i64 = restored
            .connection()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    assert_eq!(
        restored
            .connection()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'suplex_provider_credentials'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let after = identity(&restored);
    assert_eq!(after.0, before.0);
    assert_ne!(after.1, before.1);
    approve(&mut restored);
    assert_eq!(identity(&restored).0, before.0);
    drop(restored);
    drop(database);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cross_host_restore_preserves_live_session_by_username() {
    let root = root();
    let previous = service(&root.join("previous"));
    let next = service(&root.join("next"));
    for (backup, id) in [(&previous, "old_admin"), (&next, "new_admin")] {
        let database = Connection::open(&backup.database_path).unwrap();
        database.execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES (?1,'Admin','same-person','admin','active','2026-09-26T00:00:00Z','2026-09-26T00:00:00Z',1)", [id]).unwrap();
    }
    let live = SuplexDatabase::open(&next.database_path, OpenMode::ReadWrite).unwrap();
    let token = crate::identity::auth::create_session(&live, "new_admin", Utc::now()).unwrap();
    let archive = root.join("old.tar.gz");
    previous.create(&archive).unwrap();
    next.restore_in_place(&archive).unwrap();
    let user = crate::identity::auth::get_user_by_session(&live, &token, Utc::now())
        .unwrap()
        .unwrap();
    assert_eq!(user.id, "old_admin");
    assert_eq!(user.username, "same-person");
    drop(live);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn backup_rejects_truncated_missing_and_wrong_version_archives() {
    let root = root();
    let backups = service(&root);
    let archive = root.join("backup.tar.gz");
    backups.create(&archive).unwrap();
    let broken = root.join("broken.tar.gz");
    fs::write(&broken, "not-an-archive").unwrap();
    assert!(!backups.verify(&broken).unwrap().valid);
    for (name, expected) in [
        ("missing", "missing entry: config/config.json"),
        ("version", "unsupported backup version"),
    ] {
        let unpacked = root.join(name);
        fs::create_dir_all(&unpacked).unwrap();
        tar(
            &[
                "-xzf".as_ref(),
                archive.as_os_str(),
                "-C".as_ref(),
                unpacked.as_os_str(),
            ],
            30,
        )
        .unwrap();
        if name == "missing" {
            fs::remove_file(unpacked.join("suplex-backup/config/config.json")).unwrap();
        } else {
            let path = unpacked.join("suplex-backup/manifest.json");
            let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            manifest["version"] = json!(999);
            fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        }
        tar(
            &[
                "-czf".as_ref(),
                broken.as_os_str(),
                "-C".as_ref(),
                unpacked.as_os_str(),
                BACKUP_ROOT.as_ref(),
            ],
            30,
        )
        .unwrap();
        let verification = backups.verify(&broken).unwrap();
        assert!(!verification.valid);
        assert!(
            verification.errors.iter().any(|error| error == expected),
            "{:?}",
            verification.errors
        );
    }
    assert!(backups.verify(&archive).unwrap().valid);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn backup_health_checks_exact_age_and_invalid_verification() {
    let root = root();
    let verified = DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    fs::write(
        root.join("backup-status.json"),
        json!({"valid":true,"verifiedAt":verified.to_rfc3339()}).to_string(),
    )
    .unwrap();
    let boundary = verified + chrono::Duration::milliseconds(HEALTH_MAX_AGE_MS);
    assert_eq!(health_check(&root, boundary)["status"], "healthy");
    assert_eq!(
        health_check(&root, boundary + chrono::Duration::milliseconds(1))["status"],
        "warning"
    );
    for status in [
        json!({"valid":false,"verifiedAt":verified.to_rfc3339(),"errors":["hash mismatch"]}),
        json!({"valid":true,"verifiedAt":"not-a-date"}),
    ] {
        fs::write(root.join("backup-status.json"), status.to_string()).unwrap();
        assert_eq!(health_check(&root, boundary)["status"], "unhealthy");
        assert_eq!(health_check(&root, boundary)["details"]["ageMs"], -1);
    }
    fs::remove_dir_all(root).unwrap();
}
