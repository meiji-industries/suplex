use serde::Deserialize;
use serde_json::Value;
use suplex::{
    http::contracts::{self, JsContractFailure},
    shared::js_json::{self, JsDocument},
};

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

#[test]
fn ported_contracts_match_zod_fixtures() {
    let lossless_schemas = [
        "auth.CompanyNameBodySchema",
        "auth.DisplayNameBodySchema",
        "auth.MembershipBodySchema",
        "auth.CompanyIssueCodeBodySchema",
        "auth.ProfileBodySchema",
        "common.EmptyBodySchema",
        "common.TokenBodySchema",
        "common.RegistrationVerificationBodySchema",
        "common.AuthenticationVerificationBodySchema",
        "projects.ProjectAgentTaskPolicySchema",
        "projects.ProjectRepositoryBodySchema",
        "projects.ProjectIntegrationSchema",
        "projects.ProjectExecutionSchema",
        "projects.ProjectProviderPolicySchema",
        "projects.ProjectNewRepositoryBodySchema",
        "projects.ProjectBodySchema",
        "projects.ProjectPatchBodySchema",
        "projects.ProjectCreateBodySchema",
        "projects.ProjectResponseSchema",
        "projects.ProjectListResponseSchema",
        "workflows.WorkflowRecordInputSchema",
        "workflows.WorkflowRecordPatchSchema",
        "workflows.WorkflowRecordSchema",
        "workflows.WorkflowRecordParamsSchema",
        "workflows.WorkflowListQuerySchema",
        "workflows.WorkflowListResponseSchema",
    ];
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
                || fixture_path
                    .file_stem()
                    .is_some_and(|stem| stem.to_string_lossy().starts_with("raw_"))
            {
                continue;
            }
            let fixture: Fixture =
                serde_json::from_slice(&std::fs::read(&fixture_path).unwrap()).unwrap();
            let input = fixture.fields.get("input").map(|value| {
                JsDocument::parse(&js_json::stringify(value)).expect("ordinary fixture is JSON")
            });
            let detailed = contracts::validate_js_detailed(&fixture.contract, input.as_ref());
            if lossless_schemas.contains(&fixture.contract.as_str()) {
                assert!(
                    detailed.is_some(),
                    "lossless schema was skipped: {}",
                    fixture_path.display()
                );
            }
            let actual = if let Some(result) = detailed {
                Some(match result {
                    Ok(value) => Ok(value
                        .to_serde_if_representable()
                        .expect("ordinary output is representable")),
                    Err(JsContractFailure::Issues(issues)) => Err(issues
                        .to_serde_if_representable()
                        .expect("ordinary issues are representable")),
                    Err(JsContractFailure::Thrown(thrown)) => Err(thrown
                        .as_document()
                        .to_serde_if_representable()
                        .expect("ordinary thrown metadata is representable")),
                })
            } else {
                contracts::validate(&fixture.contract, fixture.fields.get("input"))
                    .map(|result| result.map_err(Value::Array))
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
    assert_eq!(schemas.len(), 74, "seventy-four explicitly ported schemas");
    assert!(
        verified >= 140,
        "every ported schema has multiple Zod cases"
    );
    println!("verified {verified} cases across {} schemas", schemas.len());
}
