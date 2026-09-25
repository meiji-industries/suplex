use axum::{Router, http::StatusCode};
use suplex::platform::{config::Installation, embedded};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let installation = Installation::load()?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, installation.port)).await?;
    println!("Suplex Rust revision: {}", env!("SUPLEX_RUST_REVISION"));
    println!("URL: http://127.0.0.1:{}", installation.port);
    println!("Installation: {}", installation.root.display());
    println!(
        "Bundle: {} migrations, {} frontend assets",
        embedded::MIGRATIONS.len(),
        embedded::FRONTEND.len()
    );
    println!("Experimental HTTP routes are not ported yet.");
    axum::serve(
        listener,
        Router::new().fallback(|| async { StatusCode::NOT_FOUND }),
    )
    .await?;
    Ok(())
}
