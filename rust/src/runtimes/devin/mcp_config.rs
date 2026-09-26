use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Map, Value, json};

use crate::coordination::bridge_auth::{
    ADVISOR_BINDING_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV, ROOT_TOKEN_ENV,
};

const LOCAL_CONFIG_PATH: &str = ".devin/mcp_config.local.json";
// The trailing * also hides the pending file written beside the config.
const EXCLUDE_PATTERN: &str = "/.devin/mcp_config.local.json*";
// ponytail: process-global lock on info/exclude appends; per-repository locks if this ever contends.
static EXCLUDE_LOCK: Mutex<()> = Mutex::new(());

fn read_config(path: &Path) -> Map<String, Value> {
    let Some(Value::Object(config)) = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
    else {
        return Map::new();
    };
    match config.get("mcpServers") {
        None | Some(Value::Object(_)) => config,
        Some(_) => Map::new(),
    }
}

fn git_common_directory(directory: &Path) -> io::Result<PathBuf> {
    let repository = git2::Repository::discover(directory)
        .map_err(|_| io::Error::other("Devin MCP configuration requires a Git worktree"))?;
    Ok(repository.commondir().to_owned())
}

fn ensure_excluded(directory: &Path) -> io::Result<()> {
    let exclude_path = git_common_directory(directory)?.join("info/exclude");
    fs::create_dir_all(exclude_path.parent().expect("exclude path has a parent"))?;
    let _guard = EXCLUDE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = match fs::read_to_string(&exclude_path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    if current.lines().any(|line| line == EXCLUDE_PATTERN) {
        return Ok(());
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(&exclude_path)?
        .write_all(format!("{separator}{EXCLUDE_PATTERN}\n").as_bytes())
}

/// The bridge command with `${VAR}` placeholders; Devin interpolates its
/// project-local MCP environment from the dispatched turn's environment.
fn environment_bridge_server(kind: &str, suplex: &str, gh_command: Option<&str>) -> Value {
    let (binding, token) = if kind == "root" {
        (ROOT_BINDING_ENV, ROOT_TOKEN_ENV)
    } else {
        (ADVISOR_BINDING_ENV, ADVISOR_TOKEN_ENV)
    };
    let mut environment = Map::new();
    environment.insert(binding.into(), json!(format!("${{{binding}}}")));
    environment.insert(token.into(), json!(format!("${{{token}}}")));
    if let Some(gh) = gh_command {
        environment.insert("SUPLEX_GH_COMMAND".into(), json!(gh));
    }
    json!({ "command": suplex, "args": ["mcp", kind], "env": environment })
}

pub fn ensure(directory: &Path, suplex: &str, gh_command: Option<&str>) -> io::Result<PathBuf> {
    ensure_excluded(directory)?;
    let path = directory.join(LOCAL_CONFIG_PATH);
    let parent = path.parent().expect("config path has a parent");
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let mut next = read_config(&path);
    let servers = next
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("mcpServers is an object");
    servers.insert(
        "suplex_root".into(),
        environment_bridge_server("root", suplex, gh_command),
    );
    servers.insert(
        "suplex_advisor".into(),
        environment_bridge_server("advisor", suplex, gh_command),
    );
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&next).map_err(io::Error::other)?
    );
    if crate::shared::fs::read_optional(&path)?.as_deref() != Some(serialized.as_str()) {
        crate::shared::fs::write_private(&path, serialized.as_bytes())?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_outside_a_git_worktree_is_refused() {
        let directory =
            std::env::temp_dir().join(format!("suplex-devin-no-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let error = ensure(&directory, "/suplex", None).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Devin MCP configuration requires a Git worktree"
        );
        assert!(!directory.join(".devin").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
