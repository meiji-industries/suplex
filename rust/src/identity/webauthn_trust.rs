//! The trust anchors shipped by @simplewebauthn/server 13.3.2 for Suplex's
//! uncustomized SettingsService. These public certificates are copied from its
//! defaultRootCerts package files; the Rust process has no Node dependency.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
};
use openssl::{
    asn1::Asn1Time,
    stack::Stack,
    x509::{
        CrlStatus, X509, X509Crl, X509StoreContext, store::X509StoreBuilder,
        verify::X509VerifyParam,
    },
};
use serde_cbor_2::Value;
use serde_json::Value as JsonValue;

const APPLE: &[u8] = include_bytes!("attestation_roots/Apple_WebAuthn_Root_CA.pem");
const GOOGLE: [&[u8]; 4] = [
    include_bytes!("attestation_roots/Google_Hardware_Attestation_Root_1.pem"),
    include_bytes!("attestation_roots/Google_Hardware_Attestation_Root_2.pem"),
    include_bytes!("attestation_roots/Google_Hardware_Attestation_Root_3.pem"),
    include_bytes!("attestation_roots/Google_Hardware_Attestation_Root_4.pem"),
];
const GLOBALSIGN: &[u8] = include_bytes!("attestation_roots/GlobalSign_Root_CA.pem");

#[derive(Clone)]
struct CachedCrl {
    next_update: Option<i64>,
    revoked_serials: HashSet<String>,
}

static CRL_CACHE: OnceLock<Mutex<HashMap<Vec<u8>, CachedCrl>>> = OnceLock::new();

fn crl_cache() -> &'static Mutex<HashMap<Vec<u8>, CachedCrl>> {
    CRL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn crl_url(certificate: &X509) -> Option<String> {
    certificate
        .crl_distribution_points()?
        .get(0)?
        .distpoint()?
        .fullname()?
        .get(0)?
        .uri()
        .map(str::to_owned)
}

fn key_identifier(certificate: &X509) -> Option<Vec<u8>> {
    certificate
        .authority_key_id()
        .or_else(|| certificate.subject_key_id())
        .map(|id| id.as_slice().to_vec())
}

fn serial(certificate: &X509) -> Option<String> {
    Some(
        certificate
            .serial_number()
            .to_bn()
            .ok()?
            .to_hex_str()
            .ok()?
            .to_string(),
    )
}

async fn assert_not_revoked(certificate: &X509, now_unix: i64) -> Result<(), String> {
    assert_not_revoked_at(certificate, now_unix, None).await
}

pub(super) async fn assert_not_revoked_at(
    certificate: &X509,
    now_unix: i64,
    test_url: Option<&str>,
) -> Result<(), String> {
    let key = key_identifier(certificate).map(|mut key| {
        if let Some(url) = test_url {
            // Keep controlled URL probes separate from production CRL entries
            // and from other parallel probes using the same certificate.
            key.push(0);
            key.extend_from_slice(url.as_bytes());
        }
        key
    });
    if let Some(key) = &key {
        let cached = crl_cache()
            .lock()
            .map_err(|error| error.to_string())?
            .get(key)
            .cloned();
        if let Some(cached) = cached
            && cached.next_update.is_none_or(|next| next > now_unix)
        {
            if serial(certificate).is_some_and(|value| cached.revoked_serials.contains(&value)) {
                return Err("attestation certificate is revoked".into());
            }
            return Ok(());
        }
    }
    let Some(url) = test_url.map(str::to_owned).or_else(|| crl_url(certificate)) else {
        return Ok(());
    };
    // The SDK treats download, HTTP, and CRL parse failures as unavailable
    // revocation data, while a successfully parsed matching serial is fatal.
    let bytes = match reqwest::get(url).await {
        Ok(response) => match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => return Ok(()),
        },
        Err(_) => return Ok(()),
    };
    let crl = match X509Crl::from_der(&bytes) {
        Ok(crl) => crl,
        Err(_) => return Ok(()),
    };
    if let (Some(key), Some(entries)) = (key, crl.get_revoked()) {
        let next_update = x509_parser::parse_x509_crl(&bytes)
            .ok()
            .and_then(|(_, parsed)| parsed.next_update().map(|time| time.timestamp()));
        let revoked_serials = entries
            .iter()
            .filter_map(|entry| {
                entry
                    .serial_number()
                    .to_bn()
                    .ok()?
                    .to_hex_str()
                    .ok()
                    .map(|hex| hex.to_string())
            })
            .collect::<HashSet<_>>();
        crl_cache()
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                key,
                CachedCrl {
                    next_update,
                    revoked_serials,
                },
            );
    }
    if matches!(crl.get_by_cert(certificate), CrlStatus::Revoked(_)) {
        Err("attestation certificate is revoked".into())
    } else {
        Ok(())
    }
}

