//! `suplex hosted serve`: billing, accounts, and the suplex.sh site in one
//! process on Fly, sharing one SQLite database.

use std::{path::Path, sync::Arc, time::Duration};

use axum::{Router, middleware};

use crate::{
    accounts::hosted::{self as accounts, Accounts, providers::Endpoints},
    billing::hosted::{
        self as billing, Clock, Hosted,
        revenuecat::{REVENUECAT_API_BASE, RevenueCatClient},
        stripe::{STRIPE_API_BASE, StripeClient},
    },
};

pub mod site;

const PROCESSOR_INTERVAL: Duration = Duration::from_secs(30);

pub fn router(accounts: &Accounts) -> Router {
    billing::server::router(accounts.hosted.clone())
        .merge(accounts::server::router(accounts.clone()))
        .merge(accounts::start::router(accounts.clone()))
        .merge(accounts::delete::router(accounts.clone()))
        .merge(site::router(accounts.clone()))
        .layer(middleware::from_fn_with_state(
            accounts.hosted.config.origin.clone(),
            site::redirect_www,
        ))
}

fn system_clock() -> Clock {
    Arc::new(|| chrono::Utc::now().timestamp_millis())
}

async fn shutdown_signal() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            let _ = interrupt.await;
            return;
        };
        tokio::select! {
            _ = interrupt => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = interrupt.await;
    }
}

/// Serves until SIGINT or SIGTERM. The billing processor and the account
/// sweep run at startup and every 30 seconds, and the processor once more
/// after the listener closes.
pub async fn serve() -> Result<(), String> {
    let env = |name: &str| std::env::var(name).ok();
    let config = billing::server::load_config(&env)?;
    let account_config = accounts::load_config(&env)?;
    let connection = billing::store::open(Path::new(&config.database_path))
        .map_err(|error| error.to_string())?;
    accounts::store::apply_schema(&connection).map_err(|error| error.to_string())?;
    let hosted = Hosted::new(
        config.hosted(),
        connection,
        StripeClient::new(STRIPE_API_BASE, &config.stripe_secret_key),
        RevenueCatClient::new(
            REVENUECAT_API_BASE,
            &config.revenuecat_secret_api_key,
            &config.revenuecat_stripe_public_api_key,
        ),
        system_clock(),
    );
    let accounts = Accounts::new(hosted.clone(), account_config, Endpoints::production());
    let processor = {
        let accounts = accounts.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(PROCESSOR_INTERVAL);
            loop {
                interval.tick().await;
                if let Err(error) = accounts.hosted.run_processor_pass().await {
                    eprintln!(
                        "billing: event processor pass failed: {}",
                        error.code.as_deref().unwrap_or("internal")
                    );
                }
                if accounts.sweep().is_err() {
                    eprintln!("accounts: sweep failed");
                }
            }
        })
    };
    let listener = tokio::net::TcpListener::bind((config.address.as_str(), config.port))
        .await
        .map_err(|error| error.to_string())?;
    eprintln!(
        "suplex hosted listening on {}:{}",
        config.address, config.port
    );
    let served = axum::serve(listener, router(&accounts))
        .with_graceful_shutdown(shutdown_signal())
        .await;
    processor.abort();
    let _ = hosted.run_processor_pass().await;
    served.map_err(|error| error.to_string())
}

/// Prints the accounts subscribed to product update emails as CSV, for an
/// email tool import. Reads `BILLING_DATABASE_PATH` only, and fails when that
/// file does not exist instead of creating an empty database.
fn email_updates() -> Result<(), String> {
    let path = std::env::var("BILLING_DATABASE_PATH")
        .map_err(|_| "BILLING_DATABASE_PATH is necessary".to_owned())?;
    let connection = billing::store::open_existing(Path::new(&path))
        .map_err(|error| format!("Suplex could not open the database at {path}: {error}"))?;
    accounts::store::apply_schema(&connection).map_err(|error| error.to_string())?;
    let csv =
        accounts::email_updates::export_csv(&connection).map_err(|error| error.to_string())?;
    print!("{csv}");
    Ok(())
}

/// `suplex hosted serve` or `suplex hosted email-updates`. Returns the process exit code.
pub async fn main(args: &[String]) -> i32 {
    let outcome = match args {
        [command] if command == "serve" => serve().await,
        [command] if command == "email-updates" => email_updates(),
        _ => Err("Usage: suplex hosted serve | suplex hosted email-updates".to_owned()),
    };
    match outcome {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}
