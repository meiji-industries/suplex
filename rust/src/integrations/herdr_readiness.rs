//! Herdr host readiness. Only a spawn "not found" proves the CLI is absent;
//! timeouts and other failures are ambiguous.

use std::{collections::HashMap, time::Duration};

use serde_json::{Map, Value, json};

use super::herdr::Herdr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Ok(String),
    Missing,
    Ambiguous,
}

struct ServerDiagnostic {
    server_version: Value,
    private_protocol: Value,
    private_compatibility: &'static str,
    endpoint_compatibility: &'static str,
}

fn compatibility(value: Option<&Value>) -> &'static str {
    match value {
        Some(Value::Bool(true)) => "compatible",
        Some(Value::Bool(false)) => "incompatible",
        Some(Value::String(text)) if text == "yes" || text == "true" => "compatible",
        Some(Value::String(text)) if text == "no" || text == "false" => "incompatible",
        _ => "unknown",
    }
}

fn parse_text_status(raw: &str) -> Option<ServerDiagnostic> {
    let line = regex::Regex::new(r"^([a-z_]+):\s*(.*?)\s*$").expect("status line pattern");
    let fields = raw
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|text| {
            let found = line.captures(text)?;
            Some((found[1].to_owned(), found[2].to_owned()))
        })
        .collect::<HashMap<_, _>>();
    let version = fields
        .get("version")
        .filter(|version| !version.is_empty())?;
    let protocol = fields
        .get("private_protocol")
        .or_else(|| fields.get("protocol"))?;
    let protocol = if protocol.is_empty() {
        0.0
    } else {
        protocol.parse::<f64>().ok()?
    };
    if protocol.fract() != 0.0 || protocol < 0.0 {
        return None;
    }
    let private = fields
        .get("private_protocol_compatible")
        .or_else(|| fields.get("compatible"))?;
    Some(ServerDiagnostic {
        server_version: json!(version),
        private_protocol: json!(protocol as u64),
        private_compatibility: compatibility(Some(&json!(private))),
        endpoint_compatibility: compatibility(
            fields
                .get("endpoint_compatible")
                .map(|value| json!(value))
                .as_ref(),
        ),
    })
}

fn parse_server_status(raw: &str) -> Option<ServerDiagnostic> {
    let status = serde_json::from_str::<Value>(raw).ok().filter(|status| {
        let typed = |key: &str, valid: fn(&Value) -> bool| status.get(key).is_none_or(valid);
        status.is_object()
            && typed("status", Value::is_string)
            && typed("running", Value::is_boolean)
            && typed("version", |value| {
                value.as_str().is_some_and(|text| !text.is_empty())
            })
            && typed("protocol", |value| value.as_u64().is_some())
            && typed("compatible", Value::is_boolean)
            && typed("endpoint_compatible", |value| {
                value.is_boolean() || value.is_null()
            })
    });
    let Some(status) = status else {
        return parse_text_status(raw);
    };
    if status["running"] == false
        || status["status"]
            .as_str()
            .is_some_and(|value| value != "running")
    {
        return None;
    }
    if status["version"].is_null() || status["protocol"].is_null() || status["compatible"].is_null()
    {
        return None;
    }
    Some(ServerDiagnostic {
        server_version: status["version"].clone(),
        private_protocol: status["protocol"].clone(),
        private_compatibility: compatibility(status.get("compatible")),
        endpoint_compatibility: compatibility(status.get("endpoint_compatible")),
    })
}

fn client_version(raw: &str) -> String {
    regex::Regex::new(r"\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b")
        .expect("version pattern")
        .find(raw)
        .map_or_else(|| "unknown".to_owned(), |found| found.as_str().to_owned())
}

fn check(status: &str, summary: &str, details: Value, remedy: Option<&str>) -> Value {
    let mut check = Map::new();
    check.insert("id".into(), json!("herdr-readiness"));
    check.insert("label".into(), json!("Herdr"));
    check.insert("status".into(), json!(status));
    check.insert("summary".into(), json!(summary));
    if let Some(remedy) = remedy {
        check.insert("remedy".into(), json!(remedy));
    }
    check.insert("details".into(), details);
    Value::Object(check)
}

