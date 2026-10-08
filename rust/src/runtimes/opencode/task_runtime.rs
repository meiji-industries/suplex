//! TypeScript `OpenCodeTaskRuntime` behind the shared task harness seam.
//!
//! The seam reserves a native session identity before launch; OpenCode names
//! its own sessions. `dispatch` creates the OpenCode session for a reserved
//! `opencode-…` identity and records the pairing in the session runtime
//! directory, next to `server.json`. Native `ses…` identities are used as is.

use crate::runtimes::native::SessionRef;
use crate::shared::hash::sha256_hex;
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Value, json};

use super::{
    client::CreateSessionInput,
    contracts::{Envelope, Part, PromptState as NativeState, SessionCreateModel, SessionStatus},
    server::{
        self, BridgeServer, EnsureInput, Profile, RoleConfigInput, RoleKind, ServerReference,
    },
    session::{
        self as native_session, Admission, BoxError, Dispatch, InterruptedExecution, PromptIntent,
        PromptPort, ReplayBlocked, Retry, StoppedServer, correlated_assistants, open_code_model,
        reconcile,
    },
    session_history::read_history,
    session_reader::{self, OpenCodeSessionReader, ReaderSession as OpenCodeReaderSession},
};
use crate::{
    coordination::{
        advisor_bridge,
        bridge_auth::{ADVISOR_BINDING_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV, ROOT_TOKEN_ENV},
        root_bridge,
    },
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        git_guard, headless,
        native::{NativeReasoning, NativeTool, UsageTokens},
        task_harness::{
            DispatchClaim, DispatchState, HarnessFuture, NativeSessionReader, NativeTimeline,
            PromptObservation, PromptState, ReaderSession, TaskHarness, TaskRole, TaskScope,
            UsageEntry, WorkflowLaunch, task_scope_environment,
        },
    },
};

const SESSION_BINDING: &str = "opencode-session.json";

pub struct OpenCodeTaskRuntime;

/// Keeps the native error as the source so callers can classify it (such as `SessionNotFound`).
fn io_error(error: impl Into<BoxError>) -> io::Error {
    io::Error::other(error.into())
}

/// The native OpenCode session for a Suplex identity: itself when native, else the recorded pairing.
fn native_session_id(directory: &Path, reserved: &str) -> io::Result<Option<String>> {
    if reserved.starts_with("ses") {
        return Ok(Some(reserved.to_owned()));
    }
    let binding: Value = match fs::read(directory.join(SESSION_BINDING)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok((binding["reserved"] == reserved)
        .then(|| binding["sessionID"].as_str().map(str::to_owned))
        .flatten())
}

fn intent_path(directory: &Path, turn_id: &str) -> io::Result<PathBuf> {
    if turn_id.is_empty()
        || !turn_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(io::Error::other("Invalid turn identity"));
    }
    Ok(directory.join(format!("turn-{turn_id}.opencode-intent.json")))
}

