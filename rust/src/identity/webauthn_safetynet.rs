//! SafetyNet JWT attestation is intentionally separate: webauthn-rs-core 0.5.4
//! returns AttestationNotSupported for this format.

use std::collections::BTreeMap;

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
};
use openssl::{
    hash::MessageDigest,
    nid::Nid,
    rsa::Padding,
    sign::{RsaPssSaltlen, Verifier},
    x509::X509,
};
use serde_cbor_2::Value;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use x509_parser::parse_x509_certificate;

use super::{rsa_digest, trust};

fn statement_field<'a>(
    statement: &'a BTreeMap<Value, Value>,
    name: &str,
) -> Result<&'a Value, String> {
    statement
        .get(&Value::Text(name.into()))
        .ok_or_else(|| format!("missing SafetyNet {name}"))
}

pub(super) fn signature_algorithm(
    statement: &BTreeMap<Value, Value>,
    certificate: &[u8],
) -> Result<(i128, i128), String> {
    let override_algorithm = if let Some(value) = statement.get(&Value::Text("alg".into())) {
        match value {
            Value::Integer(0) | Value::Null | Value::Bool(false) => None,
            Value::Text(text) if text.is_empty() => None,
            Value::Float(float) if *float == 0.0 => None,
            Value::Integer(algorithm) => Some(*algorithm),
            _ => return Err("invalid SafetyNet attestation algorithm".into()),
        }
    } else {
        None
    };
    let (_, parsed) = parse_x509_certificate(certificate).map_err(|error| error.to_string())?;
    let certificate_algorithm = match parsed
        .tbs_certificate
        .signature
        .algorithm
        .to_id_string()
        .as_str()
    {
        "1.2.840.10045.4.3.2" => -7,
        "1.2.840.10045.4.3.3" => -35,
        "1.2.840.10045.4.3.4" => -36,
        "1.2.840.113549.1.1.11" => -257,
        "1.2.840.113549.1.1.12" => -258,
        "1.2.840.113549.1.1.13" => -259,
        "1.2.840.113549.1.1.5" => -65535,
        _ => return Err("unsupported SafetyNet certificate algorithm".into()),
    };
    Ok((
        certificate_algorithm,
        override_algorithm.unwrap_or(certificate_algorithm),
    ))
}

pub(super) fn digest(algorithm: i128) -> Result<MessageDigest, String> {
    match algorithm {
        -7 | -257 | -37 => Ok(MessageDigest::sha256()),
        -35 | -258 | -38 => Ok(MessageDigest::sha384()),
        -8 | -36 | -259 | -39 => Ok(MessageDigest::sha512()),
        -65535 => Ok(MessageDigest::sha1()),
        _ => Err("unsupported SafetyNet signature algorithm".into()),
    }
}

fn truthy(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) | Some(JsonValue::Bool(false)) => false,
        Some(JsonValue::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(JsonValue::String(value)) => !value.is_empty(),
        _ => true,
    }
}

fn cbor_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) | Value::Integer(0) => false,
        Value::Float(value) => *value != 0.0 && !value.is_nan(),
        Value::Text(value) => !value.is_empty(),
        _ => true,
    }
}

fn jwt_part(encoded: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| URL_SAFE.decode(encoded))
        .map_err(|error| error.to_string())
}

pub(super) fn verify(
    statement: &BTreeMap<Value, Value>,
    auth_data: &[u8],
    client_data: &[u8],
    now_ms: i64,
) -> Result<(), String> {
    verify_with_policy(statement, auth_data, client_data, now_ms, true, None)
}

#[cfg(test)]
fn verify_with_cts(
    statement: &BTreeMap<Value, Value>,
    auth_data: &[u8],
    client_data: &[u8],
    now_ms: i64,
    enforce_cts: bool,
) -> Result<(), String> {
    verify_with_policy(statement, auth_data, client_data, now_ms, enforce_cts, None)
}

pub(super) struct Prepared {
    certificates: Vec<Value>,
    leaf_der: Vec<u8>,
    signed: String,
    signature: Vec<u8>,
}

