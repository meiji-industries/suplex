//! TPM attestation gap in webauthn-rs-core: its SHA-1 signature branch rejects
//! a response accepted by the installed SimpleWebAuthn verifier.

use std::collections::BTreeMap;

use openssl::{
    hash::{MessageDigest, hash},
    rsa::Padding,
    sign::{RsaPssSaltlen, Verifier},
    x509::X509,
};
use serde_cbor_2::Value;
use sha2::{Digest, Sha256};
use x509_parser::{extensions::GeneralName, parse_x509_certificate};

use super::{cose_bytes, cose_map, cose_number, rsa_digest};

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or("TPM length overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("short TPM structure")?;
        self.offset = end;
        Ok(value)
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_be_bytes(
            self.take(2)?.try_into().map_err(|_| "short TPM u16")?,
        ))
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| "short TPM u32")?,
        ))
    }

    fn sized(&mut self) -> Result<&'a [u8], String> {
        let size = usize::from(self.u16()?);
        self.take(size)
    }
}

fn field<'a>(statement: &'a BTreeMap<Value, Value>, name: &str) -> Result<&'a Value, String> {
    statement
        .get(&Value::Text(name.into()))
        .ok_or_else(|| format!("missing TPM {name}"))
}

fn bytes<'a>(statement: &'a BTreeMap<Value, Value>, name: &str) -> Result<&'a [u8], String> {
    match field(statement, name)? {
        Value::Bytes(bytes) => Ok(bytes),
        _ => Err(format!("invalid TPM {name}")),
    }
}

fn digest(algorithm: i128) -> Result<MessageDigest, String> {
    match algorithm {
        -7 | -257 | -37 => Ok(MessageDigest::sha256()),
        -35 | -258 | -38 => Ok(MessageDigest::sha384()),
        -36 | -259 | -39 => Ok(MessageDigest::sha512()),
        -65535 => Ok(MessageDigest::sha1()),
        _ => Err("unsupported TPM attestation algorithm".into()),
    }
}

fn verify_pub_area(pub_area: &[u8], public_key: &[u8]) -> Result<(), String> {
    let key = cose_map(public_key)?;
    let mut cursor = Cursor::new(pub_area);
    let key_type = cursor.u16()?;
    cursor.take(2)?; // nameAlg; certInfo names the hash actually used.
    cursor.take(4)?; // objectAttributes
    cursor.sized()?; // authPolicy
    cursor.take(4)?; // symmetric and scheme
    match key_type {
        0x0001 => {
            cursor.take(2)?; // keyBits
            let exponent = cursor.u32()?;
            let modulus = cursor.sized()?;
            if cose_number(&key, 1)? != 3 || modulus != cose_bytes(&key, -1)? {
                return Err("TPM RSA public key mismatch".into());
            }
            let cose_exponent = cose_bytes(&key, -2)?;
            // SimpleWebAuthn's TPM parser reads the first three COSE bytes as a
            // little-endian integer, including its 65537 default handling.
            let actual = u32::from(*cose_exponent.first().unwrap_or(&0))
                | (u32::from(*cose_exponent.get(1).unwrap_or(&0)) << 8)
                | (u32::from(*cose_exponent.get(2).unwrap_or(&0)) << 16);
            if (if exponent == 0 { 65537 } else { exponent }) != actual {
                return Err("TPM RSA exponent mismatch".into());
            }
        }
        0x0023 => {
            let curve = cursor.u16()?;
            cursor.take(2)?; // KDF
            let x = cursor.sized()?;
            let y = cursor.sized()?;
            let cose_curve = match curve {
                0x0003 | 0x0010 | 0x0020 => 1,
                0x0004 => 2,
                0x0005 => 3,
                _ => return Err("unsupported TPM ECC curve".into()),
            };
            if cose_number(&key, 1)? != 2
                || cose_number(&key, -1)? != cose_curve
                || x != cose_bytes(&key, -2)?
                || y != cose_bytes(&key, -3)?
            {
                return Err("TPM ECC public key mismatch".into());
            }
        }
        _ => return Err("unsupported TPM key type".into()),
    }
    Ok(())
}

fn verify_cert_info(
    cert_info: &[u8],
    pub_area: &[u8],
    auth_data: &[u8],
    client_data: &[u8],
    algorithm: i128,
) -> Result<(), String> {
    let mut cursor = Cursor::new(cert_info);
    if cursor.u32()? != 0xff54_4347 || cursor.u16()? != 0x8017 {
        return Err("invalid TPM certify header".into());
    }
    cursor.sized()?; // qualifiedSigner
    let extra_data = cursor.sized()?;
    cursor.take(17)?; // clockInfo
    cursor.take(8)?; // firmwareVersion
    let name = cursor.sized()?;
    cursor.sized()?; // qualifiedName
    let mut signed = auth_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data));
    if hash(digest(algorithm)?, &signed)
        .map_err(|error| error.to_string())?
        .as_ref()
        != extra_data
    {
        return Err("TPM certInfo extraData mismatch".into());
    }
    let (name_algorithm, expected_hash) = match name.get(..2) {
        Some([0x00, 0x0b]) => (0x000b_u16, MessageDigest::sha256()),
        Some([0x00, 0x0c]) => (0x000c_u16, MessageDigest::sha384()),
        Some([0x00, 0x0d]) => (0x000d_u16, MessageDigest::sha512()),
        _ => return Err("unsupported TPM attested name hash".into()),
    };
    let mut expected_name = name_algorithm.to_be_bytes().to_vec();
    expected_name
        .extend_from_slice(&hash(expected_hash, pub_area).map_err(|error| error.to_string())?);
    if name != expected_name {
        return Err("TPM pubArea name mismatch".into());
    }
    Ok(())
}