fn read_intent(directory: &Path, turn_id: &str) -> io::Result<Option<PromptIntent>> {
    match fs::read(intent_path(directory, turn_id)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// TypeScript `openCodeDisplayAttached`: whether a pane's foreground argv is this server's attach.
pub fn display_attached(reference: &ServerReference, session_id: &str, args: &[String]) -> bool {
    let after = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
    };
    args.first() == Some(&reference.executable)
        && args.get(1).map(String::as_str) == Some("attach")
        && args.get(2) == Some(&reference.base_url)
        && after("--session").map(String::as_str) == Some(session_id)
        && after("--dir") == Some(&reference.directory)
}

fn role_parts(
    role: TaskRole<'_>,
    workflow: WorkflowLaunch,
) -> (RoleKind, &'static str, &'static str, &'static str) {
    let prompt = workflow.role_prompt(role);
    match (role, workflow.advisor) {
        (TaskRole::Root(_), _) => (RoleKind::Root, "suplex-root", "Coordinator", prompt),
        (TaskRole::Worker(_), Some(advisor)) => {
            let label = crate::coordination::workflows::advisor_label(advisor.as_str());
            (RoleKind::Advisor, "suplex-advisor", label, prompt)
        }
        (TaskRole::Worker(_), None) => (RoleKind::Worker, "suplex-worker", "Worker", prompt),
    }
}

/// TypeScript `ensureSession`: start or reuse the task server, check the bridge, then create or reuse the native session.
pub async fn ensure_session(scope: &TaskScope<'_>) -> Result<String, BoxError> {
    let runtime = scope.runtime_directory()?;
    let executable = server::resolve_executable(scope.executable)?;
    let (role, agent, label, _) = role_parts(scope.role, scope.workflow);
    let bridge = match scope.role {
        TaskRole::Root(identity) => {
            let suplex = std::env::current_exe()?.to_string_lossy().into_owned();
            let binding = root_bridge::write_binding(
                &runtime,
                identity,
                scope.database_path,
                scope.artifact_root,
                &suplex,
            )?;
            Some(BridgeServer {
                command: suplex,
                args: vec!["mcp".into(), "root".into()],
                environment: [
                    (
                        ROOT_BINDING_ENV.to_owned(),
                        binding.binding_path.to_string_lossy().into_owned(),
                    ),
                    (ROOT_TOKEN_ENV.to_owned(), binding.token),
                ]
                .into(),
            })
        }
        TaskRole::Worker(_) => match scope.workflow.advisor {
            Some(advisor) => {
                let suplex = std::env::current_exe()?.to_string_lossy().into_owned();
                let binding = advisor_bridge::write_binding(&runtime, advisor, &suplex)?;
                Some(BridgeServer {
                    command: suplex,
                    args: vec!["mcp".into(), "advisor".into()],
                    environment: [
                        (
                            ADVISOR_BINDING_ENV.to_owned(),
                            binding.binding_path.to_string_lossy().into_owned(),
                        ),
                        (ADVISOR_TOKEN_ENV.to_owned(), binding.token),
                    ]
                    .into(),
                })
            }
            None => None,
        },
    };
    let environment = match role {
        RoleKind::Worker => {
            let (git, gh) = git_guard::resolve_guard_binaries(scope.inherited_environment)?;
            git_guard::create_git_command_guard(
                &runtime,
                &git,
                gh.as_deref(),
                scope.inherited_environment,
            )?
            .environment
        }
        _ => scope.inherited_environment.clone(),
    };
    let mut environment =
        task_scope_environment(environment, scope.worktree, scope.project_environment);
    for key in scope.excluded_environment_keys {
        environment.remove(key);
    }
    let profile = Profile {
        model_id: scope.model.to_owned(),
        reasoning_effort: scope.reasoning_effort.to_owned(),
        service_tier: "default".to_owned(),
    };
    let context = scope
        .project_context_path
        .and_then(Path::parent)
        .map(|path| path.to_string_lossy().into_owned());
    // Coordinator and Advisor sessions read the pinned workflow evidence or prepared project context.
    let evidence = (role != RoleKind::Worker
        && (scope.workflow.reads_evidence(scope.role) || scope.project_context_path.is_some()))
    .then(|| scope.evidence_root().to_string_lossy().into_owned());
    let worktree = scope.worktree.to_string_lossy().into_owned();
    let config = server::role_config(RoleConfigInput {
        role,
        profile: &profile,
        bridge: bridge.as_ref(),
        evidence_directory: evidence.as_deref(),
        context_directory: context.as_deref(),
        directory: evidence.as_ref().map(|_| worktree.as_str()),
    })?;
    let reference = server::ensure_server(EnsureInput {
        runtime_directory: &runtime,
        executable: &executable,
        directory: scope.worktree,
        config: &config,
        env: Some(&environment),
    })
    .await?;
    let client = server::client(&reference)?;
    let directory = scope.worktree.to_string_lossy();
    if role != RoleKind::Worker {
        let (name, label) = if role == RoleKind::Root {
            ("suplex_root", "Coordinator")
        } else {
            ("suplex_advisor", "Advisor report")
        };
        let status = client.mcp_status(&directory).await?.remove(name);
        if status.as_ref().map(|status| status.status.as_str()) != Some("connected") {
            let detail = status
                .map(|status| status.error.unwrap_or(status.status))
                .unwrap_or_else(|| "not configured".into());
            return Err(format!("Suplex {label} bridge is unavailable: {detail}").into());
        }
    }
    if let Some(native) = native_session_id(&runtime, scope.native_session_id)? {
        return Ok(client.get_session(&native, Some(&directory)).await?.id);
    }
    let model = open_code_model(scope.model)?;
    let native = client
        .create_session(CreateSessionInput {
            title: &format!("{} {label}", scope.task_id),
            directory: Some(&directory),
            model: SessionCreateModel {
                id: model.model_id,
                provider_id: model.provider_id,
                variant: Some(scope.reasoning_effort.to_owned()),
            },
            agent,
            metadata: None,
        })
        .await?;
    crate::shared::fs::write_private(
        &runtime.join(SESSION_BINDING),
        json!({"reserved":scope.native_session_id,"sessionID":native.id})
            .to_string()
            .as_bytes(),
    )?;
    Ok(native.id)
}

/// The recorded intent of one turn, or a reconstruction from native evidence when it predates this runtime.
async fn turn_context(
    directory: &Path,
    reserved: &str,
    turn_id: &str,
    dispatch: Dispatch,
) -> Result<Option<(ServerReference, PromptIntent)>, BoxError> {
    let recorded = read_intent(directory, turn_id)?;
    let Some(session_id) = native_session_id(directory, reserved)?
        .or_else(|| recorded.as_ref().map(|intent| intent.session_id.clone()))
    else {
        return Ok(None);
    };
    let reference =
        server::read_server(directory)?.ok_or("OpenCode server reference is missing")?;
    let intent = match recorded {
        Some(intent) => intent,
        None => {
            let client = server::client(&reference)?;
            let prompt = client
                .get_messages(&session_id, Some(&reference.directory), None)
                .await
                .ok()
                .and_then(|messages| {
                    messages
                        .into_iter()
                        .find(|message| message.info.id() == turn_id)
                })
                .map(|message| text(&message, ""))
                .unwrap_or_default();
            PromptIntent {
                session_id,
                message_id: turn_id.to_owned(),
                directory: reference.directory.clone(),
                prompt_hash: sha256_hex(prompt.as_bytes()),
                prompt,
                system: None,
                model: open_code_model("unknown/unknown")?,
                agent: String::new(),
                variant: String::new(),
                dispatch,
            }
        }
    };
    Ok(Some((reference, PromptIntent { dispatch, ..intent })))
}

fn text(message: &Envelope, separator: &str) -> String {
    message
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(separator)
}

fn unsubmitted(
    native_session_id: &str,
    turn_id: &str,
    dispatch: Dispatch,
) -> native_session::PromptObservation {
    let replayable = matches!(dispatch, Dispatch::NotSubmitted | Dispatch::Rejected);
    native_session::PromptObservation {
        state: NativeState::Unknown,
        admission: Admission::NotObserved,
        retry: if replayable {
            Retry::Allowed
        } else {
            Retry::Forbidden
        },
        session_id: native_session_id.to_owned(),
        message_id: turn_id.to_owned(),
        assistant_message_ids: Vec::new(),
        assistant_message_id: None,
        status: None,
        native: None,
        interrupted_execution: None,
        execution_uncertain: None,
        unsettled_tools: None,
        unsettled_tool_ids: None,
        process_running: None,
        native_final_observed: None,
        reason: Some(
            if replayable {
                "message_not_observed"
            } else {
                "admission_ambiguous"
            }
            .into(),
        ),
    }
}

fn in_flight(observed: &native_session::PromptObservation) -> bool {
    observed.admission == Admission::Observed
        && (matches!(observed.state, NativeState::Admitted | NativeState::Running)
            || observed.reason.as_deref() == Some("native_abort"))
}

/// TypeScript `recoverDispatch`: stop the fenced server generation, then read the current server.
pub async fn recover_native(
    directory: &Path,
    intent: &PromptIntent,
    generation: &str,
) -> Result<native_session::PromptObservation, BoxError> {
    if generation.len() != 36 || uuid::Uuid::parse_str(generation).is_err() {
        return Err("OpenCode dispatch server identity is invalid".into());
    }
    let fenced = ServerReference::parse(&fs::read(
        directory.join(format!("dispatch-server-{generation}.json")),
    )?)?;
    if fenced.generation != generation {
        return Err("OpenCode dispatch server identity changed".into());
    }
    server::stop_server(&fenced)?;
    headless::stop_execution(directory, generation)?;
    let current = server::read_server(directory)?.ok_or("OpenCode server reference is missing")?;
    let observed = reconcile(
        &server::client(&current)?,
        &PromptIntent {
            dispatch: Dispatch::NotSubmitted,
            ..intent.clone()
        },
    )
    .await;
    if in_flight(&observed) && observed.status == Some(SessionStatus::Idle) {
        let stopped = StoppedServer {
            stopped_server_generation: generation.to_owned(),
        };
        if observed.unsettled_tools == Some(true) {
            return Ok(native_session::PromptObservation {
                state: NativeState::Unknown,
                reason: Some("tool_execution_after_server_crash".into()),
                execution_uncertain: Some(stopped),
                ..observed
            });
        }
        return Ok(native_session::PromptObservation {
            state: NativeState::Interrupted,
            reason: Some("dispatch_process_stopped".into()),
            interrupted_execution: Some(InterruptedExecution::Stopped(stopped)),
            ..observed
        });
    }
    Ok(observed)
}

async fn observe_native(
    directory: &Path,
    native_session_id: &str,
    turn_id: &str,
    dispatch: Dispatch,
    generation: Option<&str>,
) -> Result<native_session::PromptObservation, BoxError> {
    let Some((reference, intent)) =
        turn_context(directory, native_session_id, turn_id, dispatch).await?
    else {
        return Ok(unsubmitted(native_session_id, turn_id, dispatch));
    };
    let observed = reconcile(&server::client(&reference)?, &intent).await;
    match generation {
        Some(generation) if generation != reference.generation && in_flight(&observed) => {
            recover_native(directory, &intent, generation).await
        }
        _ => Ok(observed),
    }
}

const REASONS: &[&str] = &[
    "admission_ambiguous",
    "native_status_unavailable",
    "native_session_busy",
    "message_not_observed",
    "message_id_conflict",
    "tool_pending_or_running",
    "assistant_not_terminal",
    "native_abort",
    "native_error",
    "native_terminal_incomplete",
    "continuation_ambiguous",
    "later_user_boundary",
    "final_response_not_observed",
    "session_identity_conflict",
    "session_directory_mismatch",
    "native_read_unavailable",
    "native_idle_incomplete",
    "tool_execution_after_server_crash",
    "dispatch_process_stopped",
];

/// The shared observation vocabulary has no `admitted` or `terminal_incomplete`
/// state; they finish like `running` and `error` in the source controller.
fn shared(observed: &native_session::PromptObservation) -> PromptObservation {
    PromptObservation {
        state: match observed.state {
            NativeState::Admitted | NativeState::Running => PromptState::Running,
            NativeState::Completed => PromptState::Completed,
            NativeState::TerminalIncomplete | NativeState::Error => PromptState::Error,
            NativeState::Interrupted => PromptState::Interrupted,
            NativeState::Unknown => PromptState::Unknown,
        },
        admission_observed: observed.admission == Admission::Observed,
        retry_allowed: observed.retry == Retry::Allowed,
        reason: observed
            .reason
            .as_deref()
            .and_then(|reason| REASONS.iter().find(|known| **known == reason).copied())
            .unwrap_or("native_turn_completed"),
        unsettled_tool_ids: observed.unsettled_tool_ids.clone().unwrap_or_default(),
        native_final_observed: observed.native_final_observed == Some(true),
        process_running: false,
        execution_uncertain: observed.execution_uncertain.is_some(),
    }
}

fn dispatch_state(dispatch: DispatchState) -> Dispatch {
    match dispatch {
        DispatchState::NotSubmitted => Dispatch::NotSubmitted,
        DispatchState::Ambiguous => Dispatch::Ambiguous,
    }
}

// ponytail: interns each distinct native provider name once; widen `UsageEntry.provider` to `String` to drop this.
fn provider_name(name: &str) -> &'static str {
    static NAMES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut names = NAMES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = names.iter().find(|known| **known == name) {
        return found;
    }
    let leaked: &'static str = Box::leak(name.to_owned().into_boxed_str());
    names.push(leaked);
    leaked
}

