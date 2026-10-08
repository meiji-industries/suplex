use crate::shared::PublicFailure;
use axum::response::{IntoResponse, Response};
use std::error::Error;

#[derive(Debug)]
pub struct ApiError(pub PublicFailure);

impl From<Box<dyn Error + Send + Sync>> for ApiError {
    fn from(error: Box<dyn Error + Send + Sync>) -> Self {
        Self(public_failure(error))
    }
}
impl From<PublicFailure> for ApiError {
    fn from(failure: PublicFailure) -> Self {
        Self(failure)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        self.0.into_response()
    }
}
impl ApiError {
    pub fn response(error: Box<dyn Error + Send + Sync>) -> Response {
        Self::from(error).into_response()
    }
}

pub use crate::shared::public_failure;
