use serde::Deserialize;
use suplex::{http::contracts, shared::js_json::JsDocument};

#[derive(Deserialize)]
struct Fixture {
    contract: String,
    encoding: String,
    input: String,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    accepted: bool,
    value: Option<String>,
    error: Option<String>,
}

#[test]
fn lossless_contracts_match_zod_raw_json() {
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/parity");
    let mut verified = 0;
    for contract in std::fs::read_dir(directory).unwrap() {
        let contract = contract.unwrap().path();
        if !contract.is_dir() {
            continue;
        }
        for path in std::fs::read_dir(contract).unwrap() {
            let path = path.unwrap().path();
            if !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("raw_"))
            {
                continue;
            }
            let fixture: Fixture = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(fixture.encoding, "raw-json", "{}", path.display());
            let input = JsDocument::parse(&fixture.input)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let actual = contracts::validate_js_detailed(&fixture.contract, Some(&input))
                .unwrap_or_else(|| panic!("unported raw contract: {}", fixture.contract));
            match actual {
                Ok(value) => {
                    assert!(fixture.expected.accepted, "{}", path.display());
                    assert_eq!(
                        Some(value.stringify()),
                        fixture.expected.value,
                        "{}",
                        path.display()
                    );
                }
                Err(failure) => {
                    assert!(!fixture.expected.accepted, "{}", path.display());
                    assert_eq!(
                        Some(failure.stringify()),
                        fixture.expected.error,
                        "{}",
                        path.display()
                    );
                }
            }
            verified += 1;
        }
    }
    assert_eq!(verified, 36);

    let mut nested = serde_json::json!(0);
    for _ in 0..129 {
        nested = serde_json::Value::Array(vec![nested]);
    }
    let input = serde_json::json!({ "nested": nested });
    assert!(contracts::validate("common.EmptyBodySchema", Some(&input)).is_none());
    let raw = JsDocument::parse(&suplex::shared::js_json::stringify(&input)).unwrap();
    assert!(
        contracts::validate_js("common.EmptyBodySchema", Some(&raw))
            .unwrap()
            .is_ok()
    );
}
