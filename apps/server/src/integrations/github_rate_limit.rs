//! Process-wide request cooldowns. GitHub response headers, not task status,
//! determine when a request can be sent again. New clients share the same state.

use super::github_delivery::{GithubFailure, GithubResult};
use crate::shared::time::rfc3339_millis;
use chrono::{DateTime, Utc};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Resource {
    Rest,
    Graphql,
    Secondary,
}

impl Resource {
    fn index(self) -> usize {
        self as usize
    }
    fn scopes(self) -> [Self; 2] {
        [Self::Secondary, self]
    }
}

struct Cooldown {
    until: DateTime<Utc>,
    failures: u32,
    generation: u64,
    probing: bool,
    summary: String,
}

impl Cooldown {
    fn failure(&self) -> GithubFailure {
        GithubFailure {
            code: "provider-rate-limited",
            summary: self.summary.clone(),
            retry_at: Some(rfc3339_millis(self.until)),
        }
    }
}

#[derive(Default)]
struct State {
    limits: [Option<Cooldown>; 3],
    generation: u64,
}

#[derive(Default)]
pub(super) struct RateLimits {
    state: Mutex<State>,
}

static SHARED: LazyLock<Mutex<HashMap<String, Arc<RateLimits>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

impl RateLimits {
    pub(super) fn shared(identity: &str) -> Arc<Self> {
        SHARED
            .lock()
            .expect("GitHub cooldown registry")
            .entry(identity.to_owned())
            .or_default()
            .clone()
    }

    pub(super) fn acquire(
        self: &Arc<Self>,
        resource: Resource,
        now: DateTime<Utc>,
    ) -> GithubResult<Permit> {
        let mut state = self.state.lock().expect("GitHub cooldown state");
        for scope in resource.scopes() {
            if let Some(limit) = &state.limits[scope.index()]
                && (now < limit.until || limit.probing)
            {
                return Err(limit.failure());
            }
        }
        let mut claims = Vec::new();
        for scope in resource.scopes() {
            if let Some(limit) = &mut state.limits[scope.index()] {
                limit.probing = true;
                claims.push((scope, limit.generation));
            }
        }
        Ok(Permit {
            limits: self.clone(),
            claims,
        })
    }

    /// Return whether this starts an episode, so repeated failures do not log.
    pub(super) fn record(
        &self,
        resource: Resource,
        deadline: Option<DateTime<Utc>>,
        summary: String,
        now: DateTime<Utc>,
    ) -> (GithubFailure, bool) {
        let mut state = self.state.lock().expect("GitHub cooldown state");
        let previous = state.limits[resource.index()].as_ref();
        let started = previous.is_none();
        let failures = previous.map_or(1, |limit| limit.failures.saturating_add(1));
        let seconds = (60_i64 * (1_i64 << (failures - 1).min(4))).min(900);
        let until = deadline
            .filter(|deadline| *deadline > now)
            .unwrap_or(now + chrono::Duration::seconds(seconds));
        let until = previous.map_or(until, |limit| until.max(limit.until));
        state.generation += 1;
        let limit = Cooldown {
            until,
            failures,
            generation: state.generation,
            probing: false,
            summary,
        };
        let failure = limit.failure();
        state.limits[resource.index()] = Some(limit);
        (failure, started)
    }
}

/// Only one request probes an expired cooldown. Cancellation or a failed probe
/// releases the claim and postpones the next probe without sleeping a task.
pub(super) struct Permit {
    limits: Arc<RateLimits>,
    claims: Vec<(Resource, u64)>,
}

impl Permit {
    pub(super) fn finish(mut self, success: bool, now: DateTime<Utc>) -> bool {
        self.finish_at(success, now)
    }

