//! Provider sign-in state in the provider listing vocabulary.

use serde_json::{Map, Value, json};

use super::provider_readiness::{self, ProbeResult, strip_ansi};

/// Maps a health-check outcome onto the provider sign-in vocabulary.
pub fn connection_from_health(check: &Value) -> Value {
    let status = match check["status"].as_str() {
        Some("healthy") => "connected",
        Some("unhealthy") => "not-connected",
        _ => "unknown",
    };
    let mut connection = Map::new();
    connection.insert("status".into(), json!(status));
    connection.insert("summary".into(), check["summary"].clone());
    if status == "connected"
        && let Some(account) = check["details"]["account"].as_str()
    {
        connection.insert("account".into(), json!(account));
    }
    Value::Object(connection)
}

/// `devin auth status` prints "Logged in (via …)" details or reports that no
/// credentials exist.
pub fn classify_devin_auth_status(result: &ProbeResult) -> Value {
    let output = strip_ansi(&format!("{}\n{}", result.stdout, result.stderr)).to_lowercase();
    let signed_out = [
        "not logged in",
        "logged out",
        "unauthenticated",
        "no credentials",
    ];
    if signed_out.iter().any(|phrase| output.contains(phrase)) {
        json!({"status":"not-connected","summary":"Devin CLI is not signed in"})
    } else if result.timed_out {
        json!({"status":"unknown","summary":"The Devin CLI sign-in check timed out"})
    } else if output.contains("logged in") {
        json!({"status":"connected","summary":"Devin CLI is signed in. Model access is not tested."})
    } else {
        json!({"status":"unknown","summary":"Suplex could not check the Devin CLI sign-in"})
    }
}

async fn devin_connection() -> Value {
    let missing = json!({"status":"not-connected","summary":"Devin CLI is not installed"});
    let Ok(executable) = provider_readiness::resolve_executable("devin") else {
        return missing;
    };
    match provider_readiness::probe_command(&executable, &["auth", "status"], None).await {
        Ok(result) => classify_devin_auth_status(&result),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing,
        Err(_) => {
            json!({"status":"unknown","summary":"Suplex could not check the Devin CLI sign-in"})
        }
    }
}

/// One sign-in probe for a harness kind. The Claude Code probe reports the
/// signed-in account for the provider listing.
// No per-listing memo; a listing calls this once per kind. Add a shared pending map if two callers race.
pub async fn provider_connection(kind: &str) -> Value {
    match kind {
        "devin" => devin_connection().await,
        "claude-code" => connection_from_health(&provider_readiness::check(kind, None, true).await),
        _ => connection_from_health(&provider_readiness::check(kind, None, false).await),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(stdout: &str, timed_out: bool) -> ProbeResult {
        ProbeResult {
            stdout: stdout.into(),
            exit_code: Some(0),
            timed_out,
            ..ProbeResult::default()
        }
    }

    #[test]
    fn health_maps_onto_the_sign_in_vocabulary() {
        assert_eq!(
            connection_from_health(
                &json!({"status":"healthy","summary":"Signed in","details":{"account":"person@example.com"}})
            ),
            json!({"status":"connected","summary":"Signed in","account":"person@example.com"})
        );
        assert_eq!(
            connection_from_health(
                &json!({"status":"unhealthy","summary":"Not signed in","details":{"account":"x"}})
            ),
            json!({"status":"not-connected","summary":"Not signed in"})
        );
        assert_eq!(
            connection_from_health(&json!({"status":"warning","summary":"?"}))["status"],
            "unknown"
        );
    }

    #[test]
    fn devin_auth_status_is_classified_from_its_output() {
        assert_eq!(
            classify_devin_auth_status(&said("\x1b[1mLogged in\x1b[0m (via browser)", false))["status"],
            "connected"
        );
        assert_eq!(
            classify_devin_auth_status(&said("Not logged in", false))["status"],
            "not-connected"
        );
        assert_eq!(
            classify_devin_auth_status(&said("", true))["summary"],
            "The Devin CLI sign-in check timed out"
        );
        assert_eq!(
            classify_devin_auth_status(&said("???", false))["status"],
            "unknown"
        );
    }
}
