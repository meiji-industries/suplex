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

use crate::platform::{config::Installation, environment_settings::UpdateChannel, supervisor};

type Error = Box<dyn std::error::Error + Send + Sync>;
type UpdateResult = Result<i32, Error>;

/// The top-level fields of the Mac feed's `latest-mac.yml` (the electron-builder format, still published beside the Tauri feed).
#[derive(Debug, PartialEq)]
struct Release {
    version: String,
    path: String,
    sha512: String,
}

/// `channel` overrides the host's update channel for this run.
pub async fn run(app: &Path, assume_yes: bool, channel: Option<UpdateChannel>) -> UpdateResult {
    let current = env!("CARGO_PKG_VERSION");
    let installation = Installation::load().ok();
    let channel = channel
        .or_else(|| installation.as_ref().map(UpdateChannel::configured))
        .unwrap_or(UpdateChannel::Stable);
    let installed_feed = feed_url(app)?;
    let mut releases = Vec::new();
    for &source in channel.feeds() {
        let feed = channel_feed(&installed_feed, source);
        releases.push(fetch_release(&feed).await.map(|release| (feed, release)));
    }
    let (feed, release) = newest(releases, |(_, release)| &release.version)?;
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
    // Buffers the ~150 MB archive in memory; stream to disk if that becomes a problem.
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

fn feed_url(app: &Path) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let config = fs::read_to_string(app.join("Contents/Resources/app-update.yml"))
        .map_err(|_| "This Suplex.app has no update feed. Install a new build to update it.")?;
    let url = config
        .lines()
        .find_map(|line| line.strip_prefix("url: "))
        .ok_or("app-update.yml has no url")?
        .trim();
    Ok(format!("{}/", url.trim_end_matches('/')))
}

async fn fetch_release(feed: &str) -> Result<Release, Error> {
    parse_feed(
        &reqwest::get(format!("{feed}latest-mac.yml"))
            .await?
            .error_for_status()?
            .text()
            .await?,
    )
}

/// The same feed folder in another channel: `.../stable/mac/arm64/` and `.../dev/mac/arm64/`.
/// A development build names the dev folder in its `app-update.yml`.
pub(crate) fn channel_feed(feed: &str, channel: UpdateChannel) -> String {
    for folder in ["/stable/", "/dev/"] {
        if let Some(index) = feed.rfind(folder) {
            return format!(
                "{}/{channel}/{}",
                &feed[..index],
                &feed[index + folder.len()..]
            );
        }
    }
    feed.to_owned()
}

/// The newest release among a channel's feeds. A feed that fails is skipped while another
/// answers, so a platform without a development release still follows stable.
pub(crate) fn newest<R>(
    releases: Vec<Result<R, Error>>,
    version: impl Fn(&R) -> &str,
) -> Result<R, Error> {
    let mut best: Option<R> = None;
    let mut failure = None;
    for release in releases {
        match release {
            Ok(release) => {
                if best
                    .as_ref()
                    .is_none_or(|best| newer(version(&release), version(best)))
                {
                    best = Some(release);
                }
            }
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    best.ok_or_else(|| failure.unwrap_or_else(|| "No update feed answered.".into()))
}

fn parse_feed(text: &str) -> Result<Release, Error> {
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

/// Semantic version precedence: a prerelease such as `1.13.9-dev.202611131540` is newer than
/// 1.13.8 and older than 1.13.9, and `+<commit>` build metadata does not count. A version
/// that does not parse is never newer.
pub(crate) fn newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate.trim()),
        semver::Version::parse(current.trim()),
    ) {
        (Ok(candidate), Ok(current)) => candidate.cmp_precedence(&current).is_gt(),
        _ => false,
    }
}

/// The new bundle must pass Gatekeeper and come from the same team as the installed one.
fn verify_signature(
    installed: &Path,
    new_app: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
fn quit_app(app: &Path) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
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

pub(crate) fn confirm(version: &str, assume_yes: bool) -> io::Result<bool> {
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

fn check(
    command: &mut Command,
    name: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
    fn compares_versions_by_semantic_version_precedence() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.8.3", "0.8.3"));
        assert!(!newer("0.8.2", "0.8.3"));
        let dev = "1.13.9-dev.202611131540";
        // A development build sorts above the stable release before it and below the next one.
        assert!(newer(dev, "1.13.8"));
        assert!(!newer("1.13.8", dev));
        assert!(newer("1.13.9", dev));
        assert!(!newer(dev, "1.13.9"));
        // Its timestamp orders development builds; the commit metadata does not count.
        assert!(newer("1.13.9-dev.202611131541", dev));
        assert!(!newer(dev, "1.13.9-dev.202611131541+60ff4ce2"));
        assert!(!newer(dev, &format!("{dev}+60ff4ce2")));
        assert!(!newer(&format!("{dev}+60ff4ce2"), dev));
        // Numeric identifiers compare as numbers, alphanumeric ones as text and above numbers.
        assert!(newer("1.0.0-dev.10", "1.0.0-dev.9"));
        assert!(newer("1.0.0-dev.a", "1.0.0-dev.9"));
        assert!(newer("1.0.0-beta", "1.0.0-alpha.1"));
        assert!(!newer("not a version", "1.0.0"));
        assert!(!newer("1.0.0", "not a version"));
    }

    #[test]
    fn feeds_follow_the_channel() {
        let stable = "https://downloads.example/stable/mac/arm64/";
        let dev = "https://downloads.example/dev/mac/arm64/";
        assert_eq!(channel_feed(stable, UpdateChannel::Dev), dev);
        assert_eq!(channel_feed(dev, UpdateChannel::Stable), stable);
        assert_eq!(channel_feed(stable, UpdateChannel::Stable), stable);
        assert_eq!(UpdateChannel::Stable.feeds(), [UpdateChannel::Stable]);
        assert_eq!(
            UpdateChannel::Dev.feeds(),
            [UpdateChannel::Stable, UpdateChannel::Dev]
        );
    }

    #[test]
    fn the_newest_release_across_feeds_wins_and_a_missing_feed_is_skipped() {
        fn version<'a>(release: &'a &str) -> &'a str {
            release
        }
        // A stable host on 1.13.8 and a development host both see the newest answer.
        assert_eq!(
            newest(vec![Ok("1.13.9"), Ok("1.13.9-dev.202611131540")], version).unwrap(),
            "1.13.9"
        );
        assert_eq!(
            newest(vec![Ok("1.13.8"), Ok("1.13.9-dev.202611131540")], version).unwrap(),
            "1.13.9-dev.202611131540"
        );
        assert_eq!(
            newest(vec![Ok("1.13.8"), Err("no dev feed".into())], version).unwrap(),
            "1.13.8"
        );
        assert!(newest::<&str>(vec![Err("offline".into())], version).is_err());
    }
}