fn with_failure(details: &Value, failure: &str) -> Value {
    let mut details = details.clone();
    details["failure"] = json!(failure);
    details
}

/// Classifies the three observations into the public health check.
pub fn evaluate(version: Probe, status: Probe, api_reachable: bool) -> Value {
    if version == Probe::Missing {
        return check(
            "unhealthy",
            "Herdr is not installed",
            json!({"cliPresent": false, "apiReachable": api_reachable}),
            // Source: https://herdr.dev install script.
            Some("curl -fsSL https://herdr.dev/install.sh | sh"),
        );
    }
    let client = match &version {
        Probe::Ok(stdout) => client_version(stdout),
        Probe::Missing | Probe::Ambiguous => "unknown".to_owned(),
    };
    let server = match &status {
        Probe::Ok(stdout) => parse_server_status(stdout),
        Probe::Missing | Probe::Ambiguous => None,
    };
    let diagnostic = server.as_ref();
    let details = json!({
        "apiReachable": api_reachable,
        "cliPresent": if matches!(version, Probe::Ok(_)) { json!(true) } else { json!("unknown") },
        "clientVersion": client,
        "serverVersion": diagnostic.map_or(json!("unknown"), |server| server.server_version.clone()),
        "privateProtocol": diagnostic.map_or(json!("unknown"), |server| server.private_protocol.clone()),
        "privateProtocolCompatibility": diagnostic.map_or("unknown", |server| server.private_compatibility),
        "endpointCompatibility": diagnostic.map_or("unknown", |server| server.endpoint_compatibility),
    });
    if !api_reachable {
        if version == Probe::Ambiguous && !matches!(status, Probe::Ok(_)) {
            return check(
                "warning",
                "Suplex could not check Herdr",
                with_failure(&details, "probe-ambiguous"),
                None,
            );
        }
        // The CLI answered but the socket API did not: the server is not running.
        return check(
            "unhealthy",
            "Suplex cannot reach Herdr",
            with_failure(&details, "api-unreachable"),
            Some("herdr"),
        );
    }
    if diagnostic.is_some_and(|server| server.private_compatibility == "incompatible") {
        return check(
            "warning",
            "Restart Herdr for terminal views",
            with_failure(&details, "protocol-incompatible"),
            Some("herdr server stop && herdr"),
        );
    }
    if diagnostic.is_none() {
        // The API answered, so Herdr runs; only its status output is missing or unrecognized.
        return check(
            "warning",
            "Herdr diagnostics are incomplete",
            with_failure(&details, "diagnostics-incomplete"),
            Some("herdr status"),
        );
    }
    if client == "unknown" {
        return check(
            "warning",
            "Suplex could not check Herdr",
            with_failure(&details, "probe-ambiguous"),
            None,
        );
    }
    check(
        "healthy",
        "Herdr API and terminal views are available",
        details,
        None,
    )
}

async fn probe(command: &str, args: &[&str]) -> Probe {
    let child = tokio::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(3), child).await {
        Ok(Ok(output)) if output.status.success() => {
            Probe::Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Probe::Missing,
        _ => Probe::Ambiguous,
    }
}

