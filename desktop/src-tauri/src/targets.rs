//! Which Suplex host the window shows: URL policy, launch-argument precedence, navigation policy,
//! and the origin-only registry of remembered hosts in `desktop.json`.

use std::{collections::HashMap, path::Path};

use serde_json::Value;
use url::Url;

use crate::paths::write_atomic;

const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
const LIMIT: usize = 8;

/// A validated host. `url` is the first page to load (an invitation link keeps its path and query);
/// `origin` is what every later same-origin check compares against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuplexTarget {
    pub url: Url,
    pub origin: String,
}

impl SuplexTarget {
    /// The origin's root page, which is all the registry ever remembers.
    pub fn root(&self) -> SuplexTarget {
        parse_target(&format!("{}/", self.origin)).expect("an origin of a valid target is valid")
    }
}

/// https anywhere, or http on a literal loopback host. Credentials and fragments are refused.
pub fn parse_target(value: &str) -> Result<SuplexTarget, String> {
    let url =
        Url::parse(value.trim()).map_err(|_| "The value is not an absolute URL.".to_owned())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The URL must not contain credentials.".into());
    }
    if url.fragment().is_some() {
        return Err("The URL must not contain a fragment.".into());
    }
    match url.scheme() {
        "http"
            if url
                .host_str()
                .is_some_and(|host| LOOPBACK_HOSTS.contains(&host)) => {}
        "http" => return Err("http is accepted only for localhost.".into()),
        "https" if url.host_str().is_some() => {}
        _ => return Err("Only https URLs are accepted.".into()),
    }
    let origin = url.origin().ascii_serialization();
    Ok(SuplexTarget { url, origin })
}

/// `suplex://join?url=<https URL>` from a company invitation. It carries only a host address;
/// authentication stays on that host.
pub fn invitation_target(value: &str) -> Option<SuplexTarget> {
    let link = Url::parse(value).ok()?;
    if link.scheme() != "suplex"
        || link.host_str() != Some("join")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.fragment().is_some()
    {
        return None;
    }
    let mut values = link.query_pairs().filter(|(key, _)| key == "url");
    let (_, only) = values.next()?;
    if values.next().is_some() || !only.starts_with("https://") {
        return None;
    }
    parse_target(&only).ok()
}

