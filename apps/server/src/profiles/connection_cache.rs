//! One host-wide sign-in observation per provider login. The task agents
//! route and the sync feed read it for every task that uses the login, so a
//! probe runs once per login in each refresh interval, not once per task.
//! The result is a display observation: no command waits for it or depends
//! on it.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

use chrono::Utc;
use serde::Deserialize;

use crate::{shared::time::rfc3339_millis, tasks::control::HarnessKind};

crate::shared::wire_enum! {
    /// The provider sign-in vocabulary of Settings.
    pub enum ProviderConnectionStatus {
        Connected = "connected",
        NotConnected = "not-connected",
        Unknown = "unknown",
    }
}

/// One provider login: the provider, and the home directory of a Claude Code
/// provider instance. Other providers have one login per host.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConnectionKey {
    pub provider: HarnessKind,
    pub home_directory: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderConnection {
    pub status: ProviderConnectionStatus,
    pub summary: String,
    /// When the probe ended (RFC 3339).
    pub observed_at: String,
}

impl ProviderConnection {
    /// Reads the `{status, summary}` object of `provider_connection`.
    pub fn from_value(value: &serde_json::Value) -> Self {
        #[derive(Deserialize)]
        struct Observed {
            status: ProviderConnectionStatus,
            #[serde(default)]
            summary: String,
        }
        let observed = Observed::deserialize(value).unwrap_or(Observed {
            status: ProviderConnectionStatus::Unknown,
            summary: "Suplex could not check the sign-in".into(),
        });
        Self {
            status: observed.status,
            summary: observed.summary,
            observed_at: rfc3339_millis(Utc::now()),
        }
    }
}

type Probe = Arc<
    dyn Fn(ConnectionKey) -> Pin<Box<dyn Future<Output = ProviderConnection> + Send>> + Send + Sync,
>;

#[derive(Default)]
struct Entry {
    observed: Option<(Instant, ProviderConnection)>,
    /// What a read returns before the first probe of the login ends. It does
    /// not change until then, so each read in that time returns the same value.
    unchecked: Option<ProviderConnection>,
    /// A probe of the login runs now.
    probing: bool,
}

/// A bounded cache of sign-in probes. A read never waits for a probe. It
/// returns the last observation while it is newer than `fresh_for`. Otherwise
/// it starts one probe and returns the older observation, or an `unknown`
/// sign-in before the first probe ends. A later read gets the result.
pub struct ProviderConnections {
    entries: Mutex<HashMap<ConnectionKey, Entry>>,
    probe: Probe,
    fresh_for: Duration,
}

/// Clears `probing` when the probe task ends, also when it panics or its
/// runtime stops, so a later read can probe the login again.
struct Probing {
    cache: Arc<ProviderConnections>,
    key: ConnectionKey,
}

impl Drop for Probing {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.cache.entries.lock()
            && let Some(entry) = entries.get_mut(&self.key)
        {
            entry.probing = false;
        }
    }
}

/// The interval in which one login is probed at most once.
pub const FRESH_FOR: Duration = Duration::from_secs(60);

/// The host's cache. It calls the same `provider_connection` probe that
/// Settings uses.
pub static HOST: LazyLock<Arc<ProviderConnections>> =
    LazyLock::new(|| ProviderConnections::new(FRESH_FOR, Arc::new(|key| Box::pin(probe(key)))));

#[cfg(not(test))]
async fn probe(key: ConnectionKey) -> ProviderConnection {
    use super::{provider_connection, provider_readiness};
    let value = match (key.provider, key.home_directory) {
        // The same instance probe as `GET /api/provider-instances`.
        (HarnessKind::ClaudeCode, Some(home)) => {
            let mut environment = std::env::vars().collect::<HashMap<_, _>>();
            environment.insert("CLAUDE_CONFIG_DIR".into(), home);
            let check = provider_readiness::check(
                HarnessKind::ClaudeCode.as_str(),
                Some(environment),
                false,
            )
            .await;
            provider_connection::connection_from_health(&check)
        }
        (provider, _) => provider_connection::provider_connection(provider.as_str()).await,
    };
    ProviderConnection::from_value(&value)
}

/// Unit tests do not start provider command lines. The probe never ends, so
/// each read returns the same `unknown` sign-in.
#[cfg(test)]
async fn probe(_key: ConnectionKey) -> ProviderConnection {
    std::future::pending().await
}