pub async fn check_herdr_readiness(herdr: &Herdr) -> Value {
    let client = herdr.clone();
    let (version, status, api) = tokio::join!(
        probe(&herdr.binary, &["--version"]),
        probe(&herdr.binary, &["status", "server", "--json"]),
        tokio::task::spawn_blocking(move || client.list_workspaces().is_ok()),
    );
    evaluate(version, status, api.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING: &str = r#"{"status":"running","running":true,"version":"0.9.0","protocol":22,"compatible":true,"endpoint_compatible":true,"socket":"/private/herdr.sock"}"#;

    fn ok(text: &str) -> Probe {
        Probe::Ok(text.to_owned())
    }

    #[test]
    fn reports_a_reachable_matching_client_and_server() {
        let result = evaluate(ok("herdr 0.9.0\n"), ok(RUNNING), true);
        assert_eq!(
            result,
            json!({"id":"herdr-readiness","label":"Herdr","status":"healthy","summary":"Herdr API and terminal views are available",
                "details":{"apiReachable":true,"cliPresent":true,"clientVersion":"0.9.0","serverVersion":"0.9.0","privateProtocol":22,
                    "privateProtocolCompatibility":"compatible","endpointCompatibility":"compatible"}})
        );
        assert!(!result.to_string().contains("/private/"));
    }

    #[test]
    fn a_missing_cli_reports_not_installed_with_the_install_command() {
        let result = evaluate(Probe::Missing, Probe::Missing, false);
        assert_eq!(result["status"], "unhealthy");
        assert_eq!(result["summary"], "Herdr is not installed");
        assert_eq!(
            result["remedy"],
            "curl -fsSL https://herdr.dev/install.sh | sh"
        );
        assert_eq!(result["details"]["cliPresent"], false);
    }

    #[tokio::test]
    async fn a_missing_binary_is_proven_by_spawn_not_found() {
        let result = check_herdr_readiness(&Herdr::new("/nonexistent/suplex-herdr")).await;
        assert_eq!(result["summary"], "Herdr is not installed");
    }

    #[test]
    fn an_unreachable_api_with_a_present_cli_reports_cannot_reach() {
        let result = evaluate(ok("herdr 0.9.0\n"), ok("status: stopped\n"), false);
        assert_eq!(result["summary"], "Suplex cannot reach Herdr");
        assert_eq!(result["remedy"], "herdr");
        assert_eq!(result["details"]["failure"], "api-unreachable");
        assert_eq!(result["details"]["cliPresent"], true);
    }

    #[test]
    fn an_incompatible_private_protocol_warns_with_a_restart_remedy() {
        let status = r#"{"status":"running","running":true,"version":"0.8.2","protocol":20,"compatible":false,"endpoint_compatible":true,"socket":"/private/herdr.sock"}"#;
        let result = evaluate(ok("herdr 0.9.0\n"), ok(status), true);
        assert_eq!(result["status"], "warning");
        assert_eq!(result["summary"], "Restart Herdr for terminal views");
        assert_eq!(result["remedy"], "herdr server stop && herdr");
        assert_eq!(result["details"]["privateProtocol"], 20);
        assert_eq!(
            result["details"]["privateProtocolCompatibility"],
            "incompatible"
        );
        assert_eq!(result["details"]["endpointCompatibility"], "compatible");
        assert!(!result.to_string().contains("/private/"));
    }

    #[test]
    fn missing_or_failed_diagnostics_warn_and_are_never_reported_missing() {
        for status in [
            ok("not diagnostic output /private/herdr.sock\n"),
            Probe::Ambiguous,
        ] {
            let result = evaluate(ok("herdr 0.9.0\n"), status, true);
            assert_eq!(result["summary"], "Herdr diagnostics are incomplete");
            assert_eq!(result["details"]["serverVersion"], "unknown");
            assert_eq!(result["details"]["failure"], "diagnostics-incomplete");
            assert!(!result.to_string().contains("/private/"));
        }
    }

    #[test]
    fn ambiguous_probes_report_suplex_could_not_check() {
        let result = evaluate(Probe::Ambiguous, Probe::Ambiguous, false);
        assert_eq!(result["summary"], "Suplex could not check Herdr");
        assert_eq!(result["details"]["failure"], "probe-ambiguous");
        let result = evaluate(Probe::Ambiguous, ok(RUNNING), true);
        assert_eq!(result["summary"], "Suplex could not check Herdr");
        assert_eq!(result["details"]["clientVersion"], "unknown");
        assert_eq!(
            result["details"]["privateProtocolCompatibility"],
            "compatible"
        );
    }

    #[test]
    fn text_status_output_is_parsed() {
        let result = evaluate(
            ok("herdr 0.9.0"),
            ok(
                "version: 0.9.0\nprivate_protocol: 22\nprivate_protocol_compatible: yes\nendpoint_compatible: no\n",
            ),
            true,
        );
        assert_eq!(result["status"], "healthy");
        assert_eq!(result["details"]["privateProtocol"], 22);
        assert_eq!(result["details"]["endpointCompatibility"], "incompatible");
    }
}
