use std::collections::HashMap;

use crate::coordination::bridge_auth::{
    ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV, ROOT_TOKEN_ENV,
};

/// Build one native task process environment. A recovered task must not inherit
/// another task's bridge capability from the API process environment.
pub fn task_bridge_environment(
    inherited: &HashMap<String, String>,
    server: Option<&HashMap<String, String>>,
    additions: &HashMap<String, String>,
) -> HashMap<String, String> {
    let blocked = [
        ROOT_BINDING_ENV,
        ROOT_TOKEN_ENV,
        ADVISOR_BINDING_ENV,
        ADVISOR_TOKEN_ENV,
        ADVISOR_RESULT_ENV,
    ];
    let mut clean = inherited
        .iter()
        .filter(|(name, _)| !blocked.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<HashMap<_, _>>();
    if let Some(server) = server {
        clean.extend(
            server
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
    }
    clean.extend(
        additions
            .iter()
            .map(|(name, value)| (name.clone(), value.clone())),
    );
    clean
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::headless::{self, DispatchInput};
    use std::{path::Path, process::Command, thread, time::Duration};

    #[test]
    fn task_environment_removes_stale_bridge_capabilities_then_applies_current_binding() {
        let inherited = HashMap::from([
            ("PATH".into(), "/bin".into()),
            (ROOT_TOKEN_ENV.into(), "old-root-token".into()),
            (ADVISOR_RESULT_ENV.into(), "old-result".into()),
        ]);
        let server = HashMap::from([
            (ADVISOR_TOKEN_ENV.into(), "current-token".into()),
            (ADVISOR_BINDING_ENV.into(), "/current/binding".into()),
        ]);
        let additions = HashMap::from([("PATH".into(), "/guard:/bin".into())]);
        let result = task_bridge_environment(&inherited, Some(&server), &additions);
        assert_eq!(result.get("PATH").map(String::as_str), Some("/guard:/bin"));
        assert_eq!(
            result.get(ADVISOR_TOKEN_ENV).map(String::as_str),
            Some("current-token")
        );
        assert_eq!(
            result.get(ADVISOR_BINDING_ENV).map(String::as_str),
            Some("/current/binding")
        );
        assert!(!result.contains_key(ROOT_TOKEN_ENV));
        assert!(!result.contains_key(ADVISOR_RESULT_ENV));
    }

    #[test]
    fn detached_child_receives_only_its_current_bridge_capability() {
        if std::env::var_os("SUPLEX_HARNESS_ENV_PROBE").is_none() {
            let result = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtimes::task_harness::tests::detached_child_receives_only_its_current_bridge_capability",
                    "--nocapture",
                ])
                .env("SUPLEX_HARNESS_ENV_PROBE", "1")
                .env(ROOT_TOKEN_ENV, "stale-root-capability")
                .output()
                .unwrap();
            assert!(result.status.success(), "nested test failed");
            return;
        }

        let directory =
            std::env::temp_dir().join(format!("suplex-bridge-env-{}", uuid::Uuid::new_v4()));
        let inherited = std::env::vars().collect::<HashMap<_, _>>();
        let server = HashMap::from([(ADVISOR_TOKEN_ENV.to_owned(), "current-token".to_owned())]);
        let environment = task_bridge_environment(&inherited, Some(&server), &HashMap::new());
        let args = vec![
            "-c".to_owned(),
            "test -z \"$SUPLEX_ROOT_TOKEN\" && test \"$SUPLEX_ADVISOR_TOKEN\" = current-token"
                .to_owned(),
        ];
        headless::dispatch(
            DispatchInput {
                directory: &directory,
                worktree: Path::new("/tmp"),
                session_id: "bridge-env-session",
                turn_id: "bridge-env-turn",
                executable: Path::new("/bin/sh"),
                args: &args,
                prompt: "probe",
                environment: &environment,
            },
            |_| Ok(true),
        )
        .unwrap();
        let exit_file = headless::turn_file(&directory, "bridge-env-turn", "exit");
        for _ in 0..40 {
            if let Ok(status) = std::fs::read_to_string(&exit_file) {
                assert_eq!(status.trim(), "0");
                std::fs::remove_dir_all(&directory).unwrap();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("bridge probe child did not finish");
    }
}
