//! Native exception reports for PostHog Error Tracking: panics from any `suplex`
//! command, and handled failures such as a 500 response or a failed background
//! loop. `docs/telemetry.md` lists the event and its properties.
//!
//! A panic hook records into a file spool under the installation root. The host
//! forwards the spool with the rest of its telemetry, under the same gates: a
//! report is recorded only while the build has a key, the environment allows it,
//! the Environment setting is on, and the notice was answered, and the host sends
//! it only while those hold and the report is not older than the last time
//! telemetry turned on. The spool stays bounded: one file per failure, a count
//! for repeats, and an hour of quiet after a send.
//!
//! Reports hold no panic or error message, payload, or path outside the Suplex
//! source tree (see `suplex-exception`). A failure here never changes the
//! operation that failed.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, PoisonError, RwLock},
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use suplex_exception::{Report, handled_report, install_panic_hook, spool};

use super::{Config, durable_event, state};
use crate::platform::{
    config::Installation,
    database::{OpenMode, SuplexDatabase},
    environment_settings,
};
use crate::shared::time::rfc3339_millis;

const SOURCE: &str = "host";
/// Exceptions in one send.
pub(super) const PER_TICK: usize = 10;
const QUIET: Duration = Duration::from_secs(60);
const MAX_QUIET_KEYS: usize = 128;

#[derive(Clone, Debug)]
struct Destination {
    spool: PathBuf,
    database: PathBuf,
    installation_id: String,
}

impl From<&Installation> for Destination {
    fn from(installation: &Installation) -> Self {
        Self {
            spool: spool_directory(&installation.root),
            database: installation.database.clone(),
            installation_id: installation.installation_id.clone(),
        }
    }
}

type Handler = Arc<dyn Fn(Report) + Send + Sync>;

static DESTINATION: OnceLock<Destination> = OnceLock::new();
static HANDLER: RwLock<Option<(&'static str, Handler)>> = RwLock::new(None);
static RECENT: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Where reports wait for the host to send them. The desktop shell writes here too.
pub fn spool_directory(root: &Path) -> PathBuf {
    root.join("exceptions")
}

/// Reports every panic in this process. Call first in `main`: later code, and
/// every subcommand, is covered.
pub fn install() {
    install_panic_hook(SOURCE, Box::new(dispatch));
}

/// Names this process's installation, so a panic does not have to find it.
pub fn configure(installation: &Installation) {
    let _ = DESTINATION.set(installation.into());
}

/// Sends reports from this process to `handler` instead of the native spool,
/// as `source`. The hosted service uses this: it has no installation, so it
/// never reads the host's gates.
pub fn route_to(source: &'static str, handler: impl Fn(Report) + Send + Sync + 'static) {
    *HANDLER.write().unwrap_or_else(PoisonError::into_inner) = Some((source, Arc::new(handler)));
}

fn source() -> &'static str {
    HANDLER
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map_or(SOURCE, |(source, _)| source)
}

fn dispatch(report: Report) {
    let routed = HANDLER
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    match routed {
        Some((source, handler)) => handler(report.with_source(source)),
        None => record(&report),
    }
}

/// Writes `report` to the spool when every gate allows it. The host decides
/// again when it sends.
fn record(report: &Report) {
    let destination = match DESTINATION.get() {
        Some(destination) => destination.clone(),
        None => match Installation::load() {
            Ok(installation) => Destination::from(&installation),
            Err(_) => return,
        },
    };
    let environment_allows = super::config(&destination.installation_id).is_some();
    if recording_allowed(&destination, environment_allows) {
        let _ = spool::record(&destination.spool, report);
    }
}

/// `environment_allows` is the build key and the opt-out variables; the
/// database holds the Environment setting and the notice.
fn recording_allowed(destination: &Destination, environment_allows: bool) -> bool {
    environment_allows
        && SuplexDatabase::open(&destination.database, OpenMode::ReadOnly).is_ok_and(|database| {
            environment_settings::read(&database).is_ok_and(|settings| settings.telemetry_enabled)
                && state(&database)
                    .ok()
                    .flatten()
                    .is_some_and(|state| state.notice_at.is_some())
        })
}

/// One report per failure and minute from this process. A failing request or
/// loop would otherwise capture a backtrace each time.
fn quiet(key: &str) -> bool {
    let mut recent = RECENT.lock().unwrap_or_else(PoisonError::into_inner);
    let recent = recent.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    if recent.len() >= MAX_QUIET_KEYS {
        recent.retain(|_, at| now.duration_since(*at) < QUIET);
    }
    match recent.get(key) {
        Some(at) if now.duration_since(*at) < QUIET => true,
        _ => {
            if recent.len() < MAX_QUIET_KEYS {
                recent.insert(key.to_owned(), now);
            }
            false
        }
    }
}

