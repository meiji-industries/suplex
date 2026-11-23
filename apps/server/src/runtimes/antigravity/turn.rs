//! `suplex antigravity-turn`: the ACP client of one headless turn. The host
//! starts it through the shared headless runtime with the prompt on stdin;
//! it starts `agy acp`, opens or resumes the native session, selects the
//! model and thinking level, sends the prompt, answers permission requests
//! for the role, and writes the turn log (see `transcript`) to stdout.

use std::{
    collections::HashMap,
    error::Error,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    acp::{self, AcpError, AcpProcess, Client},
    cli,
    transcript::Tools,
};

/// The first launch of a runtime unpacks it, which can take minutes.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(300);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the client waits for a command that outlives its prompt.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Root,
    Worker,
    Advisor,
}

impl Role {
    /// The MCP server name of the role's task bridge.
    pub fn bridge_name(self) -> Option<&'static str> {
        match self {
            Self::Root => Some("suplex_root"),
            Self::Advisor => Some("suplex_advisor"),
            Self::Worker => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Worker => "worker",
            Self::Advisor => "advisor",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "root" => Some(Self::Root),
            "worker" => Some(Self::Worker),
            "advisor" => Some(Self::Advisor),
            _ => None,
        }
    }
}

/// One MCP server for `session/new`. `inherit` names variables that the
/// client copies from its own environment, so the file holds no bridge token.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpServer {
    pub name: String,
    /// `stdio` or `http`.
    #[serde(rename = "type")]
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub inherit: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// The MCP servers of a turn and the project tools a read-only role may call.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpConfig {
    pub servers: Vec<McpServer>,
    /// `mcp__<server>__<tool>` names granted to the role.
    #[serde(default)]
    pub grants: Vec<String>,
}

impl McpConfig {
    pub fn has_http(&self) -> bool {
        self.servers.iter().any(|server| server.transport == "http")
    }

    /// ACP `McpServer` values. A missing inherited variable is left out.
    pub fn acp_servers(&self, environment: &dyn Fn(&str) -> Option<String>) -> Value {
        let pairs = |pairs: &[(String, String)]| {
            pairs
                .iter()
                .map(|(name, value)| json!({"name": name, "value": value}))
                .collect::<Vec<_>>()
        };
        Value::Array(
            self.servers
                .iter()
                .map(|server| {
                    if server.transport == "http" {
                        json!({"type":"http","name":server.name,"url":server.url,"headers":pairs(&server.headers)})
                    } else {
                        let mut env = pairs(&server.env);
                        for name in &server.inherit {
                            if let Some(value) = environment(name) {
                                env.push(json!({"name": name, "value": value}));
                            }
                        }
                        json!({"name":server.name,"command":server.command,"args":server.args,"env":env})
                    }
                })
                .collect(),
        )
    }
}

/// The arguments of `suplex antigravity-turn`.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnArgs {
    pub agy: PathBuf,
    pub role: Role,
    pub model: String,
    pub effort: String,
    pub resume: Option<String>,
    pub mcp: Option<PathBuf>,
}

impl TurnArgs {
    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            cli::TURN_SUBCOMMAND.to_owned(),
            "--agy".into(),
            self.agy.to_string_lossy().into_owned(),
            "--role".into(),
            self.role.as_str().into(),
            "--model".into(),
            self.model.clone(),
            "--effort".into(),
            self.effort.clone(),
        ];
        if let Some(resume) = &self.resume {
            args.extend(["--resume".into(), resume.clone()]);
        }
        if let Some(mcp) = &self.mcp {
            args.extend(["--mcp".into(), mcp.to_string_lossy().into_owned()]);
        }
        args
    }

    /// Parses the arguments after the subcommand.
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut values = HashMap::new();
        let mut rest = args.iter();
        while let Some(flag) = rest.next() {
            let value = rest.next().ok_or_else(|| format!("{flag} needs a value"))?;
            values.insert(flag.as_str(), value.clone());
        }
        let required = |flag: &str| {
            values
                .get(flag)
                .cloned()
                .ok_or_else(|| format!("{flag} is required"))
        };
        Ok(Self {
            agy: PathBuf::from(required("--agy")?),
            role: Role::parse(&required("--role")?).ok_or("--role is not valid")?,
            model: values.get("--model").cloned().unwrap_or_default(),
            effort: values.get("--effort").cloned().unwrap_or_default(),
            resume: values.get("--resume").cloned().filter(|id| !id.is_empty()),
            mcp: values.get("--mcp").map(PathBuf::from),
        })
    }
}

