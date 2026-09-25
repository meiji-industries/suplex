use suplex::{
    http::{self, AppState, session::SessionConfig},
    platform::{
        config::Installation,
        database::{OpenMode, SuplexDatabase},
        embedded,
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
        return suplex::coordination::root_stdio::serve_from_environment().await;
    }
    let installation = Installation::load()?;
    suplex::platform::system_events::install(installation.logs.clone());
    let database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    suplex::identity::auth::normalize_legacy_users(&database)?;
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
    let shutdown_state = state.clone();
    let result = axum::serve(listener, http::router(state))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            shutdown_state.shutdown_history();
        })
        .await;
    task_host.stop().await;
    result?;
    Ok(())
}
