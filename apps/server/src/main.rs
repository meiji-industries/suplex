use serde_json::json;
use suplex::tasks::control::HarnessKind;
use suplex::{
    http::{self, AppState, session::SessionConfig},
    platform::{
        config::Installation,
        database::{OpenMode, SuplexDatabase},
        development, embedded, system_event_transport, system_events,
    },
};
use tokio::net::TcpListener;

fn main() {
    // PATH changes before the runtime starts its worker threads.
    suplex::platform::user_path::extend();
    let runtime = tokio::runtime::Runtime::new().expect("Failed building the Runtime");
    if let Err(error) = runtime.block_on(run()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let command = std::env::args().skip(1).collect::<Vec<_>>();
    if command == ["github-store-credential"] {
        suplex::integrations::github::use_installation(&Installation::load()?.database);
        if let Err(error) = suplex::integrations::github::store_device_credential_from_stdin() {
            eprintln!("GitHub credential storage failed: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if command == ["mcp", "advisor"] {
        return suplex::coordination::advisor_bridge::serve_from_environment().await;
    }
    if command == ["update-apply"] {
        return suplex::platform::update::apply();
    }
    if let [subcommand, directory] = command.as_slice()
        && subcommand == suplex::runtimes::codex::display::SUBCOMMAND
    {
        return suplex::runtimes::codex::display::serve(directory).await;
    }
    if command == ["mcp", "root"] {
        // The Root bridge forwards its events to the server's system log.
        if let Ok(binding) = suplex::coordination::root_bridge::authenticated_binding() {
            system_events::install_producer(&binding.database_path);
            suplex::integrations::github::use_installation(&binding.database_path);
        }
        return suplex::coordination::root_stdio::serve_from_environment().await;
    }
    if command == ["mcp"] {
        return suplex::integrations::suplex::bridge::serve_from_environment().await;
    }
    if command.starts_with(&["display".to_owned(), "devin".to_owned()]) {
        return suplex::runtimes::devin::display::main(&command[2..]);
    }
    if let [display, provider, directory] = command.as_slice()
        && display == "display"
        && provider == HarnessKind::ClaudeCode.as_str()
    {
        return Ok(suplex::runtimes::claude_code::display::run_claude_display(
            std::path::Path::new(directory),
        )?);
    }
    if command.first().map(String::as_str) == Some("billing") {
        std::process::exit(suplex::billing::hosted::server::main(&command[1..]).await);
    }
    if command.first().map(String::as_str) == Some("hosted") {
        std::process::exit(suplex::hosted::main(&command[1..]).await);
    }
    if matches!(
        command.first().map(String::as_str),
        Some("serve" | "start" | "up" | "restart" | "stop" | "down")
    ) {
        suplex::platform::supervisor::require_non_root_host()?;
    }
    match command.first().map(String::as_str) {
        None => {
            print!("{}", suplex::cli::HELP);
            Ok(())
        }
        Some("serve") => serve().await,
        Some("start" | "up") if command.iter().any(|arg| arg == "--foreground") => {
            suplex::platform::supervisor::run_foreground().await
        }
        Some(name) => match suplex::cli::run(name, &command[1..]).await {
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
    let installation = Installation::load()?;
    suplex::integrations::github::use_installation(&installation.database);
    system_events::install(installation.logs.clone());
    let mut database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    suplex::identity::auth::normalize_legacy_users(&database)?;
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
    suplex::platform::supervisor::configure_foreground(&installation)?;
    let host_terminals = std::sync::Arc::<suplex::terminals::host::HostTerminals>::default();
    suplex::projects::git::set_libgit2_transport(
        suplex::platform::environment_settings::read(&database)?.git2_enabled,
    );
    let telemetry =
        suplex::telemetry::spawn(installation.database.clone(), &installation.installation_id);
    let task_host = suplex::tasks::host::spawn_task_host(
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
        Some(url) => state.with_billing(suplex::billing::BillingClient::new(url)),
        None => state,
    };
    suplex::billing::spawn_refresh(state.clone());
    let state = match installation.account_service_url.clone() {
        Some(url) => state.with_accounts(suplex::accounts::AccountClient::new(
            url,
            installation.installation_id.clone(),
        )),
        None => state,
    };
    #[cfg(debug_assertions)]
    let state = match std::env::var_os("SUPLEX_ASSETS_DIR") {
        Some(directory) => state.with_dev_assets_dir(directory.into()),
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
            (last_wall, last_monotonic) = (wall, monotonic);
        }
    });
    let shutdown_state = state.clone();
    let app = http::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            let reason = {
                let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => "SIGINT", _ = terminate.recv() => "SIGTERM" }
            };
            #[cfg(not(unix))]
            let reason = { let _ = tokio::signal::ctrl_c().await; "SIGINT" };
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
