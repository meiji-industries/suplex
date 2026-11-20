mod accounts;
mod billing;
mod cli;
mod coordination;
mod delivery;
mod hosted;
mod http;
mod identity;
mod integrations;
mod moves;
mod platform;
mod profiles;
mod projects;
mod runtimes;
mod shared;
mod sync;
mod tasks;
mod telemetry;
mod terminals;
mod web_push;

use crate::http::{AppState, session::SessionConfig};
use crate::platform::{
    config::Installation,
    database::{OpenMode, SuplexDatabase},
    development, embedded, system_event_transport, system_events,
};
use crate::tasks::control::HarnessKind;
use serde_json::json;
use tokio::net::TcpListener;

fn main() {
    // Every command reports its panics, before anything that could panic.
    crate::telemetry::exceptions::install();
    // PATH changes before the runtime starts its worker threads.
    crate::platform::user_path::extend();
    // glibc gives each thread that allocates its own arena, up to 8 per core, and
    // keeps freed pages in each one. On a production host the server held about
    // 750 MB in 31 arenas and grew about 200 MB an hour. Fewer arenas share free
    // pages; the heartbeat returns the free ones to the system.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 4);
    }
    let command = std::env::args().skip(1).collect::<Vec<_>>();
    // The updater builds a runtime per network step; inside another runtime that panics.
    let result = if command == ["update-apply"] {
        crate::platform::update::apply(None).map(|_| ())
    } else {
        tokio::runtime::Runtime::new()
            .expect("Failed building the Runtime")
            .block_on(run(command))
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run(command: Vec<String>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if command == ["github-store-credential"] {
        crate::integrations::github::use_installation(&Installation::load()?.database);
        if let Err(error) = crate::integrations::github::store_device_credential_from_stdin() {
            eprintln!("GitHub credential storage failed: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if command == ["mcp", "advisor"] {
        return crate::coordination::advisor_bridge::serve_from_environment().await;
    }
    if let [subcommand, directory] = command.as_slice()
        && subcommand == crate::runtimes::codex::display::SUBCOMMAND
    {
        return crate::runtimes::codex::display::serve(directory).await;
    }
    if let [subcommand, directory] = command.as_slice()
        && let Some(cli) = crate::runtimes::pi::display::for_subcommand(subcommand)
    {
        return crate::runtimes::pi::display::serve(cli, directory).await;
    }
    if command == ["mcp", "root"] {
        // The Root bridge forwards its events to the server's system log.
        if let Ok(binding) = crate::coordination::root_bridge::authenticated_binding() {
            system_events::install_producer(&binding.database_path);
            crate::integrations::github::use_installation(&binding.database_path);
        }
        return crate::coordination::root_stdio::serve_from_environment().await;
    }
    if command == ["mcp"] {
        return crate::integrations::suplex::bridge::serve_from_environment().await;
    }
    if command.starts_with(&["display".to_owned(), "devin".to_owned()]) {
        return crate::runtimes::devin::display::main(&command[2..]);
    }
    if let [display, provider, directory] = command.as_slice()
        && display == "display"
        && provider == HarnessKind::ClaudeCode.as_str()
    {
        return Ok(crate::runtimes::claude_code::display::run_claude_display(
            std::path::Path::new(directory),
        )?);
    }
    if command.first().map(String::as_str) == Some("billing") {
        std::process::exit(crate::billing::hosted::server::main(&command[1..]).await);
    }
    if command.first().map(String::as_str) == Some("hosted") {
        std::process::exit(crate::hosted::main(&command[1..]).await);
    }
    if matches!(
        command.first().map(String::as_str),
        Some("serve" | "start" | "up" | "restart" | "stop" | "down")
    ) {
        crate::platform::supervisor::require_non_root_host()?;
    }
    match command.first().map(String::as_str) {
        None => {
            print!("{}", crate::cli::HELP);
            Ok(())
        }
        Some("serve") => serve().await,
        Some("start" | "up") if command.iter().any(|arg| arg == "--foreground") => {
            crate::platform::supervisor::run_foreground().await
        }
        Some(name) => match crate::cli::run(name, &command[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("Suplex command failed: {error}");
                std::process::exit(1);
            }
        },
    }
}

fn server_event(state: &str, extra: serde_json::Value) {
    let mut event = json!({"type": "server", "state": state});
    if let (Some(event), serde_json::Value::Object(extra)) = (event.as_object_mut(), extra) {
        event.extend(extra);
    }
    let mut context = serde_json::Map::new();
    context.insert("source".into(), json!("server"));
    system_events::emit_with_context(event, context);
}

async fn serve() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::sync::LazyLock::force(&crate::platform::health::STARTED_EXECUTABLE);
    let installation = Installation::load()?;
    crate::telemetry::exceptions::configure(&installation);
    crate::integrations::github::use_installation(&installation.database);
    system_events::install(installation.logs.clone());
    let mut database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    crate::identity::auth::normalize_legacy_users(&database)?;
    // Every access mode needs the Operator and a first company: loopback and tailnet requests
    // sign in as the Operator (ADR 0009), and onboarding renames that company rather than
    // creating one. Idempotent, so restarts are no-ops.
    development::seed_development_data(&mut database, chrono::Utc::now())?;
    std::fs::create_dir_all(&installation.artifacts)?;
    std::fs::create_dir_all(&installation.worktrees)?;
    std::fs::create_dir_all(&installation.runtime)?;
    let _receiver =
        system_event_transport::start_receiver(&installation.database, system_events::forward)
            .await;
    server_event("starting", json!({}));
    let listener =
        TcpListener::bind((installation.bind_address.as_str(), installation.port)).await?;
    crate::platform::supervisor::configure_foreground(&installation)?;
    let host_terminals = std::sync::Arc::<crate::terminals::host::HostTerminals>::default();
    crate::projects::git::set_libgit2_transport(
        crate::platform::environment_settings::read(&database)?.git2_enabled,
    );
    let telemetry = crate::telemetry::spawn(
        installation.database.clone(),
        crate::telemetry::exceptions::spool_directory(&installation.root),
        &installation.installation_id,
    );
    let task_host = crate::tasks::host::spawn_task_host(
        installation.database.clone(),
        installation.artifacts.clone(),
        host_terminals.clone(),
    );
    println!("Suplex revision: {}", env!("SUPLEX_REVISION"));
    println!("URL: {}", installation.reachable_address);
    println!("Installation: {}", installation.root.display());
    println!(
        "Bundle: {} migrations, {} frontend assets",
        embedded::MIGRATIONS.len(),
        embedded::FRONTEND.len()
    );
    let state = AppState::new(
        database,
        SessionConfig {
            port: installation.port,
            reachable_address: installation.reachable_address.clone(),
            tailscale_exposure: installation.tailscale_exposure.clone(),
        },
    )
    .with_installation(installation.clone())
    .with_project_roots(
        installation.repositories.clone(),
        installation.worktrees.clone(),
    )
    .with_artifact_root(installation.artifacts.clone())
    .with_task_host(task_host.clone())
    .with_host_terminals(host_terminals.clone());
    let state = match installation.billing_service_url.clone() {
        Some(url) => state.with_billing(crate::billing::BillingClient::new(url)),
        None => state,
    };
    crate::billing::spawn_refresh(state.clone());
    let state = match installation.account_service_url.clone() {
        Some(url) => state.with_accounts(crate::accounts::AccountClient::new(
            url,
            installation.installation_id.clone(),
        )),
        None => state,
    };
    #[cfg(debug_assertions)]
    let state = match resolve_dev_assets_dir(
        std::env::var_os("SUPLEX_ASSETS_DIR").map(std::path::PathBuf::from),
        embedded::FRONTEND.is_empty(),
        std::env::current_exe().ok().as_deref(),
    ) {
        Some(directory) => state.with_dev_assets_dir(directory),
        None => state,
    };
    server_event("listening", json!({}));
    let heartbeat = tokio::spawn(async {
        let mut last_wall = chrono::Utc::now();
        let mut last_monotonic = std::time::Instant::now();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.tick().await;
        loop {
            interval.tick().await;
            let wall = chrono::Utc::now();
            let monotonic = std::time::Instant::now();
            let wall_elapsed = (wall - last_wall).num_milliseconds();
            let monotonic_elapsed = monotonic.duration_since(last_monotonic).as_millis() as i64;
            let elapsed =
                json!({"wallElapsedMs": wall_elapsed, "monotonicElapsedMs": monotonic_elapsed});
            if wall_elapsed > 90_000
                || monotonic_elapsed > 90_000
                || (wall_elapsed - monotonic_elapsed).abs() > 30_000
            {
                server_event("clock_gap", elapsed.clone());
            }
            server_event("heartbeat", elapsed);
            #[cfg(all(target_os = "linux", target_env = "gnu"))]
            unsafe {
                libc::malloc_trim(0);
            }
            (last_wall, last_monotonic) = (wall, monotonic);
        }
    });
    let shutdown_state = state.clone();
    let app = http::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            let reason = {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => "SIGINT", _ = terminate.recv() => "SIGTERM" }
            };
            #[cfg(not(unix))]
            let reason = {
                let _ = tokio::signal::ctrl_c().await;
                "SIGINT"
            };
            server_event("shutdown_requested", json!({"reason": reason}));
            shutdown_state.shutdown_history();
        })
        .await;
    heartbeat.abort();
    if let Some(telemetry) = telemetry {
        telemetry.abort();
    }
    task_host.stop().await;
    host_terminals.close_all().await;
    server_event("stopped", json!({}));
    result?;
    Ok(())
}