fn reader(session: &ReaderSession<'_>) -> OpenCodeSessionReader {
    OpenCodeSessionReader {
        database_path: session.database_path.to_owned(),
        executable: None,
    }
}

fn opencode_session<'a>(
    native: Option<&'a str>,
    id: &'a str,
    current: bool,
) -> OpenCodeReaderSession<'a> {
    OpenCodeReaderSession {
        id,
        native_session_id: native,
        current,
        kind: "",
    }
}

fn resolved(session: &ReaderSession<'_>) -> io::Result<Option<String>> {
    native_session_id(&session.runtime_directory()?, session.native_session_id)
}

/// Native messages from the live server, or the native export when the server is gone.
async fn messages(
    session_id: &str,
    database_path: &Path,
    native: &str,
) -> Result<Vec<Envelope>, BoxError> {
    let directory = crate::runtimes::native::session_directory(database_path, session_id)?;
    if let Some(reference) = server::read_server(&directory)?
        && let Ok(messages) = server::client(&reference)?
            .get_messages(native, Some(&reference.directory), None)
            .await
    {
        return Ok(messages);
    }
    read_history(native, None).await
}

impl NativeSessionReader for OpenCodeTaskRuntime {
    fn history<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<Value>>> {
        Box::pin(async move {
            let Some(native) = resolved(session)? else {
                return Ok(Vec::new());
            };
            reader(session)
                .history(&opencode_session(Some(&native), session.session_id, true))
                .await
                .map_err(io_error)
        })
    }

