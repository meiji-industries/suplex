use serde::Deserialize;
use serde_json::Value;
use suplex::http::contracts;

#[derive(Deserialize)]
struct Fixture {
    contract: String,
    input: Value,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    accepted: bool,
    value: Option<Value>,
    error: Option<Vec<Value>>,
}

fn public_findings(issues: Vec<Value>) -> Vec<Value> {
    issues.into_iter().map(|issue| {
        let field = issue.get("path").and_then(Value::as_array).map_or_else(String::new, |path| {
            path.iter().map(|part| part.as_str().map(str::to_owned).unwrap_or_else(|| part.to_string())).collect::<Vec<_>>().join(".")
        });
        serde_json::json!({
            "code": format!("invalid-{}", issue.get("code").and_then(Value::as_str).unwrap_or("request")),
            "field": format!(".{field}"),
            "message": "Request value is invalid"
        })
    }).collect()
}

#[test]
fn stored_project_nested_schemas_match_zod() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/parity");
    let mut schemas = std::collections::BTreeSet::new();
    let mut cases = 0;
    for directory in std::fs::read_dir(root).unwrap() {
        let directory = directory.unwrap().path();
        if !directory.is_dir()
            || !directory.file_name().is_some_and(|name| {
                [
                    "projects.ProjectIntegrationSchema",
                    "projects.ProjectExecutionSchema",
                    "projects.ProjectProviderPolicySchema",
                ]
                .iter()
                .any(|candidate| name == *candidate)
            })
        {
            continue;
        }
        for file in std::fs::read_dir(directory).unwrap() {
            let path = file.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let fixture: Fixture = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let actual = contracts::validate(&fixture.contract, Some(&fixture.input))
                .unwrap_or_else(|| panic!("unported stored-project schema: {}", fixture.contract));
            schemas.insert(fixture.contract);
            match actual {
                Ok(value) => {
                    assert!(fixture.expected.accepted, "{}", path.display());
                    assert_eq!(Some(value), fixture.expected.value, "{}", path.display());
                }
                Err(error) => {
                    assert!(!fixture.expected.accepted, "{}", path.display());
                    assert_eq!(
                        Some(public_findings(error)),
                        fixture.expected.error,
                        "{}",
                        path.display()
                    );
                }
            }
            cases += 1;
        }
    }
    assert_eq!(schemas.len(), 3);
    assert_eq!(cases, 18);
    println!(
        "verified {cases} stored-project cases across {} nested schemas",
        schemas.len()
    );
}