impl ProviderConnections {
    pub fn new(fresh_for: Duration, probe: Probe) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::default(),
            probe,
            fresh_for,
        })
    }

    /// The sign-in of one login, without a wait. Call it inside a Tokio
    /// runtime, which runs the probe.
    pub fn read(self: &Arc<Self>, key: &ConnectionKey) -> ProviderConnection {
        let mut entries = self
            .entries
            .lock()
            .expect("provider connections lock poisoned");
        let entry = entries.entry(key.clone()).or_default();
        if let Some((at, observed)) = &entry.observed
            && at.elapsed() < self.fresh_for
        {
            return observed.clone();
        }
        if !entry.probing {
            entry.probing = true;
            let probing = Probing {
                cache: self.clone(),
                key: key.clone(),
            };
            // The read starts the probe; the task only waits for it.
            let probe = (self.probe)(key.clone());
            tokio::spawn(async move {
                let observed = probe.await;
                let mut entries = probing
                    .cache
                    .entries
                    .lock()
                    .expect("provider connections lock poisoned");
                let entry = entries.entry(probing.key.clone()).or_default();
                entry.observed = Some((Instant::now(), observed));
                entry.unchecked = None;
                drop(entries);
                drop(probing);
            });
        }
        match &entry.observed {
            Some((_, observed)) => observed.clone(),
            None => entry
                .unchecked
                .get_or_insert_with(|| ProviderConnection {
                    status: ProviderConnectionStatus::Unknown,
                    summary: "Suplex did not check the sign-in yet".into(),
                    observed_at: rfc3339_millis(Utc::now()),
                })
                .clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counted(fresh_for: Duration) -> (Arc<ProviderConnections>, Arc<AtomicUsize>) {
        let probes = Arc::new(AtomicUsize::new(0));
        let counter = probes.clone();
        let cache = ProviderConnections::new(
            fresh_for,
            Arc::new(move |_key| {
                let count = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    ProviderConnection {
                        status: ProviderConnectionStatus::NotConnected,
                        summary: format!("probe {count}"),
                        observed_at: format!("probe {count}"),
                    }
                })
            }),
        );
        (cache, probes)
    }

    fn claude() -> ConnectionKey {
        ConnectionKey {
            provider: HarnessKind::ClaudeCode,
            home_directory: None,
        }
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    #[tokio::test]
    async fn a_first_read_returns_unknown_at_once_and_tasks_on_one_login_share_one_probe() {
        let (cache, probes) = counted(Duration::from_secs(60));
        // Twenty watched tasks read before the first probe ends. None waits.
        let first = cache.read(&claude());
        assert_eq!(first.status, ProviderConnectionStatus::Unknown);
        assert_eq!(first.summary, "Suplex did not check the sign-in yet");
        for _ in 0..19 {
            assert_eq!(cache.read(&claude()), first);
        }
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        // The next pass gets the result of the one probe.
        settle().await;
        for _ in 0..20 {
            assert_eq!(cache.read(&claude()).summary, "probe 1");
        }
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        // Another login has its own probe.
        let codex = ConnectionKey {
            provider: HarnessKind::Codex,
            home_directory: None,
        };
        assert_eq!(cache.read(&codex).status, ProviderConnectionStatus::Unknown);
        settle().await;
        assert_eq!(cache.read(&codex).summary, "probe 2");
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_old_observation_starts_one_probe_without_a_wait() {
        let (cache, probes) = counted(Duration::from_millis(50));
        cache.read(&claude());
        settle().await;
        assert_eq!(cache.read(&claude()).summary, "probe 1");
        tokio::time::sleep(Duration::from_millis(60)).await;
        // The old observation returns at once while one probe runs.
        for _ in 0..10 {
            assert_eq!(cache.read(&claude()).summary, "probe 1");
        }
        settle().await;
        assert_eq!(cache.read(&claude()).summary, "probe 2");
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_probe_that_fails_lets_a_later_read_probe_again() {
        let probes = Arc::new(AtomicUsize::new(0));
        let counter = probes.clone();
        let cache = ProviderConnections::new(
            Duration::from_secs(60),
            Arc::new(move |_key| {
                let count = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move {
                    assert!(count > 1, "the first probe fails");
                    ProviderConnection {
                        status: ProviderConnectionStatus::Connected,
                        summary: "Signed in".into(),
                        observed_at: "now".into(),
                    }
                })
            }),
        );
        assert_eq!(
            cache.read(&claude()).status,
            ProviderConnectionStatus::Unknown
        );
        settle().await;
        assert_eq!(
            cache.read(&claude()).status,
            ProviderConnectionStatus::Unknown
        );
        settle().await;
        assert_eq!(cache.read(&claude()).summary, "Signed in");
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_settings_vocabulary_is_read() {
        let connected = ProviderConnection::from_value(
            &serde_json::json!({"status": "not-connected", "summary": "Devin CLI is not installed"}),
        );
        assert_eq!(connected.status, ProviderConnectionStatus::NotConnected);
        assert_eq!(connected.summary, "Devin CLI is not installed");
        assert_eq!(
            ProviderConnection::from_value(&serde_json::json!({"status": "other"})).status,
            ProviderConnectionStatus::Unknown
        );
    }
}
