//! `suplex update` for a Suplex.app installation: download the release from the
//! app's own update feed, verify it, and replace the bundle. A running app and
//! host are stopped before the swap and started again after it.

use std::{
    fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use base64::Engine;
use sha2::{Digest, Sha512};

use crate::platform::{config::Installation, supervisor};

type UpdateResult = Result<i32, Box<dyn std::error::Error>>;

/// The top-level fields of electron-builder's `latest-mac.yml`.
#[derive(Debug, PartialEq)]
struct Release {
    version: String,
    path: String,
    sha512: String,
}

pub async fn run(app: &Path, assume_yes: bool) -> UpdateResult {
    let current = env!("CARGO_PKG_VERSION");
    let feed = feed_url(app)?;
    let release = parse_feed(
        &reqwest::get(format!("{feed}latest-mac.yml"))
            .await?
            .error_for_status()?
            .text()
            .await?,
    )?;
    if !newer(&release.version, current) {
        println!("Suplex {current} is current.");
        return Ok(0);
    }

    // Stage next to the bundle so the final swap is a rename on the same volume.
    let parent = app.parent().ok_or("Suplex.app has no parent directory")?;
    let staging = Staging(parent.join(format!(".suplex-update-{}", std::process::id())));
    fs::create_dir(&staging.0)
        .map_err(|error| format!("Cannot write to {}: {error}", parent.display()))?;

    println!("Downloading Suplex {}...", release.version);
    // ponytail: buffers the ~150 MB archive in memory; stream to disk if that becomes a problem.
    let archive = reqwest::get(format!("{feed}{}", release.path))
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&archive));
    if digest != release.sha512 {
        return Err("The downloaded archive does not match the update feed checksum.".into());
    }
    let zip = staging.0.join("update.zip");
    fs::write(&zip, &archive)?;
    drop(archive);
    let extracted = staging.0.join("new");
    check(
        Command::new("ditto")
            .arg("-x")
            .arg("-k")
            .arg(&zip)
            .arg(&extracted),
        "ditto",
    )?;
    let new_app = extracted.join(app.file_name().ok_or("Suplex.app has no name")?);
    verify_signature(app, &new_app)?;

    let app_running = app_running(app);
    let installation = Installation::load().ok();
    let host_running = installation.as_ref().is_some_and(supervisor::host_running);
    if (app_running || host_running) && !confirm(&release.version, assume_yes)? {
        println!("Update cancelled.");
        return Ok(1);
    }
    let app_killed = if app_running {
        println!("Quitting Suplex.app...");
        quit_app(app)?
    } else {
        false
    };
    // The app stops a host it started; stop an independent host too and start it after.
    // A killed app leaves its host running: stop that one, and the app starts it again.
    let restart_host = match &installation {
        Some(installation) if supervisor::host_running(installation) => {
            println!("Stopping the Suplex host...");
            supervisor::stop(installation)?;
            !app_killed
        }
        _ => false,
    };

    let old_app = staging.0.join("old.app");
    fs::rename(app, &old_app)?;
    if let Err(error) = fs::rename(&new_app, app) {
        fs::rename(&old_app, app)?;
        return Err(format!("Could not install the new Suplex.app: {error}").into());
    }
    println!("Installed Suplex {}.", release.version);

    if restart_host && let Some(installation) = &installation {
        // current_exe() keeps the original path, which now holds the new bundle.
        let pid = supervisor::start(installation)?;
        println!(
            "Suplex started at {}; owned processes: server#{pid}",
            installation.reachable_address
        );
    }
    if app_running {
        check(Command::new("open").arg(app), "open")?;
        println!("Suplex.app started.");
    }
    Ok(0)
}

/// Removes the staging directory, including the replaced bundle, on every exit path.
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn feed_url(app: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let config = fs::read_to_string(app.join("Contents/Resources/app-update.yml"))
        .map_err(|_| "This Suplex.app has no update feed. Install a new build to update it.")?;
    let url = config
        .lines()
        .find_map(|line| line.strip_prefix("url: "))
        .ok_or("app-update.yml has no url")?
        .trim();
    Ok(format!("{}/", url.trim_end_matches('/')))
}

