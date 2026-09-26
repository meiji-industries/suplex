//! Periodic native usage collection (`src/tasks/analytics/collector.ts`).

use std::{
    error::Error,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::shared::time::now_millis_rfc3339;
use chrono::{DateTime, Utc};
use tokio::sync::watch;

use super::{CacheTokens, TaskUsage, Tokens, failed, observe, record, session_observations};
use crate::{
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    profiles::model_pricing::{ModelPricingCatalog, ModelsDevCatalogReader},
    runtimes::{task_harness::ReaderSession, task_harness_registry},
};

/// The provider instance home of the session profile, when it has one.
fn instance_home(database_path: &Path, session_id: &str) -> Option<PathBuf> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly).ok()?;
    let profile: String = database
        .connection()
        .query_row(
            "SELECT profile_json FROM suplex_task_sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str::<serde_json::Value>(&profile).ok()?["instanceHomeDirectory"]
        .as_str()
        .map(PathBuf::from)
}

pub struct Session {
    pub id: String,
    pub native_session_id: String,
    pub kind: String,
}

/// `AnalyticsHistoryReader.read`: the native usage of one session, read by the
/// runtime that owns it.
pub fn read_native_usage(
    database_path: &Path,
    session: &Session,
    instance_home: Option<&Path>,
    pricing: Option<&ModelPricingCatalog>,
) -> Result<Vec<TaskUsage>, Box<dyn Error>> {
    let native = session.native_session_id.as_str();
    let reader = task_harness_registry::native_session_reader(native)
        .ok_or("Native timeline reader is not available")?;
    let observed = reader.timeline(
        &ReaderSession {
            database_path,
            session_id: &session.id,
            native_session_id: native,
            instance_home_directory: instance_home,
        },
        pricing,
    )?;
    Ok(observed
        .usage
        .into_iter()
        .map(|entry| TaskUsage {
            session_id: native.to_owned(),
            completed_at: entry
                .completed_at_ms
                .filter(|_| observed.live_message_id.as_deref() != Some(entry.message_id.as_str()))
                .map(|value| value as f64),
            steps: entry.steps,
            message_id: entry.message_id,
            turn_id: entry.turn_id,
            role: session.kind.clone(),
            provider: entry.provider.to_owned(),
            model: entry.model,
            started_at: entry.started_at_ms as f64,
            failed: entry.failed,
            summary: entry.summary,
            cost: entry.cost_usd,
            subsidized: entry.subsidized,
            tokens: Tokens {
                input: entry.tokens.input,
                output: entry.tokens.output,
                reasoning: entry.tokens.reasoning,
                cache: CacheTokens {
                    read: entry.tokens.cache_read,
                    write: entry.tokens.cache_write,
                },
            },
            source: entry.source.into(),
        })
        .collect())
}

pub type ReadUsage<'a> = dyn FnMut(&Session) -> Result<Vec<TaskUsage>, Box<dyn Error>> + 'a;

