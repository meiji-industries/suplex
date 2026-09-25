use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use suplex::shared::js_json;

#[derive(Deserialize)]
struct Fixture {
    #[serde(rename = "inputJson")]
    input_json: String,
    encoding: String,
    bytes: String,
    digest: String,
}

#[test]
fn persisted_hash_bytes_match_json_stringify() {
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
    assert_eq!(paths.len(), 7);
    for path in paths {
        let fixture: Fixture = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let value: Value = serde_json::from_str(&fixture.input_json).unwrap();
        let actual = js_json::stringify(&value);
        assert_eq!(actual, fixture.bytes, "{}", path.display());
        if path
            .file_stem()
            .is_some_and(|stem| stem == "numeric_keys_and_floats")
        {
            assert_ne!(serde_json::to_string(&value).unwrap(), fixture.bytes);
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