    fn execution<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<(Vec<NativeTool>, Value)>> {
        Box::pin(async move {
            let Some(native) = resolved(session)? else {
                return Ok((Vec::new(), Value::Null));
            };
            let reader = reader(session);
            let (execution, _) = match reader
                .execution(&opencode_session(Some(&native), session.session_id, true))
                .await
            {
                Ok(read) => read,
                Err(_) => reader
                    .execution(&opencode_session(Some(&native), session.session_id, false))
                    .await
                    .map_err(io_error)?,
            };
            Ok((execution.tools, json!(execution.plan)))
        })
    }

    fn reasoning<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<NativeReasoning>>> {
        Box::pin(async move {
            let Some(native) = resolved(session)? else {
                return Ok(Vec::new());
            };
            let messages = messages(session.session_id, session.database_path, &native)
                .await
                .map_err(io_error)?;
            Ok(session_reader::reasoning_from_messages(&messages))
        })
    }

    fn turn_evidence<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<Option<Vec<NativeTool>>>> {
        Box::pin(async move {
            let Some(native) = resolved(session)? else {
                return Ok(None);
            };
            let messages = messages(session.session_id, session.database_path, &native)
                .await
                .map_err(io_error)?;
            let correlated = correlated_assistants(&messages, turn_id);
            if !correlated.prompt_found {
                return Ok(None);
            }
            Ok(Some(
                session_reader::execution_from_messages(&correlated.messages)
                    .map_err(io_error)?
                    .tools,
            ))
        })
    }