/// Models that keep the account's current Antigravity model.
pub fn keeps_current_model(model: &str) -> bool {
    matches!(model, "" | "default" | "antigravity-default")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

/// The permission option to choose for a request, by the role's policy.
/// A Worker may do anything the agent asks; a Coordinator or Advisor only
/// reads, and calls its bridge and its granted project MCP tools.
pub fn permission_choice(role: Role, grants: &[String], params: &Value) -> Value {
    let call = &params["toolCall"];
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let option = |kinds: &[&str]| {
        kinds.iter().find_map(|kind| {
            options
                .iter()
                .find(|option| option["kind"] == *kind)
                .and_then(|option| option["optionId"].as_str())
        })
    };
    let selected = |id: &str| json!({"outcome": {"outcome": "selected", "optionId": id}});
    let cancelled = json!({"outcome": {"outcome": "cancelled"}});
    // A native question is not an approval; no one is there to answer it.
    if call["toolCallId"]
        .as_str()
        .is_some_and(|id| id.starts_with("interaction_"))
    {
        return cancelled;
    }
    let allowed = match role {
        Role::Worker => true,
        Role::Root | Role::Advisor => {
            read_only_kind(call["kind"].as_str()) || mcp_allowed(role, grants, call)
        }
    };
    let chosen = if allowed {
        option(&["allow_once", "allow_always"])
    } else {
        option(&["reject_once", "reject_always"])
    };
    chosen.map_or(cancelled, selected)
}

fn read_only_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("read" | "search" | "think" | "fetch"))
}

/// The MCP server and tool a permission request names: `rawInput` names
/// them, and the title `Run mcp_<server>_<tool>` does on older runtimes.
fn mcp_call(call: &Value, servers: &[&str]) -> Option<(String, String)> {
    let input = &call["rawInput"];
    if let (Some(server), Some(tool)) = (input["ServerName"].as_str(), input["ToolName"].as_str()) {
        return Some((server.to_owned(), tool.to_owned()));
    }
    let title = call["title"].as_str()?.trim().trim_end_matches('?');
    let rest = title.strip_prefix("Run mcp_")?;
    servers.iter().find_map(|server| {
        rest.strip_prefix(server)?
            .strip_prefix('_')
            .map(|tool| ((*server).to_owned(), tool.to_owned()))
    })
}

fn mcp_allowed(role: Role, grants: &[String], call: &Value) -> bool {
    let bridge = role.bridge_name();
    let granted_servers = grants
        .iter()
        .filter_map(|grant| grant.strip_prefix("mcp__")?.split_once("__"))
        .map(|(server, _)| server)
        .collect::<Vec<_>>();
    let servers = bridge
        .into_iter()
        .chain(granted_servers.iter().copied())
        .collect::<Vec<_>>();
    let Some((server, tool)) = mcp_call(call, &servers) else {
        return false;
    };
    Some(server.as_str()) == bridge || grants.contains(&format!("mcp__{server}__{tool}"))
}

/// Writes turn log events and answers the agent.
struct TurnClient<'a, W: Write> {
    output: &'a mut W,
    session_id: Option<String>,
    role: Role,
    grants: Vec<String>,
    tools: Tools,
    /// The current run of message or thought chunks, for `message`/`thought`.
    run: Option<(&'static str, String)>,
    /// Updates of a `session/load` replay are history, not this turn.
    replaying: bool,
}

