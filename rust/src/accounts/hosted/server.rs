//! Account routes. `/v1/auth/*` is the private host's JSON API; `/auth/*`
//! is what the browser visits.

use axum::{
    Form, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::Value;

use super::{Accounts, visitor_cookie};
use crate::{
    accounts::wire::{
        AuthAttemptBody, AuthAttemptResponse, AuthEmailBody, AuthPollBody, AuthProvider,
        LoginClient, token_shape,
    },
    billing::hosted::{HostedError, HostedResult, server::JsonBody},
    shared::page,
};

const BODY_LIMIT: usize = 64 * 1024;
const DONE_PAGE: &str = include_str!("done.html");

fn to_json<T: serde::Serialize>(value: &T) -> Json<Value> {
    Json(serde_json::to_value(value).unwrap_or(Value::Null))
}

fn parse<T: for<'de> Deserialize<'de>>(body: Value) -> HostedResult<T> {
    serde_json::from_value(body).map_err(|_| HostedError::new(400, None, "Invalid request"))
}

/// Browser routes answer with a page, never with JSON.
fn page(result: HostedResult<Response>) -> Response {
    result.unwrap_or_else(|error| {
        let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST);
        let body = if error.has_code("email_unverified") {
            page::render(
                "Email address is not verified",
                "<p>The provider did not report a verified email address. Verify the address with the provider, then retry in Suplex.</p>",
            )
        } else {
            page::render(
                "Login is not complete",
                "<p>Suplex could not complete the login. Return to Suplex and retry.</p>",
            )
        };
        (status, Html(body)).into_response()
    })
}

/// The done page opens the desktop app unless the login started in a web
/// browser.
fn done(client: LoginClient) -> Response {
    Redirect::to(match client {
        LoginClient::Desktop => "/auth/done",
        LoginClient::Web => "/auth/done?client=web",
    })
    .into_response()
}

async fn create_attempt(
    State(accounts): State<Accounts>,
    JsonBody(body): JsonBody,
) -> HostedResult<Json<Value>> {
    let attempt_id = accounts.create_attempt(&parse::<AuthAttemptBody>(body)?)?;
    Ok(to_json(&AuthAttemptResponse { attempt_id }))
}

async fn poll(
    State(accounts): State<Accounts>,
    Path(attempt_id): Path<String>,
    JsonBody(body): JsonBody,
) -> HostedResult<Json<Value>> {
    let response = accounts.poll(&attempt_id, &parse::<AuthPollBody>(body)?)?;
    Ok(to_json(&response))
}

async fn send_email(
    State(accounts): State<Accounts>,
    JsonBody(body): JsonBody,
) -> HostedResult<StatusCode> {
    accounts
        .send_magic_link(&parse::<AuthEmailBody>(body)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn logout(State(accounts): State<Accounts>, headers: HeaderMap) -> HostedResult<StatusCode> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    accounts.logout(authorization)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct StartQuery {
    attempt: Option<String>,
    provider: Option<String>,
}

async fn start(State(accounts): State<Accounts>, Query(query): Query<StartQuery>) -> Response {
    let (Some(attempt), Some(provider)) = (
        query.attempt,
        query.provider.as_deref().and_then(AuthProvider::parse),
    ) else {
        return page(Err(super::invalid()));
    };
    page(
        accounts
            .start_oauth(&attempt, provider)
            .map(|url| Redirect::to(&url).into_response()),
    )
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

async fn callback(
    State(accounts): State<Accounts>,
    Path(provider): Path<String>,
    Query(query): Query<CallbackQuery>,
    headers: HeaderMap,
) -> Response {
    let (Some(provider), Some(code), Some(state)) =
        (AuthProvider::parse(&provider), query.code, query.state)
    else {
        return page(Err(super::invalid()));
    };
    let finished = accounts
        .finish_oauth(provider, &code, &state, visitor_cookie(&headers))
        .await;
    page(finished.map(done))
}

#[derive(Deserialize)]
struct TokenForm {
    token: Option<String>,
}

async fn verify_form(Query(query): Query<TokenForm>) -> Response {
    match query.token {
        // The token is inserted only after `token_shape` accepts it. A GET never
        // consumes the link: mail scanners fetch links before people open them.
        Some(token) if token_shape(&token) => Html(page::render(
            "Log in to Suplex",
            &format!("<p>Select Continue to log in.</p><form class=\"actions\" method=\"post\" action=\"/auth/email/verify\"><input type=\"hidden\" name=\"token\" value=\"{token}\"><button class=\"primary\" type=\"submit\">Continue</button></form>"),
        ))
        .into_response(),
        _ => page(Err(super::expired())),
    }
}

async fn verify(
    State(accounts): State<Accounts>,
    headers: HeaderMap,
    Form(form): Form<TokenForm>,
) -> Response {
    let token = form.token.unwrap_or_default();
    page(
        accounts
            .verify_magic_link(&token, visitor_cookie(&headers))
            .map(done),
    )
}

async fn done_page() -> Html<&'static str> {
    Html(DONE_PAGE)
}

async fn require_enabled(
    State(accounts): State<Accounts>,
    request: Request,
    next: Next,
) -> Response {
    match accounts.config() {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

async fn private(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

pub fn router(accounts: Accounts) -> Router {
    Router::new()
        .merge(super::invitations::router())
        .route("/v1/auth/attempts", post(create_attempt))
        .route("/v1/auth/attempts/{id}/poll", post(poll))
        .route("/v1/auth/email", post(send_email))
        .route("/v1/auth/logout", post(logout))
        .route("/auth/start", get(start))
        .route("/auth/callback/{provider}", get(callback))
        .route("/auth/email/verify", get(verify_form).post(verify))
        .route_layer(middleware::from_fn_with_state(
            accounts.clone(),
            require_enabled,
        ))
        .route("/auth/done", get(done_page))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::map_response(private))
        .with_state(accounts)
}

#[cfg(test)]
include!("../../../tests/accounts/hosted.rs");
