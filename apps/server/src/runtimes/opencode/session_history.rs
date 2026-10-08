//! Retired native sessions read through `opencode export`, without a running server.

use std::{path::Path, process::Stdio, time::Duration};

use serde_json::Value;

use super::{contracts::Envelope, server::resolve_executable, session::BoxError};

/// TypeScript `OpenCodeFailure` with code `not_found`: OpenCode no longer has the session.
#[derive(Debug)]
pub struct SessionNotFound;

impl std::fmt::Display for SessionNotFound {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OpenCode session history is not available")
    }
}

impl std::error::Error for SessionNotFound {}

async fn export(session_id: &str, executable: Option<&Path>) -> Result<Vec<u8>, BoxError> {
    let unavailable = || -> BoxError { "OpenCode session history is not available".into() };
    let executable = resolve_executable(executable).map_err(|_| unavailable())?;
    let output = tokio::process::Command::new(executable)
        .args(["export", "--pure", session_id])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(30), output)
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    // `opencode export` reports a deleted or unknown session only on stderr.
    if String::from_utf8_lossy(&output.stderr).contains("Session not found") {
        return Err(Box::new(SessionNotFound));
    }
    Err(unavailable())
}

pub async fn read_history(
    session_id: &str,
    executable: Option<&Path>,
) -> Result<Vec<Envelope>, BoxError> {
    let valid = session_id.strip_prefix("ses_").is_some_and(|rest| {
        !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
    });
    if !valid {
        return Err("Invalid OpenCode session identity".into());
    }
    let stdout = export(session_id, executable).await?;
    let mut exported: Value = serde_json::from_slice(&stdout)?;
    let id = exported["info"]["id"]
        .as_str()
        .ok_or("OpenCode export is invalid")?
        .to_owned();
    let messages = Envelope::parse_all(exported["messages"].take())?;
    if id != session_id
        || messages
            .iter()
            .any(|message| message.info.session_id() != session_id)
    {
        return Err("OpenCode returned history for another session".into());
    }
    Ok(messages)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    /// A fake `opencode` that prints `export` as the native export of `ses_old`.
    pub(crate) fn exporter(directory: &Path, export: &Value) -> PathBuf {
        fs::write(directory.join("export.json"), export.to_string()).unwrap();
        let executable = directory.join("opencode");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\n[ \"$1 $2 $3\" = 'export --pure ses_old' ] || exit 9\ncat '{}'\n",
                directory.join("export.json").display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        executable
    }

    pub(crate) fn retired_message() -> Value {
        serde_json::json!({"info":{"id":"msg_result","sessionID":"ses_old","role":"assistant","time":{"created":100,"completed":200},"parentID":"msg_user","modelID":"model","providerID":"openai","mode":"primary","agent":"suplex-worker","path":{"cwd":"/repo","root":"/repo"},"cost":3,"tokens":{"input":10,"output":20,"reasoning":30,"cache":{"read":40,"write":50}}},"parts":[]})
    }

    #[tokio::test]
    async fn a_session_opencode_no_longer_has_is_not_found_and_other_failures_are_not() {
        let directory = crate::runtimes::opencode::server::tests::temporary("opencode-missing");
        let executable = directory.join("opencode");
        fs::write(
            &executable,
            "#!/bin/sh\necho 'Exporting session: ses_gone' >&2\necho 'Error: Session not found: ses_gone' >&2\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let missing = read_history("ses_gone", Some(&executable))
            .await
            .unwrap_err();
        assert!(missing.is::<SessionNotFound>());
        assert_eq!(
            missing.to_string(),
            "OpenCode session history is not available"
        );
        fs::write(
            &executable,
            "#!/bin/sh\necho 'Error: database is locked' >&2\nexit 1\n",
        )
        .unwrap();
        let failed = read_history("ses_gone", Some(&executable))
            .await
            .unwrap_err();
        assert!(!failed.is::<SessionNotFound>());
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn an_export_from_another_session_cannot_replace_spend_history() {
        let directory = crate::runtimes::opencode::server::tests::temporary("opencode-export");
        let executable = exporter(
            &directory,
            &serde_json::json!({"info":{"id":"ses_other"},"messages":[retired_message()]}),
        );
        let error = read_history("ses_old", Some(&executable))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("another session"));
        assert_eq!(
            read_history("ses_bad; rm", Some(&executable))
                .await
                .unwrap_err()
                .to_string(),
            "Invalid OpenCode session identity"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn native_machine_output_survives_an_immediate_process_exit_after_a_large_write() {
        let directory = crate::runtimes::opencode::server::tests::temporary("opencode-large");
        let mut message = retired_message();
        message["parts"] = serde_json::json!([{"type":"text","text":"x".repeat(200_000)}]);
        let executable = exporter(
            &directory,
            &serde_json::json!({"info":{"id":"ses_old"},"messages":[message]}),
        );
        let messages = read_history("ses_old", Some(&executable)).await.unwrap();
        assert_eq!(
            messages[0].raw["parts"][0]["text"].as_str().unwrap().len(),
            200_000
        );
        fs::write(&executable, "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(
            read_history("ses_old", Some(&executable))
                .await
                .unwrap_err()
                .to_string(),
            "OpenCode session history is not available"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
