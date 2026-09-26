use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::{MethodFilter, on},
};
use chrono::Utc;

use crate::http::{AppState, session};

use super::auth;

use Access::{Administrator, Authenticated};

// Routes the TypeScript backend registers that Rust has not ported yet. Keep
// this list explicit so an unknown path still receives the normal 404 response.
// WebSocket routes are plain GET handlers here: they answer 501 before any
// upgrade. `scripts/rust-route-coverage.ts` checks this list stays complete.
const ROUTES: &[(Method, &str, Access)] = &[];

pub fn router() -> Router<AppState> {
    ROUTES
        .iter()
        .fold(Router::new(), |router, (method, path, access)| {
            let filter = MethodFilter::try_from(method.clone()).expect("stub method");
            router.route(
                path,
                match access {
                    Authenticated => on(filter, authenticated),
                    Administrator => on(filter, administrator),
                },
            )
        })
}

#[derive(Clone, Copy)]
enum Access {
    Authenticated,
    Administrator,
}

async fn authenticated(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    guarded(&state, &headers, &method, Access::Authenticated)
}

async fn administrator(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    guarded(&state, &headers, &method, Access::Administrator)
}

fn guarded(state: &AppState, headers: &HeaderMap, method: &Method, access: Access) -> Response {
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let session = match state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return auth::service_error(error),
    };
    let response = match session.user {
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Some(user) if matches!(access, Access::Administrator) && user.role != "admin" => {
            auth::error(StatusCode::FORBIDDEN, "Administrator access required")
        }
        Some(_) => auth::not_ported(),
    };
    let mut response = response;
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
include!("../../../tests/routes/unported.rs");
