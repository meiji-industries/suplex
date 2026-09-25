use std::{cmp::Ordering, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use openssl::{
    asn1::Asn1Time,
    bn::BigNum,
    ec::{EcGroup, EcKey, EcPoint},
    hash::MessageDigest,
    nid::Nid,
    pkey::PKey,
    rsa::{Padding, Rsa},
    sign::{RsaPssSaltlen, Verifier},
    x509::X509,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use webauthn_rs_core::{
    WebauthnCore,
    proto::{
        AttestationFormat, AuthenticationState, COSEAlgorithm, COSEKey, Credential,
        ParsedAttestation, PublicKeyCredential, RegisterPublicKeyCredential, RegisteredExtensions,
        RegistrationState, UserVerificationPolicy,
    },
};

#[derive(Clone, Debug)]
pub struct StoredCredential {
    pub id: String,
    pub public_key: Vec<u8>,
    pub counter: u32,
    pub transports: Vec<String>,
}

fn core(rp_id: &str, origin: &str) -> Result<WebauthnCore, String> {
    let origin = url::Url::parse(origin).map_err(|error| error.to_string())?;
    Ok(WebauthnCore::new_unsafe_experts_only(
        "Suplex",
        rp_id,
        vec![origin],
        Duration::from_secs(300),
        Some(false),
        Some(false),
    ))
}

fn check_credential_id(response: &Value) -> Result<Vec<u8>, String> {
    let id = response["id"].as_str().ok_or("missing credential ID")?;
    let raw = response["rawId"]
        .as_str()
        .ok_or("missing raw credential ID")?;
    if id.is_empty() || response["type"] != "public-key" || id != raw {
        return Err("invalid credential identity".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|error| error.to_string())?;
    if URL_SAFE_NO_PAD.encode(&bytes) != id {
        return Err("noncanonical credential ID".into());
    }
    Ok(bytes)
}

fn check_client_data(
    response: &Value,
    kind: &str,
    challenge: &str,
    origin: &str,
) -> Result<(), String> {
    let encoded = response["response"]["clientDataJSON"]
        .as_str()
        .ok_or("missing client data")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    let data: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if data["type"] != kind || data["challenge"] != challenge || data["origin"] != origin {
        return Err("client data does not match ceremony".into());
    }
    let token_binding = &data["tokenBinding"];
    let present = match token_binding {
        Value::Null | Value::Bool(false) => false,
        Value::Number(value) if value.as_f64() == Some(0.0) => false,
        Value::String(value) if value.is_empty() => false,
        _ => true,
    };
    if present {
        let status = token_binding["status"]
            .as_str()
            .ok_or("invalid token binding")?;
        let allowed = if kind == "webauthn.create" {
            ["present", "supported", "not-supported"]
        } else {
            ["present", "supported", "notSupported"]
        };
        if !allowed.contains(&status) {
            return Err("invalid token binding status".into());
        }
    }
    Ok(())
}

fn expected_state<T: serde::de::DeserializeOwned>(
    state: &impl serde::Serialize,
    challenge: &str,
) -> Result<T, String> {
    let challenge_bytes = URL_SAFE_NO_PAD
        .decode(challenge)
        .map_err(|error| error.to_string())?;
    if URL_SAFE_NO_PAD.encode(&challenge_bytes) != challenge {
        return Err("noncanonical challenge".into());
    }
    let mut value = serde_json::to_value(state).map_err(|error| error.to_string())?;
    value["challenge"] = json!(challenge);
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn raw_cose(attestation_object: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(attestation_object)
        .map_err(|error| error.to_string())?;
    let object: serde_cbor_2::Value =
        serde_cbor_2::from_slice(&bytes).map_err(|error| error.to_string())?;
    let serde_cbor_2::Value::Map(map) = object else {
        return Err("attestation object is not a map".into());
    };
    let format = map.get(&serde_cbor_2::Value::Text("fmt".into()));
    let Some(serde_cbor_2::Value::Map(statement)) =
        map.get(&serde_cbor_2::Value::Text("attStmt".into()))
    else {
        return Err("missing attestation statement".into());
    };
    match format {
        Some(serde_cbor_2::Value::Text(value)) if value == "none" && statement.is_empty() => {}
        Some(serde_cbor_2::Value::Text(value)) if value == "packed" => {}
        Some(serde_cbor_2::Value::Text(value)) if value == "fido-u2f" => {}
        _ => return Err("attestation format requires separate trust verification".into()),
    }
    let Some(serde_cbor_2::Value::Bytes(auth_data)) =
        map.get(&serde_cbor_2::Value::Text("authData".into()))
    else {
        return Err("missing authenticator data".into());
    };
    if auth_data.len() < 55 {
        return Err("short authenticator data".into());
    }
    let id_len = usize::from(u16::from_be_bytes([auth_data[53], auth_data[54]]));
    let key_start = 55 + id_len;
    if key_start >= auth_data.len() {
        return Err("missing credential public key".into());
    }
    let mut decoder = serde_cbor_2::Deserializer::from_slice(&auth_data[key_start..]);
    let _: serde_cbor_2::Value =
        Deserialize::deserialize(&mut decoder).map_err(|error| error.to_string())?;
    Ok(auth_data[key_start..key_start + decoder.byte_offset()].to_vec())
}

fn core_attestation_required(attestation_object: &str) -> Result<bool, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(attestation_object)
        .map_err(|error| error.to_string())?;
    let serde_cbor_2::Value::Map(object) = serde_cbor_2::from_slice::<serde_cbor_2::Value>(&bytes)
        .map_err(|error| error.to_string())?
    else {
        return Err("invalid attestation object".into());
    };
    let packed = object.get(&serde_cbor_2::Value::Text("fmt".into()))
        == Some(&serde_cbor_2::Value::Text("packed".into()));
    let none = object.get(&serde_cbor_2::Value::Text("fmt".into()))
        == Some(&serde_cbor_2::Value::Text("none".into()));
    let u2f = object.get(&serde_cbor_2::Value::Text("fmt".into()))
        == Some(&serde_cbor_2::Value::Text("fido-u2f".into()));
    let Some(serde_cbor_2::Value::Map(statement)) =
        object.get(&serde_cbor_2::Value::Text("attStmt".into()))
    else {
        return Err("missing attestation statement".into());
    };
    if u2f {
        let Some(serde_cbor_2::Value::Bytes(auth_data)) =
            object.get(&serde_cbor_2::Value::Text("authData".into()))
        else {
            return Err("missing authenticator data".into());
        };
        if auth_data.get(37..53) != Some(&[0_u8; 16][..]) {
            return Err("U2F AAGUID must be zero".into());
        }
    }
    if !packed {
        return Ok(!none);
    }
    let Some(certificates) = statement.get(&serde_cbor_2::Value::Text("x5c".into())) else {
        return Ok(false);
    };
    let serde_cbor_2::Value::Array(certificates) = certificates else {
        return Err("invalid packed certificate chain".into());
    };
    let Some(serde_cbor_2::Value::Bytes(leaf)) = certificates.first() else {
        return Err("missing packed leaf certificate".into());
    };
    let leaf = X509::from_der(leaf).map_err(|error| error.to_string())?;
    let now =
        Asn1Time::from_unix(chrono::Utc::now().timestamp()).map_err(|error| error.to_string())?;
    if leaf
        .not_before()
        .compare(&now)
        .map_err(|error| error.to_string())?
        == Ordering::Greater
        || leaf
            .not_after()
            .compare(&now)
            .map_err(|error| error.to_string())?
            == Ordering::Less
    {
        return Err("packed certificate is outside its validity period".into());
    }
    Ok(true)
}

fn core_registration_response(response: &Value) -> Result<Value, String> {
    let mut response = response.clone();
    let attestation = response["response"]["attestationObject"]
        .as_str()
        .ok_or("missing attestation object")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(attestation)
        .map_err(|error| error.to_string())?;
    let mut object: serde_cbor_2::Value =
        serde_cbor_2::from_slice(&bytes).map_err(|error| error.to_string())?;
    let serde_cbor_2::Value::Map(ref mut map) = object else {
        return Err("invalid attestation object".into());
    };
    if map.get(&serde_cbor_2::Value::Text("fmt".into()))
        != Some(&serde_cbor_2::Value::Text("fido-u2f".into()))
    {
        return Ok(response);
    }
    let Some(serde_cbor_2::Value::Map(statement)) =
        map.get_mut(&serde_cbor_2::Value::Text("attStmt".into()))
    else {
        return Err("missing attestation statement".into());
    };
    let Some(serde_cbor_2::Value::Array(certificates)) =
        statement.get_mut(&serde_cbor_2::Value::Text("x5c".into()))
    else {
        return Err("missing U2F certificate".into());
    };
    if certificates.is_empty()
        || certificates
            .iter()
            .any(|certificate| !matches!(certificate, serde_cbor_2::Value::Bytes(_)))
    {
        return Err("invalid U2F certificate chain".into());
    }
    // Suplex's SimpleWebAuthn verifier has no U2F trust roots configured. It
    // verifies the leaf signature and accepts additional x5c entries. Core's
    // U2F verifier requires exactly one entry, so present only the signed leaf.
    certificates.truncate(1);
    response["response"]["attestationObject"] = json!(
        URL_SAFE_NO_PAD.encode(serde_cbor_2::to_vec(&object).map_err(|error| error.to_string())?)
    );
    Ok(response)
}

fn cose_map(
    bytes: &[u8],
) -> Result<std::collections::BTreeMap<serde_cbor_2::Value, serde_cbor_2::Value>, String> {
    let serde_cbor_2::Value::Map(map) =
        serde_cbor_2::from_slice(bytes).map_err(|error| error.to_string())?
    else {
        return Err("credential public key is not a CBOR map".into());
    };
    Ok(map)
}

fn cose_number(
    map: &std::collections::BTreeMap<serde_cbor_2::Value, serde_cbor_2::Value>,
    key: i128,
) -> Result<i128, String> {
    let Some(serde_cbor_2::Value::Integer(value)) = map.get(&serde_cbor_2::Value::Integer(key))
    else {
        return Err("missing COSE integer".into());
    };
    Ok(*value)
}

fn cose_bytes(
    map: &std::collections::BTreeMap<serde_cbor_2::Value, serde_cbor_2::Value>,
    key: i128,
) -> Result<&[u8], String> {
    let Some(serde_cbor_2::Value::Bytes(value)) = map.get(&serde_cbor_2::Value::Integer(key))
    else {
        return Err("missing COSE bytes".into());
    };
    Ok(value)
}

fn rsa_digest(algorithm: i128) -> Result<(MessageDigest, Padding), String> {
    match algorithm {
        -257 => Ok((MessageDigest::sha256(), Padding::PKCS1)),
        -37 => Ok((MessageDigest::sha256(), Padding::PKCS1_PSS)),
        -38 => Ok((MessageDigest::sha384(), Padding::PKCS1_PSS)),
        -39 => Ok((MessageDigest::sha512(), Padding::PKCS1_PSS)),
        -258 => Ok((MessageDigest::sha384(), Padding::PKCS1)),
        -259 => Ok((MessageDigest::sha512(), Padding::PKCS1)),
        -65535 => Ok((MessageDigest::sha1(), Padding::PKCS1)),
        _ => Err("unsupported RSA algorithm".into()),
    }
}

fn verify_rsa_signature(
    public_key: &[u8],
    key_algorithm: i128,
    signature_algorithm: i128,
    data: &[u8],
    signature: &[u8],
) -> Result<(), String> {
    let map = cose_map(public_key)?;
    if cose_number(&map, 1)? != 3 || cose_number(&map, 3)? != key_algorithm {
        return Err("invalid RSA COSE key".into());
    }
    let modulus = cose_bytes(&map, -1)?;
    let exponent = cose_bytes(&map, -2)?;
    if modulus.is_empty() || exponent.is_empty() {
        return Err("invalid RSA key size".into());
    }
    let rsa = Rsa::from_public_components(
        BigNum::from_slice(modulus).map_err(|error| error.to_string())?,
        BigNum::from_slice(exponent).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let key = PKey::from_rsa(rsa).map_err(|error| error.to_string())?;
    let (digest, _) = rsa_digest(signature_algorithm)?;
    let (_, padding) = rsa_digest(key_algorithm)?;
    let mut verifier = Verifier::new(digest, &key).map_err(|error| error.to_string())?;
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
    verifier.update(data).map_err(|error| error.to_string())?;
    if !verifier
        .verify(signature)
        .map_err(|error| error.to_string())?
    {
        return Err("invalid signature".into());
    }
    Ok(())
}

fn es512_public_key(public_key: &[u8]) -> Result<PKey<openssl::pkey::Public>, String> {
    let map = cose_map(public_key)?;
    if cose_number(&map, 1)? != 2 || cose_number(&map, 3)? != -36 || cose_number(&map, -1)? != 3 {
        return Err("invalid ES512 COSE key".into());
    }
    let x = cose_bytes(&map, -2)?;
    let y = cose_bytes(&map, -3)?;
    if x.len() != 66 || y.len() != 66 {
        return Err("invalid ES512 coordinates".into());
    }
    let group = EcGroup::from_curve_name(Nid::SECP521R1).map_err(|error| error.to_string())?;
    let mut encoded = Vec::with_capacity(133);
    encoded.push(4);
    encoded.extend_from_slice(x);
    encoded.extend_from_slice(y);
    let mut context = openssl::bn::BigNumContext::new().map_err(|error| error.to_string())?;
    let point =
        EcPoint::from_bytes(&group, &encoded, &mut context).map_err(|error| error.to_string())?;
    let ec = EcKey::from_public_key(&group, &point).map_err(|error| error.to_string())?;
    ec.check_key().map_err(|error| error.to_string())?;
    PKey::from_ec_key(ec).map_err(|error| error.to_string())
}

fn verify_es512_signature(public_key: &[u8], data: &[u8], signature: &[u8]) -> Result<(), String> {
    let key = es512_public_key(public_key)?;
    let mut verifier =
        Verifier::new(MessageDigest::sha512(), &key).map_err(|error| error.to_string())?;
    verifier.update(data).map_err(|error| error.to_string())?;
    if !verifier
        .verify(signature)
        .map_err(|error| error.to_string())?
    {
        return Err("invalid signature".into());
    }
    Ok(())
}

fn verify_fallback_registration(
    response: &Value,
    rp_id: &str,
    response_id: &[u8],
    public_key: Vec<u8>,
    algorithm: i128,
) -> Result<StoredCredential, String> {
    let object = URL_SAFE_NO_PAD
        .decode(
            response["response"]["attestationObject"]
                .as_str()
                .ok_or("missing attestation object")?,
        )
        .map_err(|error| error.to_string())?;
    let serde_cbor_2::Value::Map(map) = serde_cbor_2::from_slice::<serde_cbor_2::Value>(&object)
        .map_err(|error| error.to_string())?
    else {
        return Err("invalid attestation object".into());
    };
    let format = map.get(&serde_cbor_2::Value::Text("fmt".into()));
    let Some(serde_cbor_2::Value::Map(statement)) =
        map.get(&serde_cbor_2::Value::Text("attStmt".into()))
    else {
        return Err("missing attestation statement".into());
    };
    let Some(serde_cbor_2::Value::Bytes(auth_data)) =
        map.get(&serde_cbor_2::Value::Text("authData".into()))
    else {
        return Err("missing authenticator data".into());
    };
    if auth_data.len() < 55 || auth_data[..32] != Sha256::digest(rp_id.as_bytes()).as_slice()[..] {
        return Err("invalid relying party".into());
    }
    let flags = auth_data[32];
    if flags & 0x45 != 0x45 || (flags & 0x10 != 0 && flags & 0x08 == 0) {
        return Err("user verification or attested key missing".into());
    }
    let id_len = usize::from(u16::from_be_bytes([auth_data[53], auth_data[54]]));
    if auth_data.get(55..55 + id_len) != Some(response_id) {
        return Err("credential ID mismatch".into());
    }
    let key_end = 55 + id_len + public_key.len();
    if flags & 0x80 == 0 && auth_data.len() != key_end {
        return Err("unexpected authenticator data".into());
    }
    if flags & 0x80 != 0 {
        let extension: serde_cbor_2::Value = serde_cbor_2::from_slice(
            auth_data
                .get(key_end..)
                .ok_or("missing authenticator extensions")?,
        )
        .map_err(|error| error.to_string())?;
        if !matches!(extension, serde_cbor_2::Value::Map(_)) {
            return Err("invalid authenticator extensions".into());
        }
    }
    let map = cose_map(&public_key)?;
    if algorithm == -36 {
        es512_public_key(&public_key)?;
    } else if cose_number(&map, 1)? != 3
        || cose_number(&map, 3)? != algorithm
        || cose_bytes(&map, -1)?.is_empty()
        || cose_bytes(&map, -2)?.is_empty()
    {
        return Err("invalid RSA COSE key".into());
    }
    match format {
        Some(serde_cbor_2::Value::Text(value)) if value == "none" && statement.is_empty() => {}
        Some(serde_cbor_2::Value::Text(value))
            if value == "packed"
                && !statement.contains_key(&serde_cbor_2::Value::Text("x5c".into())) =>
        {
            let Some(serde_cbor_2::Value::Integer(attestation_algorithm)) =
                statement.get(&serde_cbor_2::Value::Text("alg".into()))
            else {
                return Err("missing packed attestation algorithm".into());
            };
            let Some(serde_cbor_2::Value::Bytes(signature)) =
                statement.get(&serde_cbor_2::Value::Text("sig".into()))
            else {
                return Err("missing packed attestation signature".into());
            };
            let attestation_algorithm = *attestation_algorithm;
            let client_data = URL_SAFE_NO_PAD
                .decode(
                    response["response"]["clientDataJSON"]
                        .as_str()
                        .ok_or("missing client data")?,
                )
                .map_err(|error| error.to_string())?;
            let mut signed = auth_data.clone();
            signed.extend_from_slice(&Sha256::digest(client_data));
            if attestation_algorithm == -36 {
                verify_es512_signature(&public_key, &signed, signature)?;
            } else {
                verify_rsa_signature(
                    &public_key,
                    algorithm,
                    attestation_algorithm,
                    &signed,
                    signature,
                )?;
            }
        }
        _ => return Err("unsupported attestation format for fallback".into()),
    }
    let counter = u32::from_be_bytes(
        auth_data[33..37]
            .try_into()
            .map_err(|_| "invalid counter")?,
    );
    Ok(StoredCredential {
        id: URL_SAFE_NO_PAD.encode(response_id),
        public_key,
        counter,
        transports: response["response"]["transports"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn verify_fallback_authentication(
    response: &Value,
    rp_id: &str,
    stored: &StoredCredential,
    algorithm: i128,
    auth_data: &[u8],
) -> Result<u32, String> {
    if auth_data.len() < 37 || auth_data[..32] != Sha256::digest(rp_id.as_bytes()).as_slice()[..] {
        return Err("invalid relying party".into());
    }
    let flags = auth_data[32];
    if flags & 0x05 != 0x05 || (flags & 0x10 != 0 && flags & 0x08 == 0) || flags & 0x40 != 0 {
        return Err("user verification failed".into());
    }
    if flags & 0x80 == 0 && auth_data.len() != 37 {
        return Err("unexpected authenticator data".into());
    }
    if flags & 0x80 != 0 {
        let extension: serde_cbor_2::Value =
            serde_cbor_2::from_slice(&auth_data[37..]).map_err(|error| error.to_string())?;
        if !matches!(extension, serde_cbor_2::Value::Map(_)) {
            return Err("invalid authenticator extensions".into());
        }
    }
    let counter = u32::from_be_bytes(
        auth_data[33..37]
            .try_into()
            .map_err(|_| "invalid counter")?,
    );
    if (counter > 0 || stored.counter > 0) && counter <= stored.counter {
        return Err("stale counter".into());
    }
    let user_handle = &response["response"]["userHandle"];
    let nonempty = match user_handle {
        Value::Null | Value::Bool(false) => false,
        Value::Number(value) if value.as_f64() == Some(0.0) => false,
        Value::String(value) if value.is_empty() => false,
        _ => true,
    };
    if nonempty && !user_handle.is_string() {
        return Err("invalid user handle".into());
    }
    let client_data = URL_SAFE_NO_PAD
        .decode(
            response["response"]["clientDataJSON"]
                .as_str()
                .ok_or("missing client data")?,
        )
        .map_err(|error| error.to_string())?;
    let signature = URL_SAFE_NO_PAD
        .decode(
            response["response"]["signature"]
                .as_str()
                .ok_or("missing signature")?,
        )
        .map_err(|error| error.to_string())?;
    let mut signed = auth_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data));
    if algorithm == -36 {
        verify_es512_signature(&stored.public_key, &signed, &signature)?;
    } else {
        verify_rsa_signature(
            &stored.public_key,
            algorithm,
            algorithm,
            &signed,
            &signature,
        )?;
    }
    Ok(counter)
}

pub fn verify_registration(
    response: &Value,
    challenge: &str,
    origin: &str,
    rp_id: &str,
) -> Result<StoredCredential, String> {
    let response_id = check_credential_id(response)?;
    check_client_data(response, "webauthn.create", challenge, origin)?;
    let public_key = raw_cose(
        response["response"]["attestationObject"]
            .as_str()
            .ok_or("missing attestation object")?,
    )?;
    let algorithm = cose_number(&cose_map(&public_key)?, 3)?;
    let attestation_object = response["response"]["attestationObject"]
        .as_str()
        .ok_or("missing attestation object")?;
    let core_attestation = core_attestation_required(attestation_object)?;
    if (algorithm == -36 || rsa_digest(algorithm).is_ok()) && !core_attestation {
        return verify_fallback_registration(response, rp_id, &response_id, public_key, algorithm);
    }
    let core = core(rp_id, origin)?;
    let builder = core
        .new_challenge_register_builder(b"user_existing", "user_existing", "User")
        .map_err(|error| format!("{error:?}"))?
        .user_verification_policy(UserVerificationPolicy::Required)
        .credential_algorithms(vec![
            COSEAlgorithm::EDDSA,
            COSEAlgorithm::ES256,
            COSEAlgorithm::ES512,
            COSEAlgorithm::PS256,
            COSEAlgorithm::PS384,
            COSEAlgorithm::PS512,
            COSEAlgorithm::RS256,
            COSEAlgorithm::RS384,
            COSEAlgorithm::RS512,
            COSEAlgorithm::INSECURE_RS1,
        ]);
    let (_, state) = core
        .generate_challenge_register(builder)
        .map_err(|error| format!("{error:?}"))?;
    let state: RegistrationState = expected_state(&state, challenge)?;
    let parsed: RegisterPublicKeyCredential =
        serde_json::from_value(core_registration_response(response)?)
            .map_err(|error| error.to_string())?;
    let credential = core
        .register_credential(&parsed, &state, None)
        .map_err(|error| format!("{error:?}"))?;
    if credential.cred_id.as_slice() != response_id {
        return Err("credential ID mismatch".into());
    }
    let parsed_key: serde_cbor_2::Value =
        serde_cbor_2::from_slice(&public_key).map_err(|error| error.to_string())?;
    if COSEKey::try_from(&parsed_key).map_err(|error| format!("{error:?}"))? != credential.cred {
        return Err("credential public key mismatch".into());
    }
    Ok(StoredCredential {
        id: URL_SAFE_NO_PAD.encode(credential.cred_id.as_slice()),
        public_key,
        counter: credential.counter,
        transports: response["response"]["transports"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn verify_authentication(
    response: &Value,
    challenge: &str,
    origin: &str,
    rp_id: &str,
    stored: &StoredCredential,
) -> Result<u32, String> {
    let response_id = check_credential_id(response)?;
    check_client_data(response, "webauthn.get", challenge, origin)?;
    if URL_SAFE_NO_PAD.encode(&response_id) != stored.id {
        return Err("credential ID mismatch".into());
    }
    let key_value: serde_cbor_2::Value =
        serde_cbor_2::from_slice(&stored.public_key).map_err(|error| error.to_string())?;
    let algorithm = cose_number(&cose_map(&stored.public_key)?, 3)?;
    let auth_data = URL_SAFE_NO_PAD
        .decode(
            response["response"]["authenticatorData"]
                .as_str()
                .ok_or("missing authenticator data")?,
        )
        .map_err(|error| error.to_string())?;
    if auth_data.len() < 37 {
        return Err("short authenticator data".into());
    }
    if algorithm == -36 || rsa_digest(algorithm).is_ok() {
        return verify_fallback_authentication(response, rp_id, stored, algorithm, &auth_data);
    }
    let key = COSEKey::try_from(&key_value).map_err(|error| format!("{error:?}"))?;
    let backup_eligible = auth_data[32] & 0x08 != 0;
    let credential = Credential {
        cred_id: response_id.into(),
        cred: key,
        counter: stored.counter,
        transports: None,
        user_verified: true,
        backup_eligible,
        backup_state: auth_data[32] & 0x10 != 0,
        registration_policy: UserVerificationPolicy::Required,
        extensions: RegisteredExtensions::none(),
        attestation: ParsedAttestation::default(),
        attestation_format: AttestationFormat::None,
    };
    let core = core(rp_id, origin)?;
    let builder = core
        .new_challenge_authenticate_builder(
            vec![credential],
            Some(UserVerificationPolicy::Required),
        )
        .map_err(|error| format!("{error:?}"))?;
    let (_, state) = core
        .generate_challenge_authenticate(builder)
        .map_err(|error| format!("{error:?}"))?;
    let state: AuthenticationState = expected_state(&state, challenge)?;
    let parsed: PublicKeyCredential =
        serde_json::from_value(response.clone()).map_err(|error| error.to_string())?;
    let result = core
        .authenticate_credential(&parsed, &state)
        .map_err(|error| format!("{error:?}"))?;
    Ok(result.counter())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-interop.json"
        ))
        .unwrap()
    }

    #[test]
    fn simplewebauthn_registration_and_assertion_interoperate() {
        let fixture = fixture();
        let rp_id = fixture["rpId"].as_str().unwrap();
        let origin = fixture["origin"].as_str().unwrap();
        let registered = verify_registration(
            &fixture["registration"],
            fixture["registrationChallenge"].as_str().unwrap(),
            origin,
            rp_id,
        )
        .unwrap();
        assert_eq!(registered.id, fixture["credentialId"]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&registered.public_key),
            fixture["publicKey"]
        );
        assert_eq!(registered.counter, 0);
        assert_eq!(
            verify_authentication(
                &fixture["assertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &registered
            )
            .unwrap(),
            1
        );
        let from_ts = StoredCredential {
            id: fixture["credentialId"].as_str().unwrap().into(),
            public_key: URL_SAFE_NO_PAD
                .decode(fixture["publicKey"].as_str().unwrap())
                .unwrap(),
            counter: 0,
            transports: vec!["internal".into()],
        };
        assert_eq!(
            verify_authentication(
                &fixture["assertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &from_ts
            )
            .unwrap(),
            1
        );
        assert_eq!(
            verify_authentication(
                &fixture["zeroCounterAssertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &from_ts
            )
            .unwrap(),
            0
        );
        let backed_up = verify_registration(
            &fixture["backedUpRegistration"],
            fixture["registrationChallenge"].as_str().unwrap(),
            origin,
            rp_id,
        )
        .unwrap();
        assert_eq!(backed_up.public_key, from_ts.public_key);
        assert_eq!(
            verify_authentication(
                &fixture["backedUpAssertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &backed_up
            )
            .unwrap(),
            0
        );
        assert_eq!(
            verify_authentication(
                &fixture["backedUpAssertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &from_ts
            )
            .unwrap(),
            0
        );
        let eddsa = verify_registration(
            &fixture["eddsa"]["registration"],
            fixture["registrationChallenge"].as_str().unwrap(),
            origin,
            rp_id,
        )
        .unwrap();
        assert_eq!(eddsa.id, fixture["eddsa"]["credentialId"]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&eddsa.public_key),
            fixture["eddsa"]["publicKey"]
        );
        assert_eq!(
            verify_authentication(
                &fixture["eddsa"]["assertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &eddsa
            )
            .unwrap(),
            1
        );
        let es512 = verify_registration(
            &fixture["es512"]["registration"],
            fixture["registrationChallenge"].as_str().unwrap(),
            origin,
            rp_id,
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&es512.public_key),
            fixture["es512"]["publicKey"]
        );
        assert_eq!(
            verify_authentication(
                &fixture["es512"]["assertion"],
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &es512
            )
            .unwrap(),
            1
        );
        for packed in [
            "packedEs256",
            "packedPs256",
            "packedRs256Rs384",
            "packedFullRs256",
        ] {
            let stored = verify_registration(
                &fixture[packed],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .unwrap_or_else(|error| panic!("{packed}: {error}"));
            assert_eq!(stored.counter, 0);
        }
        assert!(
            verify_registration(
                &fixture["invalidPackedSignature"],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .is_err()
        );
        assert!(
            verify_registration(
                &fixture["invalidPackedPadding"],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .is_err()
        );
        for invalid in ["invalidPackedFullSubject", "invalidPackedFullSignature"] {
            assert!(
                verify_registration(
                    &fixture[invalid],
                    fixture["registrationChallenge"].as_str().unwrap(),
                    origin,
                    rp_id,
                )
                .is_err(),
                "{invalid}"
            );
        }
        for u2f in ["u2fRegistration", "u2fExtraCertificate"] {
            let stored = verify_registration(
                &fixture[u2f],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .unwrap_or_else(|error| panic!("{u2f}: {error}"));
            assert_eq!(stored.counter, 0);
        }
        assert!(
            verify_registration(
                &fixture["invalidU2fAaguid"],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .is_err()
        );
        assert!(
            verify_registration(
                &fixture["invalidU2fSignature"],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .is_err()
        );
        for algorithm in ["rs256", "ps256", "ps384", "ps512", "rs384", "rs512", "rs1"] {
            let vector = &fixture[algorithm];
            let credential = verify_registration(
                &vector["registration"],
                fixture["registrationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
            )
            .unwrap_or_else(|error| panic!("{algorithm} registration: {error}"));
            assert_eq!(credential.id, vector["credentialId"]);
            assert_eq!(
                URL_SAFE_NO_PAD.encode(&credential.public_key),
                vector["publicKey"]
            );
            assert_eq!(
                verify_authentication(
                    &vector["assertion"],
                    fixture["authenticationChallenge"].as_str().unwrap(),
                    origin,
                    rp_id,
                    &credential,
                )
                .unwrap_or_else(|error| panic!("{algorithm} authentication: {error}")),
                1
            );
        }
    }

    #[test]
    fn rejects_invalid_assertions_and_counters() {
        let fixture = fixture();
        let rp_id = fixture["rpId"].as_str().unwrap();
        let origin = fixture["origin"].as_str().unwrap();
        let stored = StoredCredential {
            id: fixture["credentialId"].as_str().unwrap().into(),
            public_key: URL_SAFE_NO_PAD
                .decode(fixture["publicKey"].as_str().unwrap())
                .unwrap(),
            counter: 0,
            transports: vec![],
        };
        let response = &fixture["assertion"];
        assert!(verify_authentication(response, "wrong", origin, rp_id, &stored).is_err());
        assert!(
            verify_authentication(
                response,
                fixture["authenticationChallenge"].as_str().unwrap(),
                "https://wrong.example.test",
                rp_id,
                &stored
            )
            .is_err()
        );
        assert!(
            verify_authentication(
                response,
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                "wrong.example.test",
                &stored
            )
            .is_err()
        );
        let mut no_uv = response.clone();
        let mut auth_data = URL_SAFE_NO_PAD
            .decode(response["response"]["authenticatorData"].as_str().unwrap())
            .unwrap();
        auth_data[32] &= !0x04;
        no_uv["response"]["authenticatorData"] = json!(URL_SAFE_NO_PAD.encode(auth_data));
        assert!(
            verify_authentication(
                &no_uv,
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &stored
            )
            .is_err()
        );
        let mut bad_signature = response.clone();
        bad_signature["response"]["signature"] = json!(URL_SAFE_NO_PAD.encode([0_u8; 64]));
        assert!(
            verify_authentication(
                &bad_signature,
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &stored
            )
            .is_err()
        );
        let stale_counter = StoredCredential {
            counter: 1,
            ..stored
        };
        assert!(
            verify_authentication(
                response,
                fixture["authenticationChallenge"].as_str().unwrap(),
                origin,
                rp_id,
                &stale_counter
            )
            .is_err()
        );

        let registration = &fixture["registration"];
        let registration_challenge = fixture["registrationChallenge"].as_str().unwrap();
        assert!(verify_registration(registration, "wrong", origin, rp_id).is_err());
        assert!(
            verify_registration(
                registration,
                registration_challenge,
                "https://wrong.example.test",
                rp_id
            )
            .is_err()
        );
        assert!(
            verify_registration(
                registration,
                registration_challenge,
                origin,
                "wrong.example.test"
            )
            .is_err()
        );
        let mut no_uv_registration = registration.clone();
        let bytes = URL_SAFE_NO_PAD
            .decode(
                registration["response"]["attestationObject"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        let mut object: serde_cbor_2::Value = serde_cbor_2::from_slice(&bytes).unwrap();
        let serde_cbor_2::Value::Map(ref mut map) = object else {
            panic!("attestation fixture must be a map")
        };
        let serde_cbor_2::Value::Bytes(auth_data) = map
            .get_mut(&serde_cbor_2::Value::Text("authData".into()))
            .unwrap()
        else {
            panic!("fixture must include authenticator data")
        };
        auth_data[32] &= !0x04;
        no_uv_registration["response"]["attestationObject"] =
            json!(URL_SAFE_NO_PAD.encode(serde_cbor_2::to_vec(&object).unwrap()));
        assert!(
            verify_registration(&no_uv_registration, registration_challenge, origin, rp_id)
                .is_err()
        );
        assert!(
            verify_registration(
                &fixture["badAttestationStatement"],
                registration_challenge,
                origin,
                rp_id
            )
            .is_err()
        );
    }

    #[test]
    fn fallback_keeps_ceremony_and_attestation_checks() {
        let fixture = fixture();
        let challenge = fixture["authenticationChallenge"].as_str().unwrap();
        let registration_challenge = fixture["registrationChallenge"].as_str().unwrap();
        let origin = fixture["origin"].as_str().unwrap();
        let rp_id = fixture["rpId"].as_str().unwrap();
        for algorithm in ["ps256", "es512", "rs1"] {
            let vector = &fixture[algorithm];
            let stored = verify_registration(
                &vector["registration"],
                registration_challenge,
                origin,
                rp_id,
            )
            .unwrap();
            let assertion = &vector["assertion"];
            assert!(verify_authentication(assertion, "wrong", origin, rp_id, &stored).is_err());
            assert!(
                verify_authentication(
                    assertion,
                    challenge,
                    "https://wrong.example.test",
                    rp_id,
                    &stored
                )
                .is_err()
            );
            assert!(
                verify_authentication(assertion, challenge, origin, "wrong.example.test", &stored)
                    .is_err()
            );
            let mut no_uv = assertion.clone();
            let mut auth_data = URL_SAFE_NO_PAD
                .decode(assertion["response"]["authenticatorData"].as_str().unwrap())
                .unwrap();
            auth_data[32] &= !0x04;
            no_uv["response"]["authenticatorData"] = json!(URL_SAFE_NO_PAD.encode(auth_data));
            assert!(verify_authentication(&no_uv, challenge, origin, rp_id, &stored).is_err());
            let mut bad_signature = assertion.clone();
            bad_signature["response"]["signature"] = json!(URL_SAFE_NO_PAD.encode([0_u8; 256]));
            assert!(
                verify_authentication(&bad_signature, challenge, origin, rp_id, &stored).is_err()
            );
            let stale = StoredCredential {
                counter: 1,
                ..stored
            };
            assert!(verify_authentication(assertion, challenge, origin, rp_id, &stale).is_err());

            let registration = &vector["registration"];
            let object = URL_SAFE_NO_PAD
                .decode(
                    registration["response"]["attestationObject"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
            let mut object: serde_cbor_2::Value = serde_cbor_2::from_slice(&object).unwrap();
            let serde_cbor_2::Value::Map(ref mut map) = object else {
                panic!("fixture must be a map")
            };
            let serde_cbor_2::Value::Map(statement) = map
                .get_mut(&serde_cbor_2::Value::Text("attStmt".into()))
                .unwrap()
            else {
                panic!("fixture must have an attestation statement")
            };
            statement.insert(
                serde_cbor_2::Value::Text("sig".into()),
                serde_cbor_2::Value::Bytes(vec![0; 8]),
            );
            let mut bad_statement = registration.clone();
            bad_statement["response"]["attestationObject"] =
                json!(URL_SAFE_NO_PAD.encode(serde_cbor_2::to_vec(&object).unwrap()));
            assert!(
                verify_registration(&bad_statement, registration_challenge, origin, rp_id).is_err()
            );
        }
        assert!(
            verify_registration(
                &fixture["invalidTokenBindingRegistration"],
                registration_challenge,
                origin,
                rp_id
            )
            .is_err()
        );
        let ps256 = verify_registration(
            &fixture["ps256"]["registration"],
            registration_challenge,
            origin,
            rp_id,
        )
        .unwrap();
        assert!(
            verify_authentication(
                &fixture["invalidTokenBindingAssertion"],
                challenge,
                origin,
                rp_id,
                &ps256
            )
            .is_err()
        );
        assert_eq!(
            verify_authentication(
                &fixture["crossOriginAssertion"],
                challenge,
                origin,
                rp_id,
                &ps256
            )
            .unwrap(),
            1
        );
    }
}
