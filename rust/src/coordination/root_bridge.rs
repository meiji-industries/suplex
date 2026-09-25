use std::{
    io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::bridge_auth::{self, ROOT_BINDING_ENV, ROOT_TOKEN_ENV};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootIdentity {
    pub task_id: String,
    pub session_id: String,
    pub generation: i64,
}

pub(crate) fn valid_opaque_id(id: &str) -> bool {
    let mut characters = id.chars();
    id.len() <= 256
        && characters
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
        && characters.all(|ch| ch.is_ascii_alphanumeric() || "._:-".contains(ch))
}

impl RootIdentity {
    fn validate(&self) -> io::Result<()> {
        for id in [&self.task_id, &self.session_id] {
            if !valid_opaque_id(id) {
                return Err(io::Error::other("Coordinator bridge identity is invalid"));
            }
        }
        if self.generation <= 0 || self.generation > 9_007_199_254_740_991 {
            return Err(io::Error::other("Coordinator bridge generation is invalid"));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ServerCommand {
    command: String,
    args: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootBinding {
    version: u8,
    token: String,
    root: RootIdentity,
    database_path: Option<String>,
    artifact_root: String,
    server: ServerCommand,
}

pub struct RootLaunchBinding {
    pub binding_path: PathBuf,
    pub token: String,
}

pub fn write_binding(
    runtime_directory: &Path,
    root: &RootIdentity,
    database_path: &Path,
    artifact_root: &Path,
    executable: &str,
) -> io::Result<RootLaunchBinding> {
    root.validate()?;
    if executable.is_empty() {
        return Err(io::Error::other("Coordinator bridge executable is empty"));
    }
    let database_path = database_path
        .to_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| io::Error::other("Coordinator bridge database path is invalid"))?;
    let artifact_root = artifact_root
        .to_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| io::Error::other("Coordinator bridge artifact root is invalid"))?;
    bridge_auth::prepare_runtime_directory(runtime_directory)?;
    let binding_path = runtime_directory.join("root.binding.json");
    let token = bridge_auth::existing_token(&binding_path)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let binding = RootBinding {
        version: 1,
        token: token.clone(),
        root: root.clone(),
        database_path: Some(database_path.to_owned()),
        artifact_root: artifact_root.to_owned(),
        server: ServerCommand {
            command: executable.to_owned(),
            args: vec!["mcp".into(), "root".into()],
        },
    };
    bridge_auth::atomic_write_private(
        &binding_path,
        &serde_json::to_vec(&binding).map_err(io::Error::other)?,
    )?;
    Ok(RootLaunchBinding {
        binding_path,
        token,
    })
}

pub struct AuthenticatedRootBinding {
    pub root: RootIdentity,
    pub database_path: PathBuf,
    pub artifact_root: PathBuf,
}

pub fn authenticated_binding() -> io::Result<AuthenticatedRootBinding> {
    let path = bridge_auth::binding_path(ROOT_BINDING_ENV, "Coordinator")?;
    let binding: RootBinding = serde_json::from_slice(&std::fs::read(path)?)?;
    if binding.version != 1
        || binding.database_path.as_deref().is_none_or(str::is_empty)
        || binding.artifact_root.is_empty()
        || binding.server.command.is_empty()
    {
        return Err(io::Error::other("Coordinator bridge binding is invalid"));
    }
    binding.root.validate()?;
    let token = std::env::var(ROOT_TOKEN_ENV).ok();
    bridge_auth::authenticate_token(
        &binding.token,
        token.as_deref(),
        ROOT_TOKEN_ENV,
        "Coordinator",
    )?;
    let _ = binding.server.args;
    Ok(AuthenticatedRootBinding {
        root: binding.root,
        database_path: PathBuf::from(binding.database_path.expect("database path checked")),
        artifact_root: PathBuf::from(binding.artifact_root),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn root_binding_tracks_current_identity_and_reuses_valid_token() {
        let directory =
            std::env::temp_dir().join(format!("suplex-root-binding-{}", uuid::Uuid::new_v4()));
        let root = RootIdentity {
            task_id: "task_1".into(),
            session_id: "session_1".into(),
            generation: 1,
        };
        let first = write_binding(
            &directory,
            &root,
            Path::new("/tmp/task.sqlite"),
            Path::new("/tmp/artifacts"),
            "/usr/local/bin/suplex",
        )
        .unwrap();
        let next = RootIdentity {
            generation: 2,
            ..root.clone()
        };
        let second = write_binding(
            &directory,
            &next,
            Path::new("/tmp/task.sqlite"),
            Path::new("/tmp/artifacts"),
            "/usr/local/bin/suplex",
        )
        .unwrap();
        assert_eq!(first.token, second.token);
        let stored: Value =
            serde_json::from_slice(&std::fs::read(&first.binding_path).unwrap()).unwrap();
        assert_eq!(
            stored["root"],
            json!({"taskId":"task_1","sessionId":"session_1","generation":2})
        );
        assert_eq!(stored["server"]["args"], json!(["mcp", "root"]));
        assert!(
            write_binding(
                &directory,
                &RootIdentity {
                    task_id: "../escape".into(),
                    ..root
                },
                Path::new("/tmp/task.sqlite"),
                Path::new("/tmp/artifacts"),
                "suplex"
            )
            .is_err()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&first.binding_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