/// Resolves the on-disk frontend bundle directory for debug builds.
/// Prefers an explicit `SUPLEX_ASSETS_DIR`; when unset and no frontend assets are embedded
/// (for example after `restart` of an already-running debug supervisor), walks up from the
/// running binary (`target/debug/suplex` -> `<repo>/apps/web/dist`).
#[cfg(debug_assertions)]
fn resolve_dev_assets_dir(
    configured: Option<std::path::PathBuf>,
    embedded_empty: bool,
    executable: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    if configured.is_some() {
        return configured;
    }
    if !embedded_empty {
        return None;
    }
    executable?
        .ancestors()
        .skip(1)
        .take(5)
        .map(|ancestor| ancestor.join("apps/web/dist"))
        .find(|directory| directory.join("suplex-ui.js").is_file())
}

#[cfg(all(test, debug_assertions))]
#[allow(clippy::unwrap_used, reason = "unit test fixtures")]
mod dev_assets_tests {
    use std::path::PathBuf;

    use super::resolve_dev_assets_dir;

    #[test]
    fn resolve_dev_assets_dir_prefers_explicit_env_and_falls_back_to_checkout_dist() {
        let root = std::env::temp_dir().join(format!("suplex-dev-assets-{}", uuid::Uuid::new_v4()));
        let dist = root.join("apps/web/dist");
        let binary = root.join("target/debug/suplex");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(dist.join("suplex-ui.js"), b"export {};").unwrap();

        let explicit = PathBuf::from("/custom/assets");
        assert_eq!(
            resolve_dev_assets_dir(Some(explicit.clone()), true, Some(&binary)),
            Some(explicit)
        );
        assert_eq!(resolve_dev_assets_dir(None, false, Some(&binary)), None);
        assert_eq!(
            resolve_dev_assets_dir(None, true, Some(&binary)),
            Some(dist)
        );

        let isolated = root.join("isolated/suplex");
        std::fs::remove_file(root.join("apps/web/dist/suplex-ui.js")).unwrap();
        assert_eq!(resolve_dev_assets_dir(None, true, Some(&isolated)), None);

        let _ = std::fs::remove_dir_all(root);
    }
}
