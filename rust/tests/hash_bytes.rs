use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use suplex::shared::js_json;

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

#[test]
fn lossless_json_values_convert_only_when_serde_can_represent_them() {
    let ordinary =
        js_json::JsDocument::parse(r#"{"2":2,"1":1,"name":"😀","large":9007199254740993}"#)
            .unwrap();
    let serde = ordinary.to_serde_if_representable().unwrap();
    assert_eq!(serde["1"], serde_json::json!(1));
    assert_eq!(serde["large"], serde_json::json!(9_007_199_254_740_992_u64));
    assert_eq!(ordinary.stringify(), js_json::stringify(&serde));
    assert_eq!(
        ordinary.stringify(),
        r#"{"1":1,"2":2,"name":"😀","large":9007199254740992}"#
    );

    let surrogate = js_json::JsDocument::parse(r#"{"name":"\ud800"}"#).unwrap();
    assert!(surrogate.to_serde_if_representable().is_err());
    assert_eq!(surrogate.stringify(), r#"{"name":"\ud800"}"#);
    assert_eq!(
        surrogate.node(surrogate.get(surrogate.root(), "name").unwrap()),
        &js_json::JsNode::String(vec![0xd800])
    );

    let surrogate_key = js_json::JsDocument::parse(r#"{"\ud800":1}"#).unwrap();
    assert!(surrogate_key.to_serde_if_representable().is_err());
    assert_eq!(surrogate_key.stringify(), r#"{"\ud800":1}"#);

    let overflow = js_json::JsDocument::parse(r#"{"response":{"count":1e400}}"#).unwrap();
    assert!(overflow.to_serde_if_representable().is_err());
    assert_eq!(overflow.stringify(), r#"{"response":{"count":null}}"#);
}

#[test]
fn deep_json_parse_stringify_clone_and_drop_are_iterative() {
    let depth = 20_000;
    for input in [
        format!(
            r#"{{"nested":{}0{}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        ),
        format!(r#"{}0{}"#, r#"{"x":"#.repeat(depth), "}".repeat(depth)),
    ] {
        let parsed = js_json::JsDocument::parse(&input).unwrap();
        assert!(parsed.to_serde_if_representable().is_err());
        assert_eq!(parsed.stringify(), input);
        assert_eq!(parsed.clone().stringify(), input);
    }
    for invalid in [r#"[1,]"#, r#"{"x":1,}"#, r#"{"x":01}"#] {
        assert!(js_json::JsDocument::parse(invalid).is_err());
    }
}
