//! Native macOS smoke tests: the real app binary, built with `--features native-test`, in WKWebView.
//! Each test uses its own data directory and fixture hosts. Run through `pnpm desktop:test:native`.
#![cfg(feature = "native-test")]

use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn runtime() -> PathBuf {
    manifest().join("tests/fixtures/runtime")
}

fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn wait_until(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let began = Instant::now();
    while began.elapsed() < timeout {
        if ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn answers(origin: &str) -> bool {
    let address = origin.trim_start_matches("http://").trim_end_matches('/');
    let Ok(mut stream) = TcpStream::connect(address) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = write!(stream, "GET /health HTTP/1.0\r\nHost: {address}\r\n\r\n");
    let mut reply = String::new();
    let _ = BufReader::new(stream).read_line(&mut reply);
    reply.contains("200")
}

/// A standalone fixture host (the runtime double's `start --foreground`) serving test pages.
struct Host {
    child: Child,
    origin: String,
    _data: tempfile::TempDir,
}

impl Host {
    fn start(pages: &[(&str, &str)]) -> Host {
        Self::start_on(free_port(), pages)
    }

    fn start_on(port: u16, pages: &[(&str, &str)]) -> Host {
        let data = tempfile::tempdir().unwrap();
        write_pages(&data.path().join("data"), pages);
        let child = Command::new(runtime().join("bin/suplex"))
            .args(["start", "--foreground"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUPLEX_DATA_ROOT", data.path().join("data"))
            .env("SUPLEX_PORT", port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let origin = format!("http://localhost:{port}");
        assert!(
            wait_until(Duration::from_secs(10), || answers(&format!(
                "http://127.0.0.1:{port}"
            ))),
            "fixture host started"
        );
        Host {
            child,
            origin,
            _data: data,
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_pages(data: &Path, pages: &[(&str, &str)]) {
    let directory = data.join("fixture-pages");
    std::fs::create_dir_all(&directory).unwrap();
    for (name, body) in pages {
        std::fs::write(directory.join(name), body).unwrap();
    }
}

/// The app under test and its driver connection.
struct App {
    child: Child,
    data: PathBuf,
    driver: Option<(TcpStream, BufReader<TcpStream>)>,
}

impl App {
    fn launch(data: &Path, args: &[&str]) -> App {
        let began = Instant::now();
        let _ = std::fs::remove_file(data.join("native-test-driver.port"));
        let child = app_command(data, args).spawn().unwrap();
        let mut app = App {
            child,
            data: data.to_owned(),
            driver: None,
        };
        let port_file = data.join("native-test-driver.port");
        assert!(
            wait_until(Duration::from_secs(30), || port_file.exists()),
            "the driver started"
        );
        let port: u16 = std::fs::read_to_string(&port_file)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            // Longer than the driver's 60 s eval timeout, so a lost script reports instead of timing out the socket.
            .set_read_timeout(Some(Duration::from_secs(90)))
            .unwrap();
        app.driver = Some((stream.try_clone().unwrap(), BufReader::new(stream)));
        eprintln!("[native] launched in {} ms", began.elapsed().as_millis());
        app
    }

    fn send(&mut self, command: Value) -> Value {
        let (writer, reader) = self.driver.as_mut().unwrap();
        writeln!(writer, "{command}").unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or(Value::Null)
    }

    fn state(&mut self) -> Value {
        self.send(json!({ "cmd": "state" }))
    }

    fn wait_for(&mut self, what: &str, mut ready: impl FnMut(&Value) -> bool) -> Value {
        let began = Instant::now();
        loop {
            let state = self.state();
            if ready(&state) {
                eprintln!("[native] {what} after {} ms", began.elapsed().as_millis());
                return state;
            }
            assert!(
                began.elapsed() < Duration::from_secs(45),
                "{what}: last state {state}"
            );
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Runs an async script body in the current view and returns its value; script errors fail the test.
    fn eval(&mut self, body: &str) -> Value {
        let reply = self.send(json!({ "cmd": "eval", "script": body, "timeoutMs": 60000 }));
        assert_eq!(reply["ok"], true, "script failed: {reply} for {body}");
        reply["value"].clone()
    }

    fn effects(&self) -> Vec<Value> {
        std::fs::read_to_string(self.data.join("native-test-effects.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn effect(&self, kind: &str) -> Vec<Value> {
        self.effects()
            .into_iter()
            .filter(|effect| effect["effect"] == kind)
            .collect()
    }

    fn quit(mut self) -> std::process::ExitStatus {
        let _ = self.send(json!({ "cmd": "quit" }));
        let began = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                eprintln!("[native] quit in {} ms", began.elapsed().as_millis());
                return status;
            }
            assert!(
                began.elapsed() < Duration::from_secs(20),
                "the app exits after Quit"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn app_command(data: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_suplex-desktop"));
    command
        .args(args)
        // Only what a launched app gets from macOS: nothing from the session that runs these tests.
        .env_clear()
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .env("USER", std::env::var_os("USER").unwrap_or_default())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("TMPDIR", std::env::temp_dir())
        .env("SUPLEX_DESKTOP_USER_DATA", data)
        .env("SUPLEX_DESKTOP_BINARY", runtime().join("bin/suplex"))
        .env("SUPLEX_DESKTOP_RUNTIME", runtime())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    command
}

fn view(state: &Value) -> (&str, &str) {
    (
        state["view"]["kind"].as_str().unwrap_or_default(),
        state["view"]["label"].as_str().unwrap_or_default(),
    )
}

const RAW_INVOKE: &str = "const raw = async (command, args) => { try { await window.__TAURI_INTERNALS__.invoke(command, args ?? {}); return 'allowed'; } catch (error) { return String(error); } };";

/// V01, V04, V08, V10, V13, V11 (rendering part): first install, the owned host, the bridge boundary, a real
/// HttpOnly session read from WKWebView's own cookie store, downloads, and owned-host shutdown on Quit.
#[test]
fn local_install_bridge_boundary_cookies_downloads_and_owned_shutdown() {
    let data = tempfile::tempdir().unwrap();
    write_pages(&data.path().join("data"), &[("index.html", "<!doctype html><html lang=\"en\"><title>fixture</title><a id=\"same\" href=\"/second\">same</a><p>Suplex fixture</p></html>")]);
    let mut app = App::launch(data.path(), &[]);
    let state = app.wait_for("the choice page", |state| {
        view(state).0 == "setup" && state["boot"] == "choosing"
    });
    let setup_label = view(&state).1.to_owned();

    let setup = app.eval(&format!("{RAW_INVOKE} return {{ desktop: typeof window.suplexDesktop, app: typeof window.suplexApp, origin: location.protocol + '//' + location.host, network: await raw('app_network_access'), plugin: await raw('plugin:updater|check'), snapshot: (await window.suplexDesktop.snapshot()).state }};"));
    assert_eq!(setup["desktop"], "object");
    assert_eq!(setup["app"], "undefined");
    assert_eq!(setup["snapshot"], "choosing");
    assert_ne!(setup["network"], "allowed", "{setup}");
    assert_ne!(setup["plugin"], "allowed", "{setup}");

    // Calls that navigate the view run after the script returns, so its result is not lost with the page.
    app.eval("setTimeout(() => window.suplexDesktop.choose('local'), 500); return true;");
    // The boot state and URL change when the page starts loading; a script evaluated before the load finishes can
    // run in the old page or be lost with it.
    app.wait_for("the ready page", |state| state["boot"] == "ready");
    let effects = data.path().join("native-test-effects.log");
    assert!(
        wait_until(Duration::from_secs(45), || std::fs::read_to_string(
            &effects
        )
        .unwrap_or_default()
        .lines()
        .any(
            |line| line.contains("pages/ready.html") && line.contains(r#""started":false"#)
        )),
        "the ready page finished loading"
    );
    let log = app.eval("return (await window.suplexDesktop.snapshot()).log;");
    assert!(
        log.as_array()
            .unwrap()
            .iter()
            .any(|line| line == "herdr: working"),
        "install output streamed: {log}"
    );
    app.eval("setTimeout(() => window.suplexDesktop.launch(), 500); return true;");
    let state = app.wait_for("the owned local host", |state| {
        view(state).0 == "host" && state["local"].is_string()
    });
    let local = state["local"].as_str().unwrap().to_owned();
    assert_eq!(state["view"]["origin"], local);
    assert_ne!(
        view(&state).1,
        setup_label,
        "the host gets a fresh webview label"
    );
    assert!(answers(&local));

    let host = app.eval(&format!("{RAW_INVOKE} return {{ app: typeof window.suplexApp, desktop: typeof window.suplexDesktop, choose: await raw('desktop_choose', {{ mode: 'local' }}), install: await raw('desktop_retry'), update: await raw('plugin:updater|check'), dialog: await raw('plugin:dialog|message', {{ message: 'x' }}), access: await window.suplexApp.networkAccess() }};"));
    assert_eq!(host["app"], "object");
    assert_eq!(host["desktop"], "undefined");
    for denied in ["choose", "install", "update", "dialog"] {
        assert_ne!(host[denied], "allowed", "{denied}: {host}");
    }
    assert_eq!(
        host["access"],
        json!({ "managed": false }),
        "no session: not an admin"
    );

    let member = app.eval("await fetch('/__login?role=member'); return { cookieVisible: document.cookie.includes('sid_v1'), access: await window.suplexApp.networkAccess() };");
    assert_eq!(
        member,
        json!({ "cookieVisible": false, "access": { "managed": false } }),
        "a member session is refused"
    );
    let admin = app.eval("await fetch('/__login?role=admin'); return { cookieVisible: document.cookie.includes('sid_v1'), access: await window.suplexApp.networkAccess(), saved: await window.suplexApp.saveNetworkAccessPreference('all') };");
    assert_eq!(
        admin["cookieVisible"], false,
        "the session cookie is HttpOnly"
    );
    assert_eq!(
        admin["access"]["managed"], true,
        "the shell read the HttpOnly session from the webview's own store: {admin}"
    );
    assert_eq!(admin["saved"]["preference"], "all");
    assert_eq!(admin["saved"]["pending"], true, "saving does not restart");
    let auth = std::fs::read_to_string(data.path().join("data/fixture-auth.log")).unwrap();
    assert!(
        auth.lines().any(|line| line.contains("sid_v1=admin")),
        "the native request carried the webview's cookie"
    );

    // Downloads: a Blob export and an attachment, with a name collision, saved to the constrained directory.
    let downloads = data.path().join("Desktop");
    std::fs::create_dir_all(&downloads).unwrap();
    std::fs::write(downloads.join("export.json"), "existing").unwrap();
    app.eval("const blob = new Blob([JSON.stringify({ exported: true })], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'export.json'; document.body.append(link); link.click(); return true;");
    app.eval("setTimeout(() => { const link = document.createElement('a'); link.href = '/__download/file?name=' + encodeURIComponent('../../notes.txt'); document.body.append(link); link.click(); }, 500); return true;");
    assert!(
        wait_until(Duration::from_secs(15), || app.effect("reveal").len() >= 2),
        "both downloads finished: {:?}",
        app.effects()
    );
    assert_eq!(
        std::fs::read_to_string(downloads.join("export.json")).unwrap(),
        "existing",
        "an existing file is not overwritten"
    );
    assert_eq!(
        std::fs::read_to_string(downloads.join("export (1).json")).unwrap(),
        r#"{"exported":true}"#
    );
    let names: Vec<String> = std::fs::read_dir(&downloads)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    let attachment = names
        .iter()
        .find(|name| name.ends_with("notes.txt"))
        .unwrap_or_else(|| panic!("the attachment landed in the download directory: {names:?}"));
    eprintln!("attachment named ../../notes.txt saved as {attachment:?}");
    assert_eq!(
        std::fs::read_to_string(downloads.join(attachment)).unwrap(),
        "attachment ../../notes.txt"
    );
    for reveal in app.effect("reveal") {
        assert!(
            Path::new(reveal["path"].as_str().unwrap()).starts_with(&downloads),
            "{reveal}"
        );
    }

    // Navigation and popups: same origin stays, other origins go to the browser, other schemes are dropped.
    let before = app.state();
    app.eval("setTimeout(() => { location.href = '/second'; }, 500); return true;");
    // The URL can change before the page load that advances the generation.
    let after = app.wait_for("same-origin navigation", |state| {
        state["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/second"))
            && state["view"]["generation"].as_u64() > before["view"]["generation"].as_u64()
    });
    assert_eq!(view(&after).1, view(&before).1);
    app.eval("setTimeout(() => { window.open('https://example.com/opened'); window.open('/third'); }, 500); return true;");
    app.wait_for("same-origin popup opens in place", |state| {
        state["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/third"))
    });
    app.eval("location.href = 'https://example.org/linked'; return true;");
    assert!(
        wait_until(Duration::from_secs(10), || app
            .effect("open-external")
            .len()
            >= 2),
        "{:?}",
        app.effects()
    );
    let external: Vec<String> = app
        .effect("open-external")
        .iter()
        .map(|effect| effect["url"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        external.contains(&"https://example.com/opened".to_owned())
            && external.contains(&"https://example.org/linked".to_owned()),
        "{external:?}"
    );
    app.eval("location.href = 'file:///etc/passwd'; return true;");
    std::thread::sleep(Duration::from_millis(500));
    let state = app.state();
    assert!(
        state["url"].as_str().unwrap().starts_with(&local),
        "the page stayed on the host: {state}"
    );
    assert_eq!(
        state["windows"].as_array().unwrap().len(),
        1,
        "one logical window"
    );

    let pid: i32 = serde_json::from_str::<Value>(
        &std::fs::read_to_string(data.path().join("data/fixture-start.json")).unwrap(),
    )
    .unwrap()["pid"]
        .as_i64()
        .unwrap() as i32;
    let status = app.quit();
    assert!(status.success(), "{status}");
    assert!(!answers(&local), "Quit stopped the owned host");
    assert!(
        unsafe { libc::kill(pid, 0) } != 0,
        "the owned host process is gone"
    );
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("install.json")).unwrap())
            .unwrap();
    assert_eq!(record["runtimeStamp"], "0.0.0-fixture");
}

/// V03: a matching independently started host is adopted and survives Quit; another installation is not touched.
#[test]
fn an_adopted_host_survives_quit_and_another_installation_is_left_alone() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("installation-id"), "ours\n").unwrap();
    let port = free_port();
    std::fs::write(data.path().join("install.json"), json!({ "completedAt": "2026-10-03T00:00:00Z", "runtimeStamp": "0.0.0-fixture", "port": port }).to_string()).unwrap();
    // The same installation, started outside the app: it reads ../installation-id from its data root.
    let independent = {
        let child = Command::new(runtime().join("bin/suplex"))
            .args(["start", "--foreground"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUPLEX_DATA_ROOT", data.path().join("data"))
            .env("SUPLEX_PORT", port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(wait_until(Duration::from_secs(10), || answers(&format!(
            "http://127.0.0.1:{port}"
        ))));
        child
    };
    let mut app = App::launch(data.path(), &[]);
    let state = app.wait_for("the adopted host", |state| view(state).0 == "host");
    assert_eq!(state["local"], format!("http://127.0.0.1:{port}"));
    assert!(
        !data.path().join("logs/server.log").exists(),
        "nothing was spawned"
    );
    assert!(app.quit().success());
    assert!(
        answers(&format!("http://127.0.0.1:{port}")),
        "an adopted host is never signalled"
    );
    let mut independent = independent;
    let _ = independent.kill();
    let _ = independent.wait();
}

/// V06, V07, V05 (second launch): remote loopback hosts, host switching with fresh labels and one window, a
/// second instance forwarding --url, the failure page and its retry, and the last selection after restart.
#[test]
fn remote_hosts_switching_second_launch_failure_page_and_restart() {
    let first = Host::start(&[(
        "index.html",
        "<!doctype html><html lang=\"en\"><p>first</p></html>",
    )]);
    let second = Host::start(&[(
        "index.html",
        "<!doctype html><html lang=\"en\"><p>second</p></html>",
    )]);
    let data = tempfile::tempdir().unwrap();
    let invitation = format!("{}/?company=one", first.origin);
    let mut app = App::launch(data.path(), &["--url", &invitation]);
    let shown = app.wait_for("the first host", |state| {
        view(state).0 == "host"
            && state["url"]
                .as_str()
                .is_some_and(|url| url.contains("company=one"))
    });
    let registry: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("desktop.json")).unwrap())
            .unwrap();
    assert_eq!(
        registry,
        json!({ "current": format!("{}/", first.origin), "targets": [format!("{}/", first.origin)] }),
        "only the origin is remembered"
    );
    let remote = app.eval(&format!("{RAW_INVOKE} return {{ app: typeof window.suplexApp, access: await window.suplexApp.networkAccess(), choose: await raw('desktop_choose', {{ mode: 'local' }}) }};"));
    assert_eq!(
        remote["access"],
        json!({ "managed": false }),
        "remote authority is never local authority"
    );
    assert_ne!(remote["choose"], "allowed");

    // A second launch with --url reaches the running app, which switches to a fresh view; without --url it only focuses.
    let status = app_command(data.path(), &["--url", &format!("{}/", second.origin)])
        .status()
        .unwrap();
    assert!(
        status.success(),
        "the second instance exits after forwarding"
    );
    let switched = app.wait_for("the second host", |state| {
        state["view"]["origin"] == second.origin
    });
    assert_ne!(view(&switched).1, view(&shown).1);
    assert_eq!(
        switched["windows"].as_array().unwrap().len(),
        1,
        "one logical window"
    );
    assert!(app_command(data.path(), &[]).status().unwrap().success());
    assert_eq!(
        app.state()["view"]["origin"],
        second.origin,
        "a plain second launch only focuses"
    );
    assert_eq!(
        app.state()["registry"],
        json!([second.origin, first.origin])
    );

    // An invalid explicit second-launch URL is reported without switching or blocking.
    assert!(
        app_command(data.path(), &["--url=http://suplex.example.com"])
            .status()
            .unwrap()
            .success()
    );
    assert!(wait_until(Duration::from_secs(5), || app
        .effect("dialog")
        .iter()
        .any(|dialog| dialog["title"] == "The Suplex URL is not valid")));
    assert_eq!(app.state()["view"]["origin"], second.origin);

    // An unreachable host shows the bundled failure page, which retries and recovers when the host answers.
    let down_port = free_port();
    let down = format!("http://localhost:{down_port}");
    assert!(app_command(data.path(), &["--url", &format!("{down}/")])
        .status()
        .unwrap()
        .success());
    let failing = app.wait_for("the failure page", |state| view(state).0 == "unavailable");
    let page = app.eval(&format!("{RAW_INVOKE} return {{ address: document.getElementById('address').textContent, app: typeof window.suplexApp, desktop: typeof window.suplexDesktop, choose: await raw('desktop_choose', {{ mode: 'local' }}), network: await raw('app_network_access') }};"));
    assert_eq!(page["address"], down);
    assert_eq!(
        (page["app"].as_str(), page["desktop"].as_str()),
        (Some("undefined"), Some("undefined"))
    );
    assert_ne!(page["choose"], "allowed");
    assert_ne!(page["network"], "allowed");
    let recovered = Host::start_on(
        down_port,
        &[(
            "index.html",
            "<!doctype html><html lang=\"en\"><p>back</p></html>",
        )],
    );
    let back = app.wait_for("automatic retry", |state| {
        view(state).0 == "host" && state["view"]["origin"] == recovered.origin
    });
    assert_ne!(view(&back).1, view(&failing).1);

    // Close the window; the app and its selection stay; reopening shows the same host. Then restart.
    app.send(json!({ "cmd": "close-window" }));
    app.wait_for("no window", |state| {
        state["windows"].as_array().unwrap().is_empty()
    });
    app.send(json!({ "cmd": "reopen" }));
    let reopened = app.wait_for("reopened", |state| view(state).0 == "host");
    assert_eq!(
        reopened["view"]["origin"], recovered.origin,
        "reopening shows the current selection, not the launch argument"
    );
    assert!(app.quit().success());
    let mut again = App::launch(data.path(), &[]);
    let restored = again.wait_for("the last selection after restart", |state| {
        view(state).0 == "host"
    });
    assert_eq!(restored["view"]["origin"], recovered.origin);
    assert!(again.quit().success());
}

/// Gate: an HTTPS origin loads in WKWebView with default certificate validation, and its runtime grant is
/// bound to that exact origin. Needs internet access to example.com; reports a skip when offline.
#[test]
fn an_https_origin_gets_only_its_exact_grant() {
    if Command::new("/usr/bin/curl")
        .args(["-sSfI", "--max-time", "5", "https://example.com/"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| !status.success())
        .unwrap_or(true)
    {
        eprintln!("SKIPPED: https://example.com is not reachable from this machine");
        return;
    }
    let data = tempfile::tempdir().unwrap();
    let mut app = App::launch(data.path(), &["--url", "https://example.com/"]);
    app.wait_for("the HTTPS host", |state| {
        view(state).0 == "host" && state["view"]["origin"] == "https://example.com"
    });
    let page = app.eval(&format!("{RAW_INVOKE} return {{ origin: location.origin, secure: window.isSecureContext, app: typeof window.suplexApp, access: await window.suplexApp.networkAccess(), choose: await raw('desktop_choose', {{ mode: 'local' }}), update: await raw('plugin:updater|check'), title: document.title }};"));
    assert_eq!(page["origin"], "https://example.com");
    assert_eq!(page["secure"], true);
    assert_eq!(page["access"], json!({ "managed": false }));
    assert_ne!(page["choose"], "allowed");
    assert_ne!(page["update"], "allowed");
    assert!(app.quit().success());
}

/// V08 in real WKWebView: a frame from another origin inside the host page reaches no bridge command.
#[test]
fn a_cross_origin_frame_cannot_reach_the_bridge() {
    let frame = Host::start(&[(
        "frame.html",
        r#"<!doctype html><html lang="en"><script>
(async () => {
  if (!window.__TAURI_INTERNALS__) { parent.postMessage({ missing: true }, '*'); return; }
  const raw = async (command, args) => { try { await window.__TAURI_INTERNALS__.invoke(command, args ?? {}); return 'allowed'; } catch (error) { return String(error); } };
  parent.postMessage({
    network: await raw('app_network_access'),
    picker: await raw('app_open_host_picker'),
    save: await raw('app_save_network_access_preference', { mode: 'all' }),
    choose: await raw('desktop_choose', { mode: 'local' }),
  }, '*');
})();
</script></html>"#,
    )]);
    let page = format!(
        "<!doctype html><html lang=\"en\"><script>addEventListener('message', (event) => {{ window.__frame = event.data; }});</script><iframe src=\"{}/frame.html\"></iframe></html>",
        frame.origin
    );
    let host = Host::start(&[("index.html", &page)]);
    let data = tempfile::tempdir().unwrap();
    let mut app = App::launch(data.path(), &["--url", &format!("{}/", host.origin)]);
    app.wait_for("the host view", |state| view(state).0 == "host");
    let seen = app.eval("for (let tries = 0; tries < 30 && !window.__frame; tries++) await new Promise((resolve) => setTimeout(resolve, 100)); return window.__frame ?? null;");
    eprintln!("cross-origin frame: {seen}");
    if let Some(results) = seen
        .as_object()
        .filter(|results| !results.contains_key("missing"))
    {
        for (command, result) in results {
            assert_ne!(result, "allowed", "{command}: {seen}");
        }
    }
    let state = app.state();
    assert_eq!(state["view"]["origin"], host.origin.as_str());
    assert!(!data.path().join("network-access.json").exists());
    assert!(app.quit().success());
}

/// Gate and V14 (native part): the real React application from the Rust host renders in WKWebView with the
/// desktop bridge, host bar, titlebar inset, and drag regions. Needs `pnpm test` or `pnpm --filter suplex-web build`
/// plus the debug host binary.
#[test]
fn the_react_application_renders_from_the_rust_host() {
    let checkout = manifest().join("../../..");
    let host_binary = checkout.join("target/debug/suplex");
    if !host_binary.exists() || !checkout.join("apps/web/dist/suplex-ui.js").exists() {
        eprintln!("SKIPPED: build apps/web/dist and target/debug/suplex first");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let port = free_port();
    let data = root.path().join("data");
    // A cleared environment: nothing from the session that runs these tests reaches this host.
    let mut host = Command::new(&host_binary)
        .arg("serve")
        .env_clear()
        .env("HOME", root.path())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("TMPDIR", root.path())
        .env("SUPLEX_ROOT", root.path())
        .env("SUPLEX_ENV_FILE", root.path().join("suplex.env"))
        .env("SUPLEX_PORT", port.to_string())
        .env("SUPLEX_ACCESS_MODE", "local")
        .env("SUPLEX_BIND_ADDRESS", "127.0.0.1")
        .env("SUPLEX_DATA_ROOT", &data)
        .env("SUPLEX_DATABASE_PATH", data.join("suplex.sqlite"))
        .env("SUPLEX_ARTIFACT_ROOT", data.join("artifacts"))
        .env("SUPLEX_RUNTIME_ROOT", data.join("runtime"))
        .env("SUPLEX_REPOSITORY_ROOT", root.path().join("repositories"))
        .env("SUPLEX_WORKTREE_ROOT", root.path().join("worktrees"))
        .env("SUPLEX_ASSETS_DIR", checkout.join("apps/web/dist"))
        .env("SUPLEX_CODEX_COMMAND", "/usr/bin/false")
        .env("SUPLEX_CLAUDE_COMMAND", "/usr/bin/false")
        .env("GH_CONFIG_DIR", root.path().join("gh"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let origin = format!("http://127.0.0.1:{port}");
    assert!(
        wait_until(Duration::from_secs(30), || answers(&origin)),
        "the Rust host started"
    );
    let app_data = tempfile::tempdir().unwrap();
    let mut app = App::launch(app_data.path(), &["--url", &format!("{origin}/")]);
    app.wait_for("the host view", |state| view(state).0 == "host");
    let page = app.eval(r#"
      // The host serves a boot placeholder inside #suplex-app; wait until React replaces it and the host bar renders.
      for (let tries = 0; tries < 300 && !document.querySelector('[data-desktop-host-bar]'); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const root = document.getElementById('suplex-app');
      const drag = document.querySelector('[data-tauri-drag-region="deep"]');
      return {
        rendered: root ? root.children.length : 0,
        desktopClass: document.documentElement.classList.contains('suplex-desktop'),
        hostBar: Boolean(document.querySelector('[data-desktop-host-bar]')),
        titlebarX: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-x').trim(),
        dragRegion: drag ? drag.tagName : null,
        dragPadding: drag ? getComputedStyle(drag).paddingTop : null,
        font: getComputedStyle(document.body).fontFamily,
        text: document.body.innerText.slice(0, 200),
      };
    "#);
    eprintln!("React in WKWebView: {page}");
    assert!(page["rendered"].as_u64().unwrap() > 0, "{page}");
    assert_eq!(page["desktopClass"], true);
    assert_eq!(page["hostBar"], true);
    assert_eq!(page["titlebarX"], "5rem");
    assert!(app.quit().success());
    let _ = host.kill();
    let _ = host.wait();
}

/// The setup form submits ?url=…: an invalid URL is reported and stays on the form; a valid one opens the host
/// and remembers only its origin.
#[test]
fn the_setup_form_validates_and_connects_to_a_remote_host() {
    let host = Host::start(&[(
        "index.html",
        "<!doctype html><html lang=\"en\"><p>remote</p></html>",
    )]);
    let data = tempfile::tempdir().unwrap();
    let mut app = App::launch(data.path(), &[]);
    app.wait_for("the choice page", |state| {
        view(state).0 == "setup" && state["boot"] == "choosing"
    });
    app.eval("setTimeout(() => window.suplexDesktop.choose('remote'), 500); return true;");
    app.wait_for("the connect form", |state| {
        state["boot"] == "connecting-remote"
            && state["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/connect.html"))
    });
    let tested = app.eval(&format!(
        "return await window.suplexDesktop.testConnection('{}');",
        host.origin
    ));
    assert_eq!(tested, json!({ "ok": true, "reason": null }));
    app.eval("setTimeout(() => { document.getElementById('url').value = 'http://suplex.example.com'; document.querySelector('form').submit(); }, 500); return true;");
    assert!(wait_until(Duration::from_secs(10), || app
        .effect("dialog")
        .iter()
        .any(|dialog| dialog["title"] == "The Suplex URL is not valid")));
    assert!(
        app.state()["url"]
            .as_str()
            .unwrap()
            .contains("connect.html"),
        "an invalid URL keeps the form"
    );
    app.eval(&format!("setTimeout(() => {{ document.getElementById('url').value = '{}/?company=one'; document.querySelector('form').submit(); }}, 500); return true;", host.origin));
    let shown = app.wait_for("the remote host", |state| view(state).0 == "host");
    assert_eq!(shown["view"]["origin"], host.origin);
    let registry: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("desktop.json")).unwrap())
            .unwrap();
    assert_eq!(registry["targets"], json!([format!("{}/", host.origin)]));
    assert!(app.quit().success());
}

fn digest(path: &Path) -> Vec<(String, u64)> {
    let mut entries: Vec<(String, u64)> = std::fs::read_dir(path)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.metadata().unwrap().len(),
            )
        })
        .collect();
    entries.sort();
    entries
}

/// V02: a data directory in the Electron app's layout is used in place. Nothing is migrated, reset, or duplicated.
#[test]
fn existing_electron_data_is_used_in_place() {
    let data = tempfile::tempdir().unwrap();
    let port = free_port();
    let files = [
        ("installation-id", "electron-era-installation\n".to_owned()),
        ("install.json", json!({ "completedAt": "2026-10-01T14:26:34.989Z", "runtimeStamp": "0.0.0-fixture", "port": port }).to_string()),
        ("desktop.json", json!({ "url": format!("http://127.0.0.1:{port}/") }).to_string()),
        ("window-state.json", r#"{"width":960,"height":640,"x":60,"y":70}"#.to_owned()),
        ("network-access.json", "\"all\"".to_owned()),
        ("suplex.env", "SUPLEX_ACCESS_MODE=local\n".to_owned()),
    ];
    for (name, content) in &files {
        std::fs::write(data.path().join(name), content).unwrap();
    }
    std::fs::create_dir_all(data.path().join("data/artifacts")).unwrap();
    std::fs::write(
        data.path().join("data/suplex.sqlite"),
        b"database bytes owned by the host",
    )
    .unwrap();
    std::fs::create_dir_all(data.path().join("logs")).unwrap();
    std::fs::write(data.path().join("logs/server.log"), "earlier host output\n").unwrap();
    let data_before = digest(&data.path().join("data"));

    let mut app = App::launch(data.path(), &[]);
    let state = app.wait_for("the existing local host", |state| view(state).0 == "host");
    assert_eq!(
        state["local"],
        format!("http://127.0.0.1:{port}"),
        "the recorded port is used"
    );
    assert_eq!(
        state["preference"], "all",
        "the saved network preference is read"
    );
    let started: Value = serde_json::from_str(
        &std::fs::read_to_string(data.path().join("data/fixture-start.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(started["env"]["SUPLEX_ACCESS_MODE"], "all");
    assert_eq!(
        started["env"]["SUPLEX_DATA_ROOT"],
        data.path().join("data").display().to_string()
    );
    assert!(
        app.effects()
            .iter()
            .all(|effect| effect["url"] != "tauri://localhost/pages/choice.html"),
        "no first-install choice"
    );
    // WKWebView reports outerWidth and outerHeight as 0; the overlay title bar makes the inner size the window size.
    let bounds = app.eval("return { width: window.innerWidth, height: window.innerHeight };");
    assert_eq!(
        (bounds["width"].as_u64(), bounds["height"].as_u64()),
        (Some(960), Some(640)),
        "the saved window size is restored"
    );
    assert!(app.quit().success());

    assert_eq!(
        std::fs::read_to_string(data.path().join("installation-id")).unwrap(),
        "electron-era-installation\n",
        "the installation keeps its identity"
    );
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("install.json")).unwrap())
            .unwrap();
    assert_eq!(record["completedAt"], "2026-10-01T14:26:34.989Z");
    assert_eq!(
        std::fs::read_to_string(data.path().join("suplex.env")).unwrap(),
        "SUPLEX_ACCESS_MODE=local\n"
    );
    assert_eq!(
        std::fs::read(data.path().join("data/suplex.sqlite")).unwrap(),
        b"database bytes owned by the host"
    );
    assert!(
        data_before
            .iter()
            .all(|entry| digest(&data.path().join("data")).contains(entry)),
        "the shell changed nothing under data/"
    );
    assert!(
        std::fs::read_to_string(data.path().join("logs/server.log"))
            .unwrap()
            .starts_with("earlier host output\n"),
        "the host log is appended"
    );
    let registry: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("desktop.json")).unwrap())
            .unwrap();
    assert_eq!(
        registry["targets"],
        json!([format!("http://127.0.0.1:{port}/")]),
        "the legacy single-URL file was read and rewritten as a registry"
    );
}

/// An invalid explicit launch target fails visibly and exits instead of falling through to a remembered host.
#[test]
fn an_invalid_launch_target_fails_visibly_and_exits() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(
        data.path().join("desktop.json"),
        json!({ "url": "https://remembered.example/" }).to_string(),
    )
    .unwrap();
    let mut command = app_command(data.path(), &["--url", "http://suplex.example.com"]);
    let output = command.stderr(Stdio::piped()).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("--url is not valid: http is accepted only for localhost."));
    let effects = std::fs::read_to_string(data.path().join("native-test-effects.log")).unwrap();
    assert!(effects.contains("The Suplex URL is not valid"), "{effects}");
    assert!(!effects.contains("\"event\":\"page\""), "no page loaded");
}
