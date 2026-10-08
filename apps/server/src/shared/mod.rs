mod failure;
pub mod fs;
pub mod hash;
pub mod ids;
pub mod js_json;
pub mod page;
pub mod time;
#[cfg(test)]
mod vocabulary_check;

pub use failure::{PublicFailure, public_failure};

/// A closed set of persisted snake_case strings: serde, SQLite, and
/// `as_str` all use the one spelling. Variants order as declared.
macro_rules! wire_enum {
    ($(#[$meta:meta])* pub enum $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord,
            serde::Serialize, serde::Deserialize, ts_rs::TS,
        )]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl rusqlite::types::FromSql for $name {
            fn column_result(
                value: rusqlite::types::ValueRef<'_>,
            ) -> rusqlite::types::FromSqlResult<Self> {
                let text = value.as_str()?;
                Self::parse(text).ok_or_else(|| {
                    rusqlite::types::FromSqlError::Other(
                        format!("unknown {} {text:?}", stringify!($name)).into(),
                    )
                })
            }
        }

        impl rusqlite::types::ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }
    };
}
pub(crate) use wire_enum;

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