pub(super) fn precheck(
    statement: &BTreeMap<Value, Value>,
    auth_data: &[u8],
    client_data: &[u8],
    now_ms: i64,
    enforce_cts: bool,
) -> Result<Prepared, String> {
    if !cbor_truthy(statement_field(statement, "ver")?) {
        return Err("invalid SafetyNet version".into());
    }
    let Value::Bytes(response) = statement_field(statement, "response")? else {
        return Err("invalid SafetyNet JWT".into());
    };
    let jwt = std::str::from_utf8(response).map_err(|error| error.to_string())?;
    let mut parts = jwt.split('.');
    let encoded_header = parts.next().ok_or("missing SafetyNet JWT header")?;
    let encoded_payload = parts.next().ok_or("missing SafetyNet JWT payload")?;
    let encoded_signature = parts.next().ok_or("missing SafetyNet JWT signature")?;
    let header: JsonValue =
        serde_json::from_slice(&jwt_part(encoded_header)?).map_err(|error| error.to_string())?;
    let payload: JsonValue =
        serde_json::from_slice(&jwt_part(encoded_payload)?).map_err(|error| error.to_string())?;
    if let Some(timestamp) = payload["timestampMs"].as_i64()
        && (timestamp > now_ms || timestamp.saturating_add(60_000) < now_ms)
    {
        return Err("SafetyNet JWT timestamp is outside its validity window".into());
    }
    let mut nonce_base = auth_data.to_vec();
    nonce_base.extend_from_slice(&Sha256::digest(client_data));
    let expected_nonce = STANDARD.encode(Sha256::digest(&nonce_base));
    if payload["nonce"].as_str() != Some(expected_nonce.as_str()) {
        return Err("SafetyNet JWT nonce mismatch".into());
    }
    // Suplex does not override the SDK's true CTS default.
    if enforce_cts && !truthy(payload.get("ctsProfileMatch")) {
        return Err("SafetyNet CTS profile mismatch".into());
    }
    let certificates = header["x5c"]
        .as_array()
        .ok_or("missing SafetyNet certificate chain")?
        .iter()
        .map(|value| {
            let text = value.as_str().ok_or("invalid SafetyNet certificate")?;
            STANDARD
                .decode(text)
                .map(Value::Bytes)
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let Some(Value::Bytes(leaf_der)) = certificates.first() else {
        return Err("missing SafetyNet leaf certificate".into());
    };
    let leaf = X509::from_der(leaf_der).map_err(|error| error.to_string())?;
    let cn = leaf
        .subject_name()
        .entries_by_nid(Nid::COMMONNAME)
        .next()
        .ok_or("SafetyNet leaf has no common name")?
        .data()
        .to_string()
        .map_err(|error| error.to_string())?;
    if cn != "attest.android.com" {
        return Err("SafetyNet leaf common name mismatch".into());
    }
    let leaf_der = leaf_der.clone();
    Ok(Prepared {
        certificates,
        leaf_der,
        signed: format!("{encoded_header}.{encoded_payload}"),
        signature: jwt_part(encoded_signature)?,
    })
}

fn verify_with_policy(
    statement: &BTreeMap<Value, Value>,
    auth_data: &[u8],
    client_data: &[u8],
    now_ms: i64,
    enforce_cts: bool,
    test_anchor: Option<&[u8]>,
) -> Result<(), String> {
    let Prepared {
        certificates,
        leaf_der,
        signed,
        signature,
    } = precheck(statement, auth_data, client_data, now_ms, enforce_cts)?;
    let leaf = X509::from_der(&leaf_der).map_err(|error| error.to_string())?;
    if let Some(anchor) = test_anchor {
        trust::verify_safetynet_with_anchor(&certificates, now_ms / 1000, anchor)?;
    } else {
        trust::verify_safetynet(&certificates, now_ms / 1000)?;
    }
    let (certificate_algorithm, digest_algorithm) = signature_algorithm(statement, &leaf_der)?;
    let key = leaf.public_key().map_err(|error| error.to_string())?;
    let digest = digest(digest_algorithm)?;
    let mut verifier = Verifier::new(digest, &key).map_err(|error| error.to_string())?;
    if rsa_digest(certificate_algorithm).is_ok() {
        let (_, padding) = rsa_digest(certificate_algorithm)?;
        verifier
            .set_rsa_padding(padding)
            .map_err(|error| error.to_string())?;
        if padding == Padding::PKCS1_PSS {
            verifier
                .set_rsa_mgf1_md(digest)
                .map_err(|error| error.to_string())?;
            verifier
                .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
                .map_err(|error| error.to_string())?;
        }
    }
    verifier
        .update(signed.as_bytes())
        .map_err(|error| error.to_string())?;
    if !verifier
        .verify(&signature)
        .map_err(|error| error.to_string())?
    {
        return Err("invalid SafetyNet JWT signature".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_upstream_false_cts_is_rejected_by_suplex_default() {
        // SimpleWebAuthn v13.3.2's signed false-CTS fixture. Its own test
        // accepts it only when it explicitly disables CTS enforcement.
        let response: JsonValue = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-safetynet-upstream.json"
        ))
        .unwrap();
        let attestation = URL_SAFE_NO_PAD
            .decode(response["response"]["attestationObject"].as_str().unwrap())
            .unwrap();
        let Value::Map(object) = serde_cbor_2::from_slice::<Value>(&attestation).unwrap() else {
            unreachable!()
        };
        let Value::Map(statement) = object.get(&Value::Text("attStmt".into())).unwrap() else {
            unreachable!()
        };
        let Value::Bytes(auth_data) = object.get(&Value::Text("authData".into())).unwrap() else {
            unreachable!()
        };
        let client_data = URL_SAFE_NO_PAD
            .decode(response["response"]["clientDataJSON"].as_str().unwrap())
            .unwrap();
        let when = 1_749_501_642_989;
        assert!(verify_with_cts(statement, auth_data, &client_data, when, false).is_ok());
        assert_eq!(
            verify(statement, auth_data, &client_data, when).unwrap_err(),
            "SafetyNet CTS profile mismatch"
        );
    }

    #[test]
    fn signed_cts_true_requires_matching_root_and_false_cts_is_rejected() {
        let fixture: JsonValue = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-safetynet-synthetic.json"
        ))
        .unwrap();
        let when = fixture["timestampMs"].as_i64().unwrap() + 1000;
        let anchor = fixture["rootPEM"].as_str().unwrap().as_bytes();
        for (name, expected_cts) in [
            ("registration", true),
            ("falseCtsRegistration", false),
            ("paddedRegistration", true),
        ] {
            let response = &fixture[name]["response"];
            let attestation = URL_SAFE_NO_PAD
                .decode(response["attestationObject"].as_str().unwrap())
                .unwrap();
            let Value::Map(object) = serde_cbor_2::from_slice::<Value>(&attestation).unwrap()
            else {
                unreachable!()
            };
            let Value::Map(statement) = object.get(&Value::Text("attStmt".into())).unwrap() else {
                unreachable!()
            };
            let Value::Bytes(auth_data) = object.get(&Value::Text("authData".into())).unwrap()
            else {
                unreachable!()
            };
            let client_data = URL_SAFE_NO_PAD
                .decode(response["clientDataJSON"].as_str().unwrap())
                .unwrap();
            let result =
                verify_with_policy(statement, auth_data, &client_data, when, true, Some(anchor));
            assert_eq!(result.is_ok(), expected_cts, "{name}: {result:?}");
            assert!(verify(statement, auth_data, &client_data, when).is_err());
            if name == "registration" {
                let mut numeric_version = statement.clone();
                numeric_version.insert(Value::Text("ver".into()), Value::Integer(1));
                assert!(
                    verify_with_policy(
                        &numeric_version,
                        auth_data,
                        &client_data,
                        when,
                        true,
                        Some(anchor)
                    )
                    .is_ok()
                );
                let mut bad_algorithm = statement.clone();
                bad_algorithm.insert(Value::Text("alg".into()), Value::Text("invalid".into()));
                assert!(
                    verify_with_policy(
                        &bad_algorithm,
                        auth_data,
                        &client_data,
                        when,
                        true,
                        Some(anchor)
                    )
                    .is_err()
                );
            }
        }
    }
}