fn verify_aik_certificate(leaf_der: &[u8], aaguid: &[u8]) -> Result<X509, String> {
    let leaf = X509::from_der(leaf_der).map_err(|error| error.to_string())?;
    let (_, parsed) = parse_x509_certificate(leaf_der).map_err(|error| error.to_string())?;
    if parsed.version().0 != 2 || parsed.subject().iter_attributes().next().is_some() {
        return Err("invalid TPM AIK certificate profile".into());
    }
    if !parsed.validity().is_valid() {
        return Err("TPM AIK certificate is outside its validity period".into());
    }
    if parsed
        .basic_constraints()
        .map_err(|error| error.to_string())?
        .is_some_and(|extension| extension.value.ca)
    {
        return Err("TPM AIK certificate is a CA".into());
    }
    let san = parsed
        .subject_alternative_name()
        .map_err(|error| error.to_string())?
        .ok_or("TPM AIK certificate has no SAN")?;
    let manufacturer_ids = [
        "414D4400", "414E5400", "41544D4C", "4252434D", "4353434F", "464C5953", "524F4343",
        "474F4F47", "48504900", "48504500", "48495349", "49424D00", "49465800", "494E5443",
        "4C454E00", "4D534654", "4E534D20", "4E545A00", "4E534700", "4E544300", "51434F4D",
        "534D534E", "53454345", "534E5300", "534D5343", "53544D20", "54584E00", "57454300",
        "5345414C", "FFFFF1D0",
    ];
    let san_valid = san.value.general_names.iter().any(|name| {
        let GeneralName::DirectoryName(directory) = name else {
            return false;
        };
        let mut manufacturer = None;
        let mut model = None;
        let mut version = None;
        for item in directory.iter_attributes() {
            let Ok(value) = item.as_str() else { continue };
            match item.attr_type().to_id_string().as_str() {
                "2.23.133.2.1" => manufacturer = value.strip_prefix("id:"),
                "2.23.133.2.2" => model = Some(value),
                "2.23.133.2.3" => version = Some(value),
                _ => {}
            }
        }
        manufacturer.is_some_and(|id| manufacturer_ids.contains(&id))
            && model.is_some_and(|value| !value.is_empty())
            && version.is_some_and(|value| !value.is_empty())
    });
    if !san_valid {
        return Err("invalid TPM AIK SAN".into());
    }
    let usage = parsed
        .extended_key_usage()
        .map_err(|error| error.to_string())?
        .ok_or("TPM AIK certificate has no extended key usage")?;
    if usage
        .value
        .other
        .first()
        .map(|oid| oid.to_id_string())
        .as_deref()
        != Some("2.23.133.8.3")
    {
        return Err("invalid TPM AIK extended key usage".into());
    }
    for extension in parsed.extensions() {
        if extension.oid.to_id_string() == "1.3.6.1.4.1.45724.1.1.4"
            && (extension.value.get(..2) != Some(&[0x04, 0x10])
                || extension.value.get(2..18) != Some(aaguid)
                || extension.value.len() != 18)
        {
            return Err("TPM AIK AAGUID mismatch".into());
        }
    }
    Ok(leaf)
}

pub(super) fn verify(
    statement: &BTreeMap<Value, Value>,
    auth_data: &[u8],
    client_data: &[u8],
    public_key: &[u8],
) -> Result<(), String> {
    if field(statement, "ver")? != &Value::Text("2.0".into()) {
        return Err("unsupported TPM version".into());
    }
    let Value::Integer(algorithm) = field(statement, "alg")? else {
        return Err("invalid TPM algorithm".into());
    };
    let algorithm = *algorithm;
    let signature = bytes(statement, "sig")?;
    let pub_area = bytes(statement, "pubArea")?;
    let cert_info = bytes(statement, "certInfo")?;
    let Value::Array(certificates) = field(statement, "x5c")? else {
        return Err("invalid TPM x5c".into());
    };
    let Some(Value::Bytes(leaf_der)) = certificates.first() else {
        return Err("missing TPM AIK certificate".into());
    };
    verify_pub_area(pub_area, public_key)?;
    verify_cert_info(cert_info, pub_area, auth_data, client_data, algorithm)?;
    let leaf = verify_aik_certificate(leaf_der, auth_data.get(37..53).ok_or("missing AAGUID")?)?;
    let key = leaf.public_key().map_err(|error| error.to_string())?;
    let digest = digest(algorithm)?;
    let mut verifier = Verifier::new(digest, &key).map_err(|error| error.to_string())?;
    if rsa_digest(algorithm).is_ok() {
        let (_, padding) = rsa_digest(algorithm)?;
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
        .update(cert_info)
        .map_err(|error| error.to_string())?;
    if !verifier
        .verify(signature)
        .map_err(|error| error.to_string())?
    {
        return Err("invalid TPM attestation signature".into());
    }
    Ok(())
}
