//! Raw IPC against the real capability files, app-command permissions, and runtime host grants, through
//! Tauri's mock runtime. Proves which callers each command admits, independent of the injected bridge.

use std::{collections::HashMap, sync::Arc};

use serde_json::{json, Value};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use url::Url;

use crate::{bridge::DENIED, shell::Shell, targets::parse_target, window::ViewKind};

struct Harness {
    app: App<MockRuntime>,
    shell: Arc<Shell<MockRuntime>>,
    data: tempfile::TempDir,
}

fn harness(extra: &[(&str, &str)]) -> Harness {
    let data = tempfile::tempdir().unwrap();
    let app = crate::configure(mock_builder())
        .build(crate::context())
        .unwrap();
    let mut environment: HashMap<String, String> = [
        ("HOME", std::env::var("HOME").unwrap()),
        (
            "SUPLEX_DESKTOP_USER_DATA",
            data.path().display().to_string(),
        ),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect();
    let fixture = crate::installer::fixture_runtime();
    environment.insert(
        "SUPLEX_DESKTOP_BINARY".into(),
        fixture.binary.display().to_string(),
    );
    environment.insert(
        "SUPLEX_DESKTOP_RUNTIME".into(),
        fixture.directory.display().to_string(),
    );
    for (key, value) in extra {
        environment.insert((*key).into(), (*value).into());
    }
    let shell = Shell::new(
        app.handle().clone(),
        vec!["Suplex".into()],
        environment,
        data.path(),
    );
    app.manage(shell.clone());
    Harness { app, shell, data }
}

impl Harness {
    fn window(&self, label: &str) -> WebviewWindow<MockRuntime> {
        self.app.get_webview_window(label).unwrap()
    }

    /// A webview the shell no longer shows, still holding a label whose grant exists.
    fn lingering(&self, label: &str, url: &str) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(
            &self.app,
            label,
            WebviewUrl::External(Url::parse(url).unwrap()),
        )
        .build()
        .unwrap()
    }
}

