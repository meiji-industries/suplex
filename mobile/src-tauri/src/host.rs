//! Which host the phone shows: address policy, navigation policy, and the saved host.

use std::path::Path;

use url::Url;

pub const INVALID_HOST: &str =
    "Write an HTTPS address, for example https://studio.tail1234.ts.net.";

/// An https origin only. A phone never reaches its own loopback host, so plain http is refused.
pub fn parse_host(input: &str) -> Result<Url, &'static str> {
    let input = input.trim();
    let candidate = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&candidate).map_err(|_| INVALID_HOST)?;
    if url.scheme() != "https"
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(INVALID_HOST);
    }
    Url::parse(&format!("{}/", url.origin().ascii_serialization())).map_err(|_| INVALID_HOST)
}

/// `suplex://join?url=<https URL>` from a company invitation: only its host address.
pub fn invitation_host(link: &Url) -> Option<Url> {
    if link.scheme() != "suplex" || link.host_str() != Some("join") {
        return None;
    }
    let mut values = link.query_pairs().filter(|(key, _)| key == "url");
    let (_, only) = values.next()?;
    if values.next().is_some() || !only.starts_with("https://") {
        return None;
    }
    let target = Url::parse(&only).ok()?;
    parse_host(&target.origin().ascii_serialization()).ok()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    External(Url),
    Block,
}

fn bundled(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

/// Where a navigation goes: bundled pages and the current host stay, other web pages open in the browser. Fails closed.
pub fn classify(url: &Url, host: Option<&Url>) -> Navigation {
    if bundled(url) || host.is_some_and(|host| host.origin() == url.origin()) {
        return Navigation::Allow;
    }
    match url.scheme() {
        "http" | "https" => Navigation::External(url.clone()),
        _ => Navigation::Block,
    }
}

const SAVED_HOST: &str = "host.json";

/// A file that cannot be read or parsed counts as no saved host.
pub fn load_host(directory: &Path) -> Option<Url> {
    let text = std::fs::read_to_string(directory.join(SAVED_HOST)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse_host(value.get("url")?.as_str()?).ok()
}

pub fn save_host(directory: &Path, host: &Url) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    std::fs::write(
        directory.join(SAVED_HOST),
        serde_json::json!({ "url": host.as_str() }).to_string(),
    )
}

pub fn clear_host(directory: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(directory.join(SAVED_HOST)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn accepts_https_origins_only() {
        assert_eq!(
            parse_host("studio.tail1234.ts.net").unwrap().as_str(),
            "https://studio.tail1234.ts.net/"
        );
        assert_eq!(
            parse_host(" https://studio.tail1234.ts.net:8443/ ")
                .unwrap()
                .as_str(),
            "https://studio.tail1234.ts.net:8443/"
        );
        for invalid in [
            "",
            "http://studio.tail1234.ts.net",
            "http://127.0.0.1:55310",
            "https://user:pass@studio.tail1234.ts.net",
            "https://studio.tail1234.ts.net/tasks",
            "https://studio.tail1234.ts.net/?a=1",
            "https://studio.tail1234.ts.net/#x",
            "javascript:alert(1)",
            "file:///etc/hosts",
        ] {
            assert_eq!(parse_host(invalid), Err(INVALID_HOST), "{invalid}");
        }
    }

    #[test]
    fn invitation_links_carry_only_a_host() {
        let link = url("suplex://join?url=https%3A%2F%2Fstudio.tail1234.ts.net%2Finvite%3Fx%3D1");
        assert_eq!(
            invitation_host(&link).unwrap().as_str(),
            "https://studio.tail1234.ts.net/"
        );
        for invalid in [
            "suplex://join?url=http%3A%2F%2Fstudio.tail1234.ts.net",
            "suplex://join?url=https%3A%2F%2Fa.example&url=https%3A%2F%2Fb.example",
            "suplex://auth/done",
            "https://join?url=https%3A%2F%2Fa.example",
        ] {
            assert_eq!(invitation_host(&url(invalid)), None, "{invalid}");
        }
    }

    #[test]
    fn navigation_stays_on_bundled_pages_and_the_host() {
        let host = url("https://studio.tail1234.ts.net/");
        for allowed in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html?pick=1",
            "https://tauri.localhost/",
            "https://studio.tail1234.ts.net/tasks",
        ] {
            assert_eq!(
                classify(&url(allowed), Some(&host)),
                Navigation::Allow,
                "{allowed}"
            );
        }
        assert_eq!(
            classify(&url("https://github.com/login"), Some(&host)),
            Navigation::External(url("https://github.com/login"))
        );
        assert_eq!(
            classify(&url("https://studio.tail1234.ts.net/"), None),
            Navigation::External(url("https://studio.tail1234.ts.net/"))
        );
        assert_eq!(
            classify(&url("https://studio.tail1234.ts.net:444/"), Some(&host)),
            Navigation::External(url("https://studio.tail1234.ts.net:444/"))
        );
        for blocked in [
            "javascript:alert(1)",
            "file:///etc/hosts",
            "data:text/html,x",
            "suplex://join",
        ] {
            assert_eq!(
                classify(&url(blocked), Some(&host)),
                Navigation::Block,
                "{blocked}"
            );
        }
    }

    #[test]
    fn saved_host_round_trips_and_ignores_bad_files() {
        let directory = std::env::temp_dir().join(format!("suplex-mobile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        assert_eq!(load_host(&directory), None);
        let host = url("https://studio.tail1234.ts.net/");
        save_host(&directory, &host).unwrap();
        assert_eq!(load_host(&directory), Some(host));
        std::fs::write(directory.join(SAVED_HOST), "not json").unwrap();
        assert_eq!(load_host(&directory), None);
        std::fs::write(
            directory.join(SAVED_HOST),
            r#"{"url":"http://studio.tail1234.ts.net/"}"#,
        )
        .unwrap();
        assert_eq!(load_host(&directory), None);
        clear_host(&directory).unwrap();
        clear_host(&directory).unwrap();
        assert_eq!(load_host(&directory), None);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
