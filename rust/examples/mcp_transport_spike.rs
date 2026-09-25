use std::{env, sync::Arc};

use rmcp::transport::streamable_http_server::{
    session::never::NeverSessionManager,
    tower::{StreamableHttpServerConfig, StreamableHttpService},
};
use rmcp::{ServerHandler, ServiceExt, tool, tool_handler, tool_router};

struct Probe;

#[tool_router]
impl Probe {
    #[tool(description = "Return pong")]
    fn ping(&self) -> String {
        "pong".to_owned()
    }
}

#[tool_handler]
impl ServerHandler for Probe {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match env::args().nth(1).as_deref() {
        Some("stdio") => {
            Probe
                .serve(rmcp::transport::stdio())
                .await?
                .waiting()
                .await?;
        }
        Some("http") => {
            let port = env::args()
                .nth(2)
                .unwrap_or_else(|| "4114".to_owned())
                .parse::<u16>()?;
            let service = StreamableHttpService::new(
                || Ok(Probe),
                Arc::new(NeverSessionManager::default()),
                StreamableHttpServerConfig::default()
                    .with_json_response(true)
                    .with_legacy_session_mode(false),
            );
            let app = axum::Router::new().route_service("/mcp", service);
            let listener =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
            axum::serve(listener, app).await?;
        }
        _ => return Err("usage: mcp_transport_spike stdio | http [port]".into()),
    }
    Ok(())
}
