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
    let installation = Installation::load()?;
    let database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, installation.port)).await?;
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
    );
    println!("Experimental API routes are still being ported.");
    axum::serve(listener, http::router(state)).await?;
    Ok(())
}
