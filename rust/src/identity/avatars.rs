//! One avatar table for users, companies, projects, and agents
//! (`src/identity/avatars.ts`, `src/identity/avatar-kinds.ts`).

use crate::identity::IdentityError;
use crate::platform::PlatformError;
use crate::shared::ids::random_hex_id;
use crate::shared::time::now_millis_rfc3339;
use std::fs;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    http::contracts::typed::{avatars::AvatarUpdateBody, tasks::TaskImage},
    platform::database::{DatabaseResult, SuplexDatabase},
    projects::service as projects,
    tasks::images::decode_task_image,
};

pub const MAX_AVATAR_IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_AVATAR_IMAGE_BASE64_LENGTH: usize = MAX_AVATAR_IMAGE_BYTES.div_ceil(3) * 4;

// Owner ids are globally unique across tables, so one lookup per table resolves the kind.
const OWNER_TABLES: &[(&str, &str, &str)] = &[
    (
        "user",
        "suplex_users",
        "COALESCE(NULLIF(avatar_seed, ''), username)",
    ),
    ("company", "suplex_companies", "name"),
    ("project", "suplex_projects", "id"),
    ("agent", "suplex_profiles", "avatar_seed"),
    ("agent", "suplex_agents", "avatar_seed"),
];

pub fn dicebear_url(kind: &str, seed: &str) -> String {
    let collection = match kind {
        "user" => "pixel-art-neutral",
        "company" => "initials",
        "project" => "shapes",
        _ => "bottts-neutral",
    };
    format!(
        "https://api.dicebear.com/10.x/{collection}/svg?seed={}",
        crate::shared::encode_uri_component(seed)
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarRecord {
    pub shape: Option<String>,
    pub image_version: Option<String>,
}

pub struct AvatarImage {
    pub mime_type: String,
    pub image: Vec<u8>,
}

/// `AuthService.getUserForAuthority`: the live, active user and its role.
fn user_role(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<String> {
    database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| IdentityError::auth("Authentication required", 401, "auth_failure").into())
}

pub fn list(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<Map<String, Value>> {
    user_role(database, user_id)?;
    let mut statement = database.connection().prepare(
        "SELECT owner_id, shape, updated_at, mime_type IS NOT NULL AS has_image FROM suplex_avatars",
    )?;
    let rows = statement.query_map([], |row| {
        let updated_at: String = row.get(2)?;
        Ok((
            row.get::<_, String>(0)?,
            json!({"shape": row.get::<_, Option<String>>(1)?, "imageVersion": row.get::<_, bool>(3)?.then_some(updated_at)}),
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<Map<_, _>>>()?)
}

/// Resolve the owner kind and, for a kind without an upload, the DiceBear seed.
pub fn owner(
    database: &SuplexDatabase,
    user_id: &str,
    owner_id: &str,
) -> DatabaseResult<(&'static str, String)> {
    user_role(database, user_id)?;
    for (kind, table, seed) in OWNER_TABLES {
        let found: Option<String> = database
            .connection()
            .query_row(
                &format!("SELECT {seed} AS seed FROM {table} WHERE id = ?1"),
                [owner_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(seed) = found {
            return Ok((kind, seed));
        }
    }
    Err(IdentityError::not_found().into())
}

pub fn image(
    database: &SuplexDatabase,
    user_id: &str,
    owner_id: &str,
) -> DatabaseResult<Option<AvatarImage>> {
    user_role(database, user_id)?;
    Ok(database
        .connection()
        .query_row(
            "SELECT mime_type, image FROM suplex_avatars WHERE owner_id = ?1 AND image IS NOT NULL",
            [owner_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                ))
            },
        )
        .optional()?
        .and_then(|(mime_type, image)| {
            Some(AvatarImage {
                mime_type: mime_type?,
                image: image?,
            })
        }))
}

pub fn update(
    database: &mut SuplexDatabase,
    user_id: &str,
    owner_id: &str,
    patch: &AvatarUpdateBody,
) -> DatabaseResult<AvatarRecord> {
    let role = user_role(database, user_id)?;
    let bytes = match &patch.image {
        Some(Some(image)) => {
            let decoded = decode_task_image(&TaskImage {
                filename: "avatar".into(),
                mime_type: image.mime_type.clone(),
                base64: image.base64.clone(),
            })?;
            if decoded.bytes.len() > MAX_AVATAR_IMAGE_BYTES {
                return Err(PlatformError::invalid_image_data().into());
            }
            Some(decoded.bytes)
        }
        _ => None,
    };
    database.transaction(false, |database| {
        let mut kind = None;
        for (candidate, table, _) in OWNER_TABLES {
            if database
                .connection()
                .query_row(
                    &format!("SELECT 1 FROM {table} WHERE id = ?1"),
                    [owner_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                kind = Some(*candidate);
                break;
            }
        }
        let kind = kind.ok_or_else(IdentityError::not_found)?;
        let allowed = role == "admin"
            || (kind == "user" && owner_id == user_id)
            || (kind == "project"
                && database.connection().query_row(
                    "SELECT EXISTS(SELECT 1 FROM suplex_projects p JOIN suplex_memberships m ON m.company_id = p.company_id WHERE p.id = ?1 AND m.user_id = ?2)",
                    params![owner_id, user_id],
                    |row| row.get::<_, bool>(0),
                )?);
        if !allowed {
            return Err(IdentityError::auth(
                "Administrator access required",
                403,
                "auth_failure",
            ).into());
        }
        let current = database
            .connection()
            .query_row(
                "SELECT shape, mime_type, image FROM suplex_avatars WHERE owner_id = ?1",
                [owner_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<Vec<u8>>>(2)?,
                    ))
                },
            )
            .optional()?
            .unwrap_or_default();
        let shape = match &patch.shape {
            None => current.0,
            Some(value) => value.clone(),
        };
        let (mime_type, image) = match &patch.image {
            None => (current.1, current.2),
            Some(value) => (value.as_ref().map(|image| image.mime_type.clone()), bytes),
        };
        let updated_at = now_millis_rfc3339();
        if shape.is_none() && image.is_none() {
            database
                .connection()
                .execute("DELETE FROM suplex_avatars WHERE owner_id = ?1", [owner_id])?;
        } else {
            database.connection().execute(
                "INSERT INTO suplex_avatars (owner_id, shape, mime_type, image, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (owner_id) DO UPDATE SET shape = excluded.shape, mime_type = excluded.mime_type, image = excluded.image, updated_at = excluded.updated_at",
                params![owner_id, shape, mime_type, image, updated_at],
            )?;
        }
        crate::identity::audit::record(
database, &random_hex_id("audit")?, (Some(user_id), None), "avatar_updated", (kind == "user").then_some(owner_id), None, &json!({"ownerId": owner_id}).to_string(), &updated_at
)?;
        Ok(AvatarRecord {
            shape,
            image_version: image.is_some().then_some(updated_at),
        })
    })
}

/// `ProjectService.getProjectFavicon`: an approved repository icon location.
pub fn project_favicon(
    database: &SuplexDatabase,
    user_id: &str,
    project_id: &str,
) -> DatabaseResult<Option<Vec<u8>>> {
    let project = projects::get(database, user_id, project_id)?;
    let Ok(root) = fs::canonicalize(&project.repository_path) else {
        return Ok(None);
    };
    for relative in [
        "favicon.ico",
        "public/favicon.ico",
        "static/favicon.ico",
        "static/images/favicon.ico",
        "assets/favicon.ico",
    ] {
        let candidate = root.join(relative);
        let (Ok(icon), Ok(entry)) = (
            fs::canonicalize(&candidate),
            fs::symlink_metadata(&candidate),
        ) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&icon) else {
            continue;
        };
        if entry.file_type().is_symlink()
            || !icon.starts_with(&root)
            || !metadata.is_file()
            || metadata.len() > 1_048_576
        {
            continue;
        }
        if let Ok(bytes) = fs::read(&icon) {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}
