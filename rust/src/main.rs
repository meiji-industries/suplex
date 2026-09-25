use serde_json::json;
use suplex::{
    http::{self, AppState, session::SessionConfig},
    platform::{
        config::Installation,
        database::{OpenMode, SuplexDatabase},
        development, embedded, system_event_transport, system_events,
    },
};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = std::env::args().skip(1).collect::<Vec<_>>();
    if command == ["mcp", "advisor"] {
        return suplex::coordination::advisor_bridge::serve_from_environment().await;
    }
    if command == ["mcp", "root"] {
        // The Root bridge forwards its events to the server's system log.
        if let Ok(binding) = suplex::coordination::root_bridge::authenticated_binding() {
            system_events::install_producer(&binding.database_path);
        }
        return suplex::coordination::root_stdio::serve_from_environment().await;
    }
    if let [display, provider, directory] = command.as_slice()
        && display == "display"
        && provider == "claude-code"
    {
        return Ok(suplex::runtimes::claude_code::display::run_claude_display(
            std::path::Path::new(directory),
        )?);
    }
    match command.first().map(String::as_str) {
        None | Some("serve") => serve().await,
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

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let installation = Installation::load()?;
    system_events::install(installation.logs.clone());
    let mut database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    suplex::identity::auth::normalize_legacy_users(&database)?;
    development::seed_development_data(&mut database, chrono::Utc::now())?;
    std::fs::create_dir_all(&installation.artifacts)?;
    std::fs::create_dir_all(&installation.worktrees)?;
    std::fs::create_dir_all(&installation.runtime)?;
    let _receiver =
        system_event_transport::start_receiver(&installation.database, system_events::forward)
            .await;
    server_event("starting", json!({}));
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, installation.port)).await?;
    let task_host = suplex::tasks::host::spawn_task_host(
        installation.database.clone(),
        installation.artifacts.clone(),
    );
    println!("Suplex Rust revision: {}", env!("SUPLEX_RUST_REVISION"));
    println!("URL: http://127.0.0.1:{}", installation.port);
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
            reachable_address: format!("http://127.0.0.1:{}", installation.port),
            tailscale_exposure: "off".to_owned(),
        },
    )
    .with_project_roots(
        installation.repositories.clone(),
        installation.worktrees.clone(),
    )
    .with_artifact_root(installation.artifacts.clone())
    .with_task_host(task_host.clone());
    #[cfg(debug_assertions)]
    let state = match std::env::var_os("SUPLEX_RUST_ASSETS_DIR") {
        Some(directory) => state.with_dev_assets_dir(directory.into()),
        None => state,
    };
    println!("Experimental API routes are still being ported.");
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
    let result = axum::serve(listener, http::router(state))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            server_event("shutdown_requested", json!({"reason": "SIGINT"}));
            shutdown_state.shutdown_history();
        })
        .await;
    heartbeat.abort();
    task_host.stop().await;
    server_event("stopped", json!({}));
    result?;
    Ok(())
}
