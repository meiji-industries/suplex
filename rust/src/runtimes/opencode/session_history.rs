//! Retired native sessions read through `opencode export`, without a running server.

use std::{path::Path, process::Stdio, time::Duration};

use serde_json::Value;

use super::{contracts::Envelope, server::resolve_executable, session::BoxError};

async fn export(session_id: &str, executable: Option<&Path>) -> Option<Vec<u8>> {
    let executable = resolve_executable(executable).ok()?;
    let output = tokio::process::Command::new(executable)
        .args(["export", "--pure", session_id])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(30), output)
        .await
        .ok()?
        .ok()?;
    output.status.success().then_some(output.stdout)
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
    let stdout = export(session_id, executable)
        .await
        .ok_or("OpenCode session history is not available")?;
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
