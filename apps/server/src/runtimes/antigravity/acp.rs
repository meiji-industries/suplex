//! A small blocking ACP client: JSON-RPC 2.0, one JSON object per line, on the
//! stdin and stdout of `agy acp`. The client answers the agent's requests
//! through a [`Client`] while it waits for its own responses.

use std::{
    collections::HashMap,
    fmt,
    io::{self, BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::cli;

/// The longest line the client keeps from a non-JSON stdout line.
const TEXT_LIMIT: usize = 4_000;

#[derive(Debug)]
pub enum AcpError {
    /// The agent answered with a JSON-RPC error.
    Rpc {
        code: i64,
        message: String,
    },
    Timeout(String),
    /// The agent closed stdout or exited.
    Closed,
    /// The agent started a browser sign-in: it has no usable credentials.
    SignInRequired,
    Io(io::Error),
}

impl AcpError {
    /// `Authentication required`, or the 1.5 CLI's no-browser answer.
    pub fn sign_in_required(&self) -> bool {
        match self {
            Self::SignInRequired => true,
            Self::Rpc { code, message } => {
                *code == cli::AUTH_REQUIRED_CODE
                    || (*code == -32603 && message.starts_with(cli::NO_BROWSER_PREFIX))
            }
            Self::Timeout(_) | Self::Closed | Self::Io(_) => false,
        }
    }
}

impl fmt::Display for AcpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rpc { code, message } => write!(formatter, "{message} ({code})"),
            Self::Timeout(method) => write!(formatter, "Antigravity did not answer {method}"),
            Self::Closed => write!(formatter, "Antigravity stopped before it answered"),
            Self::SignInRequired => write!(formatter, "Antigravity is not signed in"),
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for AcpError {}

impl From<io::Error> for AcpError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// What the agent sends that is not a response to a client request.
pub trait Client {
    fn notification(&mut self, method: &str, params: &Value);
    /// The result of an agent request, or a JSON-RPC error.
    fn request(&mut self, method: &str, params: &Value) -> Result<Value, (i64, String)>;
    /// A stdout line that is not a JSON-RPC message.
    fn text(&mut self, _line: &str) {}
}

enum Incoming {
    Message(Value),
    Text(String),
    Closed,
}

pub struct AcpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    incoming: Receiver<Incoming>,
    next_id: u64,
}

impl AcpProcess {
    /// Starts `agy <args>` in `cwd` with exactly `environment`. Its stderr
    /// goes to this process's stderr when `stderr` is set, else nowhere.
    pub fn spawn(
        executable: &Path,
        args: &[String],
        cwd: &Path,
        environment: &HashMap<String, String>,
        stderr: bool,
    ) -> io::Result<Self> {
        let mut child = Command::new(executable)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(environment)
            // A browser sign-in must print its link, not open a window.
            .env("BROWSER", "false")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if stderr {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (sender, incoming) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => {
                        let _ = sender.send(Incoming::Closed);
                        return;
                    }
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&line);
                        let text = text.trim_end_matches(['\r', '\n']);
                        let message = match serde_json::from_str::<Value>(text) {
                            Ok(value @ Value::Object(_)) => Incoming::Message(value),
                            _ => Incoming::Text(text.chars().take(TEXT_LIMIT).collect()),
                        };
                        if sender.send(message).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        Ok(Self {
            stdin: child.stdin.take(),
            child,
            incoming,
            next_id: 0,
        })
    }

    fn send(&mut self, message: &Value) -> Result<(), AcpError> {
        let stdin = self.stdin.as_mut().ok_or(AcpError::Closed)?;
        let mut line = serde_json::to_vec(message).map_err(io::Error::other)?;
        line.push(b'\n');
        stdin
            .write_all(&line)
            .and_then(|()| stdin.flush())
            .map_err(|_| AcpError::Closed)
    }

    /// Sends one request and handles agent messages until its response.
    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
        client: &mut dyn Client,
    ) -> Result<Value, AcpError> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        loop {
            let wait = deadline.map_or(Duration::from_secs(3600), |deadline| {
                deadline.saturating_duration_since(Instant::now())
            });
            match self.incoming.recv_timeout(wait) {
                Ok(Incoming::Message(message)) => {
                    if message.get("method").is_none() && message["id"] == json!(id) {
                        return match message.get("error") {
                            Some(error) => Err(AcpError::Rpc {
                                code: error["code"].as_i64().unwrap_or_default(),
                                message: error["message"].as_str().unwrap_or_default().to_owned(),
                            }),
                            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                        };
                    }
                    self.handle(&message, client)?;
                }
                Ok(Incoming::Text(line)) => {
                    client.text(&line);
                    if line.starts_with(cli::SIGN_IN_LINK_PREFIX) {
                        return Err(AcpError::SignInRequired);
                    }
                }
                Ok(Incoming::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(AcpError::Closed);
                }
                Err(RecvTimeoutError::Timeout) => {
                    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                        return Err(AcpError::Timeout(method.to_owned()));
                    }
                }
            }
        }
    }

    /// Handles agent messages until `done` holds or `until` passes.
    pub fn drain<C: Client>(
        &mut self,
        until: Instant,
        client: &mut C,
        done: impl Fn(&C) -> bool,
    ) -> Result<(), AcpError> {
        while !done(client) && Instant::now() < until {
            match self.incoming.recv_timeout(Duration::from_millis(200)) {
                Ok(Incoming::Message(message)) => self.handle(&message, client)?,
                Ok(Incoming::Text(line)) => client.text(&line),
                Ok(Incoming::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(AcpError::Closed);
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        Ok(())
    }

    fn handle(&mut self, message: &Value, client: &mut dyn Client) -> Result<(), AcpError> {
        let Some(method) = message["method"].as_str() else {
            // A response to a request this client no longer waits for.
            return Ok(());
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match message.get("id") {
            None => {
                client.notification(method, &params);
                Ok(())
            }
            Some(id) => {
                let response = match client.request(method, &params) {
                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err((code, text)) => {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}})
                    }
                };
                self.send(&response)
            }
        }
    }

    /// Closes stdin, waits briefly for the agent to exit, then kills it.
    pub fn shutdown(mut self, grace: Duration) {
        self.stdin = None;
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// The client capabilities Suplex sends: the agent uses its own file and
/// terminal tools.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": cli::PROTOCOL_VERSION,
        "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
        "clientInfo": {"name": "suplex", "title": "Suplex", "version": env!("CARGO_PKG_VERSION")},
    })
}

