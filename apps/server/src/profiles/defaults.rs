//! Global default agents. A new project copies the default profile ID of each
//! slot. Existing projects keep the profile IDs they stored.

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::agent_profiles::{self, ProfileFailure};
use crate::platform::database::{DatabaseResult, SuplexDatabase};
use crate::shared::time::rfc3339_millis;

crate::shared::wire_enum! {
    /// A role slot that has one default agent for new projects.
    pub enum DefaultSlot {
        Root = "root",
        Alt = "alt",
        Worker = "worker",
    }
}

impl DefaultSlot {
    pub const ALL: [Self; 3] = [Self::Root, Self::Alt, Self::Worker];

    /// The profile role that can fill this slot.
    pub const fn role(self) -> &'static str {
        match self {
            Self::Root | Self::Alt => "root",
            Self::Worker => "worker",
        }
    }

    /// The seeded profile that fills this slot when no usable default is stored.
    pub const fn seeded(self) -> &'static str {
        match self {
            Self::Root => "profile_native_root",
            Self::Alt => "profile_native_independent",
            Self::Worker => "profile_native_worker",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Root => "Coordinator",
            Self::Alt => "Alt Coordinator",
            Self::Worker => "Worker",
        }
    }
}

/// `GET /api/profiles/defaults` and `POST /api/admin/profiles/{agentId}/default`:
/// the profile ID that a new project receives for each slot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileDefaults {
    pub root: String,
    pub alt: String,
    pub worker: String,
}

impl ProfileDefaults {
    pub fn get(&self, slot: DefaultSlot) -> &str {
        match slot {
            DefaultSlot::Root => &self.root,
            DefaultSlot::Alt => &self.alt,
            DefaultSlot::Worker => &self.worker,
        }
    }
}

/// The stored default for `slot` when that profile is active and has the
/// slot's role; otherwise the seeded profile.
pub fn resolve(database: &SuplexDatabase, slot: DefaultSlot) -> DatabaseResult<String> {
    let stored: Option<String> = database
        .connection()
        .query_row(
            "SELECT d.profile_id FROM suplex_profile_defaults d JOIN suplex_profiles p ON p.id = d.profile_id WHERE d.slot = ?1 AND p.role = ?2 AND p.archived_at IS NULL",
            params![slot.as_str(), slot.role()],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored.unwrap_or_else(|| slot.seeded().to_owned()))
}

pub fn resolve_all(database: &SuplexDatabase) -> DatabaseResult<ProfileDefaults> {
    Ok(ProfileDefaults {
        root: resolve(database, DefaultSlot::Root)?,
        alt: resolve(database, DefaultSlot::Alt)?,
        worker: resolve(database, DefaultSlot::Worker)?,
    })
}

