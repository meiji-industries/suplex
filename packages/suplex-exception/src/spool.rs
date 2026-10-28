//! A bounded directory of pending reports. One file per fingerprint, so a crash
//! loop updates one file instead of adding files. A sent report leaves a short
//! marker, so the same failure is sent at most once an hour.
//!
//! The spool has no consent model. Whoever sends from it decides first, and
//! discards the spool with [`purge`] when it may not send.

use std::{
    fs,
    io::{self, Write},
    path::Path,
};

use crate::report::Report;

/// Distinct failures kept at once. Further new failures are dropped.
pub const MAX_PENDING: usize = 20;
/// How long a sent failure stays quiet.
pub const COOLDOWN_MS: i64 = 60 * 60 * 1000;
const MAX_MARKERS: usize = 200;
const MAX_BYTES: u64 = 64 * 1024;
const MAX_OCCURRENCES: u32 = 9999;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recorded {
    Stored,
    /// The failure was pending: its count rose.
    Merged,
    /// The same failure was sent less than an hour ago.
    Quiet,
    /// The spool holds [`MAX_PENDING`] other failures.
    Full,
}

fn pending_path(directory: &Path, fingerprint: &str) -> std::path::PathBuf {
    directory.join(format!("{fingerprint}.json"))
}

fn marker_path(directory: &Path, fingerprint: &str) -> std::path::PathBuf {
    directory.join(format!("{fingerprint}.sent"))
}

fn valid(fingerprint: &str) -> bool {
    fingerprint.len() == 32 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let staged = path.with_extension("staging");
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&staged)?;
        file.write_all(contents)?;
    }
    fs::rename(staged, path)
}

fn read(path: &Path) -> Option<Report> {
    if fs::metadata(path).ok()?.len() > MAX_BYTES {
        return None;
    }
    let report: Report = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    valid(&report.fingerprint).then_some(report)
}

fn entries(directory: &Path, extension: &str) -> Vec<std::path::PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|actual| actual == extension))
        .collect()
}

/// Stores `report`, or counts it into the pending report of the same failure.
pub fn record(directory: &Path, report: &Report) -> io::Result<Recorded> {
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(
            directory,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        );
    }
    if !valid(&report.fingerprint) {
        return Ok(Recorded::Full);
    }
    let marker = marker_path(directory, &report.fingerprint);
    if let Some(sent_at) = fs::read_to_string(&marker)
        .ok()
        .and_then(|text| text.trim().parse::<i64>().ok())
        && report.last_at_ms.saturating_sub(sent_at) < COOLDOWN_MS
    {
        return Ok(Recorded::Quiet);
    }
    let path = pending_path(directory, &report.fingerprint);
    if let Some(mut existing) = read(&path) {
        existing.occurrences = existing
            .occurrences
            .saturating_add(report.occurrences)
            .min(MAX_OCCURRENCES);
        existing.last_at_ms = existing.last_at_ms.max(report.last_at_ms);
        write(
            &path,
            &serde_json::to_vec(&existing).map_err(io::Error::other)?,
        )?;
        return Ok(Recorded::Merged);
    }
    if entries(directory, "json").len() >= MAX_PENDING {
        return Ok(Recorded::Full);
    }
    write(
        &path,
        &serde_json::to_vec(report).map_err(io::Error::other)?,
    )?;
    Ok(Recorded::Stored)
}

/// Up to `limit` pending reports, oldest first. Reports first recorded before
/// `since_ms` and files that are not reports are deleted, not returned.
pub fn pending(directory: &Path, since_ms: i64, limit: usize) -> Vec<Report> {
    let mut reports = Vec::new();
    for path in entries(directory, "json") {
        match read(&path) {
            Some(report) if report.recorded_at_ms >= since_ms => reports.push(report),
            _ => {
                let _ = fs::remove_file(path);
            }
        }
    }
    reports.sort_by_key(|report| (report.recorded_at_ms, report.fingerprint.clone()));
    reports.truncate(limit);
    reports
}

