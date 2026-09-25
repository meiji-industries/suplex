#[path = "../src/shared/js_json.rs"]
mod js_json;

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[allow(dead_code)]
struct Fixture {
    site: String,
    #[serde(rename = "inputJson")]
    input_json: String,
    encoding: String,
    bytes: String,
    digest: String,
}

#[test]
fn persisted_hash_bytes_match_json_stringify() {
    assert_eq!(js_json::utf16_len("😀"), 2);
    assert!(js_json::stringify_raw_json("{\"x\":1}\u{000b}").is_err());
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/parity/hash-bytes");
    let mut paths = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    assert_eq!(paths.len(), 8);
    for path in paths {
        let fixture: Fixture = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let actual = js_json::stringify_raw_json(&fixture.input_json).unwrap();
        assert_eq!(actual, fixture.bytes, "{}", path.display());
        if let Ok(value) = serde_json::from_str::<Value>(&fixture.input_json) {
            assert_eq!(
                js_json::stringify(&value),
                fixture.bytes,
                "{}",
                path.display()
            );
            if path
                .file_stem()
                .is_some_and(|stem| stem == "numeric_keys_and_floats")
            {
                assert_ne!(serde_json::to_string(&value).unwrap(), fixture.bytes);
            }
        } else {
            assert!(matches!(
                path.file_stem().and_then(|stem| stem.to_str()),
                Some("lone_surrogate" | "large_numbers")
            ));
        }
        let hash = Sha256::digest(actual.as_bytes());
        let digest = if fixture.encoding == "base64url" {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
        } else {
            format!("{hash:x}")
        };
        assert_eq!(digest, fixture.digest, "{}", path.display());
    }
}
