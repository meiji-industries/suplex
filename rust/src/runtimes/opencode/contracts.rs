//! OpenCode v1 HTTP envelopes. Unknown keys pass through in `raw`; the typed
//! fields carry the same checks as the source Zod schemas.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// Zod `.optional()` accepts an absent key but rejects `null`.
fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(input: D) -> Result<Option<T>, D::Error> {
    T::deserialize(input).map(Some)
}

fn filled(value: &str) -> bool {
    !value.is_empty()
}

fn optional_filled(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(filled)
}

fn whole(value: f64) -> bool {
    value >= 0.0 && value.fract() == 0.0
}

pub type Invalid = String;

fn invalid<T>(what: &str) -> Result<T, Invalid> {
    Err(format!("{what} is invalid"))
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value, what: &str) -> Result<T, Invalid> {
    serde_json::from_value(value).map_err(|_| format!("{what} is invalid"))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Health {
    pub healthy: bool,
    pub version: String,
}

impl Health {
    pub fn parse(value: Value) -> Result<Self, Invalid> {
        let health: Self = parse(value, "OpenCode health")?;
        if health.healthy && filled(&health.version) {
            Ok(health)
        } else {
            invalid("OpenCode health")
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct McpServerStatus {
    pub status: String,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub error: Option<String>,
}

pub type McpStatus = HashMap<String, McpServerStatus>;

// Provider keys and options are stripped at the HTTP boundary. Neither belongs in Suplex.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ProviderModel {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Provider {
    pub id: String,
    pub name: String,
    // ponytail: sorted keys, not native insertion order; callers sort models by label anyway.
    pub models: BTreeMap<String, ProviderModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Providers {
    pub all: Vec<Provider>,
    pub connected: Vec<String>,
    pub default: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct NativeError {
    pub name: String,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub data: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MessageModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    #[serde(
        default,
        deserialize_with = "some",
        skip_serializing_if = "Option::is_none"
    )]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UserTime {
    pub created: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub time: UserTime,
    pub agent: String,
    pub model: MessageModel,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MessageTime {
    pub created: f64,
    #[serde(default, deserialize_with = "some")]
    pub completed: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MessagePath {
    pub cwd: String,
    pub root: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CacheTokens {
    pub read: f64,
    pub write: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Tokens {
    pub input: f64,
    pub output: f64,
    pub reasoning: f64,
    pub cache: CacheTokens,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AssistantMessage {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub time: MessageTime,
    #[serde(default, deserialize_with = "some")]
    pub error: Option<NativeError>,
    #[serde(rename = "parentID")]
    pub parent_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub mode: String,
    pub agent: String,
    #[serde(default, deserialize_with = "some")]
    pub summary: Option<bool>,
    pub path: MessagePath,
    pub cost: f64,
    pub tokens: Tokens,
    #[serde(default, deserialize_with = "some")]
    pub variant: Option<String>,
    #[serde(default, deserialize_with = "some")]
    pub finish: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
}

impl Message {
    fn valid(&self) -> bool {
        match self {
            Self::User(user) => {
                user.id.starts_with("msg")
                    && user.session_id.starts_with("ses")
                    && user.time.created >= 0.0
                    && filled(&user.agent)
                    && filled(&user.model.provider_id)
                    && filled(&user.model.model_id)
                    && optional_filled(&user.model.variant)
            }
            Self::Assistant(assistant) => {
                assistant.id.starts_with("msg")
                    && assistant.session_id.starts_with("ses")
                    && whole(assistant.time.created)
                    && assistant.time.completed.is_none_or(whole)
                    && assistant
                        .error
                        .as_ref()
                        .is_none_or(|error| filled(&error.name))
                    && assistant.parent_id.starts_with("msg")
                    && filled(&assistant.model_id)
                    && filled(&assistant.provider_id)
                    && filled(&assistant.mode)
                    && filled(&assistant.agent)
                    && filled(&assistant.path.cwd)
                    && filled(&assistant.path.root)
                    && optional_filled(&assistant.variant)
                    && optional_filled(&assistant.finish)
            }
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::User(user) => &user.id,
            Self::Assistant(assistant) => &assistant.id,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::User(user) => &user.session_id,
            Self::Assistant(assistant) => &assistant.session_id,
        }
    }

    pub fn created(&self) -> f64 {
        match self {
            Self::User(user) => user.time.created,
            Self::Assistant(assistant) => assistant.time.created,
        }
    }

    pub fn role(&self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::Assistant(_) => "assistant",
        }
    }

    pub fn assistant(&self) -> Option<&AssistantMessage> {
        match self {
            Self::Assistant(assistant) => Some(assistant),
            Self::User(_) => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct TextPart {
    #[serde(default, deserialize_with = "some")]
    pub id: Option<String>,
    #[serde(default, rename = "sessionID", deserialize_with = "some")]
    pub session_id: Option<String>,
    #[serde(default, rename = "messageID", deserialize_with = "some")]
    pub message_id: Option<String>,
    pub text: String,
    #[serde(default, deserialize_with = "some")]
    pub synthetic: Option<bool>,
    #[serde(default, deserialize_with = "some")]
    pub ignored: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToolPart {
    #[serde(default, deserialize_with = "some")]
    pub id: Option<String>,
    #[serde(default, rename = "sessionID", deserialize_with = "some")]
    pub session_id: Option<String>,
    #[serde(default, rename = "messageID", deserialize_with = "some")]
    pub message_id: Option<String>,
    #[serde(rename = "callID")]
    pub call_id: String,
    pub tool: String,
    /// The whole native state object; `status` is checked on parse.
    pub state: Value,
}

impl ToolPart {
    pub fn status(&self) -> &'static str {
        match self.state["status"].as_str() {
            Some("pending") => "pending",
            Some("running") => "running",
            Some("completed") => "completed",
            _ => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub enum Part {
    Text(TextPart),
    Tool(ToolPart),
    Compaction { auto: Option<bool> },
    Other(Value),
}

fn optional_prefixed(value: &Option<String>, prefix: &str) -> bool {
    value
        .as_deref()
        .is_none_or(|value| value.starts_with(prefix))
}

impl Part {
    pub fn parse(value: Value) -> Result<Self, Invalid> {
        match value.get("type").and_then(Value::as_str) {
            Some("text") => {
                let part: TextPart = parse(value, "OpenCode text part")?;
                if optional_prefixed(&part.id, "prt")
                    && optional_prefixed(&part.session_id, "ses")
                    && optional_prefixed(&part.message_id, "msg")
                {
                    Ok(Self::Text(part))
                } else {
                    invalid("OpenCode text part")
                }
            }
            Some("tool") => {
                let part: ToolPart = parse(value, "OpenCode tool part")?;
                let status = part.state.get("status").and_then(Value::as_str);
                if optional_prefixed(&part.id, "prt")
                    && optional_prefixed(&part.session_id, "ses")
                    && optional_prefixed(&part.message_id, "msg")
                    && filled(&part.call_id)
                    && filled(&part.tool)
                    && part.state.is_object()
                    && matches!(status, Some("pending" | "running" | "completed" | "error"))
                {
                    Ok(Self::Tool(part))
                } else {
                    invalid("OpenCode tool part")
                }
            }
            Some("compaction") => match value.get("auto") {
                None => Ok(Self::Compaction { auto: None }),
                Some(Value::Bool(auto)) => Ok(Self::Compaction { auto: Some(*auto) }),
                Some(_) => invalid("OpenCode compaction part"),
            },
            Some(kind) if !kind.is_empty() && value.is_object() => Ok(Self::Other(value)),
            _ => invalid("OpenCode part"),
        }
    }

    pub fn kind(&self) -> &str {
        match self {
            Self::Text(_) => "text",
            Self::Tool(_) => "tool",
            Self::Compaction { .. } => "compaction",
            Self::Other(value) => value["type"].as_str().unwrap_or_default(),
        }
    }
}

/// One validated native message with its parts, keeping the native JSON.
#[derive(Clone, Debug)]
pub struct Envelope {
    pub info: Message,
    pub parts: Vec<Part>,
    pub raw: Value,
}

impl Envelope {
    pub fn parse(value: Value) -> Result<Self, Invalid> {
        let info: Message = parse(
            value.get("info").cloned().unwrap_or(Value::Null),
            "OpenCode message",
        )?;
        if !info.valid() {
            return invalid("OpenCode message");
        }
        let Some(parts) = value.get("parts").and_then(Value::as_array) else {
            return invalid("OpenCode message parts");
        };
        let parts = parts
            .iter()
            .cloned()
            .map(Part::parse)
            .collect::<Result<_, _>>()?;
        Ok(Self {
            info,
            parts,
            raw: value,
        })
    }

    pub fn parse_all(value: Value) -> Result<Vec<Self>, Invalid> {
        let Value::Array(values) = value else {
            return invalid("OpenCode message list");
        };
        values.into_iter().map(Self::parse).collect()
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct SessionTime {
    pub created: f64,
    pub updated: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SessionModel {
    pub id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(default, deserialize_with = "some")]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Session {
    pub id: String,
    #[serde(rename = "projectID")]
    pub project_id: String,
    pub directory: String,
    pub title: String,
    pub version: String,
    pub time: SessionTime,
    #[serde(default, deserialize_with = "some")]
    pub model: Option<SessionModel>,
    #[serde(default, deserialize_with = "some")]
    pub agent: Option<String>,
    #[serde(default, deserialize_with = "some")]
    pub permission: Option<Vec<Value>>,
}

impl Session {
    pub fn parse(value: Value) -> Result<Self, Invalid> {
        let session: Self = parse(value, "OpenCode session")?;
        let model = session.model.as_ref().is_none_or(|model| {
            filled(&model.id) && filled(&model.provider_id) && optional_filled(&model.variant)
        });
        if session.id.starts_with("ses")
            && filled(&session.project_id)
            && filled(&session.directory)
            && filled(&session.version)
            && whole(session.time.created)
            && whole(session.time.updated)
            && model
            && optional_filled(&session.agent)
        {
            Ok(session)
        } else {
            invalid("OpenCode session")
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Retry {
        attempt: u64,
        message: String,
        next: u64,
    },
    Busy,
}

impl SessionStatus {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Retry { .. } => "retry",
            Self::Busy => "busy",
        }
    }
}

pub type SessionStatusMap = HashMap<String, SessionStatus>;

/// A Suplex session request. `model` is the native `{ id, providerID, variant }`.
#[derive(Clone, Debug, Serialize)]
pub struct SessionCreateRequest {
    pub title: String,
    pub agent: String,
    pub model: SessionCreateModel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SessionCreateModel {
    pub id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl SessionCreateRequest {
    pub fn valid(&self) -> bool {
        filled(&self.model.id)
            && filled(&self.model.provider_id)
            && optional_filled(&self.model.variant)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct TextInput {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub model: NativeModel,
    pub agent: String,
    pub variant: String,
    pub parts: Vec<TextInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_reply: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<BTreeMap<String, bool>>,
}

impl PromptRequest {
    pub fn valid(&self) -> bool {
        self.message_id.starts_with("msg")
            && filled(&self.model.provider_id)
            && filled(&self.model.model_id)
            && filled(&self.agent)
            && filled(&self.variant)
            && !self.parts.is_empty()
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptState {
    Admitted,
    Running,
    Completed,
    TerminalIncomplete,
    Error,
    Interrupted,
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assistant() -> Value {
        json!({"id":"msg_a","sessionID":"ses_a","role":"assistant","time":{"created":4,"completed":5},"parentID":"msg_u","modelID":"m","providerID":"openai","mode":"build","agent":"suplex-root","path":{"cwd":"/r","root":"/r"},"cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"})
    }

    #[test]
    fn envelopes_keep_unknown_keys_and_reject_malformed_native_records() {
        let parsed = Envelope::parse(json!({"info":assistant(),"parts":[{"type":"step-finish","id":"s","cost":1}],"extra":1})).unwrap();
        assert_eq!(parsed.raw["extra"], 1);
        assert_eq!(parsed.parts[0].kind(), "step-finish");
        assert!(
            Envelope::parse(
                json!({"info":assistant(),"parts":[{"type":"tool","callID":"c","tool":"bash"}]})
            )
            .is_err()
        );
        assert!(Envelope::parse(json!({"info":{"role":"system"},"parts":[]})).is_err());
        let mut null_finish = assistant();
        null_finish["finish"] = Value::Null;
        assert!(Envelope::parse(json!({"info":null_finish,"parts":[]})).is_err());
        let mut fractional = assistant();
        fractional["time"]["created"] = json!(4.5);
        assert!(Envelope::parse(json!({"info":fractional,"parts":[]})).is_err());
    }

    #[test]
    fn provider_listing_drops_credentials_and_options() {
        let providers: Providers = serde_json::from_value(json!({"all":[{"id":"openai","name":"OpenAI","key":"secret","models":{"luna":{"id":"luna","name":"Luna","options":{"apiKey":"x"}}}}],"connected":["openai"],"default":{"openai":"luna"}})).unwrap();
        assert!(
            !serde_json::to_string(&providers)
                .unwrap()
                .contains("secret")
        );
        assert!(
            !serde_json::to_string(&providers)
                .unwrap()
                .contains("apiKey")
        );
    }

    #[test]
    fn status_union_rejects_unknown_types() {
        assert!(
            serde_json::from_value::<SessionStatusMap>(json!({"s":{"type":"unrecognized"}}))
                .is_err()
        );
        assert_eq!(
            serde_json::from_value::<SessionStatusMap>(json!({"s":{"type":"busy","extra":1}}))
                .unwrap()["s"],
            SessionStatus::Busy
        );
    }
}
