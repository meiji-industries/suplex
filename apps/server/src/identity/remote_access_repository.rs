//! Persistence and validation for the host's external HTTPS origin.
use chrono::Utc;
use rusqlite::{OptionalExtension, params};

use crate::{
    identity::IdentityError,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::time::rfc3339_millis,
};

pub fn external_https_origin(database: &SuplexDatabase) -> DatabaseResult<Option<String>> {
    database
        .connection()
        .query_row(
            "SELECT external_https_origin FROM suplex_remote_access_policy WHERE id = 'host'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| "Remote access policy is missing".into())
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

pub fn effective_https_origin(external: Option<&str>, reachable: &str) -> Option<String> {
    external.map(str::to_owned).or_else(|| {
        let parsed = url::Url::parse(reachable).ok()?;
        (parsed.scheme() == "https").then(|| parsed.origin().ascii_serialization())
    })
}

pub fn set_external_https_origin(
    database: &SuplexDatabase,
    origin: Option<&str>,
) -> DatabaseResult<Option<String>> {
    let origin = validate_origin(origin)?;
    database.connection().execute(
        "UPDATE suplex_remote_access_policy SET external_https_origin = ?1, updated_at = ?2 WHERE id = 'host'",
        params![origin, rfc3339_millis(Utc::now())],
    )?;
    Ok(origin)
}