/// Reports a handled failure with the caller's frames. `attributes` are fixed
/// names such as a route template; anything outside the route alphabet is dropped.
pub fn report_handled(
    kind: &'static str,
    mechanism: &'static str,
    attributes: &[(&'static str, &str)],
) {
    let key = format!("{kind}{attributes:?}");
    if quiet(&key) {
        return;
    }
    let mut report = handled_report(source(), kind, mechanism);
    for (name, value) in attributes {
        report = report.attribute(name, value);
    }
    // The spool write and database read stay off the caller's thread.
    let _ = std::thread::Builder::new()
        .name("exception-report".into())
        .spawn(move || dispatch(report));
}

/// A request that ended in 500. `route` is the matched route template, never the path.
pub fn report_internal_error(method: &str, route: &str) {
    let method = match method {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => method,
        _ => "OTHER",
    };
    report_handled(
        "InternalServerError",
        "http_internal_error",
        &[("http_method", method), ("http_route", route)],
    );
}

/// A background loop pass that failed in a way no caller handles. `name` is a fixed identifier.
pub fn report_loop_failure(name: &'static str) {
    report_handled(
        "BackgroundLoopFailure",
        "background_loop",
        &[("loop", name)],
    );
}

/// PostHog events for pending reports, and the reports themselves for acknowledgement.
pub(super) fn events(config: &Config, reports: &[Report]) -> Vec<Value> {
    reports
        .iter()
        .map(|report| {
            let timestamp = DateTime::<Utc>::from_timestamp_millis(report.recorded_at_ms)
                .map(rfc3339_millis)
                .unwrap_or_else(|| rfc3339_millis(Utc::now()));
            durable_event(
                config,
                "$exception",
                None,
                &timestamp,
                Value::Object(report.properties()),
                &format!("exception:{}:{}", report.fingerprint, report.recorded_at_ms),
            )
        })
        .collect()
}

/// Gives a test sole use of the process-wide hook and routes its reports to a fresh list.
#[cfg(test)]
pub(crate) fn isolate_for_test() -> (std::sync::MutexGuard<'static, ()>, Arc<Mutex<Vec<Report>>>) {
    static LOCK: Mutex<()> = Mutex::new(());
    static HOOK: std::sync::Once = std::sync::Once::new();
    let guard = LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    HOOK.call_once(install);
    let collected = Arc::new(Mutex::new(Vec::new()));
    let sink = collected.clone();
    route_to("host", move |report| {
        sink.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(report);
    });
    (guard, collected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;

    fn destination() -> (Destination, SuplexDatabase) {
        let directory = std::env::temp_dir().join(format!(
            "suplex-exceptions-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let database =
            SuplexDatabase::open(&directory.join("suplex.db"), OpenMode::Migrate).unwrap();
        (
            Destination {
                spool: spool_directory(&directory),
                database: directory.join("suplex.db"),
                installation_id: "install-1".to_owned(),
            },
            database,
        )
    }

    #[test]
    fn recording_follows_the_environment_the_setting_and_the_notice() {
        let (destination, mut database) = destination();
        // The notice is unanswered.
        assert!(!recording_allowed(&destination, true));
        super::super::acknowledge(&mut database, Utc::now()).unwrap();
        assert!(recording_allowed(&destination, true));
        // DO_NOT_TRACK, SUPLEX_TELEMETRY=0, or a build without a key.
        assert!(!recording_allowed(&destination, false));
        let current = environment_settings::read(&database).unwrap();
        environment_settings::update(
            &mut database,
            environment_settings::EnvironmentSettings {
                telemetry_enabled: false,
                ..current
            },
        )
        .unwrap();
        assert!(!recording_allowed(&destination, true));
        // An installation that does not exist records nothing.
        let missing = Destination {
            database: destination.database.with_file_name("missing.db"),
            ..destination
        };
        assert!(!recording_allowed(&missing, true));
    }

    #[test]
    fn a_failing_request_or_loop_reports_once_a_minute() {
        let (_guard, collected) = isolate_for_test();
        let route = format!("/quiet-{}/{{id}}", uuid::Uuid::new_v4().simple());
        for _ in 0..50 {
            report_internal_error("GET", &route);
        }
        report_internal_error("POST", &route);
        std::thread::sleep(Duration::from_millis(500));
        let sent: Vec<Report> = collected
            .lock()
            .unwrap()
            .iter()
            .filter(|report| report.attributes.get("http_route") == Some(&route))
            .cloned()
            .collect();
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert!(sent.iter().all(|report| report.handled));
        assert!(
            sent.iter()
                .all(|report| report.mechanism == "http_internal_error")
        );
    }

    #[test]
    fn route_templates_and_methods_are_all_a_report_keeps() {
        let (_guard, collected) = isolate_for_test();
        let marker = uuid::Uuid::new_v4().simple().to_string();
        report_internal_error(&format!("SECRET-{marker}"), "/Users/ada/private repo");
        report_loop_failure("task_scheduler");
        std::thread::sleep(Duration::from_millis(500));
        let reports = collected.lock().unwrap();
        let report = reports
            .iter()
            .find(|report| {
                report
                    .attributes
                    .get("http_method")
                    .is_some_and(|method| method == "OTHER")
            })
            .expect("the report exists");
        assert!(!report.attributes.contains_key("http_route"));
        assert!(!serde_json::to_string(report).unwrap().contains(&marker));
    }
}
