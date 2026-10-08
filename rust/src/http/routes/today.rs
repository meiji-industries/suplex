use std::error::Error;

use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Duration, Utc};

use crate::{
    http::{AppState, access, error::ApiError},
    tasks::{TaskError, today_repository},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/today", get(today))
}

fn parse_range(
    raw: Option<&str>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), Box<dyn Error + Send + Sync>> {
    let mut start = None;
    let mut end = None;
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        let target = match key.as_ref() {
            "weekStartsAt" => &mut start,
            "weekEndsAt" => &mut end,
            _ => return Err(TaskError::new("Week range is invalid", 400).into()),
        };
        if target.replace(value.into_owned()).is_some() {
            return Err(TaskError::new("Week range is invalid", 400).into());
        }
    }
    let start = DateTime::parse_from_rfc3339(
        start
            .as_deref()
            .ok_or_else(|| TaskError::new("Week range is invalid", 400))?,
    )
    .map_err(|_| TaskError::new("Week range is invalid", 400))?
    .with_timezone(&Utc);
    let end = DateTime::parse_from_rfc3339(
        end.as_deref()
            .ok_or_else(|| TaskError::new("Week range is invalid", 400))?,
    )
    .map_err(|_| TaskError::new("Week range is invalid", 400))?
    .with_timezone(&Utc);
    let duration = end - start;
    if duration < Duration::days(6) || duration > Duration::days(8) {
        return Err(TaskError::new("Week range is invalid", 400).into());
    }
    Ok((start, end))
}

async fn today(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let (user, cookies) = match access::authenticated(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let range = parse_range(raw_query.as_deref());
    let result = range.and_then(|(start, end)| {
        state.with_database(|database| {
            today_repository::read(database, &user.id, start, end, Utc::now())
        })
    });
    let mut response = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError::response(error),
    };
    response.headers_mut().insert(
        CACHE_CONTROL,
        "private, no-store".parse().expect("cache header"),
    );
    auth::append_cookies(&mut response, cookies);
    response
}

#[cfg(test)]
include!("../../../tests/routes/today.rs");
