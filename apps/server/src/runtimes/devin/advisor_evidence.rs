use std::{fs, io, path::Path};

use serde_json::{Map, Value, json};

use crate::{
    coordination::advisor_bridge::{self, AdvisorRole},
    runtimes::native::NativeTool,
    shared::js_json,
};

pub struct AdvisorEvidence {
    pub tools: Vec<NativeTool>,
    pub limitation: &'static str,
}

pub fn read(runtime_directory: &Path, turn_id: &str) -> io::Result<AdvisorEvidence> {
    let path = advisor_bridge::advisor_result_path(runtime_directory, turn_id)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(AdvisorEvidence {
                tools: Vec::new(),
                limitation: "Devin CLI does not expose machine-readable tool evidence.",
            });
        }
        Err(error) => return Err(error),
    };
    let raw: Value = serde_json::from_str(&text).map_err(io::Error::other)?;
    let role: AdvisorRole = serde_json::from_value(raw.get("role").cloned().unwrap_or_default())
        .map_err(io::Error::other)?;
    let result = advisor_bridge::validate_submission(role, raw).map_err(io::Error::other)?;
    Ok(AdvisorEvidence {
        tools: vec![NativeTool {
            id: format!("devin-advisor-report-{turn_id}"),
            name: "mcp__suplex_advisor__submit_report".into(),
            status: "completed",
            input: Map::new(),
            output: Some(js_json::stringify(&json!({ "structuredContent": result }))),
            error: None,
        }],
        limitation: "Devin CLI does not expose other machine-readable tool evidence.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_report_becomes_the_only_tool_evidence() {
        let directory =
            std::env::temp_dir().join(format!("suplex-devin-evidence-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let missing = read(&directory, "turn-1").unwrap();
        assert!(missing.tools.is_empty());
        assert_eq!(
            missing.limitation,
            "Devin CLI does not expose machine-readable tool evidence."
        );
        fs::write(
            advisor_bridge::advisor_result_path(&directory, "turn-1").unwrap(),
            r#"{"rating":10,"blockingFindings":[],"verification":"passed","verificationSummary":"Focused tests passed","summary":"Ready","role":"rater"}"#,
        )
        .unwrap();
        let found = read(&directory, "turn-1").unwrap();
        assert_eq!(found.tools.len(), 1);
        assert_eq!(found.tools[0].id, "devin-advisor-report-turn-1");
        let output: Value =
            serde_json::from_str(found.tools[0].output.as_deref().unwrap()).unwrap();
        assert_eq!(output["structuredContent"]["rating"], 10);
        assert_eq!(output["structuredContent"]["role"], "rater");
        fs::write(
            advisor_bridge::advisor_result_path(&directory, "turn-1").unwrap(),
            r#"{"rating":10,"blockingFindings":["x"],"verification":"passed","verificationSummary":"v","summary":"s","role":"rater"}"#,
        )
        .unwrap();
        assert!(read(&directory, "turn-1").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
