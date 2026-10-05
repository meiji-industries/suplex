//! Persistence and validation for the host remote-access policy.
use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    identity::{
        IdentityError,
        auth::{self, AuthUser},
    },
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::time::rfc3339_millis,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum RemoteAccessPolicy {
    Open {
        require_https: bool,
        default_user_id: String,
        external_https_origin: Option<String>,
    },
    Passkeys {
        external_https_origin: Option<String>,
    },
}

impl RemoteAccessPolicy {
    pub fn requires_https(&self) -> bool {
        match self {
            Self::Open { require_https, .. } => *require_https,
            Self::Passkeys { .. } => true,
        }
    }

    pub fn external_https_origin(&self) -> Option<&str> {
        match self {
            Self::Open {
                external_https_origin,
                ..
            }
            | Self::Passkeys {
                external_https_origin,
            } => external_https_origin.as_deref(),
        }
    }
}

pub fn read(database: &SuplexDatabase) -> DatabaseResult<RemoteAccessPolicy> {
    let row = database.connection().query_row(
        "SELECT mode, require_https, default_user_id, external_https_origin FROM suplex_remote_access_policy WHERE id = 'host'",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)),
    ).optional()?;
    let Some((mode, require_https, default_user_id, external_https_origin)) = row else {
        return Err("Remote access policy is missing".into());
    };
    match mode.as_str() {
        "open" => Ok(RemoteAccessPolicy::Open {
            require_https,
            default_user_id: default_user_id
                .ok_or("Open remote access policy has no default user")?,
            external_https_origin,
        }),
        "passkeys" if require_https && default_user_id.is_none() => {
            Ok(RemoteAccessPolicy::Passkeys {
                external_https_origin,
            })
        }
        _ => Err("Remote access policy is invalid".into()),
    }
}

fn validate_origin(origin: Option<&str>) -> DatabaseResult<Option<String>> {
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let invalid = || {
        IdentityError::auth(
            "External HTTPS origin must contain only an https scheme and authority",
            400,
            "remote_access_invalid",
        )
    };
    let parsed = url::Url::parse(origin).map_err(|_| invalid())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid().into());
    }
    Ok(Some(parsed.origin().ascii_serialization()))
}

pub fn effective_https_origin(policy: &RemoteAccessPolicy, reachable: &str) -> Option<String> {
    policy
        .external_https_origin()
        .map(str::to_owned)
        .or_else(|| {
            let parsed = url::Url::parse(reachable).ok()?;
            (parsed.scheme() == "https").then(|| parsed.origin().ascii_serialization())
        })
}

pub fn default_user(
    database: &SuplexDatabase,
    policy: &RemoteAccessPolicy,
) -> DatabaseResult<Option<AuthUser>> {
    let RemoteAccessPolicy::Open {
        default_user_id, ..
    } = policy
    else {
        return Ok(None);
    };
    Ok(auth::public_user(database, default_user_id)?.filter(|user| user.status == "active"))
}

pub fn normalize(
    database: &SuplexDatabase,
    policy: RemoteAccessPolicy,
) -> DatabaseResult<RemoteAccessPolicy> {
    Ok(match policy {
        RemoteAccessPolicy::Open {
            require_https,
            default_user_id,
            external_https_origin,
        } => {
            let user = auth::public_user(database, &default_user_id)?
                .filter(|user| user.status == "active")
                .ok_or_else(|| {
                    IdentityError::auth(
                        "The default remote user must be active",
                        400,
                        "remote_access_invalid",
                    )
                })?;
            RemoteAccessPolicy::Open {
                require_https,
                default_user_id: user.id,
                external_https_origin: validate_origin(external_https_origin.as_deref())?,
            }
        }
        RemoteAccessPolicy::Passkeys {
            external_https_origin,
        } => RemoteAccessPolicy::Passkeys {
            external_https_origin: validate_origin(external_https_origin.as_deref())?,
        },
    })
}

pub fn update(
    database: &mut SuplexDatabase,
    policy: RemoteAccessPolicy,
) -> DatabaseResult<RemoteAccessPolicy> {
    let policy = normalize(database, policy)?;
    database.transaction(false, |database| {
        let now = rfc3339_millis(Utc::now());
        let (mode, require_https, default_user_id, external_https_origin) = match &policy {
            RemoteAccessPolicy::Open { require_https, default_user_id, external_https_origin } => {
                ("open", *require_https, Some(default_user_id.as_str()), external_https_origin.as_deref())
            }
            RemoteAccessPolicy::Passkeys { external_https_origin } => {
                ("passkeys", true, None, external_https_origin.as_deref())
            }
        };
        database.connection().execute(
            "UPDATE suplex_remote_access_policy SET mode = ?1, require_https = ?2, default_user_id = ?3, external_https_origin = ?4, updated_at = ?5 WHERE id = 'host'",
            params![mode, require_https, default_user_id, external_https_origin, now],
        )?;
        Ok(())
    })?;
    read(database)
}
