use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256.
pub fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