/// The selectable values of a `select` session option; grouped options are
/// flattened.
pub fn option_values(option: &Value) -> Vec<(String, String)> {
    fn collect(entries: &Value, into: &mut Vec<(String, String)>) {
        for entry in entries.as_array().into_iter().flatten() {
            if let Some(value) = entry["value"].as_str() {
                let name = entry["name"].as_str().unwrap_or(value);
                into.push((value.to_owned(), name.to_owned()));
            } else {
                collect(&entry["options"], into);
            }
        }
    }
    let mut values = Vec::new();
    collect(&option["options"], &mut values);
    values
}

/// The model option of a session's config options.
pub fn model_option(options: &Value) -> Option<&Value> {
    options
        .as_array()?
        .iter()
        .find(|option| option["id"] == cli::MODEL_OPTION || option["category"] == cli::MODEL_OPTION)
}

/// The thinking level option of a session's config options.
pub fn thinking_option(options: &Value) -> Option<&Value> {
    options
        .as_array()?
        .iter()
        .find(|option| option["category"] == cli::THINKING_CATEGORY)
}

/// The option value that names a Suplex reasoning level.
pub fn thinking_value(option: &Value, reasoning_level: &str) -> Option<String> {
    let names = cli::thinking_names(reasoning_level);
    option_values(option)
        .into_iter()
        .find(|(value, name)| {
            let (value, name) = (value.to_lowercase(), name.to_lowercase());
            names
                .iter()
                .any(|candidate| value == *candidate || name == *candidate)
        })
        .map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_options_select_models_and_thinking_levels_by_category() {
        let options = json!([
            {"id":"model","name":"Model","type":"select","currentValue":"gemini-a","options":[
                {"value":"gemini-a","name":"Gemini A"},
                {"group":"Partners","name":"Partners","options":[{"value":"claude-b","name":"Claude B"}]}
            ]},
            {"id":"thinking","name":"Thinking level","category":"thought_level","type":"select","currentValue":"medium","options":[
                {"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},
                {"value":"extra","name":"Extra"},{"value":"max","name":"Max"}
            ]}
        ]);
        let model = model_option(&options).unwrap();
        assert_eq!(
            option_values(model),
            [
                ("gemini-a".to_owned(), "Gemini A".to_owned()),
                ("claude-b".to_owned(), "Claude B".to_owned())
            ]
        );
        let thinking = thinking_option(&options).unwrap();
        assert_eq!(thinking_value(thinking, "xhigh").as_deref(), Some("extra"));
        assert_eq!(thinking_value(thinking, "low").as_deref(), Some("low"));
        assert_eq!(thinking_value(thinking, "unknown"), None);
        let named = json!({"options":[{"value":"t3","name":"Max"}]});
        assert_eq!(thinking_value(&named, "max").as_deref(), Some("t3"));
    }

    #[test]
    fn sign_in_errors_are_recognized() {
        assert!(
            AcpError::Rpc {
                code: -32000,
                message: "Authentication required".into()
            }
            .sign_in_required()
        );
        assert!(
            AcpError::Rpc {
                code: -32603,
                message: "No browser is available here.".into()
            }
            .sign_in_required()
        );
        assert!(
            !AcpError::Rpc {
                code: -32603,
                message: "Internal".into()
            }
            .sign_in_required()
        );
        assert!(AcpError::SignInRequired.sign_in_required());
        assert!(!AcpError::Closed.sign_in_required());
    }
}
