use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

/// `bytes` random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer)?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `<prefix>_<32 hex>`, the TypeScript `randomBytes(16).toString("hex")` id.
pub fn random_hex_id(prefix: &str) -> Result<String, getrandom::Error> {
    Ok(format!("{prefix}_{}", random_hex(16)?))
}

/// `<prefix>_<43 base64url>`, the TypeScript `randomBytes(32).toString("base64url")` secret.
pub fn random_secret(prefix: &str) -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes)))
}
