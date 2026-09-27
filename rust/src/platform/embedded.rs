pub struct EmbeddedFile {
    pub name: &'static str,
    pub bytes: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

pub fn frontend_asset(name: &str) -> Option<&'static [u8]> {
    FRONTEND
        .iter()
        .find(|asset| asset.name == name)
        .map(|asset| asset.bytes)
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
    fn bundled_frontend_entry_is_readable_when_built() {
        if !FRONTEND.is_empty() {
            assert!(!frontend_asset("suplex-ui.js").unwrap().is_empty());
            assert!(!frontend_asset("suplex-ui.css").unwrap().is_empty());
        }
    }
}
