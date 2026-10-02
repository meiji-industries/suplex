//! `suplex-billing`: the hosted billing service.
//!
//! ```text
//! suplex-billing [serve]
//! suplex-billing rotate-credential --db <path> --account <accountId>
//! ```
//!
//! `serve` reads its configuration from `BILLING_*`, `STRIPE_*`, and
//! `REVENUECAT_*` environment variables (see `docs/billing.md`).
//! `rotate-credential` reads the new credential from
//! `NEW_BILLING_CREDENTIAL` and verifies ownership with `STRIPE_SECRET_KEY`.

#[tokio::main]
async fn main() -> std::process::ExitCode {
    suplex::billing::hosted::server::main(std::env::args().skip(1).collect()).await
}
