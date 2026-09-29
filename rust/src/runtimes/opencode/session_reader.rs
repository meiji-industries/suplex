//! Read-only observation of an OpenCode session for history, execution, usage, and Archive.

use std::{io, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{
    client::OpenCodeClient,
    contracts::{Envelope, Part, ToolPart},
    server::{self, ServerReference},
    session::{BoxError, correlated_assistants},
    session_history::read_history,
};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::native::{NativeReasoning, NativeTool, UsageTokens, session_directory},
};

const MESSAGE_LIMIT: usize = 100;

/// The stored task session fields a native read needs.
#[derive(Clone, Copy, Debug)]
pub struct ReaderSession<'a> {
    pub id: &'a str,
    pub native_session_id: Option<&'a str>,
    pub current: bool,
    /// The Suplex session kind, reported as the usage role.
    pub kind: &'a str,
}

crate::shared::wire_enum! {
    pub enum PlanStatus {
        Pending = "pending",
        InProgress = "in_progress",
        Completed = "completed",
        Cancelled = "cancelled",
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, ts_rs::TS)]
pub struct PlanItem {
    pub content: String,
    pub status: PlanStatus,
}

#[derive(Deserialize)]
struct PlanInput {
    todos: Vec<PlanItem>,
}

#[derive(Debug)]
pub struct Execution {
    pub tools: Vec<NativeTool>,
    pub plan: Option<Vec<PlanItem>>,
}

/// A JSON number printed as JavaScript prints it: whole values have no fraction.
pub(crate) fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn optional_text(state: &Value, key: &str) -> Result<Option<String>, BoxError> {
    match state.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(format!("OpenCode tool {key} is invalid").into()),
    }
}

fn native_tool(id: String, tool: &ToolPart) -> Result<NativeTool, BoxError> {
    let input = match tool.state.get("input") {
        None => Map::new(),
        Some(Value::Object(input)) => input.clone(),
        Some(_) => return Err("OpenCode tool input is invalid".into()),
    };
    Ok(NativeTool {
        id,
        name: tool.tool.clone(),
        status: tool.status(),
        input,
        output: optional_text(&tool.state, "output")?,
        error: optional_text(&tool.state, "error")?,
    })
}

fn by_creation(messages: &[Envelope]) -> Vec<&Envelope> {
    let mut sorted: Vec<&Envelope> = messages.iter().collect();
    sorted.sort_by(|left, right| left.info.created().total_cmp(&right.info.created()));
    sorted
}