impl<W: Write> TurnClient<'_, W> {
    fn emit(&mut self, mut event: Value) {
        event["at"] = json!(now_ms());
        let mut line = serde_json::to_vec(&event).unwrap_or_default();
        line.push(b'\n');
        let _ = self.output.write_all(&line);
        let _ = self.output.flush();
    }

    fn finish_run(&mut self) {
        if let Some((kind, text)) = self.run.take()
            && !text.is_empty()
        {
            self.emit(json!({"type": kind, "text": text}));
        }
    }

    fn unsettled(&self) -> Vec<String> {
        self.tools
            .unsettled()
            .into_iter()
            .map(|call| call.id.clone())
            .collect()
    }

    /// Commands that the agent still runs after its prompt ended.
    fn awaited(&self) -> bool {
        self.tools
            .unsettled()
            .into_iter()
            .any(|call| call.kind == "execute" && !call.daemon())
    }
}

impl<W: Write> Client for TurnClient<'_, W> {
    fn notification(&mut self, method: &str, params: &Value) {
        if method != "session/update" || self.replaying {
            return;
        }
        if let Some(session) = &self.session_id
            && params["sessionId"].as_str().is_some_and(|id| id != session)
        {
            return;
        }
        let update = &params["update"];
        let chunk = match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => Some("message"),
            Some("agent_thought_chunk") => Some("thought"),
            _ => None,
        };
        match (chunk, update["content"]["text"].as_str()) {
            (Some(kind), Some(text)) => match &mut self.run {
                Some((current, buffer)) if *current == kind => buffer.push_str(text),
                _ => {
                    self.finish_run();
                    self.run = Some((kind, text.to_owned()));
                }
            },
            (Some(_), None) => {}
            (None, _) => {
                if self.tools.apply(update) {
                    self.finish_run();
                }
            }
        }
        self.emit(json!({"type": "update", "update": update}));
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "session/request_permission" => {
                let choice = permission_choice(self.role, &self.grants, params);
                let call = &params["toolCall"];
                let chosen = choice["outcome"]["optionId"].as_str().map_or_else(
                    || "cancelled".to_owned(),
                    |id| {
                        params["options"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .find(|option| option["optionId"] == id)
                            .and_then(|option| option["kind"].as_str())
                            .unwrap_or(id)
                            .to_owned()
                    },
                );
                if !self.replaying {
                    self.tools.apply(&{
                        let mut update = call.clone();
                        update["sessionUpdate"] = json!("tool_call");
                        update
                    });
                }
                self.emit(json!({
                    "type": "permission",
                    "toolCallId": call["toolCallId"],
                    "kind": call["kind"],
                    "title": call["title"],
                    "outcome": chosen,
                }));
                Ok(choice)
            }
            _ => Err((-32601, format!("Suplex does not offer {method}"))),
        }
    }

    fn text(&mut self, line: &str) {
        if !line.trim().is_empty() {
            self.emit(json!({"type": "agent_output", "text": line}));
        }
    }
}

enum Outcome {
    Completed,
    Failed,
}

/// The agent environment for this process: the inherited one.
fn environment() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn read_mcp(path: Option<&Path>) -> io::Result<McpConfig> {
    match path {
        None => Ok(McpConfig::default()),
        Some(path) => {
            serde_json::from_str(&std::fs::read_to_string(path)?).map_err(io::Error::other)
        }
    }
}

/// Runs one turn and writes its log to `output`. Returns the process exit code.
pub fn run<W: Write>(
    args: &TurnArgs,
    prompt: &str,
    cwd: &Path,
    environment: &HashMap<String, String>,
    output: &mut W,
) -> i32 {
    let mut client = TurnClient {
        output,
        session_id: None,
        role: args.role,
        grants: Vec::new(),
        tools: Tools::default(),
        run: None,
        replaying: false,
    };
    match drive(args, prompt, cwd, environment, &mut client) {
        Ok(Outcome::Completed) => 0,
        Ok(Outcome::Failed) => 1,
        Err(error) => {
            client.finish_run();
            let sign_in = error.sign_in_required();
            client.emit(json!({
                "type": "error",
                "message": if sign_in {
                    format!("Antigravity is not signed in. Run `{}` on the Suplex host, then try again.", cli::LOGIN_COMMAND)
                } else {
                    error.to_string()
                },
                "signInRequired": sign_in,
            }));
            1
        }
    }
}

