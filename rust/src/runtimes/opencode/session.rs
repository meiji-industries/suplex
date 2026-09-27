//! Prompt intent, native admission evidence, and replay fencing for OpenCode.

use crate::shared::hash::sha256_hex;
use std::{
    error::Error,
    fmt,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::{OpenCodeClient, PromptInput};
use super::contracts::{
    Envelope, Message, NativeError, NativeModel, Part, PromptState, Session, SessionStatus,
    SessionStatusMap,
};

pub type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Dispatch {
    NotSubmitted,
    Ambiguous,
    Rejected,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptIntent {
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub directory: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    pub prompt_hash: String,
    pub model: NativeModel,
    pub agent: String,
    pub variant: String,
    pub dispatch: Dispatch,
}

/// Splits a Suplex OpenCode model id into the vendor and model OpenCode itself names.
pub fn open_code_model(model_id: &str) -> Result<NativeModel, String> {
    match model_id.find('/') {
        Some(separator) if separator >= 1 => Ok(NativeModel {
            provider_id: model_id[..separator].to_owned(),
            model_id: model_id[separator + 1..].to_owned(),
        }),
        _ => Err("OpenCode models are vendor-qualified, such as openai/gpt-5.6-sol".into()),
    }
}

const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
static MESSAGE_CLOCK: Mutex<(u64, u64)> = Mutex::new((0, 0));

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// OpenCode's ascending native message identity: 48 bits of time and counter, then 14 base62 characters.
pub fn create_message_id(timestamp: u64) -> String {
    let counter = {
        let mut clock = MESSAGE_CLOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if clock.0 != timestamp {
            *clock = (timestamp, 0);
        }
        clock.1 += 1;
        clock.1
    };
    let value = timestamp.wrapping_mul(0x1000).wrapping_add(counter);
    let mut random = [0_u8; 14];
    getrandom::fill(&mut random).expect("operating system randomness is available");
    let suffix: String = random
        .iter()
        .map(|byte| BASE62[usize::from(*byte) % BASE62.len()] as char)
        .collect();
    format!("msg_{:012x}{suffix}", value & 0xffff_ffff_ffff)
}

pub fn create_prompt_intent(
    session_id: &str,
    directory: &str,
    prompt: &str,
    model: NativeModel,
    agent: &str,
    variant: &str,
) -> PromptIntent {
    PromptIntent {
        session_id: session_id.to_owned(),
        message_id: create_message_id(now_ms()),
        directory: directory.to_owned(),
        prompt: prompt.to_owned(),
        system: None,
        prompt_hash: sha256_hex(prompt.as_bytes()),
        model,
        agent: agent.to_owned(),
        variant: variant.to_owned(),
        dispatch: Dispatch::NotSubmitted,
    }
}

/// The native reads and the one write that prompt reconciliation needs.
#[allow(async_fn_in_trait)]
pub trait PromptPort {
    async fn get_session(&self, session_id: &str, directory: &str) -> Result<Session, BoxError>;
    async fn get_messages(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Vec<Envelope>, BoxError>;
    async fn get_status(&self, directory: &str) -> Result<SessionStatusMap, BoxError>;
    async fn prompt_async(&self, intent: &PromptIntent) -> Result<(), BoxError>;
}

impl PromptPort for OpenCodeClient {
    async fn get_session(&self, session_id: &str, directory: &str) -> Result<Session, BoxError> {
        Ok(OpenCodeClient::get_session(self, session_id, Some(directory)).await?)
    }

    async fn get_messages(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Vec<Envelope>, BoxError> {
        Ok(OpenCodeClient::get_messages(self, session_id, Some(directory), None).await?)
    }

    async fn get_status(&self, directory: &str) -> Result<SessionStatusMap, BoxError> {
        Ok(OpenCodeClient::get_status(self, Some(directory)).await?)
    }

    async fn prompt_async(&self, intent: &PromptIntent) -> Result<(), BoxError> {
        Ok(OpenCodeClient::prompt_async(
            self,
            PromptInput {
                session_id: &intent.session_id,
                message_id: &intent.message_id,
                text: &intent.prompt,
                model: &intent.model,
                agent: &intent.agent,
                variant: &intent.variant,
                directory: Some(&intent.directory),
                no_reply: None,
                system: intent.system.as_deref(),
            },
        )
        .await?)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Admission {
    Observed,
    NotObserved,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Retry {
    Allowed,
    Forbidden,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NativeEvidence {
    #[serde(rename = "messageID")]
    pub message_id: String,
    #[serde(rename = "parentID")]
    pub parent_id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    pub mode: String,
    pub agent: String,
    pub cwd: String,
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<NativeError>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StoppedServer {
    #[serde(rename = "stoppedServerGeneration")]
    pub stopped_server_generation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum InterruptedExecution {
    Stopped(StoppedServer),
    Idle {
        #[serde(rename = "lastActivityAt")]
        last_activity_at: f64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptObservation {
    pub state: PromptState,
    pub admission: Admission,
    pub retry: Retry,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    #[serde(rename = "assistantMessageIDs")]
    pub assistant_message_ids: Vec<String>,
    #[serde(
        rename = "assistantMessageID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub assistant_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<SessionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_execution: Option<InterruptedExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_uncertain: Option<StoppedServer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsettled_tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsettled_tool_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_final_observed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug)]
pub struct ReplayBlocked(pub &'static str);

impl ReplayBlocked {
    pub fn code(&self) -> &'static str {
        "replay_blocked"
    }
}

impl fmt::Display for ReplayBlocked {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Error for ReplayBlocked {}

fn message_text(message: &Envelope) -> String {
    message
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect()
}

fn tools(message: &Envelope) -> impl Iterator<Item = &super::contracts::ToolPart> {
    message.parts.iter().filter_map(|part| match part {
        Part::Tool(tool) => Some(tool),
        _ => None,
    })
}

fn has_active_tool(messages: &[&Envelope]) -> bool {
    messages
        .iter()
        .flat_map(|message| tools(message))
        .any(|tool| matches!(tool.status(), "pending" | "running"))
}

fn is_auto_compaction_user(message: &Envelope) -> bool {
    matches!(message.info, Message::User(_))
        && message
            .parts
            .iter()
            .any(|part| matches!(part, Part::Compaction { auto: Some(true) }))
}

fn is_synthetic_continuation_user(message: &Envelope) -> bool {
    matches!(message.info, Message::User(_))
        && (message.raw["info"]["synthetic"] == Value::Bool(true)
            || message
                .parts
                .iter()
                .any(|part| matches!(part, Part::Text(text) if text.synthetic == Some(true))))
}

fn is_compaction_summary(message: &Envelope) -> bool {
    message
        .info
        .assistant()
        .is_some_and(|assistant| assistant.agent == "compaction" && assistant.summary == Some(true))
}

fn assistant_evidence(message: &Envelope) -> Option<NativeEvidence> {
    let assistant = message.info.assistant()?;
    Some(NativeEvidence {
        message_id: assistant.id.clone(),
        parent_id: assistant.parent_id.clone(),
        provider_id: assistant.provider_id.clone(),
        model_id: assistant.model_id.clone(),
        variant: assistant.variant.clone(),
        mode: assistant.mode.clone(),
        agent: assistant.agent.clone(),
        cwd: assistant.path.cwd.clone(),
        root: assistant.path.root.clone(),
        finish: assistant.finish.clone(),
        error: assistant.error.clone(),
    })
}

// ponytail: byte order for equal timestamps where the source uses localeCompare; native ids are lowercase hex then base62.
fn ordered(messages: &[Envelope]) -> Vec<&Envelope> {
    let mut history: Vec<&Envelope> = messages.iter().collect();
    history.sort_by(|left, right| {
        left.info
            .created()
            .total_cmp(&right.info.created())
            .then_with(|| left.info.id().cmp(right.info.id()))
    });
    history
}

pub struct Correlation<'a> {
    pub messages: Vec<&'a Envelope>,
    pub prompt_found: bool,
    pub reason: Option<&'static str>,
}

/// The assistant messages of one admitted prompt, following an automatic compaction continuation.
pub fn correlated_assistants<'a>(messages: &'a [Envelope], message_id: &str) -> Correlation<'a> {
    let history = ordered(messages);
    let Some(target) = history
        .iter()
        .position(|message| message.info.id() == message_id)
    else {
        return Correlation {
            messages: Vec::new(),
            prompt_found: false,
            reason: None,
        };
    };
    let mut parents = vec![message_id.to_owned()];
    let mut assistants = Vec::new();
    let mut pending_compaction: Option<&str> = None;
    let mut awaiting_synthetic = false;
    let mut reason = None;
    for message in &history[target + 1..] {
        if let Some(assistant) = message.info.assistant() {
            if reason.is_none()
                && pending_compaction == Some(assistant.parent_id.as_str())
                && is_compaction_summary(message)
            {
                pending_compaction = None;
                awaiting_synthetic = true;
                continue;
            }
            if is_compaction_summary(message) {
                continue;
            }
            if parents.contains(&assistant.parent_id) {
                assistants.push(*message);
            }
            continue;
        }
        if reason.is_some() {
            continue;
        }
        if is_auto_compaction_user(message) && pending_compaction.is_none() && !awaiting_synthetic {
            pending_compaction = Some(message.info.id());
            continue;
        }
        if awaiting_synthetic && is_synthetic_continuation_user(message) {
            parents.push(message.info.id().to_owned());
            awaiting_synthetic = false;
            continue;
        }
        reason = Some(if awaiting_synthetic || pending_compaction.is_none() {
            "later_user_boundary"
        } else {
            "continuation_ambiguous"
        });
    }
    if reason.is_none() && (pending_compaction.is_some() || awaiting_synthetic) {
        reason = Some("continuation_ambiguous");
    }
    Correlation {
        messages: assistants,
        prompt_found: true,
        reason,
    }
}

fn is_final(message: &Envelope) -> bool {
    message.info.assistant().is_some_and(|assistant| {
        assistant.time.completed.is_some() && assistant.finish.as_deref() == Some("stop")
    })
}

fn base(
    intent: &PromptIntent,
    state: PromptState,
    admission: Admission,
    retry: Retry,
    reason: Option<&str>,
    status: Option<&SessionStatus>,
) -> PromptObservation {
    PromptObservation {
        state,
        admission,
        retry,
        session_id: intent.session_id.clone(),
        message_id: intent.message_id.clone(),
        assistant_message_ids: Vec::new(),
        assistant_message_id: None,
        status: status.cloned(),
        native: None,
        interrupted_execution: None,
        execution_uncertain: None,
        unsettled_tools: None,
        unsettled_tool_ids: None,
        process_running: None,
        native_final_observed: None,
        reason: reason.map(str::to_owned),
    }
}

fn busy(status: Option<&SessionStatus>) -> bool {
    matches!(
        status,
        Some(SessionStatus::Busy | SessionStatus::Retry { .. })
    )
}

fn classify(
    intent: &PromptIntent,
    messages: &[Envelope],
    status: Option<&SessionStatus>,
    status_known: bool,
) -> PromptObservation {
    let Some(user) = messages.iter().find(|message| {
        matches!(message.info, Message::User(_)) && message.info.id() == intent.message_id
    }) else {
        let replayable = matches!(intent.dispatch, Dispatch::NotSubmitted | Dispatch::Rejected);
        let blocked = busy(status);
        let reason = if !replayable {
            "admission_ambiguous"
        } else if !status_known {
            "native_status_unavailable"
        } else if blocked {
            "native_session_busy"
        } else {
            "message_not_observed"
        };
        let retry = if replayable && status_known && !blocked {
            Retry::Allowed
        } else {
            Retry::Forbidden
        };
        return base(
            intent,
            PromptState::Unknown,
            Admission::NotObserved,
            retry,
            Some(reason),
            status,
        );
    };
    if user.info.session_id() != intent.session_id || message_text(user) != intent.prompt {
        return base(
            intent,
            PromptState::Unknown,
            Admission::Unknown,
            Retry::Forbidden,
            Some("message_id_conflict"),
            status,
        );
    }
    let correlation = correlated_assistants(messages, &intent.message_id);
    let assistants: Vec<&Envelope> = correlation
        .messages
        .into_iter()
        .filter(|message| message.info.session_id() == intent.session_id)
        .collect();
    let last = assistants.last().copied();
    let active_tool = has_active_tool(&assistants);
    let unsettled: Vec<String> = assistants
        .iter()
        .flat_map(|message| tools(message))
        .filter(|tool| tool.state["status"] != "completed")
        .map(|tool| tool.call_id.clone())
        .take(32)
        .collect();
    let observed = |state, reason: Option<&str>, with_last: bool| PromptObservation {
        assistant_message_ids: assistants
            .iter()
            .map(|message| message.info.id().to_owned())
            .collect(),
        unsettled_tools: Some(!unsettled.is_empty()),
        unsettled_tool_ids: Some(unsettled.clone()),
        native_final_observed: Some(last.is_some_and(is_final)),
        assistant_message_id: last
            .filter(|_| with_last)
            .map(|message| message.info.id().to_owned()),
        native: last.filter(|_| with_last).and_then(assistant_evidence),
        ..base(
            intent,
            state,
            Admission::Observed,
            Retry::Forbidden,
            reason,
            status,
        )
    };
    if active_tool
        || assistants.iter().any(|message| {
            message.info.assistant().is_some_and(|assistant| {
                assistant.time.completed.is_none() && assistant.error.is_none()
            })
        })
    {
        let reason = if active_tool {
            "tool_pending_or_running"
        } else {
            "assistant_not_terminal"
        };
        return observed(PromptState::Running, Some(reason), true);
    }
    if let Some(assistant) = last.and_then(|message| message.info.assistant()) {
        match assistant.error.as_ref().map(|error| error.name.as_str()) {
            Some("MessageAbortedError") => {
                return observed(PromptState::Interrupted, Some("native_abort"), true);
            }
            Some(_) => return observed(PromptState::Error, Some("native_error"), true),
            None => {}
        }
        if last.is_some_and(is_final) {
            return observed(PromptState::Completed, None, true);
        }
        if assistant.time.completed.is_some() && assistant.finish.as_deref() != Some("tool-calls") {
            return observed(
                PromptState::TerminalIncomplete,
                Some("native_terminal_incomplete"),
                true,
            );
        }
    }
    if let Some(reason) = correlation.reason {
        return observed(PromptState::Unknown, Some(reason), false);
    }
    let state = if busy(status) {
        PromptState::Running
    } else {
        PromptState::Admitted
    };
    observed(state, Some("final_response_not_observed"), true)
}

fn canonical_fallback(value: &Path) -> String {
    let absolute = std::path::absolute(value).unwrap_or_else(|_| value.to_owned());
    let absolute = absolute.to_string_lossy().into_owned();
    // macOS exposes /tmp through /private/tmp. This alias is deliberate and only
    // applies after realpath cannot resolve a disposable or not-yet-created path.
    if cfg!(target_os = "macos")
        && (absolute == "/private/tmp" || absolute.starts_with("/private/tmp/"))
    {
        return absolute["/private".len()..].to_owned();
    }
    absolute
}

pub fn canonical_directory(value: &str) -> String {
    match std::fs::canonicalize(value) {
        Ok(resolved) => canonical_fallback(&resolved),
        Err(_) => canonical_fallback(Path::new(value)),
    }
}

fn activity_times(message: &Envelope) -> Vec<f64> {
    let time = &message.raw["info"]["time"];
    let mut times = vec![time["created"].as_f64(), time["completed"].as_f64()];
    for part in message.raw["parts"].as_array().into_iter().flatten() {
        let time = &part["state"]["time"];
        times.push(time["start"].as_f64());
        times.push(time["end"].as_f64());
    }
    times.into_iter().flatten().collect()
}

fn same_history(left: &[Envelope], right: &[Envelope]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| left.raw == right.raw)
}

async fn observe<P: PromptPort>(
    port: &P,
    intent: &PromptIntent,
) -> Result<PromptObservation, BoxError> {
    let session = port
        .get_session(&intent.session_id, &intent.directory)
        .await?;
    if session.id != intent.session_id {
        return Ok(base(
            intent,
            PromptState::Unknown,
            Admission::Unknown,
            Retry::Forbidden,
            Some("session_identity_conflict"),
            None,
        ));
    }
    if canonical_directory(&session.directory) != canonical_directory(&intent.directory) {
        return Ok(base(
            intent,
            PromptState::Unknown,
            Admission::Unknown,
            Retry::Forbidden,
            Some("session_directory_mismatch"),
            None,
        ));
    }
    let messages = port
        .get_messages(&intent.session_id, &intent.directory)
        .await?;
    // Status only supplies liveness. Message evidence remains authoritative.
    let status = port
        .get_status(&intent.directory)
        .await
        .ok()
        .map(|statuses| {
            statuses
                .get(&intent.session_id)
                .cloned()
                .unwrap_or(SessionStatus::Idle)
        });
    let observed = classify(intent, &messages, status.as_ref(), status.is_some());
    if status != Some(SessionStatus::Idle)
        || observed.unsettled_tools == Some(true)
        || !matches!(observed.state, PromptState::Running | PromptState::Admitted)
        || correlated_assistants(&messages, &intent.message_id)
            .reason
            .is_some()
    {
        return Ok(observed);
    }
    let last_activity = messages
        .iter()
        .flat_map(activity_times)
        .fold(session.time.updated, f64::max);
    if (now_ms() as f64) - last_activity < 30_000.0 {
        return Ok(observed);
    }
    let confirmed = port
        .get_messages(&intent.session_id, &intent.directory)
        .await?;
    let confirmed_status = port
        .get_status(&intent.directory)
        .await?
        .get(&intent.session_id)
        .cloned()
        .unwrap_or(SessionStatus::Idle);
    if confirmed_status != SessionStatus::Idle || !same_history(&confirmed, &messages) {
        return Ok(classify(intent, &confirmed, Some(&confirmed_status), true));
    }
    Ok(PromptObservation {
        state: PromptState::Interrupted,
        reason: Some("native_idle_incomplete".into()),
        interrupted_execution: Some(InterruptedExecution::Idle {
            last_activity_at: last_activity,
        }),
        ..observed
    })
}

pub async fn reconcile<P: PromptPort>(port: &P, intent: &PromptIntent) -> PromptObservation {
    match observe(port, intent).await {
        Ok(observed) => observed,
        Err(_) => base(
            intent,
            PromptState::Unknown,
            Admission::Unknown,
            Retry::Forbidden,
            Some("native_read_unavailable"),
            None,
        ),
    }
}

/// Posts the prompt only after native absence is proven and the durable claim is acquired.
pub async fn replay<P: PromptPort, C>(
    port: &P,
    intent: &PromptIntent,
    claim: C,
) -> Result<String, BoxError>
where
    C: FnOnce() -> Result<bool, BoxError>,
{
    if reconcile(port, intent).await.retry != Retry::Allowed {
        return Err(
            ReplayBlocked("OpenCode prompt was not proven absent; replay is blocked").into(),
        );
    }
    if !claim()? {
        return Err(ReplayBlocked("OpenCode prompt replay claim was not acquired").into());
    }
    port.prompt_async(intent).await?;
    Ok(intent.message_id.clone())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    type Messages = Box<dyn Fn() -> Result<Vec<Value>, BoxError> + Send + Sync>;
    type Statuses = Box<dyn Fn() -> Result<Value, BoxError> + Send + Sync>;

    pub(crate) struct FakePort {
        pub session: Value,
        pub messages: Messages,
        pub status: Statuses,
        pub fail_prompt: bool,
        pub prompts: Mutex<Vec<String>>,
        pub system: Mutex<Option<String>>,
    }

    impl PromptPort for FakePort {
        async fn get_session(&self, _: &str, _: &str) -> Result<Session, BoxError> {
            Ok(Session::parse(self.session.clone())?)
        }

        async fn get_messages(&self, _: &str, _: &str) -> Result<Vec<Envelope>, BoxError> {
            Ok(Envelope::parse_all(Value::Array((self.messages)()?))?)
        }

        async fn get_status(&self, _: &str) -> Result<SessionStatusMap, BoxError> {
            Ok(serde_json::from_value((self.status)()?)?)
        }

        async fn prompt_async(&self, intent: &PromptIntent) -> Result<(), BoxError> {
            self.prompts.lock().unwrap().push(intent.message_id.clone());
            *self.system.lock().unwrap() = intent.system.clone();
            if self.fail_prompt {
                return Err("prompt request failed after claim".into());
            }
            Ok(())
        }
    }

    const PROMPT: &str = "Inspect the task and report the result.";

    fn intent() -> PromptIntent {
        PromptIntent {
            message_id: "msg_task".into(),
            ..create_prompt_intent(
                "ses_task",
                "/tmp/suplex-opencode-task",
                PROMPT,
                NativeModel {
                    provider_id: "openai".into(),
                    model_id: "gpt-5.6-luna".into(),
                },
                "suplex-root",
                "max",
            )
        }
    }

    fn session() -> Value {
        json!({"id":"ses_task","projectID":"project","directory":"/tmp/suplex-opencode-task","title":"Task","version":"1.18.29","time":{"created":1,"updated":2}})
    }

    fn user_info(id: &str, created: u64) -> Value {
        json!({"id":id,"sessionID":"ses_task","role":"user","time":{"created":created},"agent":"suplex-root","model":{"providerID":"openai","modelID":"gpt-5.6-luna"}})
    }

    pub(crate) fn prompt_message() -> Value {
        json!({"info":user_info("msg_task", 3),"parts":[{"type":"text","text":PROMPT}]})
    }

    fn user(id: &str, created: u64, parts: Value) -> Value {
        json!({"info":user_info(id, created),"parts":parts})
    }

    /// An assistant reply; `info` overrides fields such as `parentID`, `completed`, `finish`, or `error`.
    fn assistant(id: &str, created: u64, info: Value, parts: Value) -> Value {
        let mut message = json!({"id":id,"sessionID":"ses_task","role":"assistant","time":{"created":created},"parentID":"msg_task","modelID":"gpt-5.6-luna","providerID":"openai","mode":"build","agent":"suplex-root","path":{"cwd":"/tmp/suplex-opencode-task","root":"/tmp/suplex-opencode-task"},"cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}});
        for (key, value) in info.as_object().unwrap() {
            if key == "completed" {
                message["time"]["completed"] = value.clone();
            } else {
                message[key] = value.clone();
            }
        }
        json!({"info":message,"parts":parts})
    }

    fn port(messages: Vec<Value>, status: Option<Value>) -> FakePort {
        let status = status.unwrap_or(json!({"type":"idle"}));
        FakePort {
            session: session(),
            messages: Box::new(move || Ok(messages.clone())),
            status: Box::new(move || Ok(json!({"ses_task":status.clone()}))),
            fail_prompt: false,
            prompts: Mutex::default(),
            system: Mutex::default(),
        }
    }

    fn failing_status(mut port: FakePort) -> FakePort {
        port.status = Box::new(|| Err("temporary status read failure".into()));
        port
    }

    fn failing(mut port: FakePort) -> FakePort {
        port.session = Value::Null;
        port.messages = Box::new(|| Err("temporary message read failure".into()));
        failing_status(port)
    }

    fn envelopes(values: Vec<Value>) -> Vec<Envelope> {
        Envelope::parse_all(Value::Array(values)).unwrap()
    }

    fn completed_tool(call: &str) -> Value {
        json!({"type":"tool","callID":call,"tool":"bash","state":{"status":"completed","input":{},"output":"done","title":"bash","metadata":{},"time":{"start":4,"end":5}}})
    }

    fn blocked(error: BoxError) -> bool {
        error
            .downcast_ref::<ReplayBlocked>()
            .is_some_and(|error| error.code() == "replay_blocked")
    }

    #[test]
    fn historical_turn_correlation_excludes_tools_from_a_later_assignment_and_needs_the_admitted_prompt()
     {
        let history = envelopes(vec![
            prompt_message(),
            assistant(
                "msg_first",
                4,
                json!({"completed":5,"finish":"stop"}),
                json!([completed_tool("first-tool")]),
            ),
            user(
                "msg_later",
                6,
                json!([{"type":"text","text":"Second assignment"}]),
            ),
            assistant(
                "msg_later_answer",
                7,
                json!({"parentID":"msg_later","completed":8,"finish":"stop"}),
                json!([completed_tool("later-tool")]),
            ),
        ]);
        let correlated = correlated_assistants(&history, "msg_task");
        assert!(correlated.prompt_found);
        assert_eq!(
            correlated
                .messages
                .iter()
                .map(|message| message.info.id())
                .collect::<Vec<_>>(),
            ["msg_first"]
        );
        let missing = correlated_assistants(&history, "missing");
        assert!(!missing.prompt_found && missing.messages.is_empty());
    }

    #[tokio::test]
    async fn a_final_assistant_does_not_complete_a_turn_with_an_active_tool() {
        for status in ["pending", "running"] {
            let result = reconcile(&port(vec![prompt_message(), assistant("msg_final", 4, json!({"completed":6,"finish":"stop"}), json!([{"type":"tool","callID":"call-active","tool":"bash","state":{"status":status,"input":{},"title":"active","time":{"start":5}}}]))], None), &intent()).await;
            assert_eq!(result.state, PromptState::Running);
            assert_eq!(result.reason.as_deref(), Some("tool_pending_or_running"));
            assert_eq!(result.retry, Retry::Forbidden);
        }
    }

    #[tokio::test]
    async fn a_later_user_does_not_hide_an_exact_parent_final_response() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    user(
                        "msg_later_user",
                        4,
                        json!([{"type":"text","text":"A queued follow-up"}]),
                    ),
                    assistant(
                        "msg_original_final",
                        5,
                        json!({"completed":6,"finish":"stop"}),
                        json!([]),
                    ),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(result.state, PromptState::Completed);
        assert_eq!(
            result.assistant_message_id.as_deref(),
            Some("msg_original_final")
        );
        assert_eq!(result.retry, Retry::Forbidden);
    }

    #[tokio::test]
    async fn a_final_assistant_does_not_hide_an_unfinished_correlated_assistant() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    assistant("msg_unfinished", 4, json!({}), json!([])),
                    assistant(
                        "msg_final",
                        5,
                        json!({"completed":6,"finish":"stop"}),
                        json!([]),
                    ),
                ],
                Some(json!({"type":"busy"})),
            ),
            &intent(),
        )
        .await;
        assert_eq!(
            (result.state, result.retry),
            (PromptState::Running, Retry::Forbidden)
        );
    }

    #[test]
    fn generated_prompt_ids_use_opencodes_ascending_native_message_format() {
        let first = create_message_id(1_788_576_300_000);
        let second = create_message_id(1_788_576_300_000);
        let format = regex::Regex::new("^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$").expect("valid regex");
        assert!(format.is_match(&first) && format.is_match(&second));
        assert!(first < second);
    }

    #[tokio::test]
    async fn native_final_response_completes_only_after_a_preceding_tool_step() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    assistant(
                        "msg_tool_step",
                        4,
                        json!({"completed":5,"finish":"tool-calls"}),
                        json!([completed_tool("call-1")]),
                    ),
                    assistant(
                        "msg_final",
                        6,
                        json!({"completed":7,"finish":"stop"}),
                        json!([{"type":"text","text":"The task is complete."}]),
                    ),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(result.state, PromptState::Completed);
        assert_eq!(result.admission, Admission::Observed);
        assert_eq!(result.retry, Retry::Forbidden);
        assert_eq!(result.assistant_message_id.as_deref(), Some("msg_final"));
        let native = result.native.unwrap();
        assert_eq!(
            (
                native.provider_id.as_str(),
                native.model_id.as_str(),
                native.finish.as_deref()
            ),
            ("openai", "gpt-5.6-luna", Some("stop"))
        );
        assert_eq!(result.assistant_message_ids, ["msg_tool_step", "msg_final"]);
    }

    #[tokio::test]
    async fn a_completed_tool_step_is_not_a_completed_turn_while_its_tool_is_running() {
        let result = reconcile(&port(vec![prompt_message(), assistant("msg_tool_step", 4, json!({"completed":5,"finish":"tool-calls"}), json!([completed_tool("call-1"), {"type":"tool","callID":"call-2","tool":"bash","state":{"status":"running","input":{},"title":"sleep","time":{"start":5}}}]))], Some(json!({"type":"busy"}))), &intent()).await;
        assert_eq!(result.state, PromptState::Running);
        assert_eq!(
            result.assistant_message_id.as_deref(),
            Some("msg_tool_step")
        );
        assert_eq!(result.reason.as_deref(), Some("tool_pending_or_running"));
    }

    #[tokio::test]
    async fn a_completed_tool_step_without_a_final_response_is_recovered_after_native_activity_stops()
     {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    assistant(
                        "msg_tool_step",
                        4,
                        json!({"completed":5,"finish":"tool-calls"}),
                        json!([completed_tool("call-1")]),
                    ),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(result.state, PromptState::Interrupted);
        assert_eq!(
            result.assistant_message_id.as_deref(),
            Some("msg_tool_step")
        );
        assert_eq!(result.reason.as_deref(), Some("native_idle_incomplete"));
    }

    #[tokio::test]
    async fn native_assistant_errors_distinguish_provider_failure_from_interruption() {
        let error = reconcile(&port(vec![prompt_message(), assistant("msg_error", 4, json!({"completed":5,"error":{"name":"ProviderAuthError","data":{"providerID":"openai","message":"authentication failed"}}}), json!([]))], None), &intent()).await;
        let interrupted = reconcile(&port(vec![prompt_message(), assistant("msg_interrupted", 4, json!({"completed":5,"error":{"name":"MessageAbortedError","data":{"message":"aborted"}}}), json!([]))], None), &intent()).await;
        assert_eq!(error.state, PromptState::Error);
        assert_eq!(interrupted.state, PromptState::Interrupted);
    }

    #[tokio::test]
    async fn native_length_and_content_filter_finishes_are_terminal_incomplete() {
        for finish in ["length", "content-filter"] {
            let result = reconcile(
                &port(
                    vec![
                        prompt_message(),
                        assistant(
                            "msg_incomplete",
                            4,
                            json!({"completed":5,"finish":finish}),
                            json!([{"type":"text","text":"partial"}]),
                        ),
                    ],
                    None,
                ),
                &intent(),
            )
            .await;
            assert_eq!(result.state, PromptState::TerminalIncomplete);
            assert_eq!(
                result.assistant_message_id.as_deref(),
                Some("msg_incomplete")
            );
        }
    }

    #[tokio::test]
    async fn a_native_stop_is_terminal_even_when_it_has_no_text_part() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    assistant(
                        "msg_empty_final",
                        4,
                        json!({"completed":5,"finish":"stop"}),
                        json!([]),
                    ),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(result.state, PromptState::Completed);
    }

    #[tokio::test]
    async fn automatic_compaction_follows_the_synthetic_continuation_without_accepting_its_summary()
    {
        let result = reconcile(&port(vec![
            prompt_message(),
            assistant("msg_tool_before_compaction", 4, json!({"completed":5,"finish":"tool-calls"}), json!([completed_tool("call-1")])),
            user("msg_compaction", 6, json!([{"type":"compaction","auto":true}])),
            assistant("msg_compaction_summary", 7, json!({"completed":8,"finish":"stop","agent":"compaction","summary":true,"parentID":"msg_compaction"}), json!([{"type":"text","text":"A summary that is not the task result."}])),
            user("msg_synthetic_continuation", 9, json!([{"type":"text","synthetic":true,"text":"Continue if you have next steps."}])),
            assistant("msg_continued_final", 10, json!({"completed":11,"finish":"stop","parentID":"msg_synthetic_continuation"}), json!([{"type":"text","text":"The task is complete."}])),
        ], None), &intent()).await;
        assert_eq!(result.state, PromptState::Completed);
        assert_eq!(
            result.assistant_message_id.as_deref(),
            Some("msg_continued_final")
        );
        assert_eq!(
            result.assistant_message_ids,
            ["msg_tool_before_compaction", "msg_continued_final"]
        );
    }

    #[tokio::test]
    async fn an_unresolved_compaction_continuation_is_explicit_unknown() {
        let result = reconcile(&port(vec![
            prompt_message(),
            user("msg_compaction_only", 6, json!([{"type":"compaction","auto":true}])),
            assistant("msg_compaction_only_summary", 7, json!({"completed":8,"finish":"stop","agent":"compaction","summary":true,"parentID":"msg_compaction_only"}), json!([])),
        ], None), &intent()).await;
        assert_eq!(
            (result.state, result.admission, result.retry),
            (PromptState::Unknown, Admission::Observed, Retry::Forbidden)
        );
        assert_eq!(result.reason.as_deref(), Some("continuation_ambiguous"));
    }

    #[tokio::test]
    async fn a_later_real_user_ends_the_assignment_boundary() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    user(
                        "msg_later_real_user",
                        5,
                        json!([{"type":"text","text":"Start a different task."}]),
                    ),
                    assistant(
                        "msg_later_real_answer",
                        6,
                        json!({"completed":7,"finish":"stop","parentID":"msg_later_real_user"}),
                        json!([{"type":"text","text":"Unrelated answer."}]),
                    ),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(
            (result.state, result.admission, result.retry),
            (PromptState::Unknown, Admission::Observed, Retry::Forbidden)
        );
        assert_eq!(result.reason.as_deref(), Some("later_user_boundary"));
        assert!(result.assistant_message_id.is_none());
    }

    #[tokio::test]
    async fn a_native_content_filter_error_is_an_error_not_a_missing_continuation() {
        let result = reconcile(&port(vec![prompt_message(), assistant("msg_filtered", 4, json!({"completed":5,"error":{"name":"ContentFilterError","data":{"message":"filtered"}}}), json!([]))], None), &intent()).await;
        assert_eq!(result.state, PromptState::Error);
    }

    #[tokio::test]
    async fn a_terminal_native_message_remains_authoritative_when_the_status_read_fails() {
        let result = reconcile(
            &failing_status(port(
                vec![
                    prompt_message(),
                    assistant(
                        "msg_final_without_status",
                        4,
                        json!({"completed":5,"finish":"stop"}),
                        json!([{"type":"text","text":"done"}]),
                    ),
                ],
                None,
            )),
            &intent(),
        )
        .await;
        assert_eq!(result.state, PromptState::Completed);
        assert_eq!(
            result.assistant_message_id.as_deref(),
            Some("msg_final_without_status")
        );
        assert!(result.status.is_none());
    }

    #[tokio::test]
    async fn missing_status_certainty_forbids_a_new_dispatch() {
        let reader = failing_status(port(vec![], None));
        let result = reconcile(&reader, &intent()).await;
        assert_eq!(
            (result.state, result.retry),
            (PromptState::Unknown, Retry::Forbidden)
        );
        assert_eq!(result.reason.as_deref(), Some("native_status_unavailable"));
        assert!(blocked(
            replay(&reader, &intent(), || Ok(true)).await.unwrap_err()
        ));
        assert!(reader.prompts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn transient_server_or_native_reads_remain_unknown_and_cannot_be_replayed() {
        let reader = failing(port(vec![], None));
        let result = reconcile(&reader, &intent()).await;
        assert_eq!(
            (result.state, result.admission, result.retry),
            (PromptState::Unknown, Admission::Unknown, Retry::Forbidden)
        );
        assert!(blocked(
            replay(&reader, &intent(), || Ok(true)).await.unwrap_err()
        ));
        assert!(reader.prompts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_never_submitted_intent_can_dispatch_after_a_successful_absent_message_read() {
        let reader = port(vec![], None);
        let result = reconcile(&reader, &intent()).await;
        assert_eq!(
            (result.state, result.admission, result.retry),
            (PromptState::Unknown, Admission::NotObserved, Retry::Allowed)
        );
        assert_eq!(
            replay(&reader, &intent(), || Ok(true)).await.unwrap(),
            "msg_task"
        );
        assert_eq!(*reader.prompts.lock().unwrap(), ["msg_task"]);
    }

    #[tokio::test]
    async fn dispatch_sends_role_instructions_as_a_system_prompt_without_changing_the_server_scope()
    {
        let reader = port(vec![], None);
        let intent = PromptIntent {
            system: Some("Coordinator owns planning and independent review.".into()),
            ..intent()
        };
        replay(&reader, &intent, || Ok(true)).await.unwrap();
        assert_eq!(
            reader.system.lock().unwrap().as_deref(),
            Some("Coordinator owns planning and independent review.")
        );
    }

    #[tokio::test]
    async fn an_omitted_entry_in_a_successful_status_map_means_idle_not_an_unavailable_read() {
        let mut reader = port(vec![], None);
        reader.status = Box::new(|| Ok(json!({})));
        assert_eq!(reconcile(&reader, &intent()).await.retry, Retry::Allowed);
        let ambiguous = PromptIntent {
            dispatch: Dispatch::Ambiguous,
            ..intent()
        };
        assert_eq!(reconcile(&reader, &ambiguous).await.retry, Retry::Forbidden);
    }

    #[tokio::test]
    async fn malformed_tool_records_cannot_fall_through_as_unknown_part_types() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    assistant(
                        "msg_bad_tool",
                        4,
                        json!({"completed":5,"finish":"stop"}),
                        json!([{"type":"tool","callID":"call","tool":"bash"}]),
                    ),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(result.state, PromptState::Unknown);
        assert_eq!(result.reason.as_deref(), Some("native_read_unavailable"));
    }

    #[tokio::test]
    async fn an_ambiguous_lost_acknowledgement_stays_fenced_while_native_admission_is_delayed() {
        let reads = Arc::new(AtomicUsize::new(0));
        let mut delayed = port(vec![], None);
        let counter = reads.clone();
        delayed.messages = Box::new(move || {
            Ok(if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                vec![]
            } else {
                vec![
                    json!({"info":user_info("msg_task", now_ms()),"parts":[{"type":"text","text":PROMPT}]}),
                ]
            })
        });
        let ambiguous = PromptIntent {
            dispatch: Dispatch::Ambiguous,
            ..intent()
        };
        let before = reconcile(&delayed, &ambiguous).await;
        let after = reconcile(&delayed, &ambiguous).await;
        assert_eq!(
            (before.state, before.admission, before.retry),
            (
                PromptState::Unknown,
                Admission::NotObserved,
                Retry::Forbidden
            )
        );
        assert_eq!(before.reason.as_deref(), Some("admission_ambiguous"));
        assert_eq!(
            (after.state, after.admission, after.retry),
            (PromptState::Admitted, Admission::Observed, Retry::Forbidden)
        );
        assert!(blocked(
            replay(&delayed, &ambiguous, || Ok(true)).await.unwrap_err()
        ));
        assert!(delayed.prompts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn two_replay_callers_use_one_durable_atomic_claim_and_only_one_posts() {
        let reader = port(vec![], None);
        let claimed = AtomicBool::new(false);
        let claim = || Ok(!claimed.swap(true, Ordering::SeqCst));
        let intent = intent();
        let (first, second) = tokio::join!(
            replay(&reader, &intent, claim),
            replay(&reader, &intent, claim)
        );
        assert_eq!(
            [first.is_ok(), second.is_ok()]
                .iter()
                .filter(|ok| **ok)
                .count(),
            1
        );
        assert_eq!(*reader.prompts.lock().unwrap(), ["msg_task"]);
    }

    #[tokio::test]
    async fn a_failed_post_after_durable_claim_stays_ambiguous_and_cannot_be_replayed() {
        let mut reader = port(vec![], None);
        reader.fail_prompt = true;
        let dispatch = Mutex::new(Dispatch::NotSubmitted);
        let claim = || {
            let mut dispatch = dispatch.lock().unwrap();
            if *dispatch != Dispatch::NotSubmitted {
                return Ok(false);
            }
            *dispatch = Dispatch::Ambiguous;
            Ok(true)
        };
        let error = replay(&reader, &intent(), claim).await.unwrap_err();
        assert_eq!(error.to_string(), "prompt request failed after claim");
        let current = *dispatch.lock().unwrap();
        let retried = PromptIntent {
            dispatch: current,
            ..intent()
        };
        assert!(blocked(replay(&reader, &retried, claim).await.unwrap_err()));
        assert_eq!(*reader.prompts.lock().unwrap(), ["msg_task"]);
    }

    #[tokio::test]
    async fn message_ids_and_prompt_text_are_correlated_before_a_retry() {
        let result = reconcile(
            &port(
                vec![user(
                    "msg_task",
                    3,
                    json!([{"type":"text","text":"different prompt"}]),
                )],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(
            (result.state, result.admission, result.retry),
            (PromptState::Unknown, Admission::Unknown, Retry::Forbidden)
        );
        assert_eq!(result.reason.as_deref(), Some("message_id_conflict"));
    }

    #[tokio::test]
    async fn session_identity_and_canonical_directory_are_checked_before_absence_can_be_replayable()
    {
        let mut wrong_session = port(vec![], None);
        wrong_session.session["id"] = json!("ses_other");
        let result = reconcile(&wrong_session, &intent()).await;
        assert_eq!(
            (result.reason.as_deref(), result.retry),
            (Some("session_identity_conflict"), Retry::Forbidden)
        );
        let mut wrong_directory = port(vec![], None);
        wrong_directory.session["directory"] = json!("/tmp/another-task");
        let result = reconcile(&wrong_directory, &intent()).await;
        assert_eq!(
            (result.reason.as_deref(), result.retry),
            (Some("session_directory_mismatch"), Retry::Forbidden)
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn deliberately_treats_macos_tmp_and_private_tmp_as_one_canonical_directory() {
        let mut alias = port(
            vec![
                prompt_message(),
                assistant(
                    "msg_alias_final",
                    4,
                    json!({"completed":5,"finish":"stop"}),
                    json!([{"type":"text","text":"done"}]),
                ),
            ],
            None,
        );
        alias.session["directory"] = json!("/private/tmp/suplex-opencode-task");
        let result = reconcile(&alias, &intent()).await;
        assert_eq!(
            (result.admission, result.state),
            (Admission::Observed, PromptState::Completed)
        );
        assert_eq!(
            result.assistant_message_id.as_deref(),
            Some("msg_alias_final")
        );
    }

    #[tokio::test]
    async fn the_same_native_session_history_remains_authoritative_after_a_client_restart() {
        let history = vec![
            prompt_message(),
            assistant(
                "msg_final",
                6,
                json!({"completed":7,"finish":"stop"}),
                json!([{"type":"text","text":"done"}]),
            ),
        ];
        let first = reconcile(&port(history.clone(), None), &intent()).await;
        let after_restart = reconcile(&port(history, None), &intent()).await;
        assert_eq!(after_restart.state, PromptState::Completed);
        assert_eq!(
            after_restart.assistant_message_id,
            first.assistant_message_id
        );
        assert_eq!(after_restart.native, first.native);
    }

    #[tokio::test]
    async fn an_idle_unfinished_assistant_becomes_an_interrupted_turn_without_replay() {
        let result = reconcile(
            &port(
                vec![
                    prompt_message(),
                    assistant("msg_empty", 4, json!({}), json!([])),
                ],
                None,
            ),
            &intent(),
        )
        .await;
        assert_eq!(
            (result.state, result.admission, result.retry),
            (
                PromptState::Interrupted,
                Admission::Observed,
                Retry::Forbidden
            )
        );
        assert_eq!(result.reason.as_deref(), Some("native_idle_incomplete"));
        assert_eq!(
            result.interrupted_execution,
            Some(InterruptedExecution::Idle {
                last_activity_at: 4.0
            })
        );
    }

    #[tokio::test]
    async fn does_not_recover_an_unfinished_turn_while_native_state_is_active_unknown_or_recent() {
        for condition in ["busy", "retry", "unavailable", "recent"] {
            let created = if condition == "recent" { now_ms() } else { 4 };
            let status = match condition {
                "busy" => Some(json!({"type":"busy"})),
                "retry" => {
                    Some(json!({"type":"retry","attempt":1,"message":"retry","next":now_ms()}))
                }
                _ => None,
            };
            let mut reader = port(
                vec![
                    prompt_message(),
                    assistant("msg_empty", created, json!({}), json!([])),
                ],
                status,
            );
            if condition == "unavailable" {
                reader = failing_status(reader);
            }
            assert_ne!(
                reconcile(&reader, &intent()).await.state,
                PromptState::Interrupted,
                "{condition}"
            );
        }
    }

    #[tokio::test]
    async fn native_activity_appearing_during_the_idle_confirmation_prevents_recovery() {
        let checks = Arc::new(AtomicUsize::new(0));
        let mut reader = port(
            vec![
                prompt_message(),
                assistant("msg_empty", 4, json!({}), json!([])),
            ],
            None,
        );
        reader.status = Box::new(move || {
            let kind = if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                "idle"
            } else {
                "busy"
            };
            Ok(json!({"ses_task":{"type":kind}}))
        });
        assert_eq!(
            reconcile(&reader, &intent()).await.state,
            PromptState::Running
        );
    }

    #[tokio::test]
    async fn a_failed_tool_receipt_alone_does_not_prove_execution_stopped() {
        let result = reconcile(&port(vec![
            prompt_message(),
            assistant("msg_tool", 4, json!({"completed":5,"finish":"tool-calls"}), json!([{"type":"tool","callID":"call-1","tool":"bash","state":{"status":"error","input":{},"error":"Command timed out","time":{"start":4,"end":5}}}])),
            assistant("msg_empty", 6, json!({}), json!([])),
        ], None), &intent()).await;
        assert_eq!(
            (result.state, result.unsettled_tools, result.retry),
            (PromptState::Running, Some(true), Retry::Forbidden)
        );
    }

    #[test]
    fn a_vendor_qualified_model_id_reaches_opencode_as_its_own_provider_and_bare_model() {
        let model = open_code_model("openai/gpt-5.6-luna").unwrap();
        assert_eq!(
            (model.provider_id.as_str(), model.model_id.as_str()),
            ("openai", "gpt-5.6-luna")
        );
        let model = open_code_model("github-copilot/claude-fable-5/preview").unwrap();
        assert_eq!(
            (model.provider_id.as_str(), model.model_id.as_str()),
            ("github-copilot", "claude-fable-5/preview")
        );
        assert!(
            open_code_model("gpt-5.6-luna")
                .unwrap_err()
                .contains("vendor-qualified")
        );
        assert!(open_code_model("/gpt-5.6-luna").is_err());
    }
}