    fn finish_at(&mut self, success: bool, now: DateTime<Utc>) -> bool {
        let mut state = self.limits.state.lock().expect("GitHub cooldown state");
        let mut recovered = false;
        for (resource, generation) in self.claims.drain(..) {
            let slot = &mut state.limits[resource.index()];
            if let Some(limit) = slot
                && limit.generation == generation
            {
                if success {
                    *slot = None;
                    recovered = true;
                } else {
                    limit.probing = false;
                    limit.until = limit.until.max(now + chrono::Duration::seconds(60));
                }
            }
        }
        recovered
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.finish_at(false, Utc::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).unwrap()
    }

    #[test]
    fn one_probe_resumes_requests_and_reports_recovery_once() {
        let limits = Arc::new(RateLimits::default());
        let (error, started) = limits.record(Resource::Graphql, None, "limited".into(), now());
        assert!(started);
        assert_eq!(
            error.retry_at,
            Some(rfc3339_millis(now() + chrono::Duration::seconds(60)))
        );
        assert!(limits.acquire(Resource::Graphql, now()).is_err());
        assert!(limits.acquire(Resource::Rest, now()).is_ok());
        let later = now() + chrono::Duration::seconds(60);
        let probe = limits.acquire(Resource::Graphql, later).unwrap();
        assert!(limits.acquire(Resource::Graphql, later).is_err());
        assert!(probe.finish(true, later));
        assert!(
            !limits
                .acquire(Resource::Graphql, later)
                .unwrap()
                .finish(true, later)
        );
    }

    #[test]
    fn repeated_limits_back_off_without_repeated_episode_notifications() {
        let limits = Arc::new(RateLimits::default());
        let mut clock = now();
        for seconds in [60, 120, 240, 480, 900, 900] {
            let (error, started) =
                limits.record(Resource::Secondary, None, "limited".into(), clock);
            assert_eq!(started, clock == now());
            clock += chrono::Duration::seconds(seconds);
            assert_eq!(error.retry_at, Some(rfc3339_millis(clock)));
            assert!(
                limits
                    .acquire(Resource::Rest, clock - chrono::Duration::seconds(1))
                    .is_err()
            );
            assert!(
                limits
                    .acquire(Resource::Graphql, clock - chrono::Duration::seconds(1))
                    .is_err()
            );
        }
        assert!(
            limits
                .acquire(Resource::Rest, clock)
                .unwrap()
                .finish(true, clock)
        );
        assert!(limits.acquire(Resource::Graphql, clock).is_ok());
    }

    #[test]
    fn a_failed_probe_does_not_leave_a_permanent_claim() {
        let limits = Arc::new(RateLimits::default());
        limits.record(Resource::Graphql, None, "limited".into(), now());
        let later = now() + chrono::Duration::seconds(60);
        let probe = limits.acquire(Resource::Graphql, later).unwrap();
        assert!(!probe.finish(false, later));
        assert!(limits.acquire(Resource::Graphql, later).is_err());
        assert!(
            limits
                .acquire(Resource::Graphql, later + chrono::Duration::seconds(60))
                .is_ok()
        );
    }

    #[test]
    fn cancelling_a_probe_releases_its_claim() {
        let limits = Arc::new(RateLimits::default());
        let now = Utc::now();
        limits.record(Resource::Secondary, None, "limited".into(), now);
        let later = now + chrono::Duration::seconds(60);
        drop(limits.acquire(Resource::Rest, later).unwrap());
        let later = now + chrono::Duration::seconds(120);
        assert!(
            limits
                .acquire(Resource::Graphql, later)
                .unwrap()
                .finish(true, later)
        );
    }

    #[test]
    fn an_old_success_does_not_clear_a_new_rate_limit() {
        let limits = Arc::new(RateLimits::default());
        limits.record(Resource::Graphql, None, "limited".into(), now());
        let later = now() + chrono::Duration::seconds(60);
        let probe = limits.acquire(Resource::Graphql, later).unwrap();
        let (_, started) = limits.record(Resource::Graphql, None, "limited again".into(), later);
        assert!(!started);
        assert!(!probe.finish(true, later));
        assert!(limits.acquire(Resource::Graphql, later).is_err());
    }
}