    fn timeline<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        pricing: Option<&'a ModelPricingCatalog>,
    ) -> HarnessFuture<'a, io::Result<NativeTimeline>> {
        Box::pin(async move {
            let Some(native) = resolved(session)? else {
                return Ok(NativeTimeline::default());
            };
            let reader = reader(session);
            let timeline = match reader
                .timeline(
                    &opencode_session(Some(&native), session.session_id, true),
                    pricing,
                )
                .await
            {
                Ok(timeline) => timeline,
                Err(_) => reader
                    .timeline(
                        &opencode_session(Some(&native), session.session_id, false),
                        pricing,
                    )
                    .await
                    .map_err(io_error)?,
            };
            let number = |value: &Value| value.as_f64().unwrap_or_default();
            Ok(NativeTimeline {
                usage: timeline
                    .usage
                    .iter()
                    .map(|entry| UsageEntry {
                        message_id: entry["messageId"].as_str().unwrap_or_default().to_owned(),
                        turn_id: entry["turnId"].as_str().unwrap_or_default().to_owned(),
                        provider: provider_name(entry["provider"].as_str().unwrap_or_default()),
                        model: entry["model"].as_str().unwrap_or_default().to_owned(),
                        started_at_ms: number(&entry["startedAt"]) as i64,
                        completed_at_ms: entry["completedAt"].as_f64().map(|value| value as i64),
                        failed: entry["failed"] == true,
                        tokens: UsageTokens {
                            input: number(&entry["tokens"]["input"]),
                            output: number(&entry["tokens"]["output"]),
                            reasoning: number(&entry["tokens"]["reasoning"]),
                            cache_read: number(&entry["tokens"]["cache"]["read"]),
                            cache_write: number(&entry["tokens"]["cache"]["write"]),
                        },
                        cost_usd: number(&entry["cost"]),
                        subsidized: entry["subsidized"] == true,
                        summary: entry["summary"] == true,
                        steps: number(&entry["steps"]),
                        source: if entry["source"] == "steps" {
                            "steps"
                        } else {
                            "message"
                        },
                    })
                    .collect(),
                live_message_id: timeline.live_message_id,
            })
        })
    }

    fn busy<'a>(&'a self, session: &'a ReaderSession<'_>) -> HarnessFuture<'a, io::Result<bool>> {
        Box::pin(async move {
            let Some(reference) = server::read_server(&session.runtime_directory()?)? else {
                return Ok(false);
            };
            if !server::server_running(&reference) {
                return Ok(false);
            }
            let statuses = server::client(&reference)
                .map_err(io_error)?
                .get_status(Some(&reference.directory))
                .await
                .map_err(io_error)?;
            Ok(statuses.values().any(|status| status.kind() != "idle"))
        })
    }

    fn status<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<(&'static str, f64)>> {
        Box::pin(async move {
            let native =
                resolved(session)?.ok_or_else(|| io::Error::other("Session is not available"))?;
            reader(session)
                .status(&opencode_session(Some(&native), session.session_id, true))
                .await
                .map_err(io_error)
        })
    }
}

impl TaskHarness for OpenCodeTaskRuntime {
    // OpenCode names its own sessions; `dispatch` pairs this reservation with one.
    fn new_session_id(&self) -> String {
        format!("opencode-{}", uuid::Uuid::new_v4())
    }