fn parse_feed(text: &str) -> Result<Release, Box<dyn std::error::Error>> {
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{name}: ")))
            .map(|value| value.trim().trim_matches('\'').to_owned())
            .ok_or_else(|| format!("The update feed has no {name}"))
    };
    Ok(Release {
        version: field("version")?,
        path: field("path")?,
        sha512: field("sha512")?,
    })
}

fn newer(candidate: &str, current: &str) -> bool {
    let parse = |version: &str| -> Option<Vec<u64>> {
        version.split('.').map(|part| part.parse().ok()).collect()
    };
    matches!((parse(candidate), parse(current)), (Some(a), Some(b)) if a > b)
}

/// The new bundle must pass Gatekeeper and come from the same team as the installed one.
fn verify_signature(installed: &Path, new_app: &Path) -> Result<(), Box<dyn std::error::Error>> {
    check(
        Command::new("codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(new_app),
        "codesign",
    )?;
    check(
        Command::new("spctl")
            .args(["--assess", "--type", "execute"])
            .arg(new_app),
        "spctl",
    )?;
    let team = |app: &Path| -> Option<String> {
        let output = Command::new("codesign").arg("-dv").arg(app).output().ok()?;
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .find_map(|line| line.strip_prefix("TeamIdentifier="))
            .map(str::to_owned)
    };
    match (team(installed), team(new_app)) {
        (Some(old), Some(new)) if old == new && old != "not set" => Ok(()),
        _ => Err("The downloaded Suplex.app is not signed by the same team.".into()),
    }
}

fn app_pids(app: &Path) -> Vec<String> {
    let binary = app.join("Contents/MacOS/Suplex");
    Command::new("ps")
        .args(["-axo", "pid=,comm="])
        .output()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().split_once(' '))
                .filter(|(_, command)| Path::new(command.trim()) == binary)
                .map(|(pid, _)| pid.to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn app_running(app: &Path) -> bool {
    !app_pids(app).is_empty()
}

fn wait_for_exit(app: &Path, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while app_running(app) {
        if Instant::now() > deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(250));
    }
    true
}

/// Returns true when the app had to be killed, which leaves the host it started running.
fn quit_app(app: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    let script = format!("tell application \"{}\" to quit", app.display());
    let accepted = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .is_ok_and(|output| output.status.success());
    if accepted && wait_for_exit(app, Duration::from_secs(10)) {
        return Ok(false);
    }
    // macOS refuses the quit event while a dialog is open. SIGTERM still quits the app normally, except under the
    // app-modal dialogs of 1.2.0 and earlier, which stop the whole process until they are answered.
    println!("Suplex.app did not quit. Stopping it...");
    for signal in ["-TERM", "-KILL"] {
        let _ = Command::new("kill")
            .arg(signal)
            .args(app_pids(app))
            .output();
        if wait_for_exit(app, Duration::from_secs(10)) {
            return Ok(signal == "-KILL");
        }
    }
    Err("Suplex.app did not stop. Quit it, then run 'suplex update' again.".into())
}

fn confirm(version: &str, assume_yes: bool) -> io::Result<bool> {
    if assume_yes {
        return Ok(true);
    }
    if !io::stdin().is_terminal() {
        return Err(io::Error::other(
            "Suplex is running. Run 'suplex update --yes' to stop it, update, and start it again.",
        ));
    }
    print!("Suplex is running. Stop it, install {version}, and start it again? [Y/n] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "" | "y" | "yes"
    ))
}

fn check(command: &mut Command, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{name} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_top_level_release_from_the_feed() {
        let feed = "version: 0.8.3\nfiles:\n  - url: Suplex-0.8.3-arm64-mac.zip\n    sha512: nested==\npath: Suplex-0.8.3-arm64-mac.zip\nsha512: top==\nreleaseDate: '2026-09-29T01:26:15.104Z'\n";
        assert_eq!(
            parse_feed(feed).unwrap(),
            Release {
                version: "0.8.3".into(),
                path: "Suplex-0.8.3-arm64-mac.zip".into(),
                sha512: "top==".into()
            }
        );
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.8.3", "0.8.3"));
        assert!(!newer("0.8.2", "0.8.3"));
        assert!(!newer("1.0.0-beta", "0.8.3"));
    }
}
