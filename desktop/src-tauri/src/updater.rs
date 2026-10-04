//! Desktop app update interaction. A dialog opens only as the direct answer to a click; automatic
//! checks, finished downloads, and background failures post a notification whose click opens the
//! dialog. Nothing downloads or installs without the user choosing it.

use std::{future::Future, sync::Mutex};

pub const TITLE: &str = "Desktop app update";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Check,
    Download,
    Install,
}

impl Failure {
    pub fn message(self) -> &'static str {
        match self {
            Self::Check => "Suplex could not check the desktop app update.",
            Self::Download => "Suplex could not download the desktop app update.",
            Self::Install => "Suplex could not install the desktop app update.",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Info,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dialog {
    pub kind: Kind,
    pub message: String,
    pub detail: Option<String>,
    /// The first button is the default action; the last cancels.
    pub buttons: Vec<&'static str>,
}

/// What clicking a notification opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Followup {
    OfferDownload(UpdateInfo),
    OfferRestart(UpdateInfo),
}

pub trait Ports: Send + Sync {
    fn check(&self) -> impl Future<Output = Result<Option<UpdateInfo>, String>> + Send;
    /// Downloads and verifies the last checked update, keeping it for a later install.
    fn download(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// Installs the downloaded update, shuts down the owned host through the normal lifecycle, and relaunches.
    fn install_and_restart(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// Shows a dialog attached to a visible window and returns the chosen button index.
    fn dialog(&self, dialog: Dialog) -> impl Future<Output = usize> + Send;
    fn notify(&self, message: String, followup: Followup);
}

#[derive(Default)]
struct State {
    checking: bool,
    downloading: bool,
    /// A prompt is open or a download runs; an automatic check waits for the next interval.
    offering: bool,
    /// The version an automatic check already announced this run.
    announced: Option<String>,
    /// A finished download waiting for the user to restart.
    downloaded: Option<UpdateInfo>,
}

pub struct DesktopUpdater<P: Ports> {
    ports: P,
    configured: bool,
    state: Mutex<State>,
}

impl<P: Ports> DesktopUpdater<P> {
    pub fn new(ports: P, configured: bool) -> Self {
        Self {
            ports,
            configured,
            state: Mutex::default(),
        }
    }

    pub async fn check(&self, manual: bool) {
        let downloaded = {
            let mut state = self.state.lock().unwrap();
            if !manual && (state.offering || state.checking || state.downloading) {
                return;
            }
            if !(manual && state.downloaded.is_some()) {
                state.checking = self.configured;
            }
            state.downloaded.clone()
        };
        if let (true, Some(info)) = (manual, downloaded) {
            return self.offer_restart(info).await;
        }
        if !self.configured {
            if manual {
                self.ports
                    .dialog(Dialog {
                        kind: Kind::Info,
                        message: "Desktop app updates are not configured.".into(),
                        detail: Some("This build has no update feed or signing key. Install a new Suplex.app build to update the desktop app.".into()),
                        buttons: vec!["Continue"],
                    })
                    .await;
            }
            return;
        }
        let result = self.ports.check().await;
        self.state.lock().unwrap().checking = false;
        match result {
            Err(error) if manual => self.show_error(Failure::Check, error).await,
            Err(error) => eprintln!("Suplex could not check the desktop app update: {error}"),
            Ok(None) if manual => {
                self.ports
                    .dialog(Dialog {
                        kind: Kind::Info,
                        message: "The Suplex desktop app is current.".into(),
                        detail: None,
                        buttons: vec!["Continue"],
                    })
                    .await;
            }
            Ok(None) => {}
            Ok(Some(info)) if manual => self.offer_download(info).await,
            Ok(Some(info)) => {
                let first = {
                    let mut state = self.state.lock().unwrap();
                    let first = state.announced.as_deref() != Some(info.version.as_str());
                    state.announced = Some(info.version.clone());
                    first
                };
                if first {
                    self.ports.notify(
                        format!("Suplex desktop app {} is available.", info.version),
                        Followup::OfferDownload(info),
                    );
                }
            }
        }
    }

    /// A notification click.
    pub async fn follow(&self, followup: Followup) {
        match followup {
            Followup::OfferDownload(info) => self.offer_download(info).await,
            Followup::OfferRestart(info) => self.offer_restart(info).await,
        }
    }

    async fn offer_download(&self, info: UpdateInfo) {
        {
            let mut state = self.state.lock().unwrap();
            if state.offering || state.downloading {
                return;
            }
            state.offering = true;
        }
        let answer = self
            .ports
            .dialog(Dialog {
                kind: Kind::Info,
                message: format!("Suplex desktop app {} is available.", info.version),
                detail: None,
                buttons: vec!["Start download", "Continue"],
            })
            .await;
        if answer == 0 {
            self.state.lock().unwrap().downloading = true;
            let result = self.ports.download().await;
            {
                let mut state = self.state.lock().unwrap();
                state.downloading = false;
                state.offering = false;
                if result.is_ok() {
                    state.downloaded = Some(info.clone());
                }
            }
            return match result {
                Ok(()) => self.ports.notify(
                    format!("Suplex desktop app {} was downloaded.", info.version),
                    Followup::OfferRestart(info),
                ),
                // The user started this download, so its failure answers them in a dialog.
                Err(error) => self.show_error(Failure::Download, error).await,
            };
        }
        self.state.lock().unwrap().offering = false;
    }

    async fn offer_restart(&self, info: UpdateInfo) {
        {
            let mut state = self.state.lock().unwrap();
            if state.offering {
                return;
            }
            state.offering = true;
        }
        let answer = self
            .ports
            .dialog(Dialog {
                kind: Kind::Info,
                message: format!("Suplex desktop app {} was downloaded.", info.version),
                detail: Some("Restart the desktop app to apply the update. A Suplex host started by this app restarts too; an independent host is not changed.".into()),
                buttons: vec!["Restart Suplex", "Continue"],
            })
            .await;
        self.state.lock().unwrap().offering = false;
        if answer != 0 {
            return;
        }
        if let Err(error) = self.ports.install_and_restart().await {
            // The installed app is unchanged; a new download is needed to try again.
            self.state.lock().unwrap().downloaded = None;
            self.show_error(Failure::Install, error).await;
        }
    }

    async fn show_error(&self, failure: Failure, detail: String) {
        self.ports
            .dialog(Dialog {
                kind: Kind::Error,
                message: failure.message().into(),
                detail: Some(detail),
                buttons: vec!["Continue"],
            })
            .await;
    }
}

/// The update feed this build was packaged with: `Contents/Resources/app-update.yml`, the same file the CLI reads.
pub fn packaged_feed(resources: &std::path::Path) -> Option<url::Url> {
    let text = std::fs::read_to_string(resources.join("app-update.yml")).ok()?;
    let value = text
        .lines()
        .find_map(|line| line.strip_prefix("url: "))?
        .trim();
    let feed = url::Url::parse(&format!("{}/", value.trim_end_matches('/'))).ok()?;
    (feed.scheme() == "https").then_some(feed)
}

/// The ports backed by the Tauri updater plugin, the shell lifecycle, and native dialogs and notifications.
pub struct TauriPorts<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
    pub shell: std::sync::Weak<crate::shell::Shell<R>>,
    pub feed: Option<url::Url>,
    checked: Mutex<Option<tauri_plugin_updater::Update>>,
    downloaded: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

impl<R: tauri::Runtime> TauriPorts<R> {
    pub fn new(
        app: tauri::AppHandle<R>,
        shell: std::sync::Weak<crate::shell::Shell<R>>,
        feed: Option<url::Url>,
    ) -> Self {
        Self {
            app,
            shell,
            feed,
            checked: Mutex::default(),
            downloaded: Mutex::default(),
        }
    }

    /// Updates are enabled only with an HTTPS feed and the build's updater public key; never with a placeholder.
    pub fn configured(&self) -> bool {
        let pubkey = self
            .app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|updater| updater.get("pubkey"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        self.feed.is_some() && !pubkey.trim().is_empty()
    }
}

impl<R: tauri::Runtime> Ports for TauriPorts<R> {
    async fn check(&self) -> Result<Option<UpdateInfo>, String> {
        use tauri_plugin_updater::UpdaterExt;
        let feed = self.feed.as_ref().ok_or("This build has no update feed.")?;
        let endpoint = feed
            .join("latest-tauri.json")
            .map_err(|error| error.to_string())?;
        let updater = self
            .app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?;
        let update = updater.check().await.map_err(|error| error.to_string())?;
        let info = update.as_ref().map(|update| UpdateInfo {
            version: update.version.clone(),
        });
        *self.checked.lock().unwrap() = update;
        Ok(info)
    }

    async fn download(&self) -> Result<(), String> {
        let update = self
            .checked
            .lock()
            .unwrap()
            .take()
            .ok_or("Check for updates again.")?;
        // The plugin verifies the Tauri updater signature before returning the bytes.
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
        *self.downloaded.lock().unwrap() = Some((update, bytes));
        Ok(())
    }

    async fn install_and_restart(&self) -> Result<(), String> {
        let (update, bytes) = self
            .downloaded
            .lock()
            .unwrap()
            .take()
            .ok_or("The downloaded update is no longer available.")?;
        // Replace the bundle first: if that fails, the owned host keeps running and nothing is lost.
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        if let Some(shell) = self.shell.upgrade() {
            shell.shutdown().await;
        }
        self.app.restart();
    }

    async fn dialog(&self, dialog: Dialog) -> usize {
        let Some(shell) = self.shell.upgrade() else {
            return dialog.buttons.len().saturating_sub(1);
        };
        // A message box needs a visible window, or macOS shows it nowhere while it blocks quitting.
        shell.open().await;
        let window = shell
            .view()
            .label()
            .and_then(|label| tauri::Manager::get_webview_window(&self.app, label));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let text = [
            dialog.message.as_str(),
            dialog.detail.as_deref().unwrap_or_default(),
        ]
        .join("\n\n");
        shell.effects.dialog(
            window.as_ref(),
            dialog.kind,
            TITLE,
            Some(text.trim()),
            &dialog.buttons,
            move |answer| {
                let _ = sender.send(answer);
            },
        );
        receiver
            .await
            .unwrap_or(dialog.buttons.len().saturating_sub(1))
    }

    fn notify(&self, message: String, followup: Followup) {
        let Some(shell) = self.shell.upgrade() else {
            return;
        };
        let app = self.app.clone();
        shell.effects.notify(message, move || {
            if let Some(updater) =
                tauri::Manager::try_state::<std::sync::Arc<DesktopUpdater<TauriPorts<R>>>>(&app)
            {
                let updater = updater.inner().clone();
                tauri::async_runtime::spawn(async move { updater.follow(followup).await });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[derive(Default)]
    struct Fake {
        checks: Mutex<Vec<Result<Option<UpdateInfo>, String>>>,
        downloads: Mutex<Vec<Result<(), String>>>,
        installs: Mutex<Vec<Result<(), String>>>,
        answers: Mutex<Vec<usize>>,
        dialogs: Mutex<Vec<Dialog>>,
        notifications: Mutex<Vec<(String, Followup)>>,
        calls: Mutex<Vec<&'static str>>,
        hold_dialog: Option<Arc<tokio::sync::Notify>>,
    }

    impl Ports for Arc<Fake> {
        async fn check(&self) -> Result<Option<UpdateInfo>, String> {
            self.calls.lock().unwrap().push("check");
            self.checks.lock().unwrap().pop().unwrap_or(Ok(None))
        }
        async fn download(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("download");
            self.downloads.lock().unwrap().pop().unwrap_or(Ok(()))
        }
        async fn install_and_restart(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("install");
            self.installs.lock().unwrap().pop().unwrap_or(Ok(()))
        }
        async fn dialog(&self, dialog: Dialog) -> usize {
            self.dialogs.lock().unwrap().push(dialog);
            if let Some(hold) = &self.hold_dialog {
                hold.notified().await;
            }
            self.answers.lock().unwrap().pop().unwrap_or(0)
        }
        fn notify(&self, message: String, followup: Followup) {
            self.notifications.lock().unwrap().push((message, followup));
        }
    }

    fn version(value: &str) -> UpdateInfo {
        UpdateInfo {
            version: value.into(),
        }
    }

    fn subject(fake: &Arc<Fake>) -> DesktopUpdater<Arc<Fake>> {
        DesktopUpdater::new(fake.clone(), true)
    }

    fn messages(fake: &Fake) -> Vec<String> {
        fake.notifications
            .lock()
            .unwrap()
            .iter()
            .map(|(message, _)| message.clone())
            .collect()
    }

    fn last_followup(fake: &Fake) -> Followup {
        fake.notifications.lock().unwrap().last().unwrap().1.clone()
    }

    #[tokio::test]
    async fn an_unconfigured_build_explains_that_updates_are_not_configured() {
        let fake = Arc::new(Fake::default());
        let updater = DesktopUpdater::new(fake.clone(), false);
        updater.check(false).await;
        assert!(fake.dialogs.lock().unwrap().is_empty());
        updater.check(true).await;
        assert_eq!(
            fake.dialogs.lock().unwrap()[0].message,
            "Desktop app updates are not configured."
        );
        assert!(fake.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_manual_check_offers_download_and_the_finished_download_offers_restart_from_its_notification(
    ) {
        let fake = Arc::new(Fake::default());
        fake.checks.lock().unwrap().push(Ok(Some(version("1.2.3"))));
        let updater = subject(&fake);
        updater.check(true).await;
        assert_eq!(*fake.calls.lock().unwrap(), ["check", "download"]);
        assert_eq!(
            fake.dialogs.lock().unwrap()[0].buttons,
            ["Start download", "Continue"]
        );
        assert_eq!(
            messages(&fake),
            ["Suplex desktop app 1.2.3 was downloaded."]
        );
        assert_eq!(
            fake.dialogs.lock().unwrap().len(),
            1,
            "the finished download posts a notification, not a dialog"
        );
        updater.follow(last_followup(&fake)).await;
        assert_eq!(fake.calls.lock().unwrap().last(), Some(&"install"));
        let restart = fake.dialogs.lock().unwrap().last().unwrap().clone();
        assert_eq!(restart.buttons, ["Restart Suplex", "Continue"]);
        assert_eq!(restart.detail.as_deref(), Some("Restart the desktop app to apply the update. A Suplex host started by this app restarts too; an independent host is not changed."));
    }

    #[tokio::test]
    async fn declining_the_download_or_restart_changes_nothing() {
        let fake = Arc::new(Fake::default());
        fake.checks.lock().unwrap().push(Ok(Some(version("1.2.3"))));
        fake.answers.lock().unwrap().push(1);
        let updater = subject(&fake);
        updater.check(true).await;
        assert_eq!(*fake.calls.lock().unwrap(), ["check"]);
        fake.checks.lock().unwrap().push(Ok(Some(version("1.2.3"))));
        updater.check(true).await;
        fake.answers.lock().unwrap().push(1);
        updater.follow(last_followup(&fake)).await;
        assert_eq!(*fake.calls.lock().unwrap(), ["check", "check", "download"]);
    }

    #[tokio::test]
    async fn a_manual_check_after_a_download_offers_the_restart_again_without_checking() {
        let fake = Arc::new(Fake::default());
        fake.checks.lock().unwrap().push(Ok(Some(version("1.2.3"))));
        let updater = subject(&fake);
        updater.check(true).await;
        fake.answers.lock().unwrap().push(1);
        updater.follow(last_followup(&fake)).await;
        fake.calls.lock().unwrap().clear();
        updater.check(true).await;
        assert_eq!(*fake.calls.lock().unwrap(), ["install"]);
        assert_eq!(
            fake.dialogs.lock().unwrap().last().unwrap().message,
            "Suplex desktop app 1.2.3 was downloaded."
        );
    }

    #[tokio::test]
    async fn events_that_arrive_on_their_own_never_open_a_dialog() {
        let fake = Arc::new(Fake::default());
        fake.checks.lock().unwrap().push(Ok(Some(version("0.2.0"))));
        let updater = subject(&fake);
        updater.check(false).await;
        assert!(fake.dialogs.lock().unwrap().is_empty());
        assert_eq!(messages(&fake), ["Suplex desktop app 0.2.0 is available."]);
        fake.checks.lock().unwrap().push(Err("offline".into()));
        updater.check(false).await;
        assert!(
            fake.dialogs.lock().unwrap().is_empty(),
            "a failed automatic check is silent"
        );
        updater.follow(last_followup(&fake)).await;
        assert_eq!(
            fake.dialogs.lock().unwrap().len(),
            1,
            "the click opens the download offer"
        );
    }

    #[tokio::test]
    async fn errors_are_reported_once_by_dialog_or_notification() {
        let fake = Arc::new(Fake::default());
        fake.checks.lock().unwrap().push(Err("offline".into()));
        let updater = subject(&fake);
        updater.check(true).await;
        assert_eq!(fake.dialogs.lock().unwrap().len(), 1);
        assert_eq!(
            fake.dialogs.lock().unwrap()[0].message,
            "Suplex could not check the desktop app update."
        );
        assert_eq!(
            fake.dialogs.lock().unwrap()[0].detail.as_deref(),
            Some("offline")
        );

        fake.checks.lock().unwrap().push(Ok(Some(version("1.2.4"))));
        fake.downloads
            .lock()
            .unwrap()
            .push(Err("signature rejected".into()));
        updater.check(true).await;
        assert!(
            messages(&fake).is_empty(),
            "a failed download is not a notification"
        );
        let shown = fake.dialogs.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            (shown.message.as_str(), shown.detail.as_deref()),
            (
                "Suplex could not download the desktop app update.",
                Some("signature rejected")
            )
        );
        fake.calls.lock().unwrap().clear();
        updater.check(true).await;
        assert_eq!(
            *fake.calls.lock().unwrap(),
            ["check"],
            "a rejected download is not kept for restart"
        );
    }

    #[tokio::test]
    async fn a_failed_install_reports_failure_and_does_not_offer_the_stale_download() {
        let fake = Arc::new(Fake::default());
        fake.checks.lock().unwrap().push(Ok(Some(version("1.2.3"))));
        fake.installs
            .lock()
            .unwrap()
            .push(Err("replacement failed".into()));
        let updater = subject(&fake);
        updater.check(true).await;
        updater.follow(last_followup(&fake)).await;
        let shown = fake.dialogs.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            (shown.kind, shown.message.as_str()),
            (
                Kind::Error,
                "Suplex could not install the desktop app update."
            )
        );
        fake.calls.lock().unwrap().clear();
        updater.check(true).await;
        assert_eq!(*fake.calls.lock().unwrap(), ["check"]);
    }

    #[tokio::test]
    async fn automatic_checks_announce_a_version_once_but_a_manual_check_offers_it_again() {
        let fake = Arc::new(Fake::default());
        let updater = subject(&fake);
        for _ in 0..3 {
            fake.checks.lock().unwrap().push(Ok(Some(version("0.2.0"))));
        }
        fake.answers.lock().unwrap().push(1);
        updater.check(false).await;
        updater.check(false).await;
        assert_eq!(messages(&fake).len(), 1);
        updater.check(true).await;
        assert_eq!(fake.dialogs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_automatic_check_waits_while_an_offer_is_open() {
        let hold = Arc::new(tokio::sync::Notify::new());
        let fake = Arc::new(Fake {
            hold_dialog: Some(hold.clone()),
            ..Fake::default()
        });
        fake.checks.lock().unwrap().push(Ok(Some(version("0.2.0"))));
        let updater = Arc::new(subject(&fake));
        updater.check(false).await;
        let offer = tokio::spawn({
            let updater = updater.clone();
            let followup = last_followup(&fake);
            async move { updater.follow(followup).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        updater.check(false).await;
        assert_eq!(*fake.calls.lock().unwrap(), ["check"]);
        fake.answers.lock().unwrap().push(1);
        hold.notify_one();
        offer.await.unwrap();
    }
}