    /// A dead server, such as after a machine restart, is started again here.
    fn ensure_session<'a>(
        &'a self,
        scope: &'a TaskScope<'_>,
    ) -> HarnessFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            ensure_session(scope).await.map_err(io_error)?;
            Ok(())
        })
    }

    fn observe<'a>(
        &'a self,
        session: SessionRef<'a>,
        turn_id: &'a str,
        dispatch: DispatchState,
        generation: Option<&'a str>,
    ) -> HarnessFuture<'a, io::Result<PromptObservation>> {
        Box::pin(async move {
            let observed = observe_native(
                session.directory,
                session.native_session_id,
                turn_id,
                dispatch_state(dispatch),
                generation,
            )
            .await
            .map_err(io_error)?;
            Ok(shared(&observed))
        })
    }

    fn dispatch<'a>(
        &'a self,
        scope: &'a TaskScope<'_>,
        turn_id: &'a str,
        prompt: &'a str,
        claim: DispatchClaim<'a>,
    ) -> HarnessFuture<'a, Result<PromptObservation, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let directory = scope.runtime_directory()?;
            let native = ensure_session(scope).await.map_err(io_error)?;
            let (_, agent, _, system) = role_parts(scope.role, scope.workflow);
            let intent = PromptIntent {
                session_id: native,
                message_id: turn_id.to_owned(),
                directory: scope.worktree.to_string_lossy().into_owned(),
                prompt: prompt.to_owned(),
                system: Some(system.to_owned()),
                prompt_hash: sha256_hex(prompt.as_bytes()),
                model: open_code_model(scope.model)?,
                agent: agent.to_owned(),
                variant: scope.reasoning_effort.to_owned(),
                dispatch: Dispatch::NotSubmitted,
            };
            crate::shared::fs::write_private(
                &intent_path(&directory, turn_id)?,
                &serde_json::to_vec(&intent)?,
            )?;
            let reference =
                server::read_server(&directory)?.ok_or("OpenCode server reference is missing")?;
            crate::shared::fs::write_private(
                &directory.join(format!("dispatch-server-{}.json", reference.generation)),
                &serde_json::to_vec(&reference)?,
            )?;
            let client = server::client(&reference)?;
            if reconcile(&client, &intent).await.retry != Retry::Allowed {
                return Err(ReplayBlocked(
                    "OpenCode prompt was not proven absent; replay is blocked",
                )
                .into());
            }
            if !claim(&reference.generation)? {
                return Err(ReplayBlocked("OpenCode prompt replay claim was not acquired").into());
            }
            PromptPort::prompt_async(&client, &intent)
                .await
                .map_err(io_error)?;
            let ambiguous = PromptIntent {
                dispatch: Dispatch::Ambiguous,
                ..intent
            };
            let observed = reconcile(&client, &ambiguous).await;
            Ok(shared(&observed))
        })
    }

    fn recover_dispatch<'a>(
        &'a self,
        session: SessionRef<'a>,
        turn_id: &'a str,
        generation: &'a str,
    ) -> HarnessFuture<'a, io::Result<PromptObservation>> {
        Box::pin(async move {
            let (directory, native_session_id) = (session.directory, session.native_session_id);
            let observed = match turn_context(
                directory,
                native_session_id,
                turn_id,
                Dispatch::NotSubmitted,
            )
            .await
            .map_err(io_error)?
            {
                Some((_, intent)) => recover_native(directory, &intent, generation)
                    .await
                    .map_err(io_error)?,
                None => unsubmitted(native_session_id, turn_id, Dispatch::NotSubmitted),
            };
            Ok(shared(&observed))
        })
    }

    fn result_text<'a>(
        &'a self,
        directory: &'a Path,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<String>> {
        Box::pin(async move {
            let intent = read_intent(directory, turn_id)?
                .ok_or_else(|| io::Error::other("OpenCode turn intent is missing"))?;
            let reference = server::read_server(directory)
                .map_err(io_error)?
                .ok_or_else(|| io::Error::other("OpenCode server reference is missing"))?;
            let messages = server::client(&reference)
                .map_err(io_error)?
                .get_messages(&intent.session_id, Some(&intent.directory), None)
                .await
                .map_err(io_error)?;
            let observed = reconcile(&server::client(&reference).map_err(io_error)?, &intent).await;
            Ok(observed
                .assistant_message_id
                .and_then(|id| messages.iter().find(|message| message.info.id() == id))
                .map(|message| text(message, "\n"))
                .unwrap_or_default())
        })
    }

    fn native<'a>(
        &'a self,
        directory: &'a Path,
        turn_id: &'a str,
        base: Value,
    ) -> HarnessFuture<'a, io::Result<Value>> {
        Box::pin(async move {
            let Some(intent) = read_intent(directory, turn_id)? else {
                return Ok(base);
            };
            let reference = server::read_server(directory)
                .map_err(io_error)?
                .ok_or_else(|| io::Error::other("OpenCode server reference is missing"))?;
            let observed = reconcile(&server::client(&reference).map_err(io_error)?, &intent).await;
            match observed.native {
                Some(native) => serde_json::to_value(native).map_err(io::Error::other),
                None => Ok(base),
            }
        })
    }

    fn stop<'a>(
        &'a self,
        directory: &'a Path,
        reserved: Option<&'a str>,
    ) -> HarnessFuture<'a, io::Result<()>> {
        Box::pin(async move {
            let Some(reference) = server::read_server(directory)? else {
                return headless::stop_session(directory, None);
            };
            let native = match reserved {
                Some(reserved) => native_session_id(directory, reserved)?,
                None => None,
            };
            if let Some(native) = native
                && server::server_running(&reference)
            {
                let client = server::client(&reference).map_err(io_error)?;
                client
                    .abort_session(&native, &reference.directory)
                    .await
                    .map_err(io_error)?;
                let status = client
                    .get_status(Some(&reference.directory))
                    .await
                    .map_err(io_error)?;
                if status
                    .get(&native)
                    .is_some_and(|status| status.kind() != "idle")
                {
                    return Err(io::Error::other("OpenCode session has not stopped"));
                }
            }
            server::stop_server(&reference)?;
            headless::stop_session(directory, None)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::opencode::{client::fake, server::tests::temporary};
    use crate::runtimes::task_harness::WorkerPurpose;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn io_error_keeps_the_native_error_for_callers_that_classify_it() {
        let error = io_error(
            Box::new(crate::runtimes::opencode::session_history::SessionNotFound) as BoxError,
        );
        assert!(error.get_ref().is_some_and(|source| {
            source.is::<crate::runtimes::opencode::session_history::SessionNotFound>()
        }));
    }

    #[test]
    fn display_attachment_matches_only_this_server_session_and_directory() {
        let reference: ServerReference = serde_json::from_value(json!({"pid":1,"baseUrl":"http://127.0.0.1:1234","password":"a".repeat(64),"directory":"/repo","executable":"/bin/opencode","generation":"b775df17-718a-4cb2-8e23-6912b8aa0d39","configHash":"a".repeat(64),"processIdentity":{"command":"opencode","executable":"/bin/opencode","argv":[],"processGroup":1,"startTime":"s","ownerUid":501}})).unwrap();
        let args = |url: &str, session: &str| -> Vec<String> {
            [
                "/bin/opencode",
                "attach",
                url,
                "--dir",
                "/repo",
                "--session",
                session,
            ]
            .map(str::to_owned)
            .to_vec()
        };
        assert!(display_attached(
            &reference,
            "ses_proof",
            &args("http://127.0.0.1:1234", "ses_proof")
        ));
        assert!(!display_attached(
            &reference,
            "ses_proof",
            &args("http://127.0.0.1:1233", "ses_proof")
        ));
        assert!(!display_attached(
            &reference,
            "ses_proof",
            &args("http://127.0.0.1:1234", "ses_other")
        ));
    }

    #[test]
    fn role_prompts_keep_the_coordinator_review_and_delivery_contract() {
        let (_, agent, _, prompt) = role_parts(
            TaskRole::Worker(WorkerPurpose::Verification),
            WorkflowLaunch::default(),
        );
        assert_eq!(agent, "suplex-worker");
        assert!(prompt.starts_with("You are Suplex's verification Worker."));
        const ROOT_STANDARD: &str = crate::runtimes::codex::role_prompt::ROOT_STANDARD;
        let rater = WorkflowLaunch {
            advisor: Some(crate::coordination::advisor_bridge::AdvisorRole::Rater),
            ..WorkflowLaunch::default()
        };
        let (kind, agent, label, prompt) =
            role_parts(TaskRole::Worker(WorkerPurpose::Implementation), rater);
        assert_eq!(
            (kind, agent, label),
            (RoleKind::Advisor, "suplex-advisor", "Rater")
        );
        assert_eq!(
            prompt,
            crate::coordination::root_prompts::ADVISOR_ROLE_PROMPT
        );
        assert!(ROOT_STANDARD.contains("Delegate one coherent functional assignment"));
        assert!(ROOT_STANDARD.contains("independent reviewer"));
        assert!(
            ROOT_STANDARD.contains(
                "generate a concise action-oriented title from the final reviewed solution"
            )
        );
        assert!(ROOT_STANDARD.contains("Supply it as pullRequestTitle"));
        assert!(ROOT_STANDARD.contains("pullRequestBody"));
    }

    #[tokio::test]
    async fn an_unpaired_reservation_has_no_native_prompt_and_a_native_identity_is_used_as_is() {
        let directory = temporary("opencode-pairing");
        assert_eq!(native_session_id(&directory, "opencode-1").unwrap(), None);
        assert_eq!(
            native_session_id(&directory, "ses_x").unwrap().as_deref(),
            Some("ses_x")
        );
        fs::write(
            directory.join(SESSION_BINDING),
            r#"{"reserved":"opencode-1","sessionID":"ses_paired"}"#,
        )
        .unwrap();
        assert_eq!(
            native_session_id(&directory, "opencode-1")
                .unwrap()
                .as_deref(),
            Some("ses_paired")
        );
        assert_eq!(native_session_id(&directory, "opencode-2").unwrap(), None);
        let observed = OpenCodeTaskRuntime
            .observe(
                SessionRef {
                    directory: &directory,
                    native_session_id: "opencode-2",
                },
                "msg_1",
                DispatchState::NotSubmitted,
                None,
            )
            .await
            .unwrap();
        assert!(observed.retry_allowed && !observed.admission_observed);
        let ambiguous = OpenCodeTaskRuntime
            .observe(
                SessionRef {
                    directory: &directory,
                    native_session_id: "opencode-2",
                },
                "msg_1",
                DispatchState::Ambiguous,
                None,
            )
            .await
            .unwrap();
        assert!(!ambiguous.retry_allowed);
        assert_eq!(
            OpenCodeTaskRuntime
                .new_session_id()
                .split_once('-')
                .unwrap()
                .0,
            "opencode"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn ensure_session_restarts_a_lost_server_and_keeps_the_native_session() {
        use std::os::unix::fs::PermissionsExt;
        let base = temporary("opencode-ensure");
        let worktree = base.join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        let executable = base.join("opencode");
        fs::write(
            &executable,
            format!(
                r#"#!{}
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const session = {{ id: "ses_kept", projectID: "project", directory: process.cwd(), title: "Kept", version: "1", time: {{ created: 1, updated: 1 }} }};
const server = http.createServer((request, response) => {{
  response.setHeader("content-type", "application/json");
  if (request.url.startsWith("/global/health")) response.end(JSON.stringify({{ healthy: true, version: "test" }}));
  else if (request.url.startsWith("/session/status")) response.end("{{}}");
  else if (request.url.startsWith("/session")) response.end(JSON.stringify(session));
  else {{ response.statusCode = 404; response.end("{{}}"); }}
}});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
"#,
                crate::runtimes::opencode::server::tests::node()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let inherited: std::collections::HashMap<String, String> = std::env::vars().collect();
        let empty = std::collections::HashMap::new();
        let database = base.join("suplex.sqlite");
        let scope = TaskScope {
            workflow: WorkflowLaunch::default(),
            database_path: &database,
            artifact_root: &base,
            task_id: "task-opencode",
            session_id: "session-opencode",
            native_session_id: "opencode-reserved",
            role: TaskRole::Worker(WorkerPurpose::Implementation),
            worktree: &worktree,
            model: "openai/test",
            reasoning_effort: "medium",
            instance_home_directory: None,
            project_mcp: None,
            project_context_path: None,
            project_environment: &empty,
            excluded_environment_keys: &[],
            executable: Some(&executable),
            inherited_environment: &inherited,
        };
        OpenCodeTaskRuntime.ensure_session(&scope).await.unwrap();
        let runtime = scope.runtime_directory().unwrap();
        let first = server::read_server(&runtime).unwrap().unwrap();
        assert_eq!(
            native_session_id(&runtime, "opencode-reserved")
                .unwrap()
                .as_deref(),
            Some("ses_kept")
        );
        // The machine restarted: the recorded server is gone.
        server::stop_server(&first).unwrap();
        assert!(!server::server_running(&first));
        OpenCodeTaskRuntime.ensure_session(&scope).await.unwrap();
        let restarted = server::read_server(&runtime).unwrap().unwrap();
        assert_ne!(restarted.generation, first.generation);
        assert!(server::server_running(&restarted));
        assert_eq!(
            native_session_id(&runtime, "opencode-reserved")
                .unwrap()
                .as_deref(),
            Some("ses_kept")
        );
        server::stop_server(&restarted).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    fn reference_json(
        pid: u32,
        url: &str,
        generation: &str,
        directory: &str,
        password: char,
    ) -> Value {
        json!({"pid":pid,"baseUrl":url,"password":password.to_string().repeat(64),"directory":directory,"executable":"/old-opencode","generation":generation,"configHash":"a".repeat(64),"processIdentity":{"command":"opencode serve","executable":"/old-opencode","argv":["opencode","serve"],"processGroup":pid,"startTime":"old-start","ownerUid":501}})
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispatch_fencing_retains_the_replacement_server_and_reads_native_history() {
        for evidence in [
            "absent",
            "admitted",
            "tool_running",
            "tool_error",
            "busy",
            "bad_history",
            "bad_status",
        ] {
            let directory = temporary("dispatch-fence");
            let worktree = directory.to_string_lossy().into_owned();
            let session_id = "ses_fence";
            let intent = PromptIntent {
                dispatch: Dispatch::Ambiguous,
                ..native_session::create_prompt_intent(
                    session_id,
                    &worktree,
                    "Do one operation",
                    open_code_model("openai/test").unwrap(),
                    "suplex-worker",
                    "medium",
                )
            };
            let posts = Arc::new(AtomicUsize::new(0));
            let counted = posts.clone();
            let (message, prompt, root) = (
                intent.message_id.clone(),
                intent.prompt.clone(),
                worktree.clone(),
            );
            let (url, _) = fake::serve(move |request| {
                if request.method != "GET" {
                    counted.fetch_add(1, Ordering::SeqCst);
                }
                let result = match request.path.as_str() {
                    "/session/ses_fence" => json!({"id":session_id,"projectID":"project","directory":root,"title":"Retained","version":"1","time":{"created":1,"updated":1}}),
                    "/session/ses_fence/message" => match evidence {
                        "bad_history" => json!([{}]),
                        "admitted" | "tool_running" | "tool_error" => {
                            let mut messages = vec![json!({"info":{"id":message,"sessionID":session_id,"role":"user","time":{"created":1},"model":{"providerID":"openai","modelID":"test"},"agent":"suplex-worker"},"parts":[{"type":"text","text":prompt}]})];
                            if evidence != "admitted" {
                                let mut info = json!({"id":"msg_assistant","sessionID":session_id,"role":"assistant","parentID":message,"time":{"created":2},"modelID":"test","providerID":"openai","mode":"suplex-worker","agent":"suplex-worker","path":{"cwd":root,"root":root},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}});
                                if evidence == "tool_error" {
                                    info["error"] = json!({"name":"MessageAbortedError"});
                                }
                                let status = if evidence == "tool_error" { "error" } else { "running" };
                                messages.push(json!({"info":info,"parts":[{"type":"tool","callID":"call_probe","tool":"bash","state":{"status":status}}]}));
                            }
                            Value::Array(messages)
                        }
                        _ => json!([]),
                    },
                    "/session/status" => match evidence {
                        "bad_status" => json!({session_id:{"type":"unrecognized"}}),
                        "busy" => json!({session_id:{"type":"busy"}}),
                        _ => json!({}),
                    },
                    _ => return (404, String::new()),
                };
                (200, result.to_string())
            })
            .await;
            let runtime = directory.join("runtime/task-sessions/session-proof");
            fs::create_dir_all(&runtime).unwrap();
            let old = "b775df17-718a-4cb2-8e23-6912b8aa0d39";
            let replacement = "c775df17-718a-4cb2-8e23-6912b8aa0d39";
            fs::write(
                runtime.join(format!("dispatch-server-{old}.json")),
                reference_json(2_147_483_647, "http://127.0.0.1:1", old, &worktree, 'a')
                    .to_string(),
            )
            .unwrap();
            fs::write(
                runtime.join("server.json"),
                reference_json(2_147_483_646, &url, replacement, &worktree, 'b').to_string(),
            )
            .unwrap();
            for _ in 0..2 {
                let result = recover_native(&runtime, &intent, old).await.unwrap();
                assert_eq!(
                    result.retry == Retry::Allowed,
                    evidence == "absent",
                    "{evidence}"
                );
                if evidence == "admitted" {
                    assert_eq!(result.admission, Admission::Observed);
                }
                if evidence.starts_with("tool_") {
                    assert_eq!(result.state, NativeState::Unknown, "{evidence}");
                    assert_eq!(
                        result
                            .execution_uncertain
                            .as_ref()
                            .unwrap()
                            .stopped_server_generation,
                        old
                    );
                }
                assert_eq!(result.session_id, session_id);
                assert_eq!(
                    server::read_server(&runtime).unwrap().unwrap().generation,
                    replacement
                );
            }
            assert_eq!(posts.load(Ordering::SeqCst), 0);
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