/// Removes a sent report and keeps its failure quiet for [`COOLDOWN_MS`].
pub fn acknowledge(directory: &Path, report: &Report, now_ms: i64) {
    if !valid(&report.fingerprint) {
        return;
    }
    let _ = write(
        &marker_path(directory, &report.fingerprint),
        now_ms.to_string().as_bytes(),
    );
    let _ = fs::remove_file(pending_path(directory, &report.fingerprint));
    let mut markers: Vec<_> = entries(directory, "sent")
        .into_iter()
        .map(|path| {
            let sent_at = fs::read_to_string(&path)
                .ok()
                .and_then(|text| text.trim().parse::<i64>().ok())
                .unwrap_or(0);
            (sent_at, path)
        })
        .collect();
    markers.sort();
    let excess = markers.len().saturating_sub(MAX_MARKERS);
    for (index, (sent_at, path)) in markers.into_iter().enumerate() {
        if index < excess || now_ms.saturating_sub(sent_at) >= COOLDOWN_MS {
            let _ = fs::remove_file(path);
        }
    }
}

/// Deletes every pending report and marker.
pub fn purge(directory: &Path) {
    for extension in ["json", "sent", "staging"] {
        for path in entries(directory, extension) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::Frame;

    fn report(name: &str, at: i64) -> Report {
        let mut report = Report::new(
            "host",
            "Panic",
            "panic",
            false,
            vec![Frame {
                function: format!("suplex::{name}"),
                filename: None,
                lineno: None,
                colno: None,
                in_app: true,
            }],
        );
        report.recorded_at_ms = at;
        report.last_at_ms = at;
        report
    }

    #[test]
    fn a_crash_loop_updates_one_file_and_is_sent_once() {
        let directory = tempfile::tempdir().unwrap();
        let first = report("loop", 1_000);
        assert_eq!(record(directory.path(), &first).unwrap(), Recorded::Stored);
        for at in 2_000..2_100 {
            assert_eq!(
                record(directory.path(), &report("loop", at)).unwrap(),
                Recorded::Merged
            );
        }
        assert_eq!(entries(directory.path(), "json").len(), 1);
        let pending = pending(directory.path(), 0, 10);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].occurrences, 101);
        assert_eq!(pending[0].recorded_at_ms, 1_000);
        acknowledge(directory.path(), &pending[0], 5_000);
        assert!(super::pending(directory.path(), 0, 10).is_empty());
        // The same failure stays quiet for an hour, then reports again.
        assert_eq!(
            record(directory.path(), &report("loop", 6_000)).unwrap(),
            Recorded::Quiet
        );
        assert_eq!(
            record(directory.path(), &report("loop", 5_000 + COOLDOWN_MS)).unwrap(),
            Recorded::Stored
        );
    }

    #[test]
    fn storage_is_bounded_by_distinct_failures_and_markers() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..MAX_PENDING + 10 {
            record(directory.path(), &report(&format!("f{index}"), 1)).unwrap();
        }
        assert_eq!(entries(directory.path(), "json").len(), MAX_PENDING);
        assert_eq!(
            record(directory.path(), &report("extra", 1)).unwrap(),
            Recorded::Full
        );
        // A known failure still counts when the spool is full.
        assert_eq!(
            record(directory.path(), &report("f0", 2)).unwrap(),
            Recorded::Merged
        );
        let all = pending(directory.path(), 0, 100);
        for (index, sent) in all.iter().enumerate() {
            acknowledge(directory.path(), sent, 10 + index as i64);
        }
        assert!(entries(directory.path(), "sent").len() <= MAX_MARKERS);
    }

    #[test]
    fn old_reports_and_foreign_files_are_deleted_not_sent() {
        let directory = tempfile::tempdir().unwrap();
        record(directory.path(), &report("old", 100)).unwrap();
        record(directory.path(), &report("new", 900)).unwrap();
        fs::write(
            directory.path().join(format!("{}.json", "a".repeat(32))),
            "not json",
        )
        .unwrap();
        let sent = pending(directory.path(), 500, 10);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].frames[0].function, "suplex::new");
        assert_eq!(entries(directory.path(), "json").len(), 1);
        purge(directory.path());
        assert!(fs::read_dir(directory.path()).unwrap().next().is_none());
    }
}
