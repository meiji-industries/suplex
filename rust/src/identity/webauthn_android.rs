//! Android Key statement checks matching the installed SimpleWebAuthn v13
//! verifier. Core additionally requires Keymaster origin/purpose tags, which
//! are not requirements of the installed SDK and reject accepted credentials.

use std::collections::BTreeMap;

use openssl::{
    pkey::Id,
    rsa::Padding,
    sign::{RsaPssSaltlen, Verifier},
    x509::X509,
};
use serde_cbor_2::Value;
use sha2::{Digest, Sha256};
use x509_parser::{der_parser::parse_der, parse_x509_certificate};

use super::{cose_bytes, cose_map, rsa_digest, safetynet, trust};

pub(super) struct Prepared {
    certificates: Vec<Value>,
    signature: Vec<u8>,
    algorithm: Value,
    leaf_der: Vec<u8>,
}

pub(super) fn precheck(
    statement: &BTreeMap<Value, Value>,
    client_data: &[u8],
    public_key: &[u8],
) -> Result<Prepared, String> {
    let Some(Value::Array(certificates)) = statement.get(&Value::Text("x5c".into())) else {
        return Err("missing Android Key certificates".into());
    };
    let Some(Value::Bytes(signature)) = statement.get(&Value::Text("sig".into())) else {
        return Err("missing Android Key signature".into());
    };
    let Some(algorithm) = statement.get(&Value::Text("alg".into())) else {
        return Err("missing Android Key algorithm".into());
    };
    let known_algorithm = match algorithm {
        Value::Integer(value) => matches!(
            value,
            -7 | -8 | -35 | -36 | -37 | -38 | -39 | -47 | -257 | -258 | -259 | -65535
        ),
        // Numeric TypeScript enums expose reverse-mapping names to isCOSEAlg().
        // The subsequent digest mapping rejects these after the path/CRL check.
        Value::Text(value) => matches!(
            value.as_str(),
            "ES256"
                | "EdDSA"
                | "ES384"
                | "ES512"
                | "PS256"
                | "PS384"
                | "PS512"
                | "ES256K"
                | "RS256"
                | "RS384"
                | "RS512"
                | "RS1"
        ),
        _ => false,
    };
    if !known_algorithm {
        return Err("invalid Android Key algorithm".into());
    }
    let Some(Value::Bytes(leaf_der)) = certificates.first() else {
        return Err("missing Android Key leaf".into());
    };
    let (_, parsed) = parse_x509_certificate(leaf_der).map_err(|error| error.to_string())?;
    let key = cose_map(public_key)?;
    let mut credential_key = vec![4_u8];
    credential_key.extend_from_slice(cose_bytes(&key, -2)?);
    if let Ok(y) = cose_bytes(&key, -3) {
        credential_key.extend_from_slice(y);
    }
    if parsed.tbs_certificate.subject_pki.subject_public_key.data != credential_key {
        return Err("Android Key certificate public key mismatch".into());
    }
    let extension = parsed
        .extensions()
        .iter()
        .find(|extension| extension.oid.to_id_string() == "1.3.6.1.4.1.11129.2.1.17")
        .ok_or("missing Android Key keyDescription")?;
    let (_, description) = parse_der(extension.value).map_err(|error| error.to_string())?;
    let fields = description
        .as_sequence()
        .map_err(|error| error.to_string())?;
    if fields.len() < 8 {
        return Err("short Android Key keyDescription".into());
    }
    let challenge = fields[4].as_slice().map_err(|error| error.to_string())?;
    if challenge != Sha256::digest(client_data).as_slice() {
        return Err("Android Key attestation challenge mismatch".into());
    }
    for list in [&fields[6], &fields[7]] {
        let entries = list.as_sequence().map_err(|error| error.to_string())?;
        if entries.iter().any(|entry| entry.tag().0 == 600) {
            return Err("Android Key allApplications is present".into());
        }
    }
    Ok(Prepared {
        certificates: certificates.clone(),
        signature: signature.clone(),
        algorithm: algorithm.clone(),
        leaf_der: leaf_der.clone(),
    })
}

pub(super) fn verify(
    prepared: Prepared,
    auth_data: &[u8],
    client_data: &[u8],
    now_unix: i64,
    test_roots: Option<&[&[u8]]>,
) -> Result<(), String> {
    if let Some(roots) = test_roots {
        trust::verify_android_key_with_roots(&prepared.certificates, now_unix, roots)?;
    } else {
        trust::verify_android_key(&prepared.certificates, now_unix)?;
    }
    let leaf = X509::from_der(&prepared.leaf_der).map_err(|error| error.to_string())?;
    let (_, digest_algorithm) = safetynet::signature_algorithm(
        &BTreeMap::from([(Value::Text("alg".into()), prepared.algorithm.clone())]),
        &prepared.leaf_der,
    )?;
    let digest = safetynet::digest(digest_algorithm)?;
    let key = leaf.public_key().map_err(|error| error.to_string())?;
    let mut verifier = Verifier::new(digest, &key).map_err(|error| error.to_string())?;
    if key.id() == Id::RSA {
        let (certificate_algorithm, _) =
            safetynet::signature_algorithm(&BTreeMap::new(), &prepared.leaf_der)?;
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
    let mut signed = auth_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data));
    verifier
        .update(&signed)
        .map_err(|error| error.to_string())?;
    if verifier
        .verify(&prepared.signature)
        .map_err(|error| error.to_string())?
    {
        Ok(())
    } else {
        Err("Android Key signature mismatch".into())
    }
}
