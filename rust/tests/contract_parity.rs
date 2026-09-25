use serde::Deserialize;
use serde_json::Value;
use suplex::http::contracts;

#[derive(Deserialize)]
struct Fixture {
    contract: String,
    expected: Expected,
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
struct Expected {
    accepted: bool,
    value: Option<Value>,
    error: Option<Value>,
}

fn public_findings(issues: Value) -> Value {
    let Some(issues) = issues.as_array() else {
        return serde_json::json!({"kind":"thrown"});
    };
    Value::Array(issues.iter().map(|issue| {
        let field = issue.get("path").and_then(Value::as_array).map_or_else(String::new, |path| {
            path.iter().map(|part| part.as_str().map(str::to_owned).unwrap_or_else(|| part.to_string())).collect::<Vec<_>>().join(".")
        });
        serde_json::json!({
            "code": format!("invalid-{}", issue.get("code").and_then(Value::as_str).unwrap_or("request")),
            "field": format!(".{field}"),
            "message": "Request value is invalid"
        })
    }).collect())
}

#[test]
fn ported_contracts_match_zod_fixtures() {
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/parity");
    let mut verified = 0;
    let mut schemas = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if !path.is_dir()
            || path.file_name().is_some_and(|name| {
                [
                    "hash-bytes",
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
        for fixture_path in std::fs::read_dir(path).unwrap() {
            let fixture_path = fixture_path.unwrap().path();
            if fixture_path
                .extension()
                .is_none_or(|extension| extension != "json")
            {
                continue;
            }
            let fixture: Fixture =
                serde_json::from_slice(&std::fs::read(&fixture_path).unwrap()).unwrap();
            let typed =
                contracts::typed::auth::validate(&fixture.contract, fixture.fields.get("input"))
                    .or_else(|| {
                        contracts::typed::avatars::validate(
                            &fixture.contract,
                            fixture.fields.get("input"),
                        )
                    })
                    .or_else(|| {
                        contracts::typed::projects::validate(
                            &fixture.contract,
                            fixture.fields.get("input"),
                        )
                    })
                    .or_else(|| {
                        contracts::typed::system::validate(
                            &fixture.contract,
                            fixture.fields.get("input"),
                        )
                    });
            let actual = if let Some(result) = typed {
                Some(match result {
                    Ok(value) => Ok(value),
                    Err(contracts::typed::ContractFailure::Issues(findings)) => {
                        Err(Value::Array(findings))
                    }
                    Err(contracts::typed::ContractFailure::Unhandled) => {
                        Err(serde_json::json!({"kind":"thrown"}))
                    }
                    Err(contracts::typed::ContractFailure::Internal(error)) => {
                        panic!("{}: {error}", fixture_path.display())
                    }
                })
            } else {
                contracts::validate(&fixture.contract, fixture.fields.get("input"))
                    .map(|result| result.map_err(|issues| public_findings(Value::Array(issues))))
            };
            if let Some(actual) = actual {
                schemas.insert(fixture.contract.clone());
                match actual {
                    Ok(value) => {
                        assert!(fixture.expected.accepted, "{}", fixture_path.display());
                        assert_eq!(
                            Some(value),
                            fixture.expected.value,
                            "{}",
                            fixture_path.display()
                        );
                    }
                    Err(error) => {
                        assert!(!fixture.expected.accepted, "{}", fixture_path.display());
                        assert_eq!(
                            Some(error),
                            fixture.expected.error,
                            "{}",
                            fixture_path.display()
                        );
                    }
                }
                verified += 1;
            }
        }
    }
    assert_eq!(schemas.len(), 49, "forty-nine implemented request schemas");
    assert!(
        verified >= 140,
        "every ported schema has multiple Zod cases"
    );
    println!("verified {verified} cases across {} schemas", schemas.len());
}
