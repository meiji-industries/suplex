//! Turns a panic in a request handler into a 500 response, and reports it as
//! handled. The panic hook still sees the panic first; the scope below tells it
//! that this code catches it.

use std::{
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    task::{Context, Poll},
};

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use suplex_exception::HandledScope;

/// Marks the response of a request whose handler panicked, so the 500 report
/// does not count the same failure twice.
#[derive(Clone, Copy)]
pub(crate) struct PanicResponse;

struct Contained(Pin<Box<dyn Future<Output = Response> + Send>>);

impl Future for Contained {
    type Output = Response;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Response> {
        let _scope = HandledScope::enter();
        match catch_unwind(AssertUnwindSafe(|| self.0.as_mut().poll(context))) {
            Ok(poll) => poll,
            Err(_) => {
                let mut response = (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({"error": "Internal server error"})),
                )
                    .into_response();
                response.extensions_mut().insert(PanicResponse);
                Poll::Ready(response)
            }
        }
    }
}

pub(crate) async fn contain(request: Request, next: Next) -> Response {
    Contained(Box::pin(next.run(request))).await
}

/// Reports a 500 response with its route template. Panics are not counted twice.
pub(crate) fn report_if_internal_error(method: &str, route: Option<&str>, response: &Response) {
    if response.status() == StatusCode::INTERNAL_SERVER_ERROR
        && response.extensions().get::<PanicResponse>().is_none()
    {
        crate::telemetry::exceptions::report_internal_error(method, route.unwrap_or("unmatched"));
    }
}

/// For routers without the host's request logging: reports 500 responses.
pub(crate) async fn report_internal_errors(request: Request, next: Next) -> Response {
    let method = request.method().to_string();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|matched| matched.as_str().to_owned());
    let response = next.run(request).await;
    report_if_internal_error(&method, route.as_deref(), &response);
    response
}
