//! `suplex update` for a Linux host installed from the release archive: compare the
//! running version with the published feed, download the archive, verify its
//! checksum, replace this binary in place, and restart the host in place. The desktop app
//! and a source checkout update through their own paths.
use std::{
    fs,
    io::{self, Write},
    path::Path,
    process::Command,
    sync::LazyLock,
    time::Duration,
};

use sha2::{Digest, Sha256};

use super::{
    app_update, config::Installation, environment_settings::UpdateChannel, supervisor, update,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

/// A Linux host that runs the release archive: not the desktop app, and not a checkout.
/// The answer cannot change while the process runs, and the status poll asks often.
pub fn managed() -> bool {
    static MANAGED: LazyLock<bool> = LazyLock::new(|| {
        cfg!(target_os = "linux")
            && std::env::var("SUPLEX_PACKAGED").as_deref() != Ok("1")
            && std::env::current_dir().is_ok_and(|root| update::remote(&root).is_err())
    });
    *MANAGED
}

fn platform() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("linux-x64"),
        "aarch64" => Ok("linux-arm64"),
        other => Err(format!("Suplex publishes no Linux release for {other}").into()),
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()?)
}

/// `latest-linux.yml`: the version, the archive file name, and its checksum.
fn parse_manifest(text: &str) -> Result<(String, String, String)> {
    let field = |name: &str| {
        text.lines()
            .find_map(|line| {
                line.trim_start()
                    .trim_start_matches("- ")
                    .strip_prefix(&format!("{name}: "))
            })
            .map(|value| value.trim().trim_matches('\'').to_owned())
            .ok_or_else(|| format!("The update feed has no {name}"))
    };
    let file = field("url")?;
    if file.contains('/') || file.contains("..") {
        return Err("The update feed names an invalid file".into());
    }
    Ok((field("version")?, file, field("sha256")?))
}

/// The newest release this channel's feeds publish for this platform, or `None` when this
/// binary is current.
pub async fn latest(service: &url::Url, channel: UpdateChannel) -> Result<Option<Release>> {
    let client = client(Duration::from_secs(30))?;
    let mut releases = Vec::new();
    for &source in channel.feeds() {
        releases.push(published(&client, service, source).await);
    }
    let release = app_update::newest(releases, |release: &Release| &release.version)?;
    Ok(app_update::newer(&release.version, env!("CARGO_PKG_VERSION")).then_some(release))
}

/// One channel's release. The download redirect names the release directory, whose manifest
/// is the source of truth.
async fn published(
    client: &reqwest::Client,
    service: &url::Url,
    channel: UpdateChannel,
) -> Result<Release> {
    let download = service.join(&format!(
        "download?platform={}&format=tar.gz&channel={channel}",
        platform()?
    ))?;
    let response = client
        .get(download.clone())
        .header("dnt", "1")
        .send()
        .await?;
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("{download} did not name a release ({})", response.status()))?;
    let directory = download.join(location)?.join("./")?;
    let text = client
        .get(directory.join("latest-linux.yml")?)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let (version, file, sha256) = parse_manifest(&text)?;
    Ok(Release {
        version,
        url: directory.join(&file)?.into(),
        sha256,
    })
}

/// The archive bytes, after their checksum matched the feed.
pub async fn download(release: &Release) -> Result<Vec<u8>> {
    let bytes = client(Duration::from_secs(600))?
        .get(&release.url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if format!("{:x}", Sha256::digest(&bytes)) != release.sha256 {
        return Err("The downloaded archive does not match the update feed checksum.".into());
    }
    Ok(bytes.to_vec())
}

/// Replaces `target` with the `suplex` file from the archive and keeps the previous
/// binary at `rollback`. The new file lands beside `target` first, so a directory
/// this user cannot write fails before anything changes.
pub fn install(archive: &[u8], target: &Path, rollback: &Path) -> Result<()> {
    let stored = rollback.with_extension("tar.gz");
    fs::write(&stored, archive)?;
    let output = Command::new("tar")
        .arg("-xzOf")
        .arg(&stored)
        .arg("suplex")
        .output();
    let _ = fs::remove_file(&stored);
    let output = output?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(format!(
            "The archive has no suplex binary: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let staging = target.with_extension("update-staging");
    let mut file = fs::File::create(&staging).map_err(|error| {
        if error.kind() == io::ErrorKind::PermissionDenied {
            format!(
                "Suplex cannot replace {}. Install the update as an administrator.",
                target.display()
            )
        } else {
            error.to_string()
        }
    })?;
    file.write_all(&output.stdout)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o755))?;
    }
    drop(file);
    let staged_rollback = rollback.with_extension("staging");
    fs::copy(target, &staged_rollback)?;
    fs::rename(&staged_rollback, rollback)?;
    fs::rename(&staging, target)?;
    Ok(())
}

