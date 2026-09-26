pub mod artifacts;
pub mod backup;
pub mod config;
pub mod database;
pub mod development;
pub mod embedded;
pub mod environment_settings;
pub mod factory_reset;
pub mod health;
pub mod install;
pub mod log_viewer;
pub mod redaction;
pub mod setup;
pub mod supervisor;
pub mod system_event_transport;
pub mod system_events;
pub mod update;

use crate::shared::PublicFailure;

/// Platform refusals.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    /// TypeScript `ArtifactFailure`.
    #[error("{message}")]
    Artifact {
        code: &'static str,
        message: &'static str,
    },
    #[error("{}", factory_reset::LIVE_SESSIONS_BLOCK_RESET)]
    LiveSessionsBlockReset,
}

impl From<PlatformError> for PublicFailure {
    fn from(error: PlatformError) -> Self {
        let message = error.to_string();
        match error {
            PlatformError::Artifact { code, .. } => {
                PublicFailure::new(422, message).with_code(code)
            }
            PlatformError::LiveSessionsBlockReset => PublicFailure::new(409, message),
        }
    }
}
