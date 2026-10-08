use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, SystemTime},
};

use crate::coordination::bridge_auth::{
    ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV, ROOT_TOKEN_ENV,
};

const WAITING_LABEL: &str = "Waiting for Devin output...\n";

pub struct DisplayCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub command: String,
}

#[derive(Default)]
struct Cursor {
    offset: u64,
    pending: Vec<u8>,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn display_command(runtime_directory: &Path) -> io::Result<DisplayCommand> {
    let executable = std::env::current_exe()?.to_string_lossy().into_owned();
    let args = vec![
        "display".to_owned(),
        "devin".to_owned(),
        runtime_directory.to_string_lossy().into_owned(),
    ];
    let clear = [
        ROOT_BINDING_ENV,
        ROOT_TOKEN_ENV,
        ADVISOR_BINDING_ENV,
        ADVISOR_TOKEN_ENV,
        ADVISOR_RESULT_ENV,
    ]
    .into_iter()
    .flat_map(|key| ["-u", key]);
    let command = ["/usr/bin/env"]
        .into_iter()
        .chain(clear)
        .chain([executable.as_str()])
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(DisplayCommand {
        executable,
        args,
        command,
    })
}

pub fn display_attached(runtime_directory: &Path, argv: &[String]) -> bool {
    let Ok(expected) = display_command(runtime_directory) else {
        return false;
    };
    argv.len() == expected.args.len() + 1
        && argv[0] == expected.executable
        && argv[1..] == expected.args[..]
}

fn safe_terminal_text(text: &str) -> String {
    text.replace('\r', "\n")
        .chars()
        .filter(|ch| !matches!(*ch as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f..=0x9f))
        .collect()
}

fn created_at(metadata: &fs::Metadata) -> SystemTime {
    metadata
        .created()
        .or_else(|_| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn output_file(name: &str) -> bool {
    name.strip_prefix("turn-").is_some_and(|rest| {
        rest.strip_suffix(".jsonl")
            .or_else(|| rest.strip_suffix(".stderr.log"))
            .is_some_and(|id| !id.is_empty())
    })
}

fn output_files(runtime_directory: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(runtime_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_file() || !output_file(&name) {
            continue;
        }
        match entry.metadata() {
            Ok(metadata) => files.push((created_at(&metadata), name, entry.path())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(files.into_iter().map(|(_, _, path)| path).collect())
}

/// Length of an incomplete UTF-8 sequence at the end of `bytes`, kept for the
/// next read like a streaming TextDecoder.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let width = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if width > back { back } else { 0 };
    }
    0
}

fn read_appended(path: &Path, cursor: &mut Cursor) -> io::Result<String> {
    let size = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error),
    };
    if size < cursor.offset {
        *cursor = Cursor::default();
    }
    if size == cursor.offset {
        return Ok(String::new());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(cursor.offset))?;
    let read = file
        .take(size - cursor.offset)
        .read_to_end(&mut cursor.pending)?;
    cursor.offset += read as u64;
    let complete = cursor.pending.len() - incomplete_tail(&cursor.pending);
    let text = String::from_utf8_lossy(&cursor.pending[..complete]).into_owned();
    cursor.pending.drain(..complete);
    Ok(text)
}

fn scan(
    runtime_directory: &Path,
    cursors: &mut HashMap<PathBuf, Cursor>,
    output: &mut impl Write,
) -> io::Result<bool> {
    let mut wrote = false;
    for path in output_files(runtime_directory)? {
        let text = safe_terminal_text(&read_appended(
            &path,
            cursors.entry(path.clone()).or_default(),
        )?);
        if text.is_empty() {
            continue;
        }
        output.write_all(text.as_bytes())?;
        output.flush()?;
        wrote = true;
    }
    Ok(wrote)
}

/// Passive pane display: follows every turn's output file without owning the native session.
pub fn run(
    runtime_directory: &Path,
    output: &mut impl Write,
    poll_interval: Duration,
    stop: &AtomicBool,
) -> io::Result<()> {
    let mut cursors = HashMap::new();
    let mut seen = false;
    if !scan(runtime_directory, &mut cursors, output)? {
        output.write_all(WAITING_LABEL.as_bytes())?;
        output.flush()?;
    }
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(poll_interval);
        if stop.load(Ordering::SeqCst)
            || crate::runtimes::task_display::runtime_removed(runtime_directory, &mut seen)
        {
            break;
        }
        scan(runtime_directory, &mut cursors, output)?;
    }
    Ok(())
}

/// `suplex display devin <runtime directory>`. SIGINT and SIGTERM end the
/// process through their default action.
pub fn main(args: &[String]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let directory = args.first().map(PathBuf::from);
    let Some(directory) = directory.filter(|path| path.is_absolute()) else {
        return Err("A private runtime directory is required".into());
    };
    run(
        &directory,
        &mut io::stdout(),
        Duration::from_millis(250),
        &AtomicBool::new(false),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn wait_for(output: &Shared, text: &str) {
        for _ in 0..200 {
            if output.text().contains(text) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("Timed out waiting for {text}: {}", output.text());
    }

    #[test]
    fn command_clears_bridge_capabilities_and_identifies_only_its_directory() {
        let directory = Path::new("/tmp/suplex-devin-runtime");
        let display = display_command(directory).unwrap();
        assert!(display.command.contains("'-u' 'SUPLEX_ROOT_BINDING'"));
        assert!(display.command.contains("'-u' 'SUPLEX_ADVISOR_RESULT'"));
        let argv = std::iter::once(display.executable.clone())
            .chain(display.args.clone())
            .collect::<Vec<_>>();
        assert!(display_attached(directory, &argv));
        assert!(!display_attached(Path::new("/tmp/other-runtime"), &argv));
        assert!(!display_attached(
            directory,
            &[
                "/bin/devin".into(),
                "--resume".into(),
                "assigned-session".into()
            ]
        ));
        assert_eq!(safe_terminal_text("a\rb\u{7}c\td\u{9b}"), "a\nbc\td");
        assert!(main(&["relative".into()]).is_err());
    }

    #[test]
    fn display_follows_two_turns_once_each_and_splits_utf8_safely() {
        let directory =
            std::env::temp_dir().join(format!("suplex-devin-display-{}", uuid::Uuid::new_v4()));
        let output = Shared::default();
        let stop = Arc::new(AtomicBool::new(false));
        let runner = {
            let (directory, mut output, stop) = (directory.clone(), output.clone(), stop.clone());
            thread::spawn(move || run(&directory, &mut output, Duration::from_millis(5), &stop))
        };
        wait_for(&output, "Waiting for Devin output");
        fs::create_dir_all(&directory).unwrap();
        let append = |name: &str, bytes: &[u8]| {
            fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(directory.join(name))
                .unwrap()
                .write_all(bytes)
                .unwrap();
        };
        append("turn-first.jsonl", b"FIRST stdout\n");
        wait_for(&output, "FIRST stdout");
        append("turn-first.stderr.log", b"FIRST stderr \xC3");
        thread::sleep(Duration::from_millis(30));
        append("turn-first.stderr.log", b"\xA9\n");
        wait_for(&output, "FIRST stderr \u{e9}");
        append("turn-first.export.json", b"ignored");
        append("turn-second.jsonl", b"SECOND stdout\n");
        append("turn-second.stderr.log", b"SECOND stderr\n");
        wait_for(&output, "SECOND stderr");
        thread::sleep(Duration::from_millis(30));
        stop.store(true, Ordering::SeqCst);
        runner.join().unwrap().unwrap();
        let text = output.text();
        for line in [
            "FIRST stdout",
            "FIRST stderr",
            "SECOND stdout",
            "SECOND stderr",
        ] {
            assert_eq!(text.matches(line).count(), 1, "{text}");
        }
        assert!(!text.contains("ignored"));
        assert!(!text.contains('\u{fffd}'));
        fs::remove_dir_all(directory).unwrap();
    }
}