pub fn reasoning_from_messages(messages: &[Envelope]) -> Vec<NativeReasoning> {
    by_creation(messages)
        .into_iter()
        .filter(|message| message.info.assistant().is_some())
        .flat_map(|message| {
            message
                .parts
                .iter()
                .enumerate()
                .filter_map(move |(index, part)| match part {
                    Part::Other(value) if value["type"] == "reasoning" => value["text"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                        .map(|text| NativeReasoning {
                            id: format!("{}:{index}", message.info.id()),
                            text: text.to_owned(),
                        }),
                    _ => None,
                })
        })
        .collect()
}

pub fn execution_from_messages(messages: &[&Envelope]) -> Result<Execution, BoxError> {
    let mut sorted = messages.to_vec();
    sorted.sort_by(|left, right| left.info.created().total_cmp(&right.info.created()));
    let mut tools = Vec::new();
    let mut plan = None;
    for message in sorted {
        if message.info.assistant().is_none() {
            continue;
        }
        for part in &message.parts {
            let Part::Tool(tool) = part else { continue };
            let native = native_tool(format!("{}:{}", message.info.id(), tool.call_id), tool)?;
            if tool.tool == "todowrite"
                && tool.status() == "completed"
                && let Ok(input) =
                    serde_json::from_value::<PlanInput>(Value::Object(native.input.clone()))
            {
                plan = Some(input.todos);
            }
            tools.push(native);
        }
    }
    Ok(Execution { tools, plan })
}

pub fn history_from_messages(messages: &[Envelope]) -> Result<Vec<Value>, BoxError> {
    let mut history = Vec::new();
    for message in by_creation(messages) {
        let mut content = Vec::new();
        for (index, part) in message.parts.iter().enumerate() {
            match part {
                Part::Text(text) if text.ignored != Some(true) => content.push(json!({
                    "id": text.id.clone().unwrap_or_else(|| format!("{}:text:{index}", message.info.id())),
                    "type": "text",
                    "text": text.text,
                })),
                Part::Other(value) if value["type"] == "reasoning" => {
                    if let Some(text) = value["text"].as_str().filter(|text| !text.trim().is_empty()) {
                        content.push(json!({
                            "id": value["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned).unwrap_or_else(|| format!("{}:reasoning:{index}", message.info.id())),
                            "type": "reasoning", "text": text,
                        }));
                    }
                }
                Part::Tool(tool) => {
                    let native = native_tool(
                        tool.id
                            .clone()
                            .unwrap_or_else(|| format!("{}:{}", message.info.id(), tool.call_id)),
                        tool,
                    )?;
                    content.push(json!({
                        "id": native.id, "type": "tool", "name": native.name, "status": native.status,
                        "input": native.input, "output": native.output, "error": native.error,
                    }));
                }
                _ => {}
            }
        }
        if !content.is_empty() {
            history.push(json!({
                "id": message.info.id(),
                "role": message.info.role(),
                "createdAt": message.raw["info"]["time"]["created"],
                "content": content,
            }));
        }
    }
    Ok(history)
}

#[derive(Clone, Copy, Default)]
struct Counts {
    input: f64,
    output: f64,
    reasoning: f64,
    read: f64,
    write: f64,
}

impl Counts {
    fn parse(value: &Value) -> Result<Self, BoxError> {
        let count = |value: &Value| {
            value
                .as_f64()
                .filter(|count| count.is_finite() && *count >= 0.0)
                .ok_or_else(|| BoxError::from("OpenCode usage tokens are invalid"))
        };
        Ok(Self {
            input: count(&value["input"])?,
            output: count(&value["output"])?,
            reasoning: count(&value["reasoning"])?,
            read: count(&value["cache"]["read"])?,
            write: count(&value["cache"]["write"])?,
        })
    }

    fn add(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.reasoning += other.reasoning;
        self.read += other.read;
        self.write += other.write;
    }

    fn json(self) -> Value {
        json!({"input":js_number(self.input),"output":js_number(self.output),"reasoning":js_number(self.reasoning),"cache":{"read":js_number(self.read),"write":js_number(self.write)}})
    }
}

/// One usage row per native assistant message; step totals win over the message total.
pub fn task_usage(
    messages: &[Envelope],
    role: &str,
    pricing: Option<&ModelPricingCatalog>,
) -> Result<Vec<Value>, BoxError> {
    let mut usage = Vec::new();
    for message in messages {
        let Some(info) = message.info.assistant() else {
            continue;
        };
        let mut steps: Vec<(String, f64, Counts)> = Vec::new();
        for part in &message.parts {
            let Part::Other(step) = part else { continue };
            if step["type"] != "step-finish" {
                continue;
            }
            let id = step["id"]
                .as_str()
                .ok_or("OpenCode usage step is invalid")?;
            let cost = step["cost"]
                .as_f64()
                .filter(|cost| cost.is_finite() && *cost >= 0.0)
                .ok_or("OpenCode usage step is invalid")?;
            let counts = Counts::parse(&step["tokens"])?;
            match steps.iter_mut().find(|(saved, _, _)| saved == id) {
                Some(saved) => *saved = (id.to_owned(), cost, counts),
                None => steps.push((id.to_owned(), cost, counts)),
            }
        }
        let (mut tokens, mut cost) = if steps.is_empty() {
            (Counts::parse(&message.raw["info"]["tokens"])?, info.cost)
        } else {
            (Counts::default(), 0.0)
        };
        for (_, step_cost, step_tokens) in &steps {
            tokens.add(*step_tokens);
            cost += step_cost;
        }
        let listed = pricing
            .and_then(|pricing| pricing.get(&format!("{}/{}", info.provider_id, info.model_id)));
        let estimate = match listed {
            Some(price) if cost == 0.0 => price.estimate(UsageTokens {
                input: tokens.input,
                output: tokens.output,
                reasoning: tokens.reasoning,
                cache_read: tokens.read,
                cache_write: tokens.write,
            }),
            _ => 0.0,
        };
        let cost = if estimate > 0.0 { estimate } else { cost };
        if !cost.is_finite() || cost < 0.0 {
            return Err("OpenCode usage cost is invalid".into());
        }
        let step_count = if steps.is_empty() {
            usize::from(info.time.completed.is_some())
        } else {
            steps.len()
        };
        usage.push(json!({
            "sessionId": info.session_id, "messageId": info.id, "turnId": info.parent_id, "role": role,
            "provider": info.provider_id, "model": info.model_id,
            "startedAt": message.raw["info"]["time"]["created"],
            "completedAt": message.raw["info"]["time"].get("completed").cloned().unwrap_or(Value::Null),
            "failed": info.error.is_some(), "summary": info.summary.unwrap_or(false),
            "steps": step_count, "cost": js_number(cost), "subsidized": estimate > 0.0,
            "tokens": tokens.json(), "source": if steps.is_empty() { "message" } else { "steps" },
        }));
    }
    Ok(usage)
}

pub struct TurnEvidence {
    pub tools: Vec<NativeTool>,
    pub limitation: Option<&'static str>,
}

pub struct Timeline {
    pub usage: Vec<Value>,
    pub live_message_id: Option<String>,
}

pub struct OpenCodeSessionReader {
    pub database_path: PathBuf,
    pub executable: Option<PathBuf>,
}

impl OpenCodeSessionReader {
    fn connect<'a>(
        &self,
        session: &ReaderSession<'a>,
    ) -> Result<(ServerReference, OpenCodeClient, &'a str), BoxError> {
        let server = server::read_server(&session_directory(&self.database_path, session.id)?)?;
        let (Some(server), Some(native)) = (server, session.native_session_id) else {
            return Err("Session is not available".into());
        };
        let client = server::client(&server)?.with_timeout(Duration::from_millis(2000));
        Ok((server, client, native))
    }

    async fn exported(&self, native: &str) -> Result<Vec<Envelope>, BoxError> {
        read_history(native, self.executable.as_deref()).await
    }

    async fn live_messages(&self, session: &ReaderSession<'_>) -> Result<Vec<Envelope>, BoxError> {
        let (server, client, native) = self.connect(session)?;
        Ok(client
            .get_messages(native, Some(&server.directory), None)
            .await?)
    }

    /// Reads the authoritative native conversation snapshot without changing session state.
    pub async fn history(&self, session: &ReaderSession<'_>) -> Result<Vec<Value>, BoxError> {
        let Some(native) = session.native_session_id else {
            return Ok(Vec::new());
        };
        let messages = if session.current {
            match self.live_messages(session).await {
                Ok(messages) => messages,
                Err(_) => self.exported(native).await?,
            }
        } else {
            self.exported(native).await?
        };
        history_from_messages(&messages)
    }

    pub async fn execution(
        &self,
        session: &ReaderSession<'_>,
    ) -> Result<(Execution, bool), BoxError> {
        if let (false, Some(native)) = (session.current, session.native_session_id) {
            let messages = self.exported(native).await?;
            let recent: Vec<&Envelope> = messages
                .iter()
                .skip(messages.len().saturating_sub(MESSAGE_LIMIT))
                .collect();
            return Ok((
                execution_from_messages(&recent)?,
                messages.len() >= MESSAGE_LIMIT,
            ));
        }
        let (server, client, native) = self.connect(session)?;
        let messages = client
            .get_messages(native, Some(&server.directory), Some(MESSAGE_LIMIT))
            .await?;
        let all: Vec<&Envelope> = messages.iter().collect();
        Ok((
            execution_from_messages(&all)?,
            messages.len() >= MESSAGE_LIMIT,
        ))
    }

    /// Reads one admitted native turn. Stored completion observations are not required for correlation.
    pub async fn turn_evidence(
        &self,
        session: &ReaderSession<'_>,
        turn_id: &str,
    ) -> Result<TurnEvidence, BoxError> {
        let messages = match (session.current, session.native_session_id) {
            (false, Some(native)) => self.exported(native).await?,
            _ => self.live_messages(session).await?,
        };
        let correlated = correlated_assistants(&messages, turn_id);
        if !correlated.prompt_found {
            return Ok(TurnEvidence {
                tools: Vec::new(),
                limitation: Some(
                    "The admitted native prompt is not present in the authoritative session history.",
                ),
            });
        }
        Ok(TurnEvidence {
            tools: execution_from_messages(&correlated.messages)?.tools,
            limitation: (correlated.reason == Some("continuation_ambiguous")).then_some(
                "Native compaction continuation was ambiguous; only tools with an authoritative parent chain are included.",
            ),
        })
    }

    /// Returns `(status, updatedAt)` from the live server.
    pub async fn status(
        &self,
        session: &ReaderSession<'_>,
    ) -> Result<(&'static str, f64), BoxError> {
        let (server, client, native) = self.connect(session)?;
        let (session_read, statuses) = tokio::join!(
            client.get_session(native, Some(&server.directory)),
            client.get_status(Some(&server.directory))
        );
        let status = statuses?.get(native).map_or("idle", |status| status.kind());
        Ok((status, session_read?.time.updated))
    }

    pub async fn timeline(
        &self,
        session: &ReaderSession<'_>,
        pricing: Option<&ModelPricingCatalog>,
    ) -> Result<Timeline, BoxError> {
        if let (false, Some(native)) = (session.current, session.native_session_id) {
            return Ok(Timeline {
                usage: task_usage(&self.exported(native).await?, session.kind, pricing)?,
                live_message_id: None,
            });
        }
        let (server, client, native) = self.connect(session)?;
        let (messages, statuses) = tokio::join!(
            client.get_messages(native, Some(&server.directory), None),
            client.get_status(Some(&server.directory))
        );
        let (messages, statuses) = (messages?, statuses?);
        let latest = by_creation(&messages)
            .last()
            .and_then(|message| message.info.assistant());
        let busy = statuses
            .get(native)
            .is_some_and(|status| status.kind() == "busy");
        let live_message_id = latest
            .filter(|assistant| busy && assistant.time.completed.is_none())
            .map(|assistant| assistant.id.clone());
        Ok(Timeline {
            usage: task_usage(&messages, session.kind, pricing)?,
            live_message_id,
        })
    }

    /// Refuses while the agent is active; returns the stop action for Archive.
    pub async fn archive(
        &self,
        session: &ReaderSession<'_>,
    ) -> Result<impl FnOnce() -> io::Result<()> + use<>, BoxError> {
        let server = server::read_server(&session_directory(&self.database_path, session.id)?)?;
        if let Some(reference) = &server
            && server::server_running(reference)
        {
            let statuses = server::client(reference)?
                .get_status(Some(&reference.directory))
                .await?;
            if statuses.values().any(|status| status.kind() != "idle") {
                return Err("An agent is still active. Retry after it stops.".into());
            }
        }
        Ok(move || server.as_ref().map_or(Ok(()), server::stop_server))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::opencode::{
        client::fake,
        server::tests::temporary,
        session_history::tests::{exporter, retired_message},
    };
    use std::fs;

    fn retired<'a>() -> ReaderSession<'a> {
        ReaderSession {
            id: "old",
            native_session_id: Some("ses_old"),
            current: false,
            kind: "worker",
        }
    }

    #[tokio::test]
    async fn retired_worker_spend_remains_readable_without_its_server_or_worktree() {
        let directory = temporary("opencode-retired");
        let mut message = retired_message();
        message["parts"] = json!([{"type":"text","text":"done"}]);
        let executable = exporter(
            &directory,
            &json!({"info":{"id":"ses_old"},"messages":[message]}),
        );
        let reader = OpenCodeSessionReader {
            database_path: "/absent/suplex.sqlite".into(),
            executable: Some(executable),
        };
        let timeline = reader.timeline(&retired(), None).await.unwrap();
        assert_eq!(timeline.usage.len(), 1);
        assert_eq!(timeline.usage[0]["cost"], json!(3));
        assert_eq!(timeline.usage[0]["sessionId"], "ses_old");
        assert_eq!(timeline.usage[0]["tokens"]["cache"]["write"], json!(50));
        assert_eq!(timeline.usage[0]["source"], "message");
        assert!(timeline.live_message_id.is_none());
        // A current session whose server reference is missing still reads the retained native history.
        let current = ReaderSession {
            current: true,
            ..retired()
        };
        assert_eq!(
            reader.history(&current).await.unwrap()[0]["id"],
            "msg_result"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    fn assistant(id: &str, created: u64, parts: Value) -> Envelope {
        Envelope::parse(json!({"info":{"id":id,"sessionID":"ses_old","role":"assistant","time":{"created":created},"parentID":"msg_user","modelID":"model","providerID":"openai","mode":"primary","agent":"suplex-worker","path":{"cwd":"/repo","root":"/repo"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}},"parts":parts})).unwrap()
    }

    #[test]
    fn reasoning_uses_native_message_order_and_ignores_empty_parts() {
        let later = assistant(
            "msg_later",
            20,
            json!([{"type":"reasoning","text":"Second thought"}]),
        );
        let earlier = assistant(
            "msg_earlier",
            10,
            json!([{"type":"reasoning","text":"First thought"},{"type":"reasoning","text":""}]),
        );
        let parts = reasoning_from_messages(&[later, earlier]);
        assert_eq!(
            parts
                .iter()
                .map(|part| part.text.as_str())
                .collect::<Vec<_>>(),
            ["First thought", "Second thought"]
        );
        assert_eq!(parts[0].id, "msg_earlier:0");
    }

    #[test]
    fn history_maps_stable_text_and_tool_identities_with_complete_native_output() {
        let output = "x".repeat(100_000);
        let user = Envelope::parse(json!({"info":{"id":"msg_user","sessionID":"ses_old","role":"user","time":{"created":10},"agent":"suplex-worker","model":{"providerID":"openai","modelID":"model"}},"parts":[{"id":"prt_user","type":"text","text":"Inspect the repository"}]})).unwrap();
        let mut result = retired_message();
        result["parts"] = json!([{"id":"prt_reasoning","type":"reasoning","text":"Check the file"},{"id":"prt_text","type":"text","text":"Complete"},{"id":"prt_tool","type":"tool","callID":"call_1","tool":"read","state":{"status":"completed","input":{"path":"/repo/file"},"output":output}}]);
        let result = Envelope::parse(result).unwrap();
        assert_eq!(
            Value::Array(history_from_messages(&[result, user]).unwrap()),
            json!([
                {"id":"msg_user","role":"user","createdAt":10,"content":[{"id":"prt_user","type":"text","text":"Inspect the repository"}]},
                {"id":"msg_result","role":"assistant","createdAt":100,"content":[
                    {"id":"prt_reasoning","type":"reasoning","text":"Check the file"},
                    {"id":"prt_text","type":"text","text":"Complete"},
                    {"id":"prt_tool","type":"tool","name":"read","status":"completed","input":{"path":"/repo/file"},"output":output,"error":null},
                ]},
            ])
        );
    }

    #[test]
    fn history_text_fallback_identities_use_the_immutable_native_block_slot() {
        let ids = |parts: Value| {
            history_from_messages(&[assistant("msg_slots", 10, parts)]).unwrap()[0]["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|part| part["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(json!([{"type":"text","text":"same"},{"type":"text","text":"same"}])),
            ["msg_slots:text:0", "msg_slots:text:1"]
        );
        assert_eq!(
            ids(json!([{"type":"text","text":"expanded text"},{"type":"text","text":"same"}]))[0],
            "msg_slots:text:0"
        );
    }

    #[test]
    fn execution_reads_tools_in_native_order_and_the_latest_completed_plan() {
        let later = assistant(
            "msg_b",
            20,
            json!([
                {"type":"tool","callID":"plan","tool":"todowrite","state":{"status":"completed","input":{"todos":[{"content":"Ship","status":"in_progress","extra":1}]}}},
                {"type":"tool","callID":"failed-plan","tool":"todowrite","state":{"status":"error","input":{"todos":[{"content":"Do not publish","status":"pending"}]},"error":"write failed"}}
            ]),
        );
        let earlier = assistant(
            "msg_a",
            10,
            json!([{"type":"tool","callID":"run","tool":"bash","state":{"status":"error","input":{"command":"false"},"error":"exit 1"}}]),
        );
        let execution = execution_from_messages(&[&later, &earlier]).unwrap();
        assert_eq!(
            execution
                .tools
                .iter()
                .map(|tool| tool.id.as_str())
                .collect::<Vec<_>>(),
            ["msg_a:run", "msg_b:plan", "msg_b:failed-plan"]
        );
        assert_eq!(execution.tools[0].error.as_deref(), Some("exit 1"));
        assert_eq!(
            execution.plan,
            Some(vec![PlanItem {
                content: "Ship".into(),
                status: PlanStatus::InProgress
            }])
        );
        let malformed = assistant(
            "msg_c",
            30,
            json!([{"type":"tool","callID":"bad","tool":"bash","state":{"status":"completed","output":7}}]),
        );
        assert!(execution_from_messages(&[&malformed]).is_err());
    }

    #[test]
    fn step_usage_replaces_the_message_total_and_prices_unpriced_models() {
        let mut message = retired_message();
        message["info"]["cost"] = json!(0);
        message["parts"] = json!([
            {"type":"step-finish","id":"s1","cost":0,"tokens":{"input":1000000,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}},
            {"type":"step-finish","id":"s1","cost":0,"tokens":{"input":2000000,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}},
        ]);
        let pricing = ModelPricingCatalog::from([(
            "openai/model".to_owned(),
            crate::profiles::model_pricing::ModelPricing {
                input: 2.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
        )]);
        let usage = task_usage(
            &[Envelope::parse(message).unwrap()],
            "worker",
            Some(&pricing),
        )
        .unwrap();
        assert_eq!(usage[0]["steps"], 1);
        assert_eq!(usage[0]["source"], "steps");
        assert_eq!(usage[0]["tokens"]["input"], json!(2_000_000));
        assert_eq!(usage[0]["cost"], json!(4));
        assert_eq!(usage[0]["subsidized"], true);
    }

    #[tokio::test]
    async fn live_status_and_timeline_read_the_task_server() {
        let root = temporary("opencode-live-reader");
        let (url, _) = fake::serve(|request| match request.path.as_str() {
            "/session/ses_live" => (200, json!({"id":"ses_live","projectID":"p","directory":"/repo","title":"t","version":"1","time":{"created":1,"updated":9}}).to_string()),
            "/session/status" => (200, json!({"ses_live":{"type":"busy"}}).to_string()),
            "/session/ses_live/message" => (200, json!([{"info":{"id":"msg_live","sessionID":"ses_live","role":"assistant","time":{"created":5},"parentID":"msg_user","modelID":"model","providerID":"openai","mode":"primary","agent":"suplex-root","path":{"cwd":"/repo","root":"/repo"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}},"parts":[]}]).to_string()),
            _ => (404, "{}".into()),
        })
        .await;
        let database = root.join("suplex.sqlite");
        let runtime = session_directory(&database, "live").unwrap();
        fs::create_dir_all(&runtime).unwrap();
        let reference = json!({"pid":4321,"baseUrl":url,"password":"a".repeat(64),"directory":"/repo","executable":"/bin/opencode","generation":"b775df17-718a-4cb2-8e23-6912b8aa0d39","configHash":"a".repeat(64),"processIdentity":{"command":"opencode serve","executable":"/bin/opencode","argv":["opencode","serve"],"processGroup":4321,"startTime":"start","ownerUid":501}});
        fs::write(runtime.join("server.json"), reference.to_string()).unwrap();
        let reader = OpenCodeSessionReader {
            database_path: database,
            executable: None,
        };
        let session = ReaderSession {
            id: "live",
            native_session_id: Some("ses_live"),
            current: true,
            kind: "root",
        };
        assert_eq!(reader.status(&session).await.unwrap(), ("busy", 9.0));
        let timeline = reader.timeline(&session, None).await.unwrap();
        assert_eq!(timeline.live_message_id.as_deref(), Some("msg_live"));
        assert_eq!(timeline.usage[0]["steps"], 0);
        // The recorded PID is not the server, so Archive observes no live agent and may proceed.
        assert!(reader.archive(&session).await.is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