/// `--url=<value>` or `--url <value>`. A bare `--url` followed by a flag takes the last absolute http(s) argument.
fn argument_value(argv: &[String]) -> Option<String> {
    if let Some(assigned) = argv.iter().find_map(|entry| entry.strip_prefix("--url=")) {
        return Some(assigned.to_owned());
    }
    let index = argv.iter().position(|entry| entry == "--url")?;
    match argv.get(index + 1) {
        Some(next) if !next.starts_with('-') => Some(next.clone()),
        _ => Some(
            argv.iter()
                .rev()
                .find(|entry| entry.starts_with("http://") || entry.starts_with("https://"))
                .cloned()
                .unwrap_or_default(),
        ),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetSource {
    Argument,
    Environment,
}

/// Argument, then environment. An explicit invalid value is an error; it never falls through.
pub fn resolve_target(
    argv: &[String],
    environment: &HashMap<String, String>,
) -> Result<Option<(TargetSource, SuplexTarget)>, String> {
    let explicit = [
        (TargetSource::Argument, "--url", argument_value(argv)),
        (
            TargetSource::Environment,
            "SUPLEX_DESKTOP_URL",
            environment.get("SUPLEX_DESKTOP_URL").cloned(),
        ),
    ];
    for (source, name, value) in explicit {
        let Some(value) = value else { continue };
        return parse_target(&value)
            .map(|target| Some((source, target)))
            .map_err(|reason| format!("{name} is not valid: {reason}"));
    }
    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NavigationDecision {
    Internal(Url),
    External(Url),
    Blocked(String),
}

/// Where a navigation, redirect, or popup goes relative to the selected origin. Fails closed.
pub fn classify_navigation(url: &str, origin: Option<&str>) -> NavigationDecision {
    let Ok(parsed) = Url::parse(url) else {
        return NavigationDecision::Blocked("not a URL".into());
    };
    match parsed.scheme() {
        "http" | "https"
            if origin.is_some_and(|origin| parsed.origin().ascii_serialization() == origin) =>
        {
            NavigationDecision::Internal(parsed)
        }
        "http" | "https" => NavigationDecision::External(parsed),
        scheme => NavigationDecision::Blocked(format!("{scheme}: is not allowed")),
    }
}

/// The remembered origins. `current` is always one of `targets`, or `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Registry {
    pub current: Option<SuplexTarget>,
    pub targets: Vec<SuplexTarget>,
}

impl Registry {
    pub fn origins(&self) -> Vec<String> {
        self.targets
            .iter()
            .map(|target| target.origin.clone())
            .collect()
    }
}

/// Only a root page (no path or query) is ever remembered.
fn origin_target(value: &Value) -> Option<SuplexTarget> {
    let target = parse_target(value.as_str()?).ok()?;
    (target.url.as_str() == format!("{}/", target.origin)).then_some(target)
}

/// Reads and revalidates the remembered origins. Invalid entries are dropped, a file with none left is
/// deleted, and the old `{ "url": ... }` form is read as a one-entry registry.
pub fn read_registry(file: &Path) -> Registry {
    let Ok(raw) = std::fs::read_to_string(file) else {
        return Registry::default();
    };
    let data = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(data)) => data,
        _ => {
            clear_registry(file);
            return Registry::default();
        }
    };
    let listed: Vec<Value> = match data.get("targets") {
        Some(Value::Array(targets)) => targets.clone(),
        _ => vec![data.get("url").cloned().unwrap_or(Value::Null)],
    };
    let mut targets: Vec<SuplexTarget> = Vec::new();
    for entry in listed.iter().filter_map(origin_target) {
        if !targets.iter().any(|known| known.origin == entry.origin) {
            targets.push(entry);
        }
    }
    if targets.is_empty() {
        clear_registry(file);
        return Registry::default();
    }
    targets.truncate(LIMIT);
    let wanted = match data.get("current") {
        Some(value) if !value.is_null() => origin_target(value),
        _ => data.get("url").and_then(origin_target),
    };
    let current = wanted.and_then(|wanted| {
        targets
            .iter()
            .find(|target| target.origin == wanted.origin)
            .cloned()
    });
    Registry { current, targets }
}

fn write_registry(file: &Path, registry: Registry) -> std::io::Result<Registry> {
    let value = serde_json::json!({
        "current": registry.current.as_ref().map(|target| target.url.as_str()),
        "targets": registry.targets.iter().map(|target| target.url.as_str()).collect::<Vec<_>>(),
    });
    write_atomic(file, value.to_string().as_bytes())?;
    Ok(registry)
}

/// Makes the target's origin current, adding it first when new.
pub fn remember(file: &Path, target: &SuplexTarget) -> std::io::Result<Registry> {
    let entry = target.root();
    let mut targets = vec![entry.clone()];
    targets.extend(
        read_registry(file)
            .targets
            .into_iter()
            .filter(|known| known.origin != entry.origin),
    );
    targets.truncate(LIMIT);
    write_registry(
        file,
        Registry {
            current: Some(entry),
            targets,
        },
    )
}

/// Removes one origin. When it was current, nothing is current afterwards.
pub fn forget(file: &Path, origin: &str) -> std::io::Result<Registry> {
    let registry = read_registry(file);
    let targets: Vec<SuplexTarget> = registry
        .targets
        .into_iter()
        .filter(|target| target.origin != origin)
        .collect();
    if targets.is_empty() {
        clear_registry(file);
        return Ok(Registry::default());
    }
    let current = registry.current.filter(|current| current.origin != origin);
    write_registry(file, Registry { current, targets })
}

