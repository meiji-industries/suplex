pub struct EmbeddedFile {
    pub name: &'static str,
    pub bytes: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

fn lookup(files: &[EmbeddedFile], name: &str) -> Option<&'static [u8]> {
    files
        .iter()
        .find(|asset| asset.name == name)
        .map(|asset| asset.bytes)
}

pub fn frontend_asset(name: &str) -> Option<&'static [u8]> {
    lookup(FRONTEND, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_migrations_contain_sql() {
        assert!(!MIGRATIONS.is_empty());
        assert!(
            MIGRATIONS
                .iter()
                .all(|migration| migration.name.ends_with(".sql") && !migration.bytes.is_empty())
        );
    }

    #[test]
    fn frontend_asset_lookup_returns_matching_bytes_and_none_for_unknown() {
        const FIXTURES: &[EmbeddedFile] = &[
            EmbeddedFile {
                name: "suplex-ui.js",
                bytes: b"export {};",
            },
            EmbeddedFile {
                name: "suplex-ui.css",
                bytes: b"body{}",
            },
        ];
        assert_eq!(lookup(FIXTURES, "suplex-ui.js"), Some(&b"export {};"[..]));
        assert_eq!(lookup(FIXTURES, "suplex-ui.css"), Some(&b"body{}"[..]));
        assert_eq!(lookup(FIXTURES, "missing.js"), None);
        if !FRONTEND.is_empty() {
            assert!(!frontend_asset("suplex-ui.js").unwrap().is_empty());
            assert!(!frontend_asset("suplex-ui.css").unwrap().is_empty());
        }
    }
}