/// One pass over every task: observe its lifecycle, then refresh each native
/// session whose saved usage is due. A read failure keeps the saved usage and
/// marks the session stale.
pub fn collect(
    database: &mut SuplexDatabase,
    startup: bool,
    now: DateTime<Utc>,
    read_usage: &mut ReadUsage<'_>,
    report: &mut dyn FnMut(Box<dyn Error>),
) -> DatabaseResult<()> {
    let tasks = {
        let mut statement = database.connection().prepare(
            "SELECT t.id, c.status, CASE WHEN c.human_question IS NOT NULL AND c.human_question <> '' THEN c.human_question_id END, CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(c.updated_at, t.updated_at)) THEN t.updated_at ELSE c.updated_at END, t.archived_at IS NOT NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id ORDER BY julianday(CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(c.updated_at, t.updated_at)) THEN t.updated_at ELSE c.updated_at END) DESC, t.id",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (task_id, status, question, updated_at, archived) in tasks {
        let mut pass = || -> DatabaseResult<()> {
            observe(
                database,
                &task_id,
                &status,
                question.as_deref(),
                &now_millis_rfc3339(),
            )?;
            let observations = session_observations(database, &task_id)?;
            let sessions = {
                let mut statement = database.connection().prepare(
                    "SELECT id, native_session_id, kind FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id IS NOT NULL ORDER BY created_at, id",
                )?;
                statement
                    .query_map([&task_id], |row| {
                        Ok(Session {
                            id: row.get(0)?,
                            native_session_id: row.get(1)?,
                            kind: row.get(2)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for session in sessions {
                let harness = task_harness_registry::session_harness(&session.native_session_id);
                let previous = observations
                    .iter()
                    .find(|value| value.session_id == session.id);
                let last_attempt = previous
                    .and_then(|value| value.error_at.as_deref().or(value.observed_at.as_deref()));
                let changed = previous
                    .and_then(|value| value.observed_at.as_deref())
                    .is_some_and(|observed| updated_at.as_str() > observed);
                let refresh_ms = if startup && matches!(harness, "codex" | "devin") {
                    0
                } else if previous.is_some_and(|value| value.error_at.is_some()) {
                    300_000
                } else if !changed
                    && (archived || !matches!(status.as_str(), "active" | "waiting_human"))
                {
                    900_000
                } else {
                    0
                };
                if let Some(last) = last_attempt
                    && DateTime::parse_from_rfc3339(last).is_ok_and(|last| {
                        now.timestamp_millis() - last.timestamp_millis() < refresh_ms
                    })
                {
                    continue;
                }
                let started = now_millis_rfc3339();
                match read_usage(&session) {
                    Ok(usage) => record(database, &task_id, &session.id, &usage, &started)?,
                    Err(error) => {
                        failed(database, &task_id, &session.id, &now_millis_rfc3339())?;
                        report(error);
                    }
                }
            }
            Ok(())
        };
        if let Err(error) = pass() {
            report(error);
        }
    }
    Ok(())
}

/// Collect now, then every 30 seconds until shutdown.
pub fn spawn(database_path: PathBuf, mut shutdown: watch::Receiver<bool>) {
    tokio::spawn(async move {
        let reader = ModelsDevCatalogReader::new().ok().map(Arc::new);
        let mut startup = true;
        loop {
            let path = database_path.clone();
            let reader = reader.clone();
            let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let mut database =
                    SuplexDatabase::open(&path, OpenMode::ReadWrite).map_err(|e| e.to_string())?;
                let mut pricing: Option<Option<Arc<ModelPricingCatalog>>> = None;
                let mut read = |session: &Session| -> Result<Vec<TaskUsage>, Box<dyn Error>> {
                    let catalog = pricing.get_or_insert_with(|| {
                        reader
                            .as_ref()
                            .and_then(|reader| crate::shared::blocking::block_on(|| reader.read()))
                    });
                    let home = instance_home(&path, &session.id);
                    read_native_usage(&path, session, home.as_deref(), catalog.as_deref())
                };
                let mut report = |error: Box<dyn Error>| {
                    eprintln!("Analytics observation failed: {error}");
                };
                collect(&mut database, startup, Utc::now(), &mut read, &mut report)
                    .map_err(|error| error.to_string())
            })
            .await;
            if let Ok(Err(error)) = result {
                eprintln!("Analytics observation failed: {error}");
            }
            startup = false;
            tokio::select! {
                changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return; },
                () = tokio::time::sleep(Duration::from_secs(30)) => {},
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;
    use crate::{profiles::model_pricing::ModelPricing, tasks::analytics};

    fn session(native: &str, kind: &str) -> Session {
        Session {
            id: "suplex-session".into(),
            native_session_id: native.into(),
            kind: kind.into(),
        }
    }

    fn runtime(root: &Path) -> (PathBuf, PathBuf) {
        let database_path = root.join("suplex.sqlite");
        let directory =
            crate::runtimes::native::session_directory(&database_path, "suplex-session").unwrap();
        fs::create_dir_all(&directory).unwrap();
        (database_path, directory)
    }

    fn lines(values: &[serde_json::Value]) -> String {
        values.iter().map(|value| format!("{value}\n")).collect()
    }

    #[tokio::test]
    async fn opencode_usage_keeps_estimates_steps_and_summary_through_both_stores() {
        use serde_json::json;
        let (seed, database) = task_database();
        drop(database);
        let root =
            std::env::temp_dir().join(format!("suplex-usage-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("suplex.sqlite");
        fs::rename(seed, &path).unwrap();
        let (url, _) = crate::runtimes::opencode::client::fake::serve(|request| match request.path.as_str() {
            "/session/status" => (200, json!({"ses_live":{"type":"idle"}}).to_string()),
            "/session/ses_live/message" => {
                let tokens = json!({"input":100,"output":0,"reasoning":0,"cache":{"read":0,"write":0}});
                let message = |id, cost, parts, time, summary, model| json!({"info":{"id":id,"sessionID":"ses_live","role":"assistant","time":time,"parentID":"msg_user","modelID":model,"providerID":"openai","mode":"primary","agent":"suplex-root","path":{"cwd":"/repo","root":"/repo"},"cost":cost,"tokens":tokens,"summary":summary},"parts":parts});
                let step = |id| json!({"type":"step-finish","id":id,"cost":0,"tokens":tokens});
                (200, json!([
                    message("msg_steps", 99, json!([step("one"),step("one"),step("two")]), json!({"created":100,"completed":200}), true, "model"),
                    message("msg_billed", 3, json!([]), json!({"created":300,"completed":400}), false, "model"),
                    message("msg_unfinished", 0, json!([]), json!({"created":500}), false, "unknown")
                ]).to_string())
            },
            _ => (404, "{}".into()),
        }).await;
        let runtime =
            crate::runtimes::task_harness::task_session_runtime_directory(&path, "s").unwrap();
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("server.json"), json!({"pid":4321,"baseUrl":url,"password":"a".repeat(64),"directory":"/repo","executable":"/bin/opencode","generation":"b775df17-718a-4cb2-8e23-6912b8aa0d39","configHash":"a".repeat(64),"processIdentity":{"command":"opencode serve","executable":"/bin/opencode","argv":["opencode","serve"],"processGroup":4321,"startTime":"start","ownerUid":501}}).to_string()).unwrap();
        let path_for_read = path.clone();
        tokio::task::spawn_blocking(move || {
            let pricing = ModelPricingCatalog::from([("openai/model".into(), ModelPricing { input:2.0, output:5.0, cache_read:0.5, cache_write:1.0 })]);
            let mut database = SuplexDatabase::open(&path_for_read, OpenMode::ReadWrite).unwrap();
            database.connection().execute("UPDATE suplex_task_sessions SET native_session_id='ses_live' WHERE id='s'", []).unwrap();
            let usage = read_native_usage(&path_for_read, &Session { id:"s".into(), native_session_id:"ses_live".into(), kind:"root".into() }, None, Some(&pricing)).unwrap();
            let by_id = |id: &str| usage.iter().find(|entry| entry.message_id == id).unwrap();
            let steps = by_id("msg_steps");
            assert_eq!((steps.steps, steps.source.as_str(), steps.summary, steps.subsidized), (2.0,"steps",true,true));
            assert!((steps.cost - 0.0004).abs() < 1e-12);
            assert_eq!((by_id("msg_billed").cost, by_id("msg_billed").subsidized), (3.0,false));
            assert_eq!((by_id("msg_unfinished").steps, by_id("msg_unfinished").completed_at, by_id("msg_unfinished").cost), (0.0,None,0.0));
            record(&mut database, "t", "s", &usage, &now_millis_rfc3339()).unwrap();
            let saved = analytics::read(&database, "t").unwrap().usage;
            for entry in &usage {
                assert_eq!(serde_json::to_value(saved.iter().find(|saved| saved.message_id == entry.message_id).unwrap()).unwrap(), serde_json::to_value(entry).unwrap());
            }
            let timeline = task_harness_registry::native_session_reader("ses_live").unwrap().timeline(&ReaderSession { database_path:&path_for_read, session_id:"s", native_session_id:"ses_live", instance_home_directory:None }, Some(&pricing)).unwrap();
            crate::tasks::limits::replace_observed_usage(&mut database, "t", vec![("ses_live".into(),"root".into(),timeline)]).unwrap();
            for entry in &usage {
                let raw: String = database.connection().query_row("SELECT snapshot FROM suplex_task_usage WHERE task_id='t' AND message_id=?1", [&entry.message_id], |row| row.get(0)).unwrap();
                assert_eq!(serde_json::to_value(serde_json::from_str::<TaskUsage>(&raw).unwrap()).unwrap(), serde_json::to_value(entry).unwrap());
            }
        }).await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collector_refreshes_devin_and_final_timing_without_coupling_delivery_to_storage() {
        for native in ["devin-old", "ses_finished"] {
            let (path, mut database) = task_database();
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_sessions SET native_session_id=?1 WHERE id='s'",
                    [native],
                )
                .unwrap();
            let old = TaskUsage {
                session_id: native.into(),
                started_at: 200.0,
                completed_at: None,
                ..usage_with(0.0)
            };
            let observed =
                crate::shared::time::rfc3339_millis(Utc::now() - chrono::Duration::seconds(1));
            record(
                &mut database,
                "t",
                "s",
                std::slice::from_ref(&old),
                &observed,
            )
            .unwrap();
            let refreshed = TaskUsage {
                started_at: 100.0,
                completed_at: Some(300.0),
                ..old
            };
            let mut reads = 0;
            let mut read = |_: &Session| -> Result<Vec<TaskUsage>, Box<dyn Error>> {
                reads += 1;
                Ok(vec![refreshed.clone()])
            };
            let mut report = |error: Box<dyn Error>| panic!("{error}");
            collect(
                &mut database,
                native == "devin-old",
                Utc::now(),
                &mut read,
                &mut report,
            )
            .unwrap();
            collect(&mut database, false, Utc::now(), &mut read, &mut report).unwrap();
            assert_eq!(reads, 1);
            let saved = analytics::read(&database, "t").unwrap();
            assert_eq!(
                (saved.usage[0].started_at, saved.usage[0].completed_at),
                (100.0, Some(300.0))
            );
            database
                .connection()
                .execute("DROP TABLE suplex_task_analytics_sessions", [])
                .unwrap();
            let mut errors = 0;
            collect(
                &mut database,
                false,
                Utc::now(),
                &mut |_| Ok(vec![refreshed.clone()]),
                &mut |_| errors += 1,
            )
            .unwrap();
            assert_eq!(errors, 1);
            assert_eq!(
                database
                    .connection()
                    .query_row(
                        "SELECT status FROM suplex_task_controls WHERE task_id='t'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "delivered"
            );
            drop(database);
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn analytics_reads_codex_usage_and_estimates_its_cost_from_the_turn_log() {
        let root =
            std::env::temp_dir().join(format!("suplex-codex-analytics-{}", uuid::Uuid::new_v4()));
        let (database_path, directory) = runtime(&root);
        let native = "codex-11111111-2222-4333-8444-555555555555";
        let thread =
            json!({"type":"thread.started","thread_id":"11111111-2222-4333-8444-555555555555"});
        fs::write(directory.join("turn-turn-1.jsonl"), lines(&[
            thread.clone(),
            json!({"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Done."}}),
            json!({"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":100,"output_tokens":50,"reasoning_output_tokens":20}}),
        ])).unwrap();
        let dispatch = |generation: &str, turn: &str, model: &str| {
            fs::write(directory.join(format!("dispatch-{generation}.json")), json!({
                "generation": generation, "turnId": turn, "sessionID": native, "pid": 999_999,
                "processIdentity": {"command":"codex","executable":"/opt/codex/codex","argv":["/opt/codex/codex","exec","--json","-m",model,"-"],"processGroup":999_999,"startTime":"0","ownerUid":0},
            }).to_string()).unwrap();
        };
        dispatch(
            "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e",
            "turn-1",
            "gpt-5.6-sol",
        );
        dispatch(
            "1f1e2d3c-4b5a-4968-8778-695a4b3c2d1e",
            "turn-2",
            "gpt-6-astra",
        );
        let price = ModelPricing {
            input: 5.0,
            output: 30.0,
            cache_read: 0.5,
            cache_write: 6.25,
        };
        let pricing = ModelPricingCatalog::from([
            ("openai/gpt-5.6-sol".to_owned(), price),
            ("openai/gpt-6-astra".to_owned(), price),
        ]);
        let session = session(native, "worker");
        let usage = read_native_usage(&database_path, &session, None, Some(&pricing)).unwrap();
        assert_eq!(usage.len(), 1);
        let first = &usage[0];
        assert_eq!(
            (
                first.session_id.as_str(),
                first.message_id.as_str(),
                first.model.as_str(),
                first.failed,
                first.subsidized,
                first.source.as_str()
            ),
            (native, "turn-1", "gpt-5.6-sol", false, true, "message")
        );
        assert_eq!(
            first.tokens,
            Tokens {
                input: 300.0,
                output: 30.0,
                reasoning: 20.0,
                cache: CacheTokens {
                    read: 600.0,
                    write: 100.0
                }
            }
        );
        assert!((first.cost - 0.003925).abs() < 1e-10);
        let second = |input: u64, cached: u64, written: u64, output: u64, reasoning: u64| {
            lines(&[
                thread.clone(),
                json!({"type":"turn.completed","usage":{"input_tokens":input,"cached_input_tokens":cached,"cache_write_input_tokens":written,"output_tokens":output,"reasoning_output_tokens":reasoning}}),
            ])
        };
        fs::write(
            directory.join("turn-turn-2.jsonl"),
            second(2_000, 1_200, 200, 100, 40),
        )
        .unwrap();
        let resumed = read_native_usage(&database_path, &session, None, Some(&pricing)).unwrap();
        assert_eq!(
            resumed
                .iter()
                .map(|entry| (entry.model.as_str(), entry.tokens.input))
                .collect::<Vec<_>>(),
            [("gpt-5.6-sol", 300.0), ("gpt-6-astra", 300.0)]
        );
        assert!((resumed[1].cost - first.cost).abs() < 1e-12);
        fs::write(
            directory.join("turn-turn-2.jsonl"),
            second(3_000, 1_800, 300, 150, 60),
        )
        .unwrap();
        let refreshed = read_native_usage(&database_path, &session, None, Some(&pricing)).unwrap();
        assert!((refreshed[1].cost - 2.0 * first.cost).abs() < 1e-10);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_usage_is_unpriced_without_a_catalog_entry_and_missing_logs_are_not_zero_usage() {
        let root =
            std::env::temp_dir().join(format!("suplex-codex-analytics-{}", uuid::Uuid::new_v4()));
        let (database_path, directory) = runtime(&root);
        let missing = read_native_usage(
            &database_path,
            &session("codex-missing", "worker"),
            None,
            None,
        );
        assert_eq!(
            missing.unwrap_err().to_string(),
            "Codex turn logs are missing"
        );
        fs::write(
            directory.join("turn-turn-1.jsonl"),
            lines(&[
                json!({"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}),
            ]),
        )
        .unwrap();
        let usage = read_native_usage(
            &database_path,
            &session("codex-unpriced", "root"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (usage[0].model.as_str(), usage[0].cost, usage[0].subsidized),
            ("unknown", 0.0, false)
        );
        assert_eq!(
            usage[0].tokens,
            Tokens {
                input: 10.0,
                output: 2.0,
                ..Tokens::default()
            }
        );
        fs::remove_file(directory.join("turn-turn-1.jsonl")).unwrap();
        fs::write(
            directory.join("turn-msg_0001.jsonl"),
            lines(&[
                json!({"type":"thread.started","thread_id":"native-thread"}),
                json!({"type":"turn.started"}),
            ]),
        )
        .unwrap();
        assert_eq!(
            read_native_usage(
                &database_path,
                &session("codex-incomplete", "worker"),
                None,
                None
            )
            .unwrap(),
            vec![]
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn task_database() -> (PathBuf, SuplexDatabase) {
        let path =
            std::env::temp_dir().join(format!("suplex-collector-{}.sqlite", uuid::Uuid::new_v4()));
        let database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let time = now_millis_rfc3339();
        let connection = database.connection();
        connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('c','C','active',?1)", [&time]).unwrap();
        connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('p','c','P','/tmp/r','/tmp/w',NULL,'main','','','root','worker','{}',?1,?1)", [&time]).unwrap();
        connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('u', 'U', 'u', 'admin', 'active', ?1, ?1, 1)", [&time]).unwrap();
        connection.execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at) VALUES ('t','c','p','T','','{}','k','h','u',?1,?1)", [&time]).unwrap();
        connection.execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at) VALUES ('t','T','local_worktree','{}','delivered','{}','{}','standard','{}','{}',?1,?1,?1)", [&time]).unwrap();
        connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('s','t','root',1,1,'live','codex-old',?1,?1)", [&time]).unwrap();
        (path, database)
    }

    fn usage_with(cost: f64) -> TaskUsage {
        TaskUsage {
            session_id: "codex-old".into(),
            cost,
            ..analytics::tests::entry("msg", cost)
        }
    }

    #[test]
    fn the_first_pass_refreshes_a_delivered_codex_session_despite_a_recent_observation() {
        let (path, mut database) = task_database();
        record(
            &mut database,
            "t",
            "s",
            &[usage_with(10.0)],
            &now_millis_rfc3339(),
        )
        .unwrap();
        let mut reads = 0;
        let mut read = |_: &Session| -> Result<Vec<TaskUsage>, Box<dyn Error>> {
            reads += 1;
            Ok(vec![usage_with(3.0)])
        };
        let mut report = |error: Box<dyn Error>| panic!("{error}");
        collect(&mut database, true, Utc::now(), &mut read, &mut report).unwrap();
        collect(&mut database, false, Utc::now(), &mut read, &mut report).unwrap();
        assert_eq!(reads, 1);
        assert_eq!(analytics::read(&database, "t").unwrap().usage[0].cost, 3.0);
        let events = analytics::read(&database, "t").unwrap().events;
        assert_eq!(
            events
                .iter()
                .map(|event| event.status.as_str())
                .collect::<Vec<_>>(),
            ["delivered"]
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_failed_read_keeps_saved_usage_marks_the_session_stale_and_retries_after_five_minutes() {
        let (path, mut database) = task_database();
        database
            .connection()
            .execute("UPDATE suplex_task_controls SET status = 'active'", [])
            .unwrap();
        let observed =
            crate::shared::time::rfc3339_millis(Utc::now() - chrono::Duration::minutes(10));
        record(
            &mut database,
            "t",
            "s",
            &[TaskUsage {
                completed_at: None,
                ..usage_with(1.0)
            }],
            &observed,
        )
        .unwrap();
        let (mut reads, mut errors, mut available) = (0, 0, false);
        let pass = |database: &mut SuplexDatabase,
                    now: DateTime<Utc>,
                    available: bool,
                    reads: &mut i32,
                    errors: &mut i32| {
            let mut read = |_: &Session| -> Result<Vec<TaskUsage>, Box<dyn Error>> {
                *reads += 1;
                if available {
                    Ok(vec![usage_with(2.0)])
                } else {
                    Err("history is missing".into())
                }
            };
            let mut report = |_: Box<dyn Error>| *errors += 1;
            collect(database, false, now, &mut read, &mut report).unwrap();
        };
        pass(
            &mut database,
            Utc::now(),
            available,
            &mut reads,
            &mut errors,
        );
        let saved = analytics::read(&database, "t").unwrap();
        assert_eq!(
            (
                reads,
                errors,
                saved.usage[0].completed_at,
                saved.sessions[0].observed_at.as_deref()
            ),
            (1, 1, None, Some(observed.as_str()))
        );
        assert!(saved.sessions[0].error_at.is_some());
        pass(
            &mut database,
            Utc::now(),
            available,
            &mut reads,
            &mut errors,
        );
        assert_eq!(reads, 1);
        available = true;
        pass(
            &mut database,
            Utc::now() + chrono::Duration::minutes(6),
            available,
            &mut reads,
            &mut errors,
        );
        let recovered = analytics::read(&database, "t").unwrap();
        assert_eq!(
            (
                reads,
                recovered.usage[0].cost,
                recovered.sessions[0].error_at.as_deref()
            ),
            (2, 2.0, None)
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_session_observation_replaces_its_old_rows_without_deleting_another_session() {
        let (path, mut database) = task_database();
        let time = now_millis_rfc3339();
        database.connection().execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('w','t','worker',1,1,'live','codex-worker',?1,?1)", [&time]).unwrap();
        let entry = |native: &str, message: &str, cost: f64| TaskUsage {
            session_id: native.into(),
            ..analytics::tests::entry(message, cost)
        };
        record(
            &mut database,
            "t",
            "s",
            &[entry("codex-old", "msg_old", 10.0)],
            &time,
        )
        .unwrap();
        record(
            &mut database,
            "t",
            "w",
            &[entry("codex-worker", "msg_worker", 7.0)],
            &time,
        )
        .unwrap();
        record(
            &mut database,
            "t",
            "s",
            &[entry("codex-old", "msg_new", 3.0)],
            &time,
        )
        .unwrap();
        let saved = |database: &SuplexDatabase| {
            let mut rows = analytics::read(database, "t")
                .unwrap()
                .usage
                .into_iter()
                .map(|entry| (entry.session_id, entry.message_id, entry.cost))
                .collect::<Vec<_>>();
            rows.sort_by(|left, right| left.1.cmp(&right.1));
            rows
        };
        let expected = vec![
            ("codex-old".to_owned(), "msg_new".to_owned(), 3.0),
            ("codex-worker".to_owned(), "msg_worker".to_owned(), 7.0),
        ];
        assert_eq!(saved(&database), expected);
        assert_eq!(
            record(&mut database, "t", "s", &[], &time)
                .unwrap_err()
                .to_string(),
            "Native usage has no completed observations"
        );
        assert_eq!(saved(&database), expected);
        let _ = fs::remove_file(path);
    }
}
