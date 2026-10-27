//! Stack frames from a captured `std::backtrace::Backtrace`, reduced to Suplex
//! source locations and function symbols.

use crate::report::Frame;

const MAX_FRAMES: usize = 30;
const MAX_FUNCTION: usize = 160;
const SOURCE_ROOTS: [&str; 2] = ["apps", "packages"];

/// The path below the last `apps/<program>/src*` or `packages/<crate>/src*`
/// pair, so a checkout location, home directory, registry path, or toolchain
/// path never survives. Any other path has no Suplex location.
pub fn relative_path(path: &str) -> Option<String> {
    let parts: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    let start = (0..parts.len().saturating_sub(3)).rev().find(|index| {
        SOURCE_ROOTS.contains(&parts[*index]) && parts[index + 2].starts_with("src")
    })?;
    let relative = parts[start..].join("/");
    let safe = relative
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "/._-".contains(character));
    (safe && !relative.contains("..") && relative.len() <= 200).then_some(relative)
}

/// A function symbol without its hash suffix, or `None` for text that is not a symbol.
pub fn clean_function(raw: &str) -> Option<String> {
    let mut name = raw.trim();
    if let Some(index) = name.rfind("::h")
        && name.len() - index == 19
        && name[index + 3..]
            .chars()
            .all(|digit| digit.is_ascii_hexdigit())
    {
        name = &name[..index];
    }
    if name.is_empty() || name == "<unknown>" || name.contains(['/', '\\']) {
        return None;
    }
    Some(name.chars().take(MAX_FUNCTION).collect())
}

fn in_app(function: &str) -> bool {
    function.trim_start_matches('<').starts_with("suplex")
}

/// Panic machinery and process entry frames carry no information about Suplex.
fn runtime_frame(function: &str) -> bool {
    const PREFIXES: [&str; 17] = [
        "core::option::expect_failed",
        "core::option::unwrap_failed",
        "core::result::unwrap_failed",
        "std::panicking",
        "std::panic::",
        "core::panicking",
        "core::panic::",
        "std::backtrace",
        "std::rt::",
        "std::sys::",
        "rust_begin_unwind",
        "rust_panic",
        "__rust_",
        "__libc_",
        "_start",
        "start_thread",
        "clone",
    ];
    PREFIXES.iter().any(|prefix| function.starts_with(prefix))
        || function.starts_with("suplex_exception::")
}

fn location(text: &str) -> (Option<String>, Option<u32>, Option<u32>) {
    let mut pieces = text.rsplitn(3, ':');
    let last = pieces.next().unwrap_or_default();
    let middle = pieces.next();
    let rest = pieces.next();
    match (last.parse::<u32>(), middle.map(str::parse::<u32>), rest) {
        (Ok(column), Some(Ok(line)), Some(path)) => (relative_path(path), Some(line), Some(column)),
        (Ok(line), Some(_), _) => (
            relative_path(text.rsplit_once(':').map_or(text, |pair| pair.0)),
            Some(line),
            None,
        ),
        _ => (relative_path(text), None, None),
    }
}

/// Frames from the `Display` text of a backtrace, outermost call last, with
/// the panic machinery before the first Suplex frame removed. Understands the
/// short form and the alternate (`{:#}`) form.
pub fn parse_frames(text: &str) -> Vec<Frame> {
    let mut raw: Vec<Frame> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("at ") {
            if let Some(frame) = raw.last_mut() {
                let (filename, lineno, colno) = location(rest);
                frame.filename = filename;
                frame.lineno = lineno;
                frame.colno = colno;
            }
            continue;
        }
        let mut rest = line;
        if let Some((number, tail)) = rest.split_once(':')
            && !number.is_empty()
            && number.chars().all(|digit| digit.is_ascii_digit())
        {
            rest = tail.trim();
        }
        if let Some(tail) = rest.strip_prefix("0x")
            && let Some((address, tail)) = tail.split_once(" - ")
            && address.chars().all(|digit| digit.is_ascii_hexdigit())
        {
            rest = tail;
        }
        if let Some(function) = clean_function(rest) {
            raw.push(Frame {
                in_app: in_app(&function),
                function,
                filename: None,
                lineno: None,
                colno: None,
            });
        }
    }
    // Everything up to the panic entry is the hook and the standard library.
    let entry = raw
        .iter()
        .rposition(|frame| frame.function.contains("rust_begin_unwind"));
    let first_app = raw.iter().position(|frame| frame.in_app);
    raw.into_iter()
        .enumerate()
        .filter(|(index, frame)| {
            entry.is_none_or(|entry| *index > entry)
                && first_app.is_none_or(|first| *index >= first)
                && !runtime_frame(&frame.function)
        })
        .map(|(_, mut frame)| {
            // A line without a Suplex file says nothing about Suplex.
            if frame.filename.is_none() {
                frame.lineno = None;
                frame.colno = None;
            }
            frame
        })
        .take(MAX_FRAMES)
        .collect()
}

