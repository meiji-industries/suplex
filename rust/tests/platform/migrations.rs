#[cfg(test)]
mod migration_regressions {
    use super::*;
    use serde_json::{Map, Value, json};

    fn memory_database() -> SuplexDatabase {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
        SuplexDatabase {
            connection,
            mode: OpenMode::ReadWrite,
            callbacks: Vec::new(),
            deferred_callbacks: None,
        }
    }

    fn rows(database: &SuplexDatabase, sql: &str) -> Value {
        use rusqlite::types::ValueRef;
        let mut statement = database.connection.prepare(sql).unwrap();
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        let values = statement
            .query_map([], |row| {
                let mut value = Map::new();
                for (index, name) in names.iter().enumerate() {
                    let field = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(value) => json!(value),
                        ValueRef::Real(value) => json!(value),
                        ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
                        ValueRef::Blob(_) => panic!("SQL regression rows do not contain blobs"),
                    };
                    value.insert(name.clone(), field);
                }
                Ok(Value::Object(value))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        json!(values)
    }

    #[test]
    fn health_preserves_schema_evidence_across_ledger_and_write_failures() {
        let filename =
            std::env::temp_dir().join(format!("suplex-db-health-{}.sqlite", uuid::Uuid::new_v4()));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let baseline = database.schema_status().unwrap().applied;
        let restore = || {
            database
                .connection
                .execute("DELETE FROM __drizzle_migrations", [])
                .unwrap();
            for migration in &baseline {
                database
                    .connection
                    .execute(
                        "INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?1,?2)",
                        params![migration.hash, migration.created_at],
                    )
                    .unwrap();
            }
        };
        for (sql, state, count) in [
            ("DELETE FROM __drizzle_migrations", SchemaState::Behind, 0),
            (
                "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
                SchemaState::Behind,
                baseline.len() - 1,
            ),
            (
                "INSERT INTO __drizzle_migrations (hash,created_at) SELECT 'future',max(created_at)+1 FROM __drizzle_migrations",
                SchemaState::Ahead,
                baseline.len() + 1,
            ),
            (
                "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 1 OFFSET 1)",
                SchemaState::Partial,
                baseline.len() - 1,
            ),
            (
                "UPDATE __drizzle_migrations SET hash='corrupt' WHERE created_at = (SELECT min(created_at) FROM __drizzle_migrations)",
                SchemaState::Corrupt,
                baseline.len(),
            ),
        ] {
            restore();
            database.connection.execute_batch(sql).unwrap();
            let health = database.health();
            assert_eq!(health.schema_state, state, "{sql}");
            assert_eq!(health.expected_migrations, baseline.len());
            assert_eq!(health.applied_migrations, count);
            assert!(health.readable && health.writable);
        }
        restore();
        database
            .connection
            .execute_batch("PRAGMA journal_mode=DELETE")
            .unwrap();
        let health = database.health();
        assert_eq!(health.schema_state, SchemaState::Current);
        assert!(!health.wal_mode);
        database
            .connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1")
            .unwrap();
        let lock = Connection::open(&filename).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        let health = database.health();
        assert_eq!(health.schema_state, SchemaState::Locked);
        assert_eq!(health.applied_migrations, baseline.len());
        assert!(health.readable && !health.writable);
        lock.execute_batch("ROLLBACK").unwrap();
        drop(lock);
        database
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let health = database.health();
        assert_eq!(health.schema_state, SchemaState::Current);
        assert!(health.readable && !health.writable);
        drop(database);
        fs::remove_file(filename).unwrap();
    }

    #[test]
    fn read_only_diagnostics_never_create_or_migrate_a_database() {
        let filename =
            std::env::temp_dir().join(format!("suplex-db-health-{}.sqlite", uuid::Uuid::new_v4()));
        assert!(SuplexDatabase::open(&filename, OpenMode::ReadOnly).is_err());
        assert!(!filename.exists());
        Connection::open(&filename)
            .unwrap()
            .execute_batch("CREATE TABLE existing_data (id INTEGER PRIMARY KEY)")
            .unwrap();
        let database = SuplexDatabase::open(&filename, OpenMode::ReadOnly).unwrap();
        assert_eq!(database.schema_status().unwrap().state, SchemaState::Behind);
        assert_eq!(
            rows(
                &database,
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ),
            json!([{"name":"existing_data"}])
        );
        assert!(database.health().readable && !database.health().writable);
        drop(database);
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        database.connection.execute("DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)", []).unwrap();
        drop(database);
        let database = SuplexDatabase::open(&filename, OpenMode::ReadOnly).unwrap();
        let status = database.schema_status().unwrap();
        assert_eq!(status.state, SchemaState::Behind);
        assert_eq!(status.applied.len(), status.expected.len() - 1);
        assert!(database.health().readable && !database.health().writable);
        assert_eq!(
            database.schema_status().unwrap().applied.len(),
            status.applied.len()
        );
        drop(database);
        fs::remove_file(filename).unwrap();
    }

    #[test]
    fn accepts_legacy_journal_and_applies_missing_older_migrations() {
        let older = EmbeddedFile {
            name: "20260812120000000_older.sql",
            bytes: b"CREATE TABLE older (id text PRIMARY KEY);\n",
        };
        let newer = EmbeddedFile {
            name: "20260813120000000_newer.sql",
            bytes: b"CREATE TABLE newer (id text PRIMARY KEY);\n",
        };
        let mut database = memory_database();
        let migration = read_migrations(std::slice::from_ref(&newer))
            .unwrap()
            .remove(0);
        database.connection.execute_batch("CREATE TABLE newer (id text PRIMARY KEY); CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)").unwrap();
        database
            .connection
            .execute(
                "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?1, ?2)",
                params![migration.hash, migration.created_at],
            )
            .unwrap();
        let files = [older, newer];
        database.apply_migrations(&files).unwrap();
        database.apply_migrations(&files).unwrap();
        assert_eq!(
            rows(
                &database,
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('older','newer') ORDER BY name"
            ),
            json!([{"name":"newer"},{"name":"older"}])
        );
        assert_eq!(
            rows(
                &database,
                "SELECT COUNT(*) AS count FROM __drizzle_migrations"
            ),
            json!([{"count":2}])
        );
    }

    #[test]
    fn rejects_sequential_and_duplicate_timestamp_names() {
        let invalid = EmbeddedFile {
            name: "0022_sequential.sql",
            bytes: b"SELECT 1;",
        };
        assert!(
            read_migrations(&[invalid])
                .unwrap_err()
                .to_string()
                .contains("UTC timestamp")
        );
        let one = EmbeddedFile {
            name: "20260812120000_one.sql",
            bytes: b"SELECT 1;",
        };
        let two = EmbeddedFile {
            name: "20260812120000_two.sql",
            bytes: b"SELECT 2;",
        };
        assert!(
            read_migrations(&[one, two])
                .unwrap_err()
                .to_string()
                .contains("unique")
        );
    }

    #[test]
    fn runner_preserves_additive_columns_across_legacy_rebuilds() {
        let files = [
            EmbeddedFile { name: "20260812100000000_create_records.sql", bytes: b"CREATE TABLE records (id text PRIMARY KEY);" },
            EmbeddedFile { name: "20260812110000000_add_excerpt.sql", bytes: b"ALTER TABLE records ADD COLUMN excerpt text;" },
            EmbeddedFile { name: "20260812120000000_rebuild_records.sql", bytes: b"CREATE TABLE records_new (id text PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO records_new SELECT * FROM records;\n--> statement-breakpoint\nDROP TABLE records;\n--> statement-breakpoint\nALTER TABLE records_new RENAME TO records;" },
        ];
        let mut database = memory_database();
        database.apply_migrations(&files).unwrap();
        assert_eq!(
            rows(
                &database,
                "SELECT name,type FROM pragma_table_info('records') ORDER BY cid"
            ),
            json!([{"name":"id","type":"TEXT"},{"name":"excerpt","type":"TEXT"}])
        );
        assert_eq!(
            rows(
                &database,
                "SELECT COUNT(*) AS count FROM __drizzle_migrations"
            ),
            json!([{"count":3}])
        );
    }

    #[test]
    fn legacy_vendor_profile_snapshots_become_opencode_models() {
        let upgrade = MIGRATIONS
            .iter()
            .find(|file| file.name.ends_with("_upgrade_legacy_vendor_profile_snapshots.sql"))
            .unwrap();
        let legacy = r#"{"profileId":"p","provider":"openai","model":"gpt-5"}"#;
        let current = r#"{"profileId":"p","provider":"codex","model":"gpt-5"}"#;
        let seed = format!(
            "CREATE TABLE suplex_task_controls (task_id text, root_profile_json text, worker_profile_json text, advisor_profiles_json text);
            CREATE TABLE suplex_task_sessions (profile_json text);
            CREATE TABLE suplex_github_trigger_dispatches (profiles_json text);
            INSERT INTO suplex_task_controls VALUES ('legacy', '{legacy}', '{current}', '{{\"rater\":{legacy},\"reviewer\":{current}}}'), ('current', '{current}', '{current}', '{{}}');
            INSERT INTO suplex_task_sessions VALUES ('{legacy}'), (NULL);
            INSERT INTO suplex_github_trigger_dispatches VALUES ('{{\"root\":{current},\"worker\":{legacy},\"advisors\":{{\"rater\":{legacy}}}}}');"
        );
        let files = [
            EmbeddedFile { name: "20260101000000000_seed.sql", bytes: Box::leak(seed.into_boxed_str()).as_bytes() },
            EmbeddedFile { name: upgrade.name, bytes: upgrade.bytes },
        ];
        let mut database = memory_database();
        database.apply_migrations(&files).unwrap();
        let upgraded = json!({"profileId":"p","provider":"opencode","model":"openai/gpt-5"});
        let current = json!({"profileId":"p","provider":"codex","model":"gpt-5"});
        let parse = |value: &Value| serde_json::from_str::<Value>(value.as_str().unwrap()).unwrap();
        let controls = rows(&database, "SELECT root_profile_json AS root, worker_profile_json AS worker, advisor_profiles_json AS advisors FROM suplex_task_controls ORDER BY task_id DESC");
        assert_eq!(parse(&controls[0]["root"]), upgraded);
        assert_eq!(parse(&controls[0]["worker"]), current);
        assert_eq!(parse(&controls[0]["advisors"]), json!({"rater": upgraded, "reviewer": current}));
        assert_eq!(parse(&controls[1]["root"]), current);
        assert_eq!(parse(&controls[1]["advisors"]), json!({}));
        let sessions = rows(&database, "SELECT profile_json AS profile FROM suplex_task_sessions ORDER BY profile_json IS NULL");
        assert_eq!(parse(&sessions[0]["profile"]), upgraded);
        assert_eq!(sessions[1]["profile"], Value::Null);
        let dispatch = rows(&database, "SELECT profiles_json AS profiles FROM suplex_github_trigger_dispatches");
        assert_eq!(parse(&dispatch[0]["profiles"]), json!({"root": current, "worker": upgraded, "advisors": {"rater": upgraded}}));
    }

    #[test]
    fn full_chain_preserves_foreign_keys_default_profiles_and_audit_constraints() {
        let mut database = memory_database();
        database.apply_migrations(MIGRATIONS).unwrap();
        assert_eq!(
            rows(&database, "PRAGMA foreign_keys"),
            json!([{"foreign_keys":1}])
        );
        assert_eq!(rows(&database, "PRAGMA foreign_key_check"), json!([]));
        assert_eq!(
            rows(
                &database,
                "SELECT role,provider,model,reasoning_level,service_tier FROM suplex_profiles ORDER BY role"
            ),
            json!([
                {"role":"root","provider":"codex","model":"gpt-5.6-sol","reasoning_level":"medium","service_tier":"default"},
                {"role":"root","provider":"codex","model":"gpt-5.6-sol","reasoning_level":"medium","service_tier":"default"},
                {"role":"worker","provider":"codex","model":"gpt-5.6-luna","reasoning_level":"max","service_tier":"priority"}
            ])
        );
        assert_eq!(
            rows(
                &database,
                "SELECT name FROM sqlite_master WHERE name IN ('suplex_issue_projections','suplex_herdr_role_sessions','suplex_model_catalog','suplex_releases')"
            ),
            json!([])
        );
        database.connection.execute_batch("INSERT INTO suplex_agents (id,name,avatar_seed,created_at,updated_at) VALUES ('agent','Agent','seed','now','now'); INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('user','User','test','admin','active','now','now',1)").unwrap();
        assert!(database.connection.execute("INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('bad','Bad','planner','seed','openai','model','medium','default','now','now')", []).is_err());
        for (id, user, agent) in [
            ("one", Some("user"), None),
            ("two", None, Some("agent")),
            ("three", None, None),
        ] {
            database.connection.execute("INSERT INTO suplex_audit_events (id,actor_user_id,actor_agent_id,action,metadata_json,created_at) VALUES (?1,?2,?3,'test','{}','now')", params![id,user,agent]).unwrap();
        }
        for (user, agent) in [(Some("user"), "agent"), (None, "missing")] {
            assert!(database.connection.execute("INSERT INTO suplex_audit_events (id,actor_user_id,actor_agent_id,action,metadata_json,created_at) VALUES ('invalid',?1,?2,'test','{}','now')", params![user,agent]).is_err());
        }
    }

    #[test]
    fn frozen_historical_rows_survive_rebuilds_and_collision_rolls_back() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/parity/migrations");
        for name in ["openrouter", "identity", "identity-collision"] {
            let expected: Value = serde_json::from_slice(
                &fs::read(fixtures.join(format!("{name}-expected.json"))).unwrap(),
            )
            .unwrap();
            let root = std::env::temp_dir().join(format!(
                "suplex-migration-regression-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&root).unwrap();
            let path = root.join("db.sqlite");
            fs::copy(fixtures.join(format!("{name}-before.sqlite")), &path).unwrap();
            let mut database = SuplexDatabase::open(&path, OpenMode::ReadWrite).unwrap();
            let migration = MIGRATIONS
                .iter()
                .find(|file| file.name == expected["migration"].as_str().unwrap())
                .unwrap();
            let before_ledger = rows(
                &database,
                "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at",
            );
            let result = database.apply_migrations(std::slice::from_ref(migration));
            assert_eq!(
                result.is_err(),
                expected["failure"].as_bool().unwrap(),
                "{name}: {result:?}"
            );
            for (table, expected_rows) in expected["tables"].as_object().unwrap() {
                assert_eq!(
                    &rows(&database, &format!("SELECT * FROM {table} ORDER BY rowid")),
                    expected_rows,
                    "{name}: {table}"
                );
            }
            if name == "identity-collision" {
                let error = result.unwrap_err().to_string();
                assert!(
                    error.contains("UNIQUE") || error.contains("PRIMARY KEY"),
                    "{error}"
                );
                assert_eq!(
                    rows(
                        &database,
                        "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at"
                    ),
                    before_ledger
                );
            } else if name == "identity" {
                for sql in [
                    "INSERT INTO suplex_external_agent_credentials (id,agent_id,credential_hash,created_at) VALUES ('second','agent_hermes_paired','second','now')",
                    "INSERT INTO suplex_hermes_pairing_codes (id,agent_id,code_hash,purpose,expires_at,created_at) VALUES ('second','agent_hermes_pending','second','initial','later','now')",
                    "INSERT INTO suplex_audit_events (id,actor_agent_id,action,metadata_json,created_at) VALUES ('invalid','missing-agent','test','{}','now')",
                    "INSERT INTO suplex_agents (id,kind,name,role,avatar_seed,profile_id,created_at,updated_at) SELECT 'duplicate',kind,name,role,avatar_seed,profile_id,created_at,updated_at FROM suplex_agents WHERE id='agent_internal_old'",
                    "INSERT INTO suplex_agents (id,kind,name,role,avatar_seed,profile_id,created_at,updated_at) SELECT 'duplicate',kind,name,role,avatar_seed,profile_id,created_at,updated_at FROM suplex_agents WHERE id='agent_hermes_paired'",
                ] {
                    assert!(database.connection.execute(sql, []).is_err(), "{sql}");
                }
                database.connection.execute("INSERT INTO suplex_audit_events (id,actor_agent_id,action,metadata_json,created_at) VALUES ('valid','agent_hermes_paired','test','{}','now')",[]).unwrap();
                assert_eq!(rows(&database, "PRAGMA foreign_key_check"), json!([]));
            }
            drop(database);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn populated_native_cutover_preserves_configuration_and_removes_phase_records() {
        let root = std::env::temp_dir().join(format!(
            "suplex-cutover-regression-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/parity/migrations/cutover-before.sqlite"),
            &path,
        )
        .unwrap();
        let database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        assert_eq!(
            rows(&database, "SELECT id FROM suplex_users"),
            json!([{"id":"user_1"},{"id":"user_development"}])
        );
        assert_eq!(
            rows(
                &database,
                "SELECT id,repository_identity,root_profile_id,worker_profile_id FROM suplex_projects"
            ),
            json!([{"id":"project_1","repository_identity":"acme/suplex","root_profile_id":"profile_native_root","worker_profile_id":"profile_native_worker"}])
        );
        assert_eq!(rows(&database, "SELECT id FROM suplex_tasks"), json!([]));
        assert_eq!(
            rows(
                &database,
                "SELECT name FROM sqlite_master WHERE name IN ('suplex_delivery_reviews','suplex_delivery_review_attempts','suplex_developer_executions','suplex_issue_projections','suplex_herdr_role_sessions','suplex_releases')"
            ),
            json!([])
        );
        assert_eq!(
            rows(&database, "SELECT role FROM suplex_profiles ORDER BY role"),
            json!([{"role":"root"},{"role":"root"},{"role":"worker"}])
        );
        assert_eq!(rows(&database, "PRAGMA foreign_key_check"), json!([]));
        drop(database);
        let reopened = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        assert_eq!(
            rows(&reopened, "SELECT COUNT(*) AS n FROM suplex_profiles"),
            json!([{"n":3}])
        );
        assert_eq!(
            reopened.schema_status().unwrap().state,
            SchemaState::Current
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queued_upgrade_preserves_control_evidence_and_historical_receipts() {
        let root =
            std::env::temp_dir().join(format!("suplex-queued-regression-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/parity/migrations/queued-before.sqlite"),
            &path,
        )
        .unwrap();
        let mut database = SuplexDatabase::open(&path, OpenMode::ReadWrite).unwrap();
        let mut expected = rows(
            &database,
            "SELECT * FROM suplex_task_controls ORDER BY task_id",
        );
        for control in expected.as_array_mut().unwrap() {
            control["queue_priority"] = json!(0);
            if control["task_id"] == "queued" {
                control["status"] = json!("queued");
            }
        }
        let foreign_keys = rows(&database, "PRAGMA foreign_key_list(suplex_task_controls)");
        database.apply_migrations(MIGRATIONS).unwrap();
        database.apply_migrations(MIGRATIONS).unwrap();
        assert_eq!(
            rows(
                &database,
                "SELECT * FROM suplex_task_controls ORDER BY task_id"
            ),
            expected
        );
        assert_eq!(
            rows(&database, "PRAGMA foreign_key_list(suplex_task_controls)"),
            foreign_keys
        );
        assert_eq!(
            rows(
                &database,
                "SELECT name FROM pragma_table_info('suplex_tasks') WHERE name='start_queued'"
            ),
            json!([])
        );
        assert_eq!(
            rows(
                &database,
                "SELECT name FROM sqlite_master WHERE name='suplex_tasks_start_queued_idx'"
            ),
            json!([])
        );
        let receipt = rows(
            &database,
            "SELECT request_hash AS hash,result_json AS result FROM suplex_hermes_task_command_receipts WHERE task_id='queued'",
        );
        assert_eq!(receipt[0]["hash"], json!("original-hash"));
        assert_eq!(
            serde_json::from_str::<Value>(receipt[0]["result"].as_str().unwrap()).unwrap(),
            json!({"status":"queued","revision":"historical-revision","queue":{"waitingOn":[{"id":"queued","status":"queued"}]},"blockedBy":[{"id":"queued","status":"queued"}]})
        );
        assert!(
            database
                .connection
                .execute(
                    "UPDATE suplex_task_controls SET status='invalid' WHERE task_id='queued'",
                    []
                )
                .is_err()
        );
        database
            .connection
            .execute(
                "UPDATE suplex_task_controls SET status='active' WHERE task_id='queued'",
                [],
            )
            .unwrap();
        assert_ne!(
            rows(
                &database,
                "SELECT status_changed_at AS changed FROM suplex_task_controls WHERE task_id='queued'"
            )[0]["changed"],
            json!("historical")
        );
        drop(database);
        fs::remove_dir_all(root).unwrap();
    }
}
