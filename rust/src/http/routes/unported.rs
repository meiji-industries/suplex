use crate::http::AppState;
#[cfg(test)]
use crate::http::error::ApiError;
use axum::Router;
#[cfg(test)]
use axum::{
    http::{HeaderMap, Method, StatusCode},
    response::Response,
};
#[cfg(test)]
use chrono::Utc;

#[cfg(test)]
use crate::http::session;

#[cfg(test)]
use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum Access {
    Authenticated,
    Administrator,
}

#[cfg(test)]
fn guarded(state: &AppState, headers: &HeaderMap, method: &Method, access: Access) -> Response {
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let session = match state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return ApiError::response(error),
    };
    let response = match session.user {
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Some(user) if matches!(access, Access::Administrator) && user.role != "admin" => {
            auth::error(StatusCode::FORBIDDEN, "Administrator access required")
        }
        Some(_) => auth::error(StatusCode::NOT_FOUND, "Not found"),
    };
    let mut response = response;
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
const ROUTES: &[(Method, &str, Access)] = &[];

#[cfg(test)]
include!("../../../tests/routes/unported.rs");