/// Captures and parses the current thread's frames.
pub fn capture() -> Vec<Frame> {
    parse_frames(&format!("{:#}", std::backtrace::Backtrace::force_capture()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_keep_only_the_suplex_source_location() {
        for (path, expected) in [
            (
                "/home/ada/suplex/worktrees/acme/suplex/task_1/apps/server/src/http/mod.rs",
                Some("apps/server/src/http/mod.rs"),
            ),
            (
                "/Users/ada/apps/Suplex/apps/desktop/src-tauri/src/lib.rs",
                Some("apps/desktop/src-tauri/src/lib.rs"),
            ),
            (
                r"C:\Users\ada\suplex\packages\exception-report\src\lib.rs",
                Some("packages/exception-report/src/lib.rs"),
            ),
            ("./apps/server/src/main.rs", Some("apps/server/src/main.rs")),
            (
                "/home/ada/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.0.0/src/runtime/task.rs",
                None,
            ),
            ("/rustc/abcdef/library/core/src/option.rs", None),
            ("/home/ada/apps/secret", None),
            ("/home/ada/apps/secret name/src/x.rs", None),
        ] {
            assert_eq!(relative_path(path).as_deref(), expected, "{path}");
        }
    }

    #[test]
    fn symbols_lose_their_hash_and_non_symbols_are_dropped() {
        assert_eq!(
            clean_function("suplex::http::route::h0123456789abcdef").as_deref(),
            Some("suplex::http::route")
        );
        assert_eq!(
            clean_function("<suplex::Foo as core::fmt::Debug>::fmt").as_deref(),
            Some("<suplex::Foo as core::fmt::Debug>::fmt")
        );
        assert_eq!(clean_function("/home/ada/lib.so"), None);
        assert_eq!(clean_function(""), None);
    }

    #[test]
    fn both_backtrace_forms_parse_and_trim_the_panic_machinery() {
        let short = "   0: std::panicking::begin_panic\n             at /rustc/abc/library/std/src/panicking.rs:1:1\n   1: suplex::tasks::run\n             at /home/ada/code/apps/server/src/tasks/mod.rs:10:5\n   2: tokio::runtime::task::poll\n             at /home/ada/.cargo/registry/src/x/tokio/src/a.rs:3:3\n   3: std::rt::lang_start\n";
        let full = "   0:     0x55d1 - core::panicking::panic_fmt::h0123456789abcdef\n                               at /rustc/abc/library/core/src/panicking.rs:2:2\n   1:     0x55d2 - suplex::tasks::run::h0123456789abcdef\n                               at /home/ada/code/apps/server/src/tasks/mod.rs:10:5\n   2:     0x55d3 - tokio::runtime::task::poll::h0123456789abcdef\n                               at /home/ada/.cargo/registry/src/x/tokio/src/a.rs:3:3\n   3:     0x55d4 - std::rt::lang_start::h0123456789abcdef\n";
        for text in [short, full] {
            let frames = parse_frames(text);
            assert_eq!(frames.len(), 2, "{text}");
            assert_eq!(frames[0].function, "suplex::tasks::run");
            assert!(frames[0].in_app);
            assert_eq!(
                frames[0].filename.as_deref(),
                Some("apps/server/src/tasks/mod.rs")
            );
            assert_eq!((frames[0].lineno, frames[0].colno), (Some(10), Some(5)));
            assert_eq!(frames[1].function, "tokio::runtime::task::poll");
            assert!(!frames[1].in_app);
            assert_eq!(frames[1].filename, None);
        }
    }

    #[test]
    fn a_real_backtrace_parses_without_absolute_paths() {
        let frames = capture();
        let text = format!("{frames:?}");
        assert!(!frames.is_empty());
        assert!(!text.contains("/home") && !text.contains("/Users") && !text.contains("/rustc"));
    }
}