pub fn read(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<ProfileDefaults> {
    agent_profiles::actor(database, user_id, false)?;
    resolve_all(database)
}

/// Makes `profile_id` the default for `slot`. The same profile can fill the
/// Coordinator and the Alt Coordinator slots.
pub fn set(
    database: &mut SuplexDatabase,
    user_id: &str,
    profile_id: &str,
    slot: DefaultSlot,
    now: DateTime<Utc>,
) -> DatabaseResult<ProfileDefaults> {
    agent_profiles::actor(database, user_id, true)?;
    database.transaction(false, |database| {
        let profile = agent_profiles::get(database, profile_id)?;
        if profile.archived_at.is_some() {
            return Err(ProfileFailure::new(
                format!(
                    "Suplex cannot make an archived agent the default {}",
                    slot.label()
                ),
                409,
            ));
        }
        if profile.role != slot.role() {
            let role = if slot.role() == "root" {
                "Coordinator"
            } else {
                "Worker"
            };
            return Err(ProfileFailure::new(
                format!(
                    "Select a {role} agent for the default {}",
                    slot.label()
                ),
                422,
            ));
        }
        let now_iso = rfc3339_millis(now);
        database.connection().execute(
            "INSERT INTO suplex_profile_defaults (slot, profile_id, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(slot) DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at",
            params![slot.as_str(), profile_id, now_iso],
        )?;
        crate::identity::audit::record(
            database,
            &crate::identity::audit::AuditEvent {
                id: &crate::shared::ids::random_hex_id("audit")?,
                actor_user_id: Some(user_id),
                actor_agent_id: None,
                action: "agent_profile_default_set",
                target_user_id: None,
                company_id: None,
                metadata_json: &serde_json::json!({"profileId": profile_id, "slot": slot.as_str()})
                    .to_string(),
                created_at: &now_iso,
            },
        )?;
        resolve_all(database)
    })
}

/// Rejects an archive, delete, or role change that would leave a default slot
/// without its agent. `action` completes "before you ... this agent".
pub(super) fn assert_not_default(
    database: &SuplexDatabase,
    profile_id: &str,
    action: &str,
) -> DatabaseResult<()> {
    let defaults = resolve_all(database)?;
    if let Some(slot) = DefaultSlot::ALL
        .into_iter()
        .find(|slot| defaults.get(*slot) == profile_id)
    {
        return Err(ProfileFailure::new(
            format!(
                "Select another default {} before you {action} this agent",
                slot.label()
            ),
            409,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::identity::{IdentityError, auth};
    use crate::platform::database::OpenMode;
    use crate::profiles::agent_profiles::{ProfileInput, ProfilePatch};

    struct Fixture {
        database: SuplexDatabase,
        path: std::path::PathBuf,
        admin: String,
        now: DateTime<Utc>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(self.path.with_extension("sqlite-wal"));
            let _ = std::fs::remove_file(self.path.with_extension("sqlite-shm"));
        }
    }

    fn fixture() -> Fixture {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-profile-role-defaults-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = auth::development_sign_in(&mut database, now)
            .unwrap()
            .user
            .id;
        Fixture {
            database,
            path,
            admin,
            now,
        }
    }

    fn agent(fixture: &mut Fixture, name: &str, role: &str) -> String {
        let input = ProfileInput {
            name: name.to_owned(),
            role: role.to_owned(),
            avatar_seed: "0123456789abcdef0123456789abcdef".to_owned(),
            provider: "codex".to_owned(),
            model: "gpt-6-sol".to_owned(),
            reasoning_level: "medium".to_owned(),
            service_tier: "default".to_owned(),
            provider_instance_id: None,
        };
        agent_profiles::create(&mut fixture.database, &fixture.admin, &input, fixture.now)
            .unwrap()
            .id
    }

    fn failure(error: Box<dyn std::error::Error + Send + Sync>) -> (u16, String) {
        let failure = error.downcast_ref::<ProfileFailure>().unwrap();
        (failure.status_code, failure.message.clone())
    }

    fn seeded() -> ProfileDefaults {
        ProfileDefaults {
            root: "profile_native_root".to_owned(),
            alt: "profile_native_independent".to_owned(),
            worker: "profile_native_worker".to_owned(),
        }
    }

    #[test]
    fn migration_seeds_each_usable_seeded_profile() {
        let fixture = fixture();
        let rows: Vec<(String, String)> = fixture
            .database
            .connection()
            .prepare("SELECT slot, profile_id FROM suplex_profile_defaults ORDER BY slot")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                ("alt".to_owned(), "profile_native_independent".to_owned()),
                ("root".to_owned(), "profile_native_root".to_owned()),
                ("worker".to_owned(), "profile_native_worker".to_owned()),
            ]
        );
        assert_eq!(read(&fixture.database, &fixture.admin).unwrap(), seeded());

        // A seeded profile that is archived or has another role gets no row,
        // and the slot still resolves to the seeded ID as before.
        let seed = include_str!("../../migrations/20261113050750787_agent_role_defaults.sql")
            .split("--> statement-breakpoint")
            .nth(1)
            .unwrap();
        let connection = fixture.database.connection();
        connection
            .execute("DELETE FROM suplex_profile_defaults", [])
            .unwrap();
        connection
            .execute(
                "UPDATE suplex_profiles SET archived_at = 'then' WHERE id = 'profile_native_independent'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE suplex_profiles SET role = 'root' WHERE id = 'profile_native_worker'",
                [],
            )
            .unwrap();
        connection.execute_batch(seed).unwrap();
        let slots: Vec<String> = connection
            .prepare("SELECT slot FROM suplex_profile_defaults ORDER BY slot")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(slots, ["root"]);
        assert_eq!(resolve_all(&fixture.database).unwrap(), seeded());
    }

    #[test]
    fn set_default_validates_the_profile_and_keeps_the_stored_default_on_failure() {
        let mut fixture = fixture();
        let worker = agent(&mut fixture, "Second Worker", "worker");
        let coordinator = agent(&mut fixture, "Second Coordinator", "root");
        let (admin, now) = (fixture.admin.clone(), fixture.now);

        let changed = set(
            &mut fixture.database,
            &admin,
            &worker,
            DefaultSlot::Worker,
            now,
        )
        .unwrap();
        assert_eq!(changed.worker, worker);
        assert_eq!(changed.root, "profile_native_root");
        // The same profile can fill the Coordinator and the Alt Coordinator slots.
        set(
            &mut fixture.database,
            &admin,
            &coordinator,
            DefaultSlot::Root,
            now,
        )
        .unwrap();
        let both = set(
            &mut fixture.database,
            &admin,
            &coordinator,
            DefaultSlot::Alt,
            now,
        )
        .unwrap();
        assert_eq!(
            (both.root.as_str(), both.alt.as_str()),
            (coordinator.as_str(), coordinator.as_str())
        );
        let audits: i64 = fixture
            .database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'agent_profile_default_set' AND json_extract(metadata_json, '$.slot') IN ('root', 'alt', 'worker')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audits, 3);

        let unknown = set(
            &mut fixture.database,
            &admin,
            "profile_missing",
            DefaultSlot::Worker,
            now,
        )
        .unwrap_err();
        assert_eq!(failure(unknown).0, 404);
        assert_eq!(
            failure(
                set(
                    &mut fixture.database,
                    &admin,
                    "profile_native_root",
                    DefaultSlot::Worker,
                    now
                )
                .unwrap_err()
            ),
            (
                422,
                "Select a Worker agent for the default Worker".to_owned()
            )
        );
        assert_eq!(
            failure(
                set(
                    &mut fixture.database,
                    &admin,
                    &worker,
                    DefaultSlot::Alt,
                    now
                )
                .unwrap_err()
            ),
            (
                422,
                "Select a Coordinator agent for the default Alt Coordinator".to_owned()
            )
        );
        let archived = agent(&mut fixture, "Archived Worker", "worker");
        agent_profiles::update(
            &mut fixture.database,
            &admin,
            &archived,
            ProfilePatch {
                archived: Some(true),
                ..Default::default()
            },
            now,
        )
        .unwrap();
        assert_eq!(
            failure(
                set(
                    &mut fixture.database,
                    &admin,
                    &archived,
                    DefaultSlot::Worker,
                    now
                )
                .unwrap_err()
            ),
            (
                409,
                "Suplex cannot make an archived agent the default Worker".to_owned()
            )
        );

        fixture.database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('defaults_member', 'Member', 'user_v1_defaults_member', 'member', 'active', ?1, ?1, 1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let forbidden = set(
            &mut fixture.database,
            "defaults_member",
            "profile_native_worker",
            DefaultSlot::Worker,
            now,
        )
        .unwrap_err();
        assert_eq!(
            forbidden.downcast_ref::<IdentityError>().unwrap().status(),
            403
        );
        assert_eq!(
            read(&fixture.database, "defaults_member").unwrap().worker,
            worker
        );
        assert_eq!(
            resolve_all(&fixture.database).unwrap(),
            ProfileDefaults {
                root: coordinator.clone(),
                alt: coordinator,
                worker
            }
        );
    }

    #[test]
    fn archive_delete_and_role_change_of_a_default_wait_for_another_default() {
        let mut fixture = fixture();
        let (admin, now) = (fixture.admin.clone(), fixture.now);
        let worker = agent(&mut fixture, "Next Worker", "worker");
        let coordinator = agent(&mut fixture, "Next Coordinator", "root");
        set(
            &mut fixture.database,
            &admin,
            &worker,
            DefaultSlot::Worker,
            now,
        )
        .unwrap();
        set(
            &mut fixture.database,
            &admin,
            &coordinator,
            DefaultSlot::Alt,
            now,
        )
        .unwrap();
        let archive = ProfilePatch {
            archived: Some(true),
            ..Default::default()
        };
        let to_worker = ProfilePatch {
            role: Some("worker".to_owned()),
            ..Default::default()
        };

        let blocked =
            agent_profiles::update(&mut fixture.database, &admin, &worker, archive.clone(), now)
                .unwrap_err();
        assert_eq!(
            failure(blocked),
            (
                409,
                "Select another default Worker before you archive this agent".to_owned()
            )
        );
        let blocked =
            agent_profiles::delete(&mut fixture.database, &admin, &worker, now).unwrap_err();
        assert_eq!(
            failure(blocked),
            (
                409,
                "Select another default Worker before you delete this agent".to_owned()
            )
        );
        let blocked = agent_profiles::update(
            &mut fixture.database,
            &admin,
            &coordinator,
            to_worker.clone(),
            now,
        )
        .unwrap_err();
        assert_eq!(
            failure(blocked),
            (
                409,
                "Select another default Alt Coordinator before you change the role of this agent"
                    .to_owned()
            )
        );
        let blocked = agent_profiles::update(
            &mut fixture.database,
            &admin,
            "profile_native_root",
            archive.clone(),
            now,
        )
        .unwrap_err();
        assert_eq!(
            failure(blocked).1,
            "Select another default Coordinator before you archive this agent"
        );
        assert!(
            agent_profiles::get(&fixture.database, &worker)
                .unwrap()
                .archived_at
                .is_none()
        );
        assert_eq!(
            agent_profiles::get(&fixture.database, &coordinator)
                .unwrap()
                .role,
            "root"
        );

        // The seeded profiles no longer fill these slots, so they can change.
        agent_profiles::update(
            &mut fixture.database,
            &admin,
            "profile_native_worker",
            archive.clone(),
            now,
        )
        .unwrap();
        set(
            &mut fixture.database,
            &admin,
            "profile_native_independent",
            DefaultSlot::Alt,
            now,
        )
        .unwrap();
        agent_profiles::update(&mut fixture.database, &admin, &coordinator, to_worker, now)
            .unwrap();
        set(
            &mut fixture.database,
            &admin,
            &coordinator,
            DefaultSlot::Worker,
            now,
        )
        .unwrap();
        agent_profiles::update(&mut fixture.database, &admin, &worker, archive, now).unwrap();
        agent_profiles::delete(&mut fixture.database, &admin, &worker, now).unwrap();
        assert_eq!(
            resolve(&fixture.database, DefaultSlot::Worker).unwrap(),
            coordinator
        );
    }
}