/// Invokes `command` as a frame at `frame_url` inside `window`.
fn invoke(
    window: &WebviewWindow<MockRuntime>,
    frame_url: &str,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: Url::parse(frame_url).unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

fn refused_by_acl(result: &Result<Value, Value>) -> bool {
    matches!(result, Err(Value::String(message)) if message.contains("not allowed") || message.contains("denied") || message.contains("ACL"))
}

const SETUP_COMMANDS: [(&str, &str); 6] = [
    ("desktop_snapshot", "{}"),
    ("desktop_choose", r#"{"mode":"local"}"#),
    ("desktop_retry", "{}"),
    (
        "desktop_test_connection",
        r#"{"url":"https://suplex.example"}"#,
    ),
    ("desktop_turn_on_tailscale", "{}"),
    (
        "desktop_select_host",
        r#"{"origin":"https://suplex.example"}"#,
    ),
];
const NETWORK_COMMANDS: [(&str, &str); 3] = [
    ("app_network_access", "{}"),
    ("app_save_network_access_preference", r#"{"mode":"all"}"#),
    ("app_restart_network_access", "{}"),
];
const UPDATE_COMMANDS: [(&str, &str); 2] =
    [("app_update_status", "{}"), ("app_check_for_updates", "{}")];
// Windows and Linux also register the notification and clipboard plugins; no page gets their commands either.
const PLUGIN_COMMANDS: [&str; 8] = [
    "plugin:notification|notify",
    "plugin:clipboard-manager|write_text",
    "plugin:updater|check",
    "plugin:updater|download_and_install",
    "plugin:dialog|message",
    "plugin:opener|open_url",
    "plugin:window|set_size",
    "plugin:webview|create_webview",
];

fn args(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn the_setup_page_reaches_setup_commands_and_nothing_else() {
    let harness = harness(&[]);
    let label = harness
        .shell
        .show_page_for_test(ViewKind::Setup, "pages/choice.html", None)
        .unwrap();
    let setup = harness.window(&label);
    let snapshot = invoke(
        &setup,
        crate::window::APP_ORIGIN,
        "desktop_snapshot",
        json!({}),
    )
    .unwrap();
    assert_eq!(snapshot["state"], "resolve");
    for (command, body) in NETWORK_COMMANDS
        .iter()
        .chain(UPDATE_COMMANDS.iter())
        .chain(&[("app_account_cleared", "{}"), ("unavailable_retry", "{}")])
    {
        assert!(
            refused_by_acl(&invoke(
                &setup,
                crate::window::APP_ORIGIN,
                command,
                args(body)
            )),
            "{command}"
        );
    }
    for command in PLUGIN_COMMANDS {
        assert!(
            refused_by_acl(&invoke(
                &setup,
                crate::window::APP_ORIGIN,
                command,
                json!({})
            )),
            "{command}"
        );
    }
}

#[test]
fn a_remote_host_reaches_only_its_narrow_bridge_on_its_exact_origin() {
    let harness = harness(&[]);
    let target = parse_target("https://suplex.example/tasks").unwrap();
    let label = harness.shell.show_host_for_test(&target).unwrap();
    let host = harness.window(&label);
    for (command, body) in NETWORK_COMMANDS {
        assert_eq!(
            invoke(&host, "https://suplex.example", command, args(body)),
            Ok(json!({ "managed": false })),
            "a remote selection is never managed: {command}"
        );
    }
    assert_eq!(
        invoke(
            &host,
            "https://suplex.example",
            "app_update_status",
            json!({})
        ),
        Ok(json!({ "phase": "idle" })),
        "a test shell manages no updater"
    );
    for (command, body) in SETUP_COMMANDS.iter().chain(&[("unavailable_retry", "{}")]) {
        assert!(
            refused_by_acl(&invoke(
                &host,
                "https://suplex.example",
                command,
                args(body)
            )),
            "{command}"
        );
    }
    for command in PLUGIN_COMMANDS {
        assert!(
            refused_by_acl(&invoke(&host, "https://suplex.example", command, json!({}))),
            "{command}"
        );
    }
    assert!(
        !harness.data.path().join("network-access.json").exists(),
        "no remote call changed the local preference"
    );
}

#[test]
fn cross_origin_frames_other_ports_and_local_files_cannot_invoke_host_commands() {
    let harness = harness(&[]);
    let label = harness
        .shell
        .show_host_for_test(&parse_target("https://suplex.example").unwrap())
        .unwrap();
    let host = harness.window(&label);
    for frame in [
        "https://evil.example",
        "https://suplex.example:8443",
        "http://suplex.example",
        "https://sub.suplex.example",
        crate::window::APP_ORIGIN,
        "file:///tmp/page.html",
    ] {
        for (command, body) in NETWORK_COMMANDS
            .iter()
            .chain(UPDATE_COMMANDS.iter())
            .chain(&[
                ("app_open_host_picker", "{}"),
                ("app_account_cleared", "{}"),
            ])
            .chain(SETUP_COMMANDS.iter())
        {
            let result = invoke(&host, frame, command, args(body));
            assert!(
                refused_by_acl(&result) || result == Err(json!(DENIED)),
                "{frame} {command}: {result:?}"
            );
        }
    }
}

#[test]
fn a_retired_host_view_keeps_no_authority_after_another_host_is_selected() {
    let harness = harness(&[]);
    let first = harness
        .shell
        .show_host_for_test(&parse_target("https://suplex.example").unwrap())
        .unwrap();
    // A webview whose destruction has not finished, or a call already in flight from it.
    let retired = harness.window(&first);
    let second = harness
        .shell
        .show_host_for_test(&parse_target("https://other.example").unwrap())
        .unwrap();
    assert_ne!(first, second, "every selection gets a fresh label");
    for (command, body) in NETWORK_COMMANDS
        .iter()
        .chain(UPDATE_COMMANDS.iter())
        .chain(&[
            ("app_open_host_picker", "{}"),
            ("app_account_cleared", "{}"),
        ])
    {
        assert_eq!(
            invoke(&retired, "https://suplex.example", command, args(body)),
            Err(json!(DENIED)),
            "{command}"
        );
    }
    let current = harness.window(&second);
    assert!(
        refused_by_acl(&invoke(
            &current,
            "https://suplex.example",
            "app_network_access",
            json!({})
        )),
        "the new label is bound to the new origin only"
    );
    assert_eq!(
        invoke(
            &current,
            "https://other.example",
            "app_network_access",
            json!({})
        ),
        Ok(json!({ "managed": false }))
    );
}

#[test]
fn the_remote_failure_page_can_retry_and_pick_a_host_but_nothing_else() {
    let harness = harness(&[]);
    let target = parse_target("https://down.example").unwrap();
    let label = harness
        .shell
        .show_page_for_test(
            ViewKind::Unavailable,
            "pages/unavailable.html",
            Some(target),
        )
        .unwrap();
    let page = harness.window(&label);
    assert_eq!(
        invoke(
            &page,
            crate::window::APP_ORIGIN,
            "unavailable_retry",
            json!({})
        ),
        Ok(Value::Null)
    );
    for (command, body) in SETUP_COMMANDS.iter().chain(NETWORK_COMMANDS.iter()) {
        assert!(
            refused_by_acl(&invoke(
                &page,
                crate::window::APP_ORIGIN,
                command,
                args(body)
            )),
            "{command}"
        );
    }
    let stale = harness.lingering(
        "setup-99",
        &format!("{}/pages/choice.html", crate::window::APP_ORIGIN),
    );
    assert_eq!(
        invoke(
            &stale,
            crate::window::APP_ORIGIN,
            "desktop_choose",
            json!({ "mode": "local" })
        ),
        Err(json!(DENIED)),
        "a setup label that is not the current view is refused natively"
    );
}

/// The local host is the fixture runtime; its `/api/auth/me` answers from the session the request carries.
#[cfg(unix)]
fn local_harness(settings: Value) -> (Harness, WebviewWindow<MockRuntime>, String) {
    let harness = harness(&[]);
    std::fs::create_dir_all(harness.data.path().join("data")).unwrap();
    std::fs::write(
        harness.data.path().join("data/fixture.json"),
        settings.to_string(),
    )
    .unwrap();
    let port = crate::local_runtime::free_port(0).unwrap();
    std::fs::write(harness.data.path().join("install.json"), json!({ "completedAt": "2026-10-03T00:00:00Z", "runtimeStamp": "0.0.0-fixture", "port": port }).to_string()).unwrap();
    tauri::async_runtime::block_on(harness.shell.network.start_preferred()).unwrap();
    let origin = harness.shell.local_origin().unwrap();
    let label = harness
        .shell
        .show_host_for_test(&parse_target(&format!("{origin}/admin/access")).unwrap())
        .unwrap();
    let window = harness.window(&label);
    (harness, window, origin)
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn local_network_control_requires_the_host_to_answer_with_an_admin_session() {
    let (harness, window, origin) = local_harness(json!({}));
    for (command, body) in NETWORK_COMMANDS {
        assert_eq!(
            invoke(&window, &origin, command, args(body)),
            Ok(json!({ "managed": false })),
            "no session: {command}"
        );
    }
    assert!(
        !harness.data.path().join("network-access.json").exists(),
        "a refused save changes nothing"
    );
    let auth: Vec<Value> =
        std::fs::read_to_string(harness.data.path().join("data/fixture-auth.log"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    assert_eq!(auth.len(), 3, "each request asked the host itself");
    tauri::async_runtime::block_on(harness.shell.shutdown());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn a_local_admin_session_manages_network_access() {
    let (harness, window, origin) = local_harness(json!({ "authDefaultRole": "admin" }));
    let managed = invoke(&window, &origin, "app_network_access", json!({})).unwrap();
    assert_eq!(
        managed,
        json!({ "managed": true, "preference": "local", "active": "local", "pending": false, "busy": false, "httpsUrl": null })
    );
    let saved = invoke(
        &window,
        &origin,
        "app_save_network_access_preference",
        json!({ "mode": "all" }),
    )
    .unwrap();
    assert_eq!(
        (saved["preference"].clone(), saved["pending"].clone()),
        (json!("all"), json!(true)),
        "saving does not restart"
    );
    assert_eq!(
        std::fs::read_to_string(harness.data.path().join("network-access.json")).unwrap(),
        "\"all\""
    );
    tauri::async_runtime::block_on(harness.shell.shutdown());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn a_member_session_is_refused() {
    let (harness, window, origin) = local_harness(json!({ "authDefaultRole": "member" }));
    assert_eq!(
        invoke(
            &window,
            &origin,
            "app_save_network_access_preference",
            json!({ "mode": "all" })
        ),
        Ok(json!({ "managed": false }))
    );
    assert!(!harness.data.path().join("network-access.json").exists());
    tauri::async_runtime::block_on(harness.shell.shutdown());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn navigation_during_admin_verification_invalidates_only_that_request() {
    let (harness, window, origin) =
        local_harness(json!({ "authDefaultRole": "admin", "authDelayMs": 600 }));
    let shell = harness.shell.clone();
    let label = window.label().to_owned();
    let page = Url::parse(&format!("{origin}/tasks")).unwrap();
    let navigate = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        shell.page_loaded(&label, &page, true);
    });
    assert_eq!(
        invoke(
            &window,
            &origin,
            "app_save_network_access_preference",
            json!({ "mode": "all" })
        ),
        Ok(json!({ "managed": false }))
    );
    navigate.join().unwrap();
    assert!(
        !harness.data.path().join("network-access.json").exists(),
        "the stale request applied no mutation"
    );
    let later = invoke(
        &window,
        &origin,
        "app_save_network_access_preference",
        json!({ "mode": "all" }),
    )
    .unwrap();
    assert_eq!(
        later["preference"], "all",
        "the next request is not poisoned"
    );
    tauri::async_runtime::block_on(harness.shell.shutdown());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn an_install_whose_record_cannot_be_saved_fails_instead_of_completing() {
    let harness = harness(&[]);
    // A directory where install.json belongs makes the atomic write fail.
    std::fs::create_dir_all(harness.data.path().join("install.json/blocker")).unwrap();
    tauri::async_runtime::block_on(harness.shell.run_install(None));
    assert!(
        matches!(harness.shell.boot_state(), crate::boot::BootState::Failed(failure) if failure.title == "Save the install record"),
        "{:?}",
        harness.shell.boot_state()
    );
    assert!(!harness.shell.local_installed());

    std::fs::remove_dir_all(harness.data.path().join("install.json")).unwrap();
    tauri::async_runtime::block_on(harness.shell.run_install(None));
    assert!(harness.shell.local_installed());
    assert!(crate::boot::read_install_record(&harness.data.path().join("install.json")).is_some());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn clearing_the_account_forgets_the_install_only_for_this_macs_host() {
    let (harness, local_window, _) = local_harness(json!({}));
    let record = harness.data.path().join("install.json");
    let remote = harness
        .shell
        .show_host_for_test(&parse_target("https://suplex.example/").unwrap())
        .unwrap();
    assert!(harness.shell.forget_local_install(&remote));
    assert!(record.exists(), "a remote clear keeps the local install");
    assert!(
        !harness.shell.forget_local_install(local_window.label()),
        "a view that is no longer shown does nothing"
    );
    assert!(record.exists());

    let origin = harness.shell.local_origin().unwrap();
    let local = harness
        .shell
        .show_host_for_test(&parse_target(&format!("{origin}/")).unwrap())
        .unwrap();
    assert!(harness.shell.forget_local_install(&local));
    assert!(
        !record.exists(),
        "a local clear starts at the choice next launch"
    );
    tauri::async_runtime::block_on(harness.shell.shutdown());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn a_network_restart_returns_to_the_page_unless_the_user_moved_on() {
    let (harness, _, origin) = local_harness(json!({}));
    let shell = harness.shell.clone();
    tauri::async_runtime::block_on(
        shell
            .network
            .save_preference(crate::contracts::NetworkMode::All),
    )
    .unwrap();
    let page = tauri::async_runtime::block_on(shell.restart_network()).unwrap();
    assert_eq!(
        shell.local_origin(),
        Some(origin.clone()),
        "the host returned on its port"
    );
    let started: Value = serde_json::from_str(
        &std::fs::read_to_string(harness.data.path().join("data/fixture-start.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (
            started["env"]["SUPLEX_ACCESS_MODE"].as_str(),
            started["env"]["SUPLEX_BIND_ADDRESS"].as_str()
        ),
        (Some("all"), Some("0.0.0.0")),
        "the restarted host runs in the saved mode"
    );
    tauri::async_runtime::block_on(shell.return_to(page));
    assert_eq!(shell.view().origin(), Some(origin.as_str()));
    let returned = harness.window(shell.view().label().unwrap()).url().unwrap();
    assert_eq!(
        returned.path(),
        "/admin/access",
        "back on the captured page"
    );

    // A host selected while the restart runs is kept.
    let page = tauri::async_runtime::block_on(shell.restart_network()).unwrap();
    shell
        .show_host_for_test(&parse_target("https://suplex.example/").unwrap())
        .unwrap();
    tauri::async_runtime::block_on(shell.return_to(page));
    assert_eq!(shell.view().origin(), Some("https://suplex.example"));
    tauri::async_runtime::block_on(shell.shutdown());
}

#[cfg(unix)] // runs the Python fixture host
#[test]
fn tray_stop_stops_only_the_owned_host_and_start_brings_it_back() {
    let (harness, _, origin) = local_harness(json!({}));
    let shell = harness.shell.clone();
    tauri::async_runtime::block_on(shell.stop_local());
    assert_eq!(shell.local_origin(), None);
    assert!(
        !tauri::async_runtime::block_on(crate::local_runtime::healthy(
            &origin,
            std::time::Duration::from_secs(1)
        )),
        "the owned host stopped"
    );
    assert_eq!(
        shell.boot_state(),
        crate::boot::BootState::Choosing,
        "the host manager is shown"
    );
    tauri::async_runtime::block_on(shell.start_local());
    assert!(shell.local_origin().is_some(), "Start brings the host back");
    tauri::async_runtime::block_on(shell.shutdown());
}

#[test]
fn reloading_a_host_that_stopped_shows_the_failure_page() {
    let harness = harness(&[]);
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let target = parse_target(&format!("http://127.0.0.1:{port}/")).unwrap();
    harness.shell.show_host_for_test(&target).unwrap();
    tauri::async_runtime::block_on(harness.shell.reload());
    assert!(
        matches!(harness.shell.view(), crate::shell::View::Unavailable { target: shown, .. } if shown.origin == target.origin),
        "{:?}",
        harness.shell.view()
    );
}