fn parse_chain(certificates: &[Value]) -> Result<Vec<X509>, String> {
    certificates
        .iter()
        .map(|value| match value {
            Value::Bytes(bytes) => X509::from_der(bytes).map_err(|error| error.to_string()),
            _ => Err("invalid attestation certificate".into()),
        })
        .collect()
}

/// Fetches the CRL distribution points the installed SDK checks for rooted
/// attestation formats. Call this only after the challenge is durably consumed.
pub(super) async fn check_registration_revocation(
    response: &JsonValue,
    now_ms: i64,
    test_url: Option<&str>,
) -> Result<(), String> {
    let attestation = response["response"]["attestationObject"]
        .as_str()
        .ok_or("missing attestation object")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(attestation)
        .map_err(|error| error.to_string())?;
    let Value::Map(object) =
        serde_cbor_2::from_slice::<Value>(&bytes).map_err(|error| error.to_string())?
    else {
        return Err("invalid attestation object".into());
    };
    let Some(Value::Text(format)) = object.get(&Value::Text("fmt".into())) else {
        return Err("missing attestation format".into());
    };
    if !matches!(
        format.as_str(),
        "apple" | "android-key" | "android-safetynet"
    ) {
        return Ok(());
    }
    let Some(Value::Map(statement)) = object.get(&Value::Text("attStmt".into())) else {
        return Err("missing attestation statement".into());
    };
    let certificates = if format == "android-safetynet" {
        let Some(Value::Bytes(jwt)) = statement.get(&Value::Text("response".into())) else {
            return Err("missing SafetyNet JWT".into());
        };
        let jwt = std::str::from_utf8(jwt).map_err(|error| error.to_string())?;
        let header = jwt.split('.').next().ok_or("missing SafetyNet header")?;
        let header_bytes = URL_SAFE_NO_PAD
            .decode(header)
            .or_else(|_| URL_SAFE.decode(header))
            .map_err(|error| error.to_string())?;
        let header: JsonValue =
            serde_json::from_slice(&header_bytes).map_err(|error| error.to_string())?;
        header["x5c"]
            .as_array()
            .ok_or("missing SafetyNet certificate chain")?
            .iter()
            .map(|certificate| {
                STANDARD
                    .decode(
                        certificate
                            .as_str()
                            .ok_or("invalid SafetyNet certificate")?,
                    )
                    .map(Value::Bytes)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        let Some(Value::Array(certificates)) = statement.get(&Value::Text("x5c".into())) else {
            return Err("missing attestation certificates".into());
        };
        certificates.clone()
    };
    let mut chain = parse_chain(&certificates)?;
    if let Some(url) = test_url {
        return assert_not_revoked_at(
            chain.first().ok_or("missing attestation leaf")?,
            now_ms / 1000,
            Some(url),
        )
        .await;
    }
    if format == "apple" {
        chain.push(X509::from_pem(APPLE).map_err(|error| error.to_string())?);
    } else if format == "android-safetynet" {
        chain.push(X509::from_pem(GLOBALSIGN).map_err(|error| error.to_string())?);
    }
    for certificate in &chain {
        assert_not_revoked(certificate, now_ms / 1000).await?;
    }
    Ok(())
}

fn within_time(certificate: &X509, now: &Asn1Time) -> Result<bool, String> {
    Ok(certificate
        .not_before()
        .compare(now)
        .map_err(|error| error.to_string())?
        != Ordering::Greater
        && certificate
            .not_after()
            .compare(now)
            .map_err(|error| error.to_string())?
            != Ordering::Less)
}

fn verify_to_root(chain: &[X509], anchor: &X509, now_unix: i64) -> Result<bool, String> {
    let Some((leaf, intermediates)) = chain.split_first() else {
        return Err("missing attestation leaf certificate".into());
    };
    let now = Asn1Time::from_unix(now_unix).map_err(|error| error.to_string())?;
    if chain
        .iter()
        .any(|cert| !within_time(cert, &now).unwrap_or(false))
        || !within_time(anchor, &now)?
    {
        return Err("attestation certificate outside validity period".into());
    }
    let anchor_der = anchor.to_der().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    seen.insert(anchor_der);
    for cert in chain {
        if !seen.insert(cert.to_der().map_err(|error| error.to_string())?) {
            return Err("duplicate attestation certificate".into());
        }
    }
    let mut store = X509StoreBuilder::new().map_err(|error| error.to_string())?;
    let mut parameters = X509VerifyParam::new().map_err(|error| error.to_string())?;
    parameters.set_time(now_unix);
    store
        .set_param(&parameters)
        .map_err(|error| error.to_string())?;
    store
        .add_cert(anchor.clone())
        .map_err(|error| error.to_string())?;
    let store = store.build();
    let mut extras = Stack::new().map_err(|error| error.to_string())?;
    for cert in intermediates {
        extras
            .push(cert.clone())
            .map_err(|error| error.to_string())?;
    }
    let mut context = X509StoreContext::new().map_err(|error| error.to_string())?;
    context
        .init(&store, leaf, &extras, |context| {
            let valid = context.verify_cert()?;
            Ok(valid
                && context
                    .chain()
                    .is_some_and(|verified| verified.len() == chain.len() + 1))
        })
        .map_err(|error| error.to_string())
}

pub(super) fn verify_apple(certificates: &[Value], now_unix: i64) -> Result<(), String> {
    let chain = parse_chain(certificates)?;
    let anchor = X509::from_pem(APPLE).map_err(|error| error.to_string())?;
    if verify_to_root(&chain, &anchor, now_unix)? {
        Ok(())
    } else {
        Err("Apple attestation chain is not trusted".into())
    }
}

pub(super) fn verify_android_key(certificates: &[Value], now_unix: i64) -> Result<(), String> {
    verify_android_key_with_roots(certificates, now_unix, &GOOGLE)
}

pub(super) fn verify_android_key_with_roots(
    certificates: &[Value],
    now_unix: i64,
    known_roots: &[&[u8]],
) -> Result<(), String> {
    let chain = parse_chain(certificates)?;
    let Some((root, untrusted)) = chain.split_last() else {
        return Err("missing Android Key root certificate".into());
    };
    if untrusted.is_empty() {
        return Err("missing Android Key leaf certificate".into());
    }
    let root_der = root.to_der().map_err(|error| error.to_string())?;
    if !known_roots.iter().any(|pem| {
        X509::from_pem(pem)
            .and_then(|known| known.to_der())
            .is_ok_and(|der| der == root_der)
    }) {
        return Err("unknown Android Key root certificate".into());
    }
    if verify_to_root(untrusted, root, now_unix)? {
        Ok(())
    } else {
        Err("Android Key attestation chain is not trusted".into())
    }
}

pub(super) fn verify_safetynet(certificates: &[Value], now_unix: i64) -> Result<(), String> {
    verify_safetynet_with_anchor(certificates, now_unix, GLOBALSIGN)
}

pub(super) fn verify_safetynet_with_anchor(
    certificates: &[Value],
    now_unix: i64,
    anchor_pem: &[u8],
) -> Result<(), String> {
    let chain = parse_chain(certificates)?;
    let anchor = X509::from_pem(anchor_pem).map_err(|error| error.to_string())?;
    if verify_to_root(&chain, &anchor, now_unix)? {
        Ok(())
    } else {
        Err("SafetyNet attestation chain is not trusted".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn revoked_crl_rejects_and_unavailable_crl_is_soft_failure() {
        let fixture: JsonValue = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-safetynet-synthetic.json"
        ))
        .unwrap();
        let attestation = URL_SAFE_NO_PAD
            .decode(
                fixture["registration"]["response"]["attestationObject"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        let Value::Map(object) = serde_cbor_2::from_slice::<Value>(&attestation).unwrap() else {
            unreachable!()
        };
        let Value::Map(statement) = object.get(&Value::Text("attStmt".into())).unwrap() else {
            unreachable!()
        };
        let Value::Bytes(jwt) = statement.get(&Value::Text("response".into())).unwrap() else {
            unreachable!()
        };
        let header = std::str::from_utf8(jwt).unwrap().split('.').next().unwrap();
        let header: JsonValue =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
        let leaf =
            X509::from_der(&STANDARD.decode(header["x5c"][0].as_str().unwrap()).unwrap()).unwrap();
        let root = X509::from_pem(fixture["rootPEM"].as_str().unwrap().as_bytes()).unwrap();
        let crl = STANDARD
            .decode(fixture["revokedCRL"].as_str().unwrap())
            .unwrap();
        let when = fixture["timestampMs"].as_i64().unwrap() / 1000;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let responder = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                crl.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(&crl).await.unwrap();
        });
        let url = format!("http://{address}/revoked.crl");
        assert_eq!(
            assert_not_revoked_at(&leaf, when, Some(&url))
                .await
                .unwrap_err(),
            "attestation certificate is revoked"
        );
        responder.await.unwrap();
        assert!(key_identifier(&leaf).is_some());
        assert_eq!(
            assert_not_revoked_at(&leaf, when, Some(&url))
                .await
                .unwrap_err(),
            "attestation certificate is revoked"
        );
        assert!(
            assert_not_revoked_at(&root, when, Some("http://127.0.0.1:1/unavailable.crl"))
                .await
                .is_ok()
        );
    }
}
