pub mod agent_delivery;
pub mod completed_pull_requests;
pub mod inspection;
pub mod issue_evidence;
pub mod operations;
#[cfg(test)]
mod tests;

/// Delivery refusals. They reach the Coordinator as tool text.
#[derive(Debug, Eq, PartialEq, thiserror::Error)]
pub enum DeliveryError {
    /// A refused delivery operation with its stable code.
    #[error("{message}")]
    Operation { code: &'static str, message: String },
    /// A delivery invariant failed.
    #[error("{0}")]
    Internal(String),
}

impl DeliveryError {
    pub fn operation(code: &'static str, message: impl Into<String>) -> Self {
        Self::Operation {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Operation { code, .. } => Some(code),
            Self::Internal(_) => None,
        }
    }

    /// The operation code of `error`, when it is a delivery refusal.
    pub fn code_of(error: &(dyn std::error::Error + 'static)) -> Option<&'static str> {
        error.downcast_ref::<Self>().and_then(Self::code)
    }
}