/// Puts the previous binary back at `target` through the same staged rename.
pub fn restore(rollback: &Path, target: &Path) -> Result<()> {
    let staging = target.with_extension("update-staging");
    fs::copy(rollback, &staging)?;
    fs::rename(&staging, target)?;
    Ok(())
}

/// Runs a check from a thread without a runtime, such as the update process or a
/// blocking task.
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(future)
}

pub fn service_url(installation: &Installation) -> Result<url::Url> {
    installation
        .account_service_url
        .clone()
        .ok_or_else(|| "The Suplex account service address is not configured.".into())
}

/// `suplex update` on an archive-installed host: the feed check and the question, then the
/// same download, check, and in-place restart as the Update button. `channel` overrides the
/// host's update channel for this run.
pub async fn run(assume_yes: bool, channel: Option<UpdateChannel>) -> Result<i32> {
    let installation = Installation::load()?;
    let channel = channel.unwrap_or_else(|| UpdateChannel::configured(&installation));
    let Some(release) = latest(&service_url(&installation)?, channel).await? else {
        println!("Suplex {} is current.", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    };
    let running = supervisor::supervisor_running(&installation);
    if running && !app_update::confirm(&release.version, assume_yes)? {
        println!("Update cancelled.");
        return Ok(1);
    }
    println!("Downloading Suplex {}...", release.version);
    if !tokio::task::spawn_blocking(move || update::apply(Some(channel))).await?? {
        return Err("Another Suplex update is in progress.".into());
    }
    if running {
        println!("Suplex {} is running.", release.version);
    } else {
        println!(
            "Suplex {} is installed. Run 'suplex up' to start it.",
            release.version
        );
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::RawQuery, http::StatusCode, response::IntoResponse, routing::get};

    const MANIFEST: &str = "version: 1.10.0\nfiles:\n  - url: suplex-1.10.0-linux-x64.tar.gz\n    sha256: 95ae29073130f1285fe43cec46b4367c3be372a331f05485f5382de8d5148988\n";

    #[test]
    fn reads_the_published_manifest_format() {
        assert_eq!(
            parse_manifest(MANIFEST).unwrap(),
            (
                "1.10.0".to_owned(),
                "suplex-1.10.0-linux-x64.tar.gz".to_owned(),
                "95ae29073130f1285fe43cec46b4367c3be372a331f05485f5382de8d5148988".to_owned()
            )
        );
        assert!(
            parse_manifest("version: 1.0.0\nfiles:\n  - url: ../etc/passwd\n    sha256: 00\n")
                .is_err()
        );
        assert!(parse_manifest("files: []\n").is_err());
    }

    /// Feeds served the way suplex.sh serves them: a redirect to the archive of the asked
    /// channel, and the manifest beside it. A channel without a version has no release.
    async fn feed(
        stable: &'static str,
        dev: Option<&'static str>,
        archive: &'static [u8],
    ) -> url::Url {
        let digest = format!("{:x}", Sha256::digest(archive));
        let manifest = move |version: &str| {
            format!(
                "version: {version}\nfiles:\n  - url: suplex-{version}-linux-x64.tar.gz\n    sha256: {digest}\n"
            )
        };
        let (stable_manifest, dev_manifest) = (manifest(stable), dev.map(manifest));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let service = url::Url::parse(&base).unwrap();
        let app = Router::new()
            .route(
                "/download",
                get(move |RawQuery(query): RawQuery| async move {
                    let query = query.unwrap_or_default();
                    let (channel, version) = if query.contains("channel=dev") {
                        ("dev", dev)
                    } else {
                        ("stable", Some(stable))
                    };
                    match version {
                        Some(version) => (
                            StatusCode::FOUND,
                            [(
                                "location",
                                format!(
                                    "{base}/{channel}/linux/x64/suplex-{version}-linux-x64.tar.gz"
                                ),
                            )],
                        )
                            .into_response(),
                        None => {
                            (StatusCode::BAD_GATEWAY, "No release is published.").into_response()
                        }
                    }
                }),
            )
            .route(
                "/stable/linux/x64/latest-linux.yml",
                get(move || async move { stable_manifest }),
            )
            .route(
                "/dev/linux/x64/latest-linux.yml",
                get(move || async move { dev_manifest.unwrap_or_default() }),
            )
            .route(
                "/{channel}/linux/x64/{file}",
                get(move || async move { archive }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        service
    }

    #[tokio::test]
    async fn the_feed_decides_whether_an_update_exists_and_the_checksum_guards_the_download() {
        if platform().is_err() {
            return;
        }
        let archive: &'static [u8] = b"not really a tarball";
        let service = feed("999.0.0", None, archive).await;
        let release = latest(&service, UpdateChannel::Stable)
            .await
            .unwrap()
            .expect("a newer release");
        assert_eq!(release.version, "999.0.0");
        assert!(
            release
                .url
                .ends_with("/stable/linux/x64/suplex-999.0.0-linux-x64.tar.gz"),
            "{}",
            release.url
        );
        assert_eq!(download(&release).await.unwrap(), archive);
        let tampered = Release {
            sha256: "00".repeat(32),
            ..release
        };
        assert!(
            download(&tampered)
                .await
                .unwrap_err()
                .to_string()
                .contains("checksum")
        );
        assert_eq!(
            latest(&feed("0.0.1", None, archive).await, UpdateChannel::Stable)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn the_channel_picks_the_feeds_and_the_newest_release_wins() {
        if platform().is_err() {
            return;
        }
        let archive: &'static [u8] = b"not really a tarball";
        let service = feed("999.0.0", Some("999.0.1-dev.202611131540"), archive).await;
        // Stable never reads the development feed.
        let stable = latest(&service, UpdateChannel::Stable)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stable.version, "999.0.0");
        let dev = latest(&service, UpdateChannel::Dev).await.unwrap().unwrap();
        assert_eq!(dev.version, "999.0.1-dev.202611131540");
        assert!(dev.url.contains("/dev/linux/x64/"), "{}", dev.url);
        // A development host moves to a stable release that is newer than its build.
        let service = feed("999.0.1", Some("999.0.1-dev.202611131540"), archive).await;
        let next = latest(&service, UpdateChannel::Dev).await.unwrap().unwrap();
        assert_eq!(next.version, "999.0.1");
        assert!(next.url.contains("/stable/linux/x64/"), "{}", next.url);
        // A platform without a development release follows stable.
        let service = feed("999.0.0", None, archive).await;
        let only_stable = latest(&service, UpdateChannel::Dev).await.unwrap().unwrap();
        assert_eq!(only_stable.version, "999.0.0");
    }

    /// `cargo test -p suplex --lib -- --ignored live_feed` proves the published feed parses.
    #[tokio::test]
    #[ignore = "reads suplex.sh"]
    async fn the_live_feed_parses() {
        if platform().is_err() {
            return;
        }
        let release = latest(
            &url::Url::parse("https://suplex.sh").unwrap(),
            UpdateChannel::Stable,
        )
        .await
        .unwrap();
        eprintln!(
            "live feed: {release:?} (running {})",
            env!("CARGO_PKG_VERSION")
        );
    }

    #[test]
    #[cfg(unix)]
    fn install_swaps_the_binary_in_place_and_keeps_a_rollback() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("suplex-archive-update-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("source")).unwrap();
        fs::write(dir.join("source/suplex"), "#!/bin/sh\necho new\n").unwrap();
        let status = Command::new("tar")
            .args(["-czf", "archive.tar.gz", "-C", "source", "suplex"])
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(status.success());
        let archive = fs::read(dir.join("archive.tar.gz")).unwrap();
        let target = dir.join("bin/suplex");
        let rollback = dir.join("update-rollback-suplex");
        fs::write(&target, "#!/bin/sh\necho old\n").unwrap();
        install(&archive, &target, &rollback).unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\necho new\n"
        );
        assert_eq!(
            fs::read_to_string(&rollback).unwrap(),
            "#!/bin/sh\necho old\n"
        );
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        restore(&rollback, &target).unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\necho old\n"
        );
        assert!(
            install(b"junk", &target, &rollback)
                .unwrap_err()
                .to_string()
                .contains("no suplex binary")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
