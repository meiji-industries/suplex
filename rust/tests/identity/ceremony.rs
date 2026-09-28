#[test]
fn bootstrap_and_recovery_revoke_prior_authority_without_leaking_tokens() {
    let (mut database, path, _, now) = setup();
    crate::identity::test_repository::revoke_seed_operator(&database).unwrap();
    let first = auth::issue_administrator_invitation(&mut database, "bootstrap", "{}", now)
        .unwrap()
        .unwrap();
    let second = auth::issue_administrator_invitation(&mut database, "bootstrap", "{}", now)
        .unwrap()
        .unwrap();
    for token in [&first, "suplex_bootstrap_not-a-token"] {
        assert_eq!(
            begin_registration(&mut database, "bootstrap", token, site(), now)
                .unwrap_err()
                .to_string(),
            "Invitation is invalid or expired"
        );
    }
    assert!(
        begin_registration(
            &mut database,
            "bootstrap",
            &second,
            site(),
            now + Duration::hours(72)
        )
        .is_err()
    );
    let stored: String = database.connection().query_row("SELECT token_hash FROM suplex_invitations WHERE kind = 'bootstrap' AND replaced_at IS NULL", [], |row| row.get(0)).unwrap();
    assert_eq!(stored, sha256_hex(&second));
    assert_ne!(stored, second);
    let options = begin_registration(&mut database, "bootstrap", &second, site(), now).unwrap();
    assert!(
        complete_registration(
            &mut database,
            "bootstrap",
            &second,
            &options.challenge_id,
            &json!({"id":"not-a-real-credential","type":"public-key"}),
            site(),
            now
        )
        .is_err()
    );
    assert!(auth::bootstrap_required(&database).unwrap());
    let enroll = |database: &mut SuplexDatabase, kind: &str, token: &str| {
        let offered = begin_registration(database, kind, token, site(), now).unwrap();
        let signed =
            synthetic(&json!({"mode":"register","options":offered.options,"origin":site().origin}));
        complete_registration(
            database,
            kind,
            token,
            &offered.challenge_id,
            &signed["response"],
            site(),
            now,
        )
        .unwrap()
    };
    let original = enroll(&mut database, "bootstrap", &second);
    assert_eq!(original.user.role, "admin");
    assert!(
        auth::issue_administrator_invitation(&mut database, "bootstrap", "{}", now)
            .unwrap()
            .is_none()
    );
    assert!(begin_registration(&mut database, "bootstrap", &second, site(), now).is_err());
    let stored_session: String = database
        .connection()
        .query_row(
            "SELECT token_hash FROM suplex_sessions WHERE user_id = ?1",
            [&original.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_session, sha256_hex(&original.session_token));
    assert_ne!(stored_session, original.session_token);
    let metadata = r#"{"initiationMethod":"local-cli","installationId":"test-installation"}"#;
    let recovery = auth::issue_administrator_invitation(&mut database, "recovery", metadata, now)
        .unwrap()
        .unwrap();
    let recovered = enroll(&mut database, "recovery", &recovery);
    assert_eq!(recovered.user.role, "admin");
    assert_ne!(recovered.user.id, original.user.id);
    assert!(
        auth::get_user_by_session(&database, &original.session_token, now)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        auth::public_user(&database, &original.user.id)
            .unwrap()
            .unwrap()
            .status,
        "revoked"
    );
    let active: i64 = database
        .connection()
        .query_row(
            "SELECT count(*) FROM suplex_credentials WHERE user_id = ?1 AND revoked_at IS NULL",
            [&original.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active, 0);
    let audit: String = database
        .connection()
        .query_row(
            "SELECT metadata_json FROM suplex_audit_events WHERE action = 'recovery_completed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let metadata: Value = serde_json::from_str(&audit).unwrap();
    assert_eq!(metadata["initiationMethod"], "local-cli");
    assert_eq!(metadata["installationId"], "test-installation");
    assert!(metadata["invitationId"].is_string());
    auth::sign_out(&database, &recovered.session_token, now).unwrap();
    assert!(
        auth::get_user_by_session(&database, &recovered.session_token, now)
            .unwrap()
            .is_none()
    );
    drop(database);
    cleanup(&path);
}

#[test]
fn remote_plain_http_cannot_start_a_passkey_ceremony() {
    let (mut database, path, token, now) = setup();
    let remote = WebAuthnSite {
        origin: "http://suplex.example.test:4111",
        rp_id: "suplex.example.test",
    };
    assert!(begin_registration(&mut database, "user", &token, remote, now).is_err());
    drop(database);
    cleanup(&path);
}