/// A session request; `Authentication required` signs in once, then retries.
fn open<W: Write>(
    agent: &mut AcpProcess,
    client: &mut TurnClient<'_, W>,
    authenticated: &mut bool,
    environment: &dyn Fn(&str) -> Option<String>,
    method: &str,
    params: Value,
) -> Result<Value, AcpError> {
    match agent.request(method, params.clone(), Some(REQUEST_TIMEOUT), client) {
        Err(error) if error.sign_in_required() && !*authenticated => {
            *authenticated = true;
            let method_id = cli::auth_method(environment);
            client.emit(json!({"type": "authenticate", "methodId": method_id}));
            agent.request(
                "authenticate",
                json!({"methodId": method_id}),
                Some(SIGN_IN_TIMEOUT),
                client,
            )?;
            agent.request(method, params, Some(REQUEST_TIMEOUT), client)
        }
        other => other,
    }
}

fn set<W: Write>(
    agent: &mut AcpProcess,
    client: &mut TurnClient<'_, W>,
    session_id: &str,
    config: &str,
    value: &str,
) -> Result<Value, AcpError> {
    agent.request(
        "session/set_config_option",
        json!({"sessionId": session_id, "configId": config, "value": value}),
        Some(REQUEST_TIMEOUT),
        client,
    )
}

