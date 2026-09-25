//! The task-owned OpenCode server process: role configuration, launch, identity, and stop.

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    fs, io,
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::{
    client::{OpenCodeClient, OpenCodeFailure},
    session::{BoxError, open_code_model},
};
use crate::{
    coordination::bridge_auth::prepare_runtime_directory,
    profiles::agent_profiles::{executable as is_executable, home_directory},
    runtimes::{
        headless::{self, HeadlessTurnRecord, RecordedProcessIdentity},
        process::{IdentityMatch, compare_identity, inspect_process, owner_marker},
    },
    shared::js_json,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerReference {
    pub pid: u32,
    pub base_url: String,
    pub password: String,
    pub directory: String,
    pub executable: String,
    pub generation: String,
    pub config_hash: String,
    pub process_identity: RecordedProcessIdentity,
}

impl ServerReference {
    pub fn parse(bytes: &[u8]) -> io::Result<Self> {
        let reference: Self = serde_json::from_slice(bytes).map_err(io::Error::other)?;
        let identity = &reference.process_identity;
        let valid = reference.pid > 0
            && url::Url::parse(&reference.base_url).is_ok()
            && reference.password.len() >= 32
            && reference.generation.len() == 36
            && uuid::Uuid::parse_str(&reference.generation).is_ok()
            && reference.config_hash.len() == 64
            && reference
                .config_hash
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            && !identity.command.is_empty()
            && !identity.executable.is_empty()
            && identity.process_group > 0
            && !identity.start_time.is_empty();
        if valid {
            Ok(reference)
        } else {
            Err(io::Error::other("OpenCode server reference is invalid"))
        }
    }

    fn owned(&self) -> HeadlessTurnRecord {
        HeadlessTurnRecord {
            generation: self.generation.clone(),
            turn_id: format!("opencode-{}", self.generation),
            session_id: String::new(),
            pid: self.pid,
            process_identity: self.process_identity.clone(),
            dispatch_arguments: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Profile {
    /// Vendor-qualified, such as `openai/gpt-5.6-sol`.
    pub model_id: String,
    pub reasoning_effort: String,
    pub service_tier: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoleKind {
    Root,
    Worker,
    Advisor,
}

impl RoleKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Worker => "worker",
            Self::Advisor => "advisor",
        }
    }
}

#[derive(Clone, Debug)]
pub struct BridgeServer {
    pub command: String,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

pub struct RoleConfigInput<'a> {
    pub role: RoleKind,
    pub profile: &'a Profile,
    pub bridge: Option<&'a BridgeServer>,
    /// Explicit task-owned evidence and context directories; other external paths remain denied.
    pub evidence_directory: Option<&'a str>,
    pub context_directory: Option<&'a str>,
    /// The task worktree; listed so an alias of the working directory (macOS /var vs /private/var) is not treated as external.
    pub directory: Option<&'a str>,
}

pub fn role_config(input: RoleConfigInput<'_>) -> Result<Value, String> {
    let native = open_code_model(&input.profile.model_id)?;
    let model = format!("{}/{}", native.provider_id, native.model_id);
    let effort = &input.profile.reasoning_effort;
    let tier = &input.profile.service_tier;
    let worktree = input
        .directory
        .filter(|_| input.evidence_directory.is_some());
    let allowed: Vec<&str> = [input.evidence_directory, input.context_directory, worktree]
        .into_iter()
        .flatten()
        .filter(|path| !path.is_empty())
        .collect();
    let read_only_external = if allowed.is_empty() {
        json!("deny")
    } else {
        let mut rules = Map::from_iter([("*".to_owned(), json!("deny"))]);
        for path in allowed {
            rules.insert(path.to_owned(), json!("allow"));
            rules.insert(format!("{path}/**"), json!("allow"));
        }
        Value::Object(rules)
    };
    let (permission, tools) = match input.role {
        RoleKind::Root => (
            json!({"read":"allow","edit":"deny","bash":"deny","task":"deny","question":"deny","external_directory":read_only_external,"doom_loop":"allow"}),
            json!({"bash":false,"edit":false,"write":false,"apply_patch":false,"task":false,"question":false}),
        ),
        RoleKind::Advisor => (
            json!({"read":"allow","edit":"deny","bash":"deny","task":"deny","question":"deny","external_directory":read_only_external,"doom_loop":"allow","suplex_root_*":"deny"}),
            json!({"bash":false,"edit":false,"write":false,"apply_patch":false,"task":false,"question":false,"suplex_root_*":false,"suplex_advisor_*":true}),
        ),
        RoleKind::Worker => (
            json!({"read":"allow","edit":"allow","bash":"allow","external_directory":"allow","doom_loop":"allow","task":"deny","question":"deny","suplex_root_*":"deny"}),
            json!({"task":false,"question":false,"suplex_root_*":false}),
        ),
    };
    let agent = format!("suplex-{}", input.role.name());
    let mut config = json!({
        "model": model,
        "default_agent": agent,
        "agent": {agent.clone(): {"mode":"primary","model":model,"variant":effort,"permission":permission,"tools":tools,"reasoningEffort":effort,"serviceTier":tier}},
        "provider": {native.provider_id.clone(): {"models": {native.model_id.clone(): {"options": {"reasoningEffort":effort,"serviceTier":tier}}}}},
    });
    if let Some(bridge) = input.bridge.filter(|_| input.role != RoleKind::Worker) {
        let name = if input.role == RoleKind::Root {
            "suplex_root"
        } else {
            "suplex_advisor"
        };
        let command: Vec<&str> = std::iter::once(bridge.command.as_str())
            .chain(bridge.args.iter().map(String::as_str))
            .collect();
        config["mcp"] = json!({name: {"type":"local","command":command,"environment":bridge.environment,"enabled":true}});
    }
    Ok(config)
}

pub fn config_hash(config: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(js_json::stringify(config).as_bytes())
    )
}

pub fn client(reference: &ServerReference) -> Result<OpenCodeClient, OpenCodeFailure> {
    OpenCodeClient::new(&reference.base_url, &reference.password)
}

pub fn read_server(runtime_directory: &Path) -> io::Result<Option<ServerReference>> {
    match fs::read(runtime_directory.join("server.json")) {
        Ok(bytes) => ServerReference::parse(&bytes).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    kill(Pid::from_raw(pid), None) != Err(Errno::ESRCH)
}

pub fn server_running(reference: &ServerReference) -> bool {
    process_alive(reference.pid)
        && compare_identity(
            &reference.owned().owned_identity(),
            inspect_process(reference.pid).as_ref(),
        ) == IdentityMatch::Exact
}

/// Stops only the exact recorded process. A reused PID is left alone.
pub fn stop_server(reference: &ServerReference) -> io::Result<()> {
    let owned = reference.owned();
    match inspect_process(reference.pid) {
        Some(found)
            if compare_identity(&owned.owned_identity(), Some(&found)) != IdentityMatch::Exact =>
        {
            return Ok(());
        }
        None if process_alive(reference.pid) => {
            return Err(io::Error::other(
                "OpenCode process identity could not be inspected",
            ));
        }
        _ => {}
    }
    headless::stop_owned(&owned)
}

pub fn resolve_executable(override_path: Option<&Path>) -> io::Result<PathBuf> {
    resolve_with(
        override_path,
        std::env::var_os("SUPLEX_OPENCODE_COMMAND").as_deref(),
        std::env::var_os("PATH").as_deref(),
        home_directory().as_deref(),
    )
}

fn resolve_with(
    override_path: Option<&Path>,
    configured: Option<&OsStr>,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
) -> io::Result<PathBuf> {
    if let Some(path) = override_path.or_else(|| configured.map(Path::new)) {
        if !path.is_absolute() {
            return Err(io::Error::other(
                "OpenCode executable must be an absolute path. Check SUPLEX_OPENCODE_COMMAND.",
            ));
        }
        if !is_executable(path) {
            return Err(io::Error::other(
                "OpenCode executable cannot be executed. Check SUPLEX_OPENCODE_COMMAND.",
            ));
        }
        return Ok(path.to_owned());
    }
    let on_path = search_path
        .map(|search| {
            std::env::split_paths(search)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join("opencode"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    on_path
        .into_iter()
        .chain(home.map(|home| home.join(".opencode/bin/opencode")))
        .find(|path| is_executable(path))
        .ok_or_else(|| {
            io::Error::other(
                "Install OpenCode or set SUPLEX_OPENCODE_COMMAND to its absolute executable path.",
            )
        })
}

pub struct EnsureInput<'a> {
    pub runtime_directory: &'a Path,
    pub executable: &'a Path,
    pub directory: &'a Path,
    pub config: &'a Value,
    pub env: Option<&'a HashMap<String, String>>,
}

fn unused_port() -> io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// The caller holds the task's durable launch claim. A live but unreachable
/// process is never replaced from this helper.
pub async fn ensure_server(input: EnsureInput<'_>) -> Result<ServerReference, BoxError> {
    if !input.executable.is_absolute() {
        return Err("OpenCode executable must be absolute".into());
    }
    let executable = input.executable.to_string_lossy().into_owned();
    let directory = fs::canonicalize(input.directory)?
        .to_string_lossy()
        .into_owned();
    let hash = config_hash(input.config);
    if let Some(previous) = read_server(input.runtime_directory)?
        && server_running(&previous)
    {
        if previous.directory != directory || previous.executable != executable {
            return Err("OpenCode runtime scope changed".into());
        }
        let client = client(&previous)?;
        client.health().await?;
        if previous.config_hash == hash {
            return Ok(previous);
        }
        let statuses = client.get_status(Some(&directory)).await?;
        if statuses.values().any(|status| status.kind() != "idle") {
            return Ok(previous);
        }
        stop_server(&previous)?;
    }
    prepare_runtime_directory(input.runtime_directory)?;
    let port = unused_port()?;
    let generation = uuid::Uuid::new_v4().to_string();
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret)?;
    let password: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
    let log_path = input.runtime_directory.join("server.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)?;
    let mut environment = input
        .env
        .cloned()
        .unwrap_or_else(|| std::env::vars().collect());
    environment.extend([
        (
            "SUPLEX_TASK_PROCESS_OWNER".to_owned(),
            owner_marker(input.directory),
        ),
        (
            "SUPLEX_SESSION_PROCESS_OWNER".to_owned(),
            owner_marker(input.runtime_directory),
        ),
        (
            "SUPLEX_EXECUTION_PROCESS_OWNER".to_owned(),
            owner_marker(&input.runtime_directory.join(&generation)),
        ),
        ("OPENCODE_SERVER_USERNAME".to_owned(), "opencode".to_owned()),
        ("OPENCODE_SERVER_PASSWORD".to_owned(), password.clone()),
        (
            "OPENCODE_CONFIG_CONTENT".to_owned(),
            js_json::stringify(input.config),
        ),
    ]);
    let mut child = Command::new(input.executable)
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .current_dir(&directory)
        .env_clear()
        .envs(&environment)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let inspection = inspect_process(pid)
        .filter(|found| found.owner_uid.is_some() && found.process_group == pid)
        .ok_or("OpenCode process identity could not be established")?;
    let reference = ServerReference {
        pid,
        base_url: format!("http://127.0.0.1:{port}"),
        password,
        directory,
        executable,
        generation,
        config_hash: hash,
        process_identity: RecordedProcessIdentity {
            command: inspection.command,
            executable: inspection.executable,
            argv: inspection.argv,
            process_group: inspection.process_group,
            start_time: inspection.start_time,
            owner_uid: inspection.owner_uid.unwrap_or_default(),
        },
    };
    crate::shared::fs::write_private(
        &input.runtime_directory.join("server.json"),
        &serde_json::to_vec(&reference)?,
    )?;
    let client = client(&reference)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if client.health().await.is_ok() {
            return Ok(reference);
        }
        if !process_alive(pid) {
            return Err(format!(
                "OpenCode exited during startup; inspect {}",
                log_path.display()
            )
            .into());
        }
        if Instant::now() >= deadline {
            return Err(
                format!("OpenCode is alive but not ready at {}", reference.base_url).into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The pane command reads the server password from a private file, not from its argv.
pub fn attach_command(
    reference: &ServerReference,
    runtime_directory: &Path,
    session_id: &str,
) -> io::Result<String> {
    let valid = session_id.strip_prefix("ses").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    });
    if !valid {
        return Err(io::Error::other("Invalid OpenCode session identity"));
    }
    let env_file = runtime_directory.join("attach.env");
    crate::shared::fs::write_private(
        &env_file,
        format!(
            "export OPENCODE_SERVER_PASSWORD={}\n",
            shell_quote(&reference.password)
        )
        .as_bytes(),
    )?;
    Ok(format!(
        "source {}; {} attach {} --dir {} --session {} --mini",
        shell_quote(&env_file.to_string_lossy()),
        shell_quote(&reference.executable),
        shell_quote(&reference.base_url),
        shell_quote(&reference.directory),
        shell_quote(session_id)
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    pub(crate) fn profile() -> Profile {
        Profile {
            model_id: "openai/gpt-5.6-luna".into(),
            reasoning_effort: "max".into(),
            service_tier: "priority".into(),
        }
    }

    fn bridge(script: &str, token: &str) -> BridgeServer {
        BridgeServer {
            command: "/node".into(),
            args: vec![script.into()],
            environment: BTreeMap::from([(token.to_owned(), "token".to_owned())]),
        }
    }

    fn input(role: RoleKind, profile: &Profile) -> RoleConfigInput<'_> {
        RoleConfigInput {
            role,
            profile,
            bridge: None,
            evidence_directory: None,
            context_directory: None,
            directory: None,
        }
    }

    pub(crate) fn temporary(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("suplex-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn denies_coordinator_native_mutations_without_resetting_inherited_mcp_servers() {
        let profile = profile();
        let bridge = bridge("/suplex/root-bridge.ts", "SUPLEX_ROOT_TOKEN");
        let config = role_config(RoleConfigInput {
            bridge: Some(&bridge),
            ..input(RoleKind::Root, &profile)
        })
        .unwrap();
        assert_eq!(config["default_agent"], "suplex-root");
        let agent = &config["agent"]["suplex-root"];
        assert_eq!(
            [
                &agent["permission"]["edit"],
                &agent["permission"]["bash"],
                &agent["permission"]["task"]
            ],
            ["deny", "deny", "deny"]
        );
        for tool in ["bash", "write", "edit", "apply_patch", "task"] {
            assert_eq!(agent["tools"][tool], false);
        }
        assert_eq!(
            config["mcp"],
            json!({"suplex_root":{"type":"local","command":["/node","/suplex/root-bridge.ts"],"environment":{"SUPLEX_ROOT_TOKEN":"token"},"enabled":true}})
        );
        assert!(!config.to_string().contains(r#""*":"allow""#));
    }

    #[test]
    fn lets_workers_edit_but_not_spawn_native_subagents_or_call_the_coordinator_bridge() {
        let profile = profile();
        let bridge = bridge("/suplex/root-bridge.ts", "SUPLEX_ROOT_TOKEN");
        let config = role_config(RoleConfigInput {
            bridge: Some(&bridge),
            ..input(RoleKind::Worker, &profile)
        })
        .unwrap();
        assert_eq!(config["model"], "openai/gpt-5.6-luna");
        let agent = &config["agent"]["suplex-worker"];
        assert_eq!(agent["permission"]["task"], "deny");
        assert_eq!(agent["tools"]["task"], false);
        assert_eq!(agent["tools"]["suplex_root_*"], false);
        assert_eq!(
            config["provider"],
            json!({"openai":{"models":{"gpt-5.6-luna":{"options":{"reasoningEffort":"max","serviceTier":"priority"}}}}})
        );
        assert!(config.get("mcp").is_none());
    }

    #[test]
    fn gives_advisors_only_the_read_only_report_bridge() {
        let profile = profile();
        let bridge = bridge("/suplex/advisor-report-bridge.ts", "SUPLEX_ADVISOR_TOKEN");
        let config = role_config(RoleConfigInput {
            bridge: Some(&bridge),
            evidence_directory: Some("/evidence"),
            directory: Some("/repo"),
            ..input(RoleKind::Advisor, &profile)
        })
        .unwrap();
        let agent = &config["agent"]["suplex-advisor"];
        for permission in ["edit", "bash", "task", "suplex_root_*"] {
            assert_eq!(agent["permission"][permission], "deny");
        }
        assert_eq!(
            agent["permission"]["external_directory"],
            json!({"*":"deny","/evidence":"allow","/evidence/**":"allow","/repo":"allow","/repo/**":"allow"})
        );
        assert_eq!(agent["tools"]["suplex_advisor_*"], true);
        assert_eq!(agent["tools"]["suplex_root_*"], false);
        assert_eq!(
            config["mcp"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["suplex_advisor"]
        );
    }

    pub(crate) fn node() -> String {
        let output = Command::new("which").arg("node").output().unwrap();
        assert!(
            output.status.success(),
            "node is required for the fake OpenCode server"
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[tokio::test]
    async fn refreshes_a_live_opencode_server_for_authenticated_bridge_environment_only_after_native_work_is_idle()
     {
        let directory = temporary("opencode-config-refresh");
        let runtime = directory.join("runtime");
        let status_path = directory.join("status.json");
        let config_log = directory.join("configs.jsonl");
        let executable = directory.join("opencode");
        fs::write(
            &executable,
            format!(
                r#"#!{}
const fs = require("node:fs");
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
fs.appendFileSync(process.env.SUPLEX_TEST_CONFIG_LOG, process.env.OPENCODE_CONFIG_CONTENT + "\n");
const server = http.createServer((request, response) => {{
  response.setHeader("content-type", "application/json");
  if (request.url.startsWith("/global/health")) response.end(JSON.stringify({{ healthy: true, version: "test" }}));
  else if (request.url.startsWith("/session/status")) response.end(fs.readFileSync(process.env.SUPLEX_TEST_STATUS_PATH, "utf8"));
  else {{ response.statusCode = 404; response.end(JSON.stringify({{ error: "missing" }})); }}
}});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
"#,
                node()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&status_path, r#"{"ses_existing":{"type":"busy"}}"#).unwrap();
        let old = json!({"mcp":{"suplex_root":{"type":"local","command":["node","bridge"],"enabled":true}}});
        let authenticated = json!({"mcp":{"suplex_root":{"type":"local","command":["node","bridge"],"environment":{"SUPLEX_ROOT_TOKEN":"token"},"enabled":true}}});
        let mut environment: HashMap<String, String> = std::env::vars().collect();
        environment.insert(
            "SUPLEX_TEST_STATUS_PATH".into(),
            status_path.display().to_string(),
        );
        environment.insert(
            "SUPLEX_TEST_CONFIG_LOG".into(),
            config_log.display().to_string(),
        );
        let ensure = |config| EnsureInput {
            runtime_directory: &runtime,
            executable: &executable,
            directory: &directory,
            config,
            env: Some(&environment),
        };
        let first = ensure_server(ensure(&old)).await.unwrap();
        let retained = ensure_server(ensure(&authenticated)).await.unwrap();
        assert_eq!(retained.generation, first.generation);
        assert!(server_running(&first));
        let lines = || {
            fs::read_to_string(&config_log)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(lines().len(), 1);
        fs::write(&status_path, r#"{"ses_existing":{"type":"idle"}}"#).unwrap();
        let refreshed = ensure_server(ensure(&authenticated)).await.unwrap();
        assert_ne!(refreshed.generation, first.generation);
        assert!(!server_running(&first));
        assert_eq!(lines(), [old.clone(), authenticated.clone()]);
        stop_server(&refreshed).unwrap();
        assert!(!server_running(&refreshed));
        fs::remove_dir_all(directory).unwrap();
    }

    fn reference(pid: u32, directory: &str, start_time: &str) -> ServerReference {
        ServerReference {
            pid,
            base_url: "http://127.0.0.1:1234".into(),
            password: "private-proof-password-not-for-pane-output".into(),
            directory: directory.into(),
            executable: "/bin/opencode".into(),
            generation: "b775df17-718a-4cb2-8e23-6912b8aa0d39".into(),
            config_hash: "a".repeat(64),
            process_identity: RecordedProcessIdentity {
                command: "opencode serve".into(),
                executable: "/bin/opencode".into(),
                argv: vec!["opencode".into(), "serve".into()],
                process_group: pid,
                start_time: start_time.into(),
                owner_uid: 501,
            },
        }
    }

    #[test]
    fn keeps_attach_credentials_out_of_the_pane_command() {
        let directory = temporary("attach-test");
        let reference = reference(std::process::id(), "/repo with spaces", "original");
        let command = attach_command(&reference, &directory, "ses_proof").unwrap();
        assert!(!command.contains(&reference.password));
        assert!(command.contains("--session 'ses_proof'"));
        assert!(command.contains("--mini"));
        assert!(command.contains("--dir '/repo with spaces'"));
        let env_file = directory.join("attach.env");
        assert_eq!(
            fs::metadata(&env_file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            fs::read_to_string(&env_file)
                .unwrap()
                .contains(&reference.password)
        );
        assert!(read_server(&directory).unwrap().is_none());
        assert_eq!(
            attach_command(&reference, &directory, "ses_bad; touch /tmp/no")
                .unwrap_err()
                .to_string(),
            "Invalid OpenCode session identity"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn never_signals_a_reused_server_pid() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let reused = reference(child.id(), "/repo", "replacement");
        stop_server(&reused).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn server_references_are_strict() {
        let valid = reference(4321, "/repo", "start");
        let bytes = serde_json::to_vec(&valid).unwrap();
        assert!(ServerReference::parse(&bytes).is_ok());
        let mut extra: Value = serde_json::from_slice(&bytes).unwrap();
        extra["unexpected"] = json!(1);
        assert!(ServerReference::parse(extra.to_string().as_bytes()).is_err());
        let short = ServerReference {
            password: "short".into(),
            ..valid
        };
        assert!(ServerReference::parse(&serde_json::to_vec(&short).unwrap()).is_err());
    }

    #[test]
    fn executable_override_precedes_path_and_home() {
        let root = temporary("opencode-exec");
        let on_path = root.join("bin/opencode");
        let at_home = root.join("home/.opencode/bin/opencode");
        for path in [&on_path, &at_home] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "#!/bin/sh\n").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let search = std::env::join_paths([on_path.parent().unwrap()]).unwrap();
        let home = root.join("home");
        assert_eq!(
            resolve_with(None, None, Some(&search), Some(&home)).unwrap(),
            on_path
        );
        assert_eq!(
            resolve_with(None, None, None, Some(&home)).unwrap(),
            at_home
        );
        assert!(resolve_with(Some(Path::new("relative/opencode")), None, None, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
