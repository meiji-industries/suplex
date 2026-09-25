use std::io;
use subtle::ConstantTimeEq;

pub const ROOT_BINDING_ENV: &str = "SUPLEX_ROOT_BINDING";
pub const ROOT_TOKEN_ENV: &str = "SUPLEX_ROOT_TOKEN";
pub const ADVISOR_BINDING_ENV: &str = "SUPLEX_ADVISOR_BINDING";
pub const ADVISOR_TOKEN_ENV: &str = "SUPLEX_ADVISOR_TOKEN";
pub const ADVISOR_RESULT_ENV: &str = "SUPLEX_ADVISOR_RESULT";

pub fn binding_path(name: &str, label: &str) -> io::Result<std::path::PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .ok_or_else(|| {
            io::Error::other(format!("{label} bridge requires {name} in its environment"))
        })
}

pub fn valid_token(value: &str) -> bool {
    if matches!(
        value,
        "00000000-0000-0000-0000-000000000000" | "ffffffff-ffff-ffff-ffff-ffffffffffff"
    ) {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
}

pub fn authenticate_token(
    expected: &str,
    actual: Option<&str>,
    name: &str,
    label: &str,
) -> io::Result<()> {
    if !valid_token(expected) {
        return Err(io::Error::other(format!(
            "{label} bridge binding token is invalid"
        )));
    }
    let actual = actual.filter(|value| valid_token(value)).ok_or_else(|| {
        io::Error::other(format!(
            "{label} bridge authentication failed: {name} is unset or invalid"
        ))
    })?;
    if bool::from(expected.as_bytes().ct_eq(actual.as_bytes())) {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{label} bridge authentication failed: {name} does not match the binding"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_binding_requires_exact_uuid_without_exposing_it() {
        let expected = "5eeafcf2-02ca-4af0-a4dd-e7b35170dcf2";
        assert!(valid_token(expected));
        assert!(valid_token("5EEAFCF2-02CA-4AF0-A4DD-E7B35170DCF2"));
        assert!(valid_token("00000000-0000-0000-0000-000000000000"));
        assert!(valid_token("ffffffff-ffff-ffff-ffff-ffffffffffff"));
        for rejected in [
            "5eeafcf202ca4af0a4dde7b35170dcf2",
            "urn:uuid:5eeafcf2-02ca-4af0-a4dd-e7b35170dcf2",
            "5eeafcf2-02ca-0af0-a4dd-e7b35170dcf2",
            "5eeafcf2-02ca-4af0-14dd-e7b35170dcf2",
        ] {
            assert!(!valid_token(rejected));
            assert!(
                authenticate_token(
                    rejected,
                    Some(rejected),
                    ADVISOR_TOKEN_ENV,
                    "Advisor report"
                )
                .is_err()
            );
        }
        assert!(
            authenticate_token(
                expected,
                Some(expected),
                ADVISOR_TOKEN_ENV,
                "Advisor report"
            )
            .is_ok()
        );
        assert!(
            authenticate_token(
                expected,
                Some("b0fbd9f7-ac8f-498e-b6e3-1a224596f19c"),
                ADVISOR_TOKEN_ENV,
                "Advisor report"
            )
            .is_err()
        );
        assert!(
            authenticate_token(expected, Some("bad"), ADVISOR_TOKEN_ENV, "Advisor report").is_err()
        );
        assert!(authenticate_token(expected, None, ADVISOR_TOKEN_ENV, "Advisor report").is_err());
        assert!(
            authenticate_token(
                expected,
                Some("5EEAFCF2-02CA-4AF0-A4DD-E7B35170DCF2"),
                ADVISOR_TOKEN_ENV,
                "Advisor report"
            )
            .is_err()
        );
    }
}
