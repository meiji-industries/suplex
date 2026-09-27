//! Stop live worktree processes after cancelled native sessions have stopped.
//! Process IDs and display records are observations; inspect the OS again
//! before signaling, and leave uncertain ownership alone.

use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};

use crate::runtimes::{
    headless,
    process::{IdentityMatch, ProcessIdentity, compare_identity, inspect_process},
};

fn command_output(command: &str, args: &[&str]) -> io::Result<String> {
    let output = Command::new(command)
        .args(args)
        .env("LC_ALL", "C")
        .output()?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 * 1024 {
        return Err(io::Error::other(format!(
            "Could not inspect task processes with {command}"
        )));
    }
    String::from_utf8(output.stdout).map_err(io::Error::other)
}

fn worktree_process_ids(path: &Path) -> io::Result<HashSet<u32>> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let existing_target = absolute.canonicalize().ok();
    let mut found = headless::discovered_process_ids("SUPLEX_TASK_PROCESS_OWNER", &absolute)?
        .into_iter()
        .collect::<HashSet<_>>();
    let uid = unsafe { libc::getuid() }.to_string();
    let output = command_output("lsof", &["-a", "-u", &uid, "-d", "cwd", "-Fpn"])?;
    let mut pid = None;
    for line in output.lines() {
        if let Some(raw) = line.strip_prefix('p') {
            pid = raw.parse::<u32>().ok();
        } else if let (Some(raw), Some(pid)) = (line.strip_prefix('n'), pid)
            && pid != std::process::id()
            && (Path::new(raw).starts_with(&absolute)
                || existing_target
                    .as_ref()
                    .is_some_and(|target| Path::new(raw).starts_with(target)))
        {
            found.insert(pid);
        }
    }
    let tree = command_output("ps", &["-axo", "pid=,ppid="])?;
    let parents = tree
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((
                fields.next()?.parse::<u32>().ok()?,
                fields.next()?.parse::<u32>().ok()?,
            ))
        })
        .collect::<HashMap<_, _>>();
    loop {
        let previous = found.len();
        for (child, parent) in &parents {
            if *child != std::process::id() && found.contains(parent) {
                found.insert(*child);
            }
        }
        if found.len() == previous {
            break;
        }
    }
    Ok(found)
}

pub fn stop_worktree_processes(path: &Path) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let first = worktree_process_ids(path)?;
        let second = worktree_process_ids(path)?;
        let owned = first
            .intersection(&second)
            .filter_map(|pid| inspect_process(*pid))
            .filter(|identity| identity.owner_uid == Some(unsafe { libc::getuid() }))
            .collect::<Vec<ProcessIdentity>>();
        if owned.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other(
                "Task commands are still running after cleanup",
            ));
        }
        for identity in owned {
            if compare_identity(&identity, inspect_process(identity.pid).as_ref())
                != IdentityMatch::Exact
            {
                continue;
            }
            let pid = Pid::from_raw(i32::try_from(identity.pid).map_err(io::Error::other)?);
            match kill(pid, Signal::SIGTERM) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
            thread::sleep(Duration::from_millis(250));
            if compare_identity(&identity, inspect_process(identity.pid).as_ref())
                != IdentityMatch::Exact
            {
                continue;
            }
            match kill(pid, Signal::SIGKILL) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::runtimes::process::owner_marker;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn cancellation_stops_live_worktree_process_without_a_display_receipt() {
        let base = std::env::temp_dir().join(format!("suplex-cancel-process-{}", Uuid::new_v4()));
        let worktree = base.join("worktree");
        let outside = base.join("outside");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let mut owned = Command::new("/bin/sleep")
            .arg("30")
            .current_dir(&worktree)
            .env("SUPLEX_TASK_PROCESS_OWNER", owner_marker(&worktree))
            .spawn()
            .unwrap();
        let mut unrelated = Command::new("/bin/sleep")
            .arg("30")
            .current_dir(&outside)
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(150));
        let result = stop_worktree_processes(&worktree);
        if result.is_err() {
            let _ = owned.kill();
        }
        assert!(result.is_ok(), "{result:?}");
        assert!(owned.wait().unwrap().code().is_none());
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        stop_worktree_processes(&base.join("missing-worktree")).unwrap();
        let linked_parent = base.join("linked-parent");
        std::os::unix::fs::symlink(&worktree, &linked_parent).unwrap();
        let missing_through_link = linked_parent.join("missing-worktree");
        assert_ne!(
            owner_marker(&missing_through_link),
            owner_marker(&worktree.join("missing-worktree"))
        );
        stop_worktree_processes(&missing_through_link).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}
