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
    error: Option<Vec<Value>>,
}

#[test]
fn ported_contracts_match_zod_fixtures() {
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/parity");
    let mut verified = 0;
    let mut schemas = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if !path.is_dir() || path.file_name().is_some_and(|name| name == "hash-bytes") {
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
            if let Some(actual) =
                contracts::validate(&fixture.contract, fixture.fields.get("input"))
            {
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
    assert_eq!(schemas.len(), 35, "thirty-five explicitly ported schemas");
    assert!(
        verified >= 140,
        "every ported schema has multiple Zod cases"
    );
    println!("verified {verified} cases across {} schemas", schemas.len());
}
