pub mod blocking;
pub mod fs;
pub mod hash;
pub mod ids;
pub mod js_json;
pub mod time;

/// JavaScript `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_like_javascript() {
        assert_eq!(
            super::encode_uri_component("a b/c?d=é~*'()!"),
            "a%20b%2Fc%3Fd%3D%C3%A9~*'()!"
        );
    }
}