fn drive<W: Write>(
    args: &TurnArgs,
    prompt: &str,
    cwd: &Path,
    environment: &HashMap<String, String>,
    client: &mut TurnClient<'_, W>,
) -> Result<Outcome, AcpError> {
    let mcp = read_mcp(args.mcp.as_deref())?;
    client.grants = mcp.grants.clone();
    let lookup = |name: &str| environment.get(name).cloned();
    let servers = mcp.acp_servers(&lookup);
    let mut agy_args = cli::ACP_ARGS
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect::<Vec<_>>();
    if mcp.has_http() {
        agy_args.push(cli::PROCESS_PER_SESSION_ARG.to_owned());
    }
    let mut agent = AcpProcess::spawn(&args.agy, &agy_args, cwd, environment, true)?;
    let initialized = agent.request(
        "initialize",
        acp::initialize_params(),
        Some(STARTUP_TIMEOUT),
        client,
    )?;
    client.emit(json!({
        "type": "initialized",
        "protocolVersion": initialized["protocolVersion"],
        "agentInfo": initialized["agentInfo"],
        "agentCapabilities": initialized["agentCapabilities"],
        "authMethods": initialized["authMethods"],
    }));
    if let Some(version) = initialized["agentInfo"]["version"].as_str()
        && cli::parse_version(version).is_some_and(|parsed| !cli::supported_version(parsed))
    {
        client.emit(json!({"type": "warning", "message": cli::older_version_message(version)}));
    }
    let capabilities = &initialized["agentCapabilities"];
    let cwd_text = cwd.to_string_lossy().into_owned();
    let mut authenticated = false;
    let mut session = None;
    if let Some(resume) = &args.resume {
        let params = json!({"sessionId": resume, "cwd": cwd_text, "mcpServers": servers});
        client.session_id = Some(resume.clone());
        let resumed = if !capabilities["sessionCapabilities"]["resume"].is_null() {
            open(
                &mut agent,
                client,
                &mut authenticated,
                &lookup,
                "session/resume",
                params,
            )
        } else if capabilities["loadSession"] == true {
            // A load replays the conversation as updates; they are not this turn.
            client.replaying = true;
            let loaded = open(
                &mut agent,
                client,
                &mut authenticated,
                &lookup,
                "session/load",
                params,
            );
            client.replaying = false;
            loaded
        } else {
            Err(AcpError::Rpc {
                code: -32601,
                message: "Antigravity offers no session resume".into(),
            })
        };
        match resumed {
            Ok(result) => {
                client.emit(json!({"type":"session","sessionId":resume,"resumed":true,"configOptions":result["configOptions"]}));
                session = Some((resume.clone(), result["configOptions"].clone()));
            }
            Err(error) if error.sign_in_required() => return Err(error),
            Err(error @ (AcpError::Closed | AcpError::Io(_))) => return Err(error),
            // The native session is gone. A new one lets work continue; the
            // log records what it replaced.
            Err(error) => {
                client.emit(
                    json!({"type":"resume_failed","sessionId":resume,"message":error.to_string()}),
                );
                client.session_id = None;
            }
        }
    }
    let (session_id, mut options) = match session {
        Some(session) => session,
        None => {
            let created = open(
                &mut agent,
                client,
                &mut authenticated,
                &lookup,
                "session/new",
                json!({"cwd": cwd_text, "mcpServers": servers}),
            )?;
            let id = created["sessionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| AcpError::Rpc {
                    code: -32603,
                    message: "Antigravity returned no session id".into(),
                })?
                .to_owned();
            client.emit(json!({"type":"session","sessionId":id,"resumed":false,"replaces":args.resume,"configOptions":created["configOptions"]}));
            (id, created["configOptions"].clone())
        }
    };
    client.session_id = Some(session_id.clone());
    let mut model = None;
    if !keeps_current_model(&args.model) {
        if let Some(option) = acp::model_option(&options) {
            let listed = acp::option_values(option);
            if !listed.iter().any(|(value, _)| value == &args.model) {
                client.emit(json!({
                    "type": "error",
                    "message": format!("Antigravity model '{}' is not available for this account. Select an available model.", args.model),
                    "available": listed.iter().map(|(value, _)| value).collect::<Vec<_>>(),
                }));
                agent.shutdown(Duration::from_secs(2));
                return Ok(Outcome::Failed);
            }
            let id = option["id"]
                .as_str()
                .unwrap_or(cli::MODEL_OPTION)
                .to_owned();
            if option["currentValue"].as_str() != Some(args.model.as_str()) {
                let result = set(&mut agent, client, &session_id, &id, &args.model)?;
                if result["configOptions"].is_array() {
                    options = result["configOptions"].clone();
                }
            }
        } else {
            // No model option: the unstable `session/set_model`.
            agent.request(
                "session/set_model",
                json!({"sessionId": session_id, "modelId": args.model}),
                Some(REQUEST_TIMEOUT),
                client,
            )?;
        }
        model = Some(args.model.clone());
    }
    let mut thinking = None;
    if let Some(option) = acp::thinking_option(&options).cloned() {
        match acp::thinking_value(&option, &args.effort) {
            Some(value) => {
                if option["currentValue"].as_str() != Some(value.as_str()) {
                    let id = option["id"].as_str().unwrap_or_default().to_owned();
                    set(&mut agent, client, &session_id, &id, &value)?;
                }
                thinking = Some(value);
            }
            None => client.emit(json!({
                "type": "warning",
                "message": format!("The model has no thinking level for '{}'; Antigravity keeps {}.", args.effort, option["currentValue"].as_str().unwrap_or("its default")),
            })),
        }
    }
    client.emit(json!({
        "type": "config",
        "model": model.or_else(|| acp::model_option(&options).and_then(|option| option["currentValue"].as_str()).map(str::to_owned)),
        "thinking": thinking,
    }));
    let result = agent.request(
        "session/prompt",
        json!({"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]}),
        None,
        client,
    );
    client.finish_run();
    let result = result?;
    client.emit(json!({
        "type": "prompt_result",
        "stopReason": result["stopReason"],
        "usage": result["usage"],
        "meta": result["_meta"],
    }));
    // Antigravity can go on running a command after the prompt ends, and
    // reports it when the command finishes.
    let _ = agent.drain(Instant::now() + SETTLE_TIMEOUT, client, |client| {
        !client.awaited()
    });
    client.finish_run();
    let unsettled = client.unsettled();
    client.emit(json!({"type": "settled", "unsettled": unsettled}));
    agent.shutdown(Duration::from_secs(3));
    Ok(match result["stopReason"].as_str() {
        Some("end_turn" | "max_tokens" | "max_turn_requests") => Outcome::Completed,
        _ => Outcome::Failed,
    })
}

/// Entry point for `suplex antigravity-turn ...`. The prompt is on stdin.
pub fn main(args: &[String]) -> Result<(), Box<dyn Error + Send + Sync>> {
    let args = TurnArgs::parse(args)?;
    let mut prompt = String::new();
    io::stdin().read_to_string(&mut prompt)?;
    let cwd = std::env::current_dir()?;
    let code = run(
        &args,
        &prompt,
        &cwd,
        &environment(),
        &mut io::stdout().lock(),
    );
    std::process::exit(code);
}