pub fn clear_registry(file: &Path) {
    let _ = std::fs::remove_file(file);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }
    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }
    fn target(value: &str) -> SuplexTarget {
        parse_target(value).unwrap()
    }

    #[test]
    fn parse_normalizes_and_keeps_scheme_host_and_port() {
        let parsed = target("https://suplex.tail1234.ts.net");
        assert_eq!(
            (parsed.url.as_str(), parsed.origin.as_str()),
            (
                "https://suplex.tail1234.ts.net/",
                "https://suplex.tail1234.ts.net"
            )
        );
        let parsed = target("  https://suplex.tail1234.ts.net:4211  ");
        assert_eq!(
            (parsed.url.as_str(), parsed.origin.as_str()),
            (
                "https://suplex.tail1234.ts.net:4211/",
                "https://suplex.tail1234.ts.net:4211"
            )
        );
        assert_eq!(
            target("https://suplex.tail1234.ts.net:443/").origin,
            "https://suplex.tail1234.ts.net"
        );
    }

    #[test]
    fn parse_keeps_a_first_page_such_as_an_invitation_with_the_origin_separate() {
        let parsed = target("https://suplex.tail1234.ts.net/?company=one");
        assert_eq!(
            parsed.url.as_str(),
            "https://suplex.tail1234.ts.net/?company=one"
        );
        assert_eq!(parsed.origin, "https://suplex.tail1234.ts.net");
        assert_eq!(
            parsed.root().url.as_str(),
            "https://suplex.tail1234.ts.net/"
        );
    }

    #[test]
    fn company_invitation_links_accept_only_validated_https_targets() {
        let link = |target: &str| {
            format!(
                "suplex://join?url={}",
                url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>()
            )
        };
        assert_eq!(
            invitation_target(&link("https://company.example/?company=one"))
                .map(|target| target.url.to_string()),
            Some("https://company.example/?company=one".to_owned())
        );
        for target in [
            "http://127.0.0.1:4111",
            "http://company.example",
            "javascript:alert(1)",
            "https://user:password@company.example",
            "https://company.example/#token",
        ] {
            assert_eq!(invitation_target(&link(target)), None, "{target}");
        }
        assert_eq!(invitation_target("suplex://auth/done"), None);
        assert_eq!(
            invitation_target("suplex://join?url=https://one.example&url=https://two.example"),
            None
        );
    }

    #[test]
    fn parse_rejects_credentials_fragments_malformed_values_and_other_schemes() {
        let reason = |value: &str| parse_target(value).unwrap_err();
        assert!(reason("https://user:pw@suplex.tail1234.ts.net").contains("credentials"));
        assert!(reason("https://user@suplex.tail1234.ts.net").contains("credentials"));
        assert!(reason("https://suplex.tail1234.ts.net/#top").contains("fragment"));
        assert!(reason("suplex.tail1234.ts.net").contains("absolute URL"));
        assert!(reason("").contains("absolute URL"));
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://suplex.tail1234.ts.net",
        ] {
            assert!(reason(value).contains("https"), "{value}");
        }
    }

    #[test]
    fn http_is_accepted_only_on_literal_loopback_hosts() {
        assert_eq!(
            target("http://localhost:4111").origin,
            "http://localhost:4111"
        );
        assert_eq!(
            target("http://127.0.0.1:4111").origin,
            "http://127.0.0.1:4111"
        );
        assert_eq!(target("http://[::1]:4111").origin, "http://[::1]:4111");
        for value in [
            "http://suplex.tail1234.ts.net",
            "http://suplex.example.com",
            "http://127.0.0.1.nip.io:4111",
            "http://localhost.example.com",
        ] {
            assert!(
                parse_target(value).unwrap_err().contains("localhost"),
                "{value}"
            );
        }
    }

    #[test]
    fn argument_beats_environment() {
        let environment = env(&[("SUPLEX_DESKTOP_URL", "https://env.tail1234.ts.net")]);
        let origin = |argv: &[&str], environment: &HashMap<String, String>| {
            resolve_target(&args(argv), environment)
                .unwrap()
                .map(|(source, target)| (source, target.origin))
        };
        let arg = Some((
            TargetSource::Argument,
            "https://arg.tail1234.ts.net".to_owned(),
        ));
        assert_eq!(
            origin(&["--url", "https://arg.tail1234.ts.net"], &environment),
            arg
        );
        assert_eq!(
            origin(&["--url=https://arg.tail1234.ts.net"], &environment),
            arg
        );
        assert_eq!(
            origin(
                &[
                    "/Applications/Suplex.app/Contents/MacOS/Suplex",
                    "--url",
                    "https://arg.tail1234.ts.net"
                ],
                &environment
            ),
            arg
        );
        assert_eq!(
            origin(
                &[
                    "Suplex",
                    "--url",
                    "--some-flag",
                    ".",
                    "https://arg.tail1234.ts.net"
                ],
                &environment
            ),
            arg
        );
        assert_eq!(
            origin(
                &[
                    "Suplex",
                    "--url=https://arg.tail1234.ts.net",
                    "--some-flag",
                    "."
                ],
                &environment
            ),
            arg
        );
        assert_eq!(
            origin(&[], &environment),
            Some((
                TargetSource::Environment,
                "https://env.tail1234.ts.net".to_owned()
            ))
        );
        assert_eq!(origin(&[], &env(&[])), None);
    }

    #[test]
    fn an_explicit_invalid_value_fails_and_never_falls_through() {
        let error = |argv: &[&str], environment: &[(&str, &str)]| {
            resolve_target(&args(argv), &env(environment)).unwrap_err()
        };
        assert!(error(
            &["--url", "http://suplex.example.com"],
            &[("SUPLEX_DESKTOP_URL", "https://ok.example")]
        )
        .starts_with("--url is not valid"));
        assert!(error(&["--url"], &[]).starts_with("--url is not valid"));
        assert!(
            error(&["Suplex", "--url", "--some-flag", "."], &[]).starts_with("--url is not valid")
        );
        assert!(error(&[], &[("SUPLEX_DESKTOP_URL", "")])
            .starts_with("SUPLEX_DESKTOP_URL is not valid"));
        assert!(
            error(&[], &[("SUPLEX_DESKTOP_URL", "http://suplex.example.com")])
                .starts_with("SUPLEX_DESKTOP_URL is not valid")
        );
    }

    #[test]
    fn navigation_compares_the_whole_origin_including_scheme_and_port() {
        let origin = Some("https://suplex.tail1234.ts.net");
        assert_eq!(
            classify_navigation("https://suplex.tail1234.ts.net/tasks/1?x=1", origin),
            NavigationDecision::Internal(
                Url::parse("https://suplex.tail1234.ts.net/tasks/1?x=1").unwrap()
            )
        );
        assert!(matches!(
            classify_navigation("https://suplex.tail1234.ts.net:8443/", origin),
            NavigationDecision::External(_)
        ));
        assert!(matches!(
            classify_navigation("http://suplex.tail1234.ts.net/", origin),
            NavigationDecision::External(_)
        ));
        assert!(matches!(
            classify_navigation("https://suplex.tail1234.ts.net:443/", origin),
            NavigationDecision::Internal(_)
        ));
        assert!(matches!(
            classify_navigation("https://github.com/meiji-industries/suplex", origin),
            NavigationDecision::External(_)
        ));
        assert!(matches!(
            classify_navigation("http://example.com", origin),
            NavigationDecision::External(_)
        ));
    }

    #[test]
    fn navigation_blocks_every_other_scheme() {
        let origin = Some("https://suplex.tail1234.ts.net");
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "suplex-desktop://connect",
            "mailto:a@b.c",
            "blob:https://suplex.tail1234.ts.net/1",
            "tauri://localhost/pages/choice.html",
            "not a url",
        ] {
            assert!(
                matches!(
                    classify_navigation(url, origin),
                    NavigationDecision::Blocked(_)
                ),
                "{url}"
            );
        }
        assert!(matches!(
            classify_navigation("https://suplex.tail1234.ts.net/", None),
            NavigationDecision::External(_)
        ));
    }

    fn registry_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("desktop.json");
        (directory, file)
    }

    #[test]
    fn remembers_only_origins_newest_first_with_the_last_one_current() {
        let (_directory, file) = registry_file();
        remember(
            &file,
            &target("https://meiji.tail1234.ts.net:4111/?company=one"),
        )
        .unwrap();
        let registry = remember(&file, &target("http://localhost:4211")).unwrap();
        assert_eq!(
            registry.current.as_ref().unwrap().origin,
            "http://localhost:4211"
        );
        assert_eq!(
            registry.origins(),
            [
                "http://localhost:4211",
                "https://meiji.tail1234.ts.net:4111"
            ]
        );
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            stored,
            serde_json::json!({ "current": "http://localhost:4211/", "targets": ["http://localhost:4211/", "https://meiji.tail1234.ts.net:4111/"] })
        );
        assert_eq!(read_registry(&file), registry);
    }

    #[test]
    fn remembering_a_known_origin_moves_it_to_the_front() {
        let (_directory, file) = registry_file();
        remember(&file, &target("https://meiji.tail1234.ts.net:4111")).unwrap();
        remember(&file, &target("http://localhost:4211")).unwrap();
        let registry =
            remember(&file, &target("https://meiji.tail1234.ts.net:4111/tasks/1")).unwrap();
        assert_eq!(
            registry.origins(),
            [
                "https://meiji.tail1234.ts.net:4111",
                "http://localhost:4211"
            ]
        );
        assert_eq!(
            registry.current.unwrap().origin,
            "https://meiji.tail1234.ts.net:4111"
        );
    }

    #[test]
    fn keeps_at_most_eight_origins() {
        let (_directory, file) = registry_file();
        for port in 1..=10 {
            remember(
                &file,
                &target(&format!("https://suplex{port}.tail1234.ts.net")),
            )
            .unwrap();
        }
        let registry = read_registry(&file);
        assert_eq!(registry.targets.len(), 8);
        assert_eq!(
            registry.targets[0].origin,
            "https://suplex10.tail1234.ts.net"
        );
    }

    #[test]
    fn forgetting_the_current_origin_leaves_nothing_current_and_the_last_one_deletes_the_file() {
        let (_directory, file) = registry_file();
        remember(&file, &target("https://meiji.tail1234.ts.net:4111")).unwrap();
        remember(&file, &target("http://localhost:4211")).unwrap();
        let after = forget(&file, "http://localhost:4211").unwrap();
        assert_eq!(after.current, None);
        assert_eq!(after.origins(), ["https://meiji.tail1234.ts.net:4111"]);
        assert_eq!(
            forget(&file, "https://meiji.tail1234.ts.net:4111").unwrap(),
            Registry::default()
        );
        assert!(!file.exists());
    }

    #[test]
    fn reads_the_legacy_single_url_file() {
        let (_directory, file) = registry_file();
        std::fs::write(&file, r#"{"url":"https://meiji.tail1234.ts.net:4111/"}"#).unwrap();
        let registry = read_registry(&file);
        assert_eq!(
            registry.current.unwrap().origin,
            "https://meiji.tail1234.ts.net:4111"
        );
        assert_eq!(registry.targets.len(), 1);
    }

    #[test]
    fn a_missing_file_is_empty_and_corrupt_files_are_deleted() {
        let (_directory, file) = registry_file();
        assert_eq!(read_registry(&file), Registry::default());
        for content in ["{not json", "[]", "42"] {
            std::fs::write(&file, content).unwrap();
            assert_eq!(read_registry(&file), Registry::default(), "{content}");
            assert!(!file.exists(), "{content}");
        }
    }

    #[test]
    fn invalid_entries_are_dropped_and_an_unlisted_current_is_ignored() {
        let (_directory, file) = registry_file();
        std::fs::write(&file, serde_json::json!({ "current": "https://gone.tail1234.ts.net/", "targets": ["http://suplex.example.com/", "https://u:p@meiji.tail1234.ts.net/", "https://meiji.tail1234.ts.net:4111/?company=x", 42, "http://localhost:4211/"] }).to_string()).unwrap();
        let registry = read_registry(&file);
        assert_eq!(registry.origins(), ["http://localhost:4211"]);
        assert_eq!(registry.current, None);
    }

    #[test]
    fn clear_tolerates_a_missing_file() {
        let (_directory, file) = registry_file();
        std::fs::write(&file, "{}").unwrap();
        clear_registry(&file);
        clear_registry(&file);
        assert!(!file.exists());
    }
}
