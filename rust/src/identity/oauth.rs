//! OAuth 2.1 authorization server for the remote MCP resource.

use std::{error::Error, fmt};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use getrandom::fill as rand_bytes;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::platform::database::{DatabaseResult, SuplexDatabase};

use super::{
    auth::{self, hash_secret, js_trim, random_hex_id},
    companies,
    external_agents::{self, ExternalAgentFailure, OAuthAgentInput, Principal},
};

pub const SCOPE: &str = "suplex:mcp";
const AUTHORIZATION_TTL_MINUTES: i64 = 10;
const CODE_TTL_MINUTES: i64 = 5;
const ACCESS_TOKEN_TTL_SECONDS: i64 = 60 * 60;
const REFRESH_TOKEN_TTL_DAYS: i64 = 30;
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

#[derive(Debug, Clone)]
pub struct OAuthFailure {
    pub error: &'static str,
    pub public_message: String,
    pub status_code: u16,
    pub redirect_uri: Option<String>,
    pub state: Option<String>,
}

impl OAuthFailure {
    pub fn new(error: &'static str, public_message: &str, status_code: u16) -> Self {
        Self {
            error,
            public_message: public_message.to_owned(),
            status_code,
            redirect_uri: None,
            state: None,
        }
    }

    fn boxed(error: &'static str, public_message: &str, status_code: u16) -> Box<dyn Error> {
        Box::new(Self::new(error, public_message, status_code))
    }

    /// Mirrors `oauthFailureFromExternal`: other domain failures become a safe server error.
    pub fn from_error(error: &(dyn Error + 'static)) -> Self {
        if let Some(failure) = error.downcast_ref::<OAuthFailure>() {
            return failure.clone();
        }
        if let Some(failure) = error.downcast_ref::<ExternalAgentFailure>() {
            return Self::new(
                "access_denied",
                &failure.public_message,
                failure.status_code,
            );
        }
        Self::new("server_error", "OAuth request failed", 500)
    }
}

impl fmt::Display for OAuthFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.public_message)
    }
}

impl Error for OAuthFailure {}

#[derive(Debug, Clone)]
pub struct OAuth {
    pub issuer: String,
    pub resource: String,
    pub available: bool,
}

pub struct ClientMetadata {
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub grant_types: Option<Vec<String>>,
    pub response_types: Option<Vec<String>>,
    pub token_endpoint_auth_method: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_id_issued_at: i64,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub grant_types: Vec<String>,
    pub response_types: Vec<String>,
    pub token_endpoint_auth_method: &'static str,
}

pub struct AuthorizationRequest<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub response_type: &'a str,
    pub state: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub resource: &'a str,
    pub code_challenge: &'a str,
    pub code_challenge_method: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    pub request_id: String,
    pub client_name: String,
    pub redirect_uri: String,
    pub redirect_origin: String,
    pub scope: String,
    pub companies: Vec<Value>,
}

#[derive(Debug, Serialize)]
pub struct Tokens {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub refresh_token: String,
    pub scope: &'static str,
}

pub struct CodeExchange<'a> {
    pub code: &'a str,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub resource: &'a str,
    pub verifier: &'a str,
}

pub struct Refresh<'a> {
    pub refresh_token: &'a str,
    pub client_id: &'a str,
    pub resource: &'a str,
    pub scope: Option<&'a str>,
}

struct Pending {
    id: String,
    client_id: String,
    redirect_uri: String,
    state: Option<String>,
    scope: String,
    resource: String,
    code_challenge: String,
    expires_at: String,
    consumed_at: Option<String>,
    client_name: String,
}

struct Grant {
    client_id: String,
    user_id: String,
    company_id: String,
    agent_id: String,
    resource: String,
    cursor_key: String,
    revoked_at: Option<String>,
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date.parse(value) <= now`; an unparsable value is never expired, as in JavaScript.
fn expired(value: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|value| value <= now)
}

fn raw_secret(prefix: &str) -> DatabaseResult<String> {
    let mut bytes = [0_u8; 32];
    rand_bytes(&mut bytes)?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_loopback_http(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url
            .host_str()
            .is_some_and(|host| LOOPBACK_HOSTS.contains(&host))
}

fn valid_redirect_uri(value: &str) -> bool {
    if utf16_len(value) > 2_048 || value.contains('*') {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.fragment().is_some_and(|fragment| !fragment.is_empty())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    url.scheme() == "https" || is_loopback_http(&url)
}

/// `URLSearchParams.set` for each pair, then serialize like `URL.toString()`.
pub(crate) fn with_params(base: &str, values: &[(&str, &str)]) -> String {
    let Ok(mut url) = url::Url::parse(base) else {
        return base.to_owned();
    };
    let mut pairs = url
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    for (name, value) in values {
        match pairs.iter().position(|(existing, _)| existing == name) {
            Some(index) => {
                pairs[index].1 = (*value).to_owned();
                let mut seen = 0;
                pairs.retain(|(existing, _)| {
                    if existing != name {
                        return true;
                    }
                    seen += 1;
                    seen == 1
                });
            }
            None => pairs.push(((*name).to_owned(), (*value).to_owned())),
        }
    }
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(pairs);
    url.to_string()
}

fn pending_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Pending> {
    Ok(Pending {
        id: row.get("id")?,
        client_id: row.get("client_id")?,
        redirect_uri: row.get("redirect_uri")?,
        state: row.get("state")?,
        scope: row.get("scope")?,
        resource: row.get("resource")?,
        code_challenge: row.get("code_challenge")?,
        expires_at: row.get("expires_at")?,
        consumed_at: row.get("consumed_at")?,
        client_name: row.get("client_name")?,
    })
}

fn read_pending(database: &SuplexDatabase, request_id: &str) -> DatabaseResult<Option<Pending>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT p.*, c.client_name FROM suplex_oauth_pending_authorizations p JOIN suplex_oauth_clients c ON c.id = p.client_id WHERE p.id = ?1",
            [request_id],
            pending_row,
        )
        .optional()?)
}

fn grant_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Grant> {
    Ok(Grant {
        client_id: row.get("client_id")?,
        user_id: row.get("user_id")?,
        company_id: row.get("company_id")?,
        agent_id: row.get("agent_id")?,
        resource: row.get("resource")?,
        cursor_key: row.get("cursor_key")?,
        revoked_at: row.get("revoked_at")?,
    })
}

fn string_array(raw: &str) -> DatabaseResult<Vec<String>> {
    Ok(serde_json::from_str(raw)?)
}

impl OAuth {
    pub fn new(reachable_address: &str) -> Self {
        let canonical = url::Url::parse(reachable_address).expect("reachable address is a URL");
        let issuer = canonical.origin().ascii_serialization();
        Self {
            resource: format!("{issuer}/mcp"),
            available: canonical.scheme() == "https" || is_loopback_http(&canonical),
            issuer,
        }
    }

    fn require_available(&self) -> DatabaseResult<()> {
        if self.available {
            Ok(())
        } else {
            Err(OAuthFailure::boxed(
                "invalid_request",
                "Suplex OAuth requires an HTTPS reachable address",
                400,
            ))
        }
    }

    pub fn register_client(
        &self,
        database: &mut SuplexDatabase,
        metadata: ClientMetadata,
        now: DateTime<Utc>,
    ) -> DatabaseResult<RegisteredClient> {
        self.require_available()?;
        let name = js_trim(&metadata.client_name).to_owned();
        let grant_types = metadata
            .grant_types
            .unwrap_or_else(|| vec!["authorization_code".into(), "refresh_token".into()]);
        let response_types = metadata
            .response_types
            .unwrap_or_else(|| vec!["code".into()]);
        let method = metadata
            .token_endpoint_auth_method
            .unwrap_or_else(|| "none".into());
        let redirects = metadata.redirect_uris;
        if name.is_empty()
            || utf16_len(&name) > 120
            || redirects.is_empty()
            || redirects.len() > 10
            || redirects.iter().any(|uri| !valid_redirect_uri(uri))
            || grant_types
                .iter()
                .any(|value| value != "authorization_code" && value != "refresh_token")
            || response_types != ["code"]
            || method != "none"
        {
            return Err(OAuthFailure::boxed(
                "invalid_client_metadata",
                "Client metadata is invalid",
                400,
            ));
        }
        let mut unique = Vec::new();
        for uri in redirects {
            if !unique.contains(&uri) {
                unique.push(uri);
            }
        }
        let client_id = random_hex_id("oauth_client")?;
        let now_iso = timestamp(now);
        database.transaction(false, |database| {
            database.connection().execute(
                "DELETE FROM suplex_oauth_clients WHERE created_at < ?1 AND NOT EXISTS (SELECT 1 FROM suplex_oauth_grants g WHERE g.client_id = suplex_oauth_clients.id) AND NOT EXISTS (SELECT 1 FROM suplex_oauth_pending_authorizations p WHERE p.client_id = suplex_oauth_clients.id AND p.expires_at > ?2)",
                params![timestamp(now - Duration::hours(24)), now_iso],
            )?;
            let count: i64 = database.connection().query_row("SELECT COUNT(*) FROM suplex_oauth_clients", [], |row| row.get(0))?;
            if count >= 1_000 {
                return Err(OAuthFailure::boxed("temporarily_unavailable", "Client registration limit reached", 429));
            }
            database.connection().execute(
                "INSERT INTO suplex_oauth_clients (id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'none', ?6, ?6)",
                params![client_id, name, json!(unique).to_string(), json!(grant_types).to_string(), json!(response_types).to_string(), now_iso],
            )?;
            Ok(())
        })?;
        Ok(RegisteredClient {
            client_id,
            client_id_issued_at: now.timestamp(),
            client_name: name,
            redirect_uris: unique,
            grant_types,
            response_types,
            token_endpoint_auth_method: "none",
        })
    }

    pub fn begin_authorization(
        &self,
        database: &mut SuplexDatabase,
        input: AuthorizationRequest<'_>,
        now: DateTime<Utc>,
    ) -> DatabaseResult<String> {
        self.require_available()?;
        let invalid =
            || OAuthFailure::boxed("invalid_request", "Authorization request is invalid", 400);
        if !(1..=128).contains(&utf16_len(input.client_id))
            || !(1..=2_048).contains(&utf16_len(input.redirect_uri))
        {
            return Err(invalid());
        }
        let client: Option<(String, String)> = database
            .connection()
            .query_row(
                "SELECT id, redirect_uris_json FROM suplex_oauth_clients WHERE id = ?1",
                [input.client_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let client_id = match client {
            Some((id, redirects))
                if string_array(&redirects)?
                    .iter()
                    .any(|uri| uri == input.redirect_uri) =>
            {
                id
            }
            _ => {
                return Err(OAuthFailure::boxed(
                    "invalid_request",
                    "Client or redirect URI is invalid",
                    400,
                ));
            }
        };
        let redirected = |error: &'static str, message: &str, status: u16| -> Box<dyn Error> {
            Box::new(OAuthFailure {
                error,
                public_message: message.to_owned(),
                status_code: status,
                redirect_uri: Some(input.redirect_uri.to_owned()),
                state: input.state.map(str::to_owned),
            })
        };
        if input.response_type != "code" {
            return Err(redirected(
                "unsupported_response_type",
                "Response type is not supported",
                400,
            ));
        }
        let challenge_valid = input.code_challenge.len() == 43
            && input
                .code_challenge
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
        if input.state.is_some_and(|state| utf16_len(state) > 2_048)
            || input.scope != Some(SCOPE)
            || input.resource != self.resource
            || input.code_challenge_method != "S256"
            || !challenge_valid
        {
            return Err(redirected(
                "invalid_request",
                "Authorization request is invalid",
                400,
            ));
        }
        let request_id = random_hex_id("oauth_request")?;
        let now_iso = timestamp(now);
        database.transaction(true, |database| {
            database.connection().execute(
                "DELETE FROM suplex_oauth_pending_authorizations WHERE expires_at <= ?1",
                [&now_iso],
            )?;
            let pending: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_oauth_pending_authorizations WHERE client_id = ?1 AND consumed_at IS NULL",
                [&client_id],
                |row| row.get(0),
            )?;
            if pending >= 20 {
                return Err(redirected("temporarily_unavailable", "Too many pending authorization requests", 429));
            }
            database.connection().execute(
                "INSERT INTO suplex_oauth_pending_authorizations (id, client_id, redirect_uri, state, scope, resource, code_challenge, code_challenge_method, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'S256', ?8, ?9)",
                params![request_id, client_id, input.redirect_uri, input.state, SCOPE, self.resource, input.code_challenge, timestamp(now + Duration::minutes(AUTHORIZATION_TTL_MINUTES)), now_iso],
            )?;
            Ok(())
        })?;
        Ok(request_id)
    }

    fn live_pending(
        database: &SuplexDatabase,
        request_id: &str,
        now: DateTime<Utc>,
    ) -> DatabaseResult<Pending> {
        match read_pending(database, request_id)? {
            Some(pending)
                if pending.consumed_at.is_none() && !expired(&pending.expires_at, now) =>
            {
                Ok(pending)
            }
            _ => Err(OAuthFailure::boxed(
                "invalid_request",
                "Authorization request expired",
                400,
            )),
        }
    }

    pub fn read_consent(
        &self,
        database: &SuplexDatabase,
        user_id: &str,
        request_id: &str,
        now: DateTime<Utc>,
    ) -> DatabaseResult<Consent> {
        if !(1..=128).contains(&utf16_len(request_id)) {
            return Err(OAuthFailure::boxed(
                "invalid_request",
                "Authorization request is invalid",
                400,
            ));
        }
        let pending = Self::live_pending(database, request_id, now)?;
        if auth::public_user(database, user_id)?.is_none_or(|user| user.status != "active") {
            return Err(OAuthFailure::boxed(
                "access_denied",
                "Authentication is necessary",
                401,
            ));
        }
        let companies = companies::list_visible_companies(database, user_id)?
            .into_iter()
            .map(|company| json!({"id": company.id, "name": company.name}))
            .collect();
        let redirect_origin = url::Url::parse(&pending.redirect_uri)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_default();
        Ok(Consent {
            request_id: request_id.to_owned(),
            client_name: pending.client_name,
            redirect_uri: pending.redirect_uri,
            redirect_origin,
            scope: pending.scope,
            companies,
        })
    }

    pub fn approve(
        &self,
        database: &mut SuplexDatabase,
        user_id: &str,
        request_id: &str,
        company_id: &str,
        project_ids: &[String],
        now: DateTime<Utc>,
    ) -> DatabaseResult<String> {
        let raw_code = raw_secret("foc")?;
        let now_iso = timestamp(now);
        let (redirect_uri, state) = database.transaction(true, |database| {
            let pending = Self::live_pending(database, request_id, now)?;
            if !auth::public_user(database, user_id)?.is_some_and(|user| user.status == "active" && user.role == "admin") {
                return Err(OAuthFailure::boxed("access_denied", "Administrator access is necessary", 403));
            }
            companies::require_company_access(database, user_id, company_id)?;
            let existing: Option<(String, String)> = database
                .connection()
                .query_row(
                    "SELECT id, agent_id FROM suplex_oauth_grants WHERE client_id = ?1 AND user_id = ?2 AND company_id = ?3",
                    params![pending.client_id, user_id, company_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let grant_id = if let Some((grant_id, agent_id)) = existing {
                let connection = database.connection();
                connection.execute("UPDATE suplex_oauth_token_families SET revoked_at = COALESCE(revoked_at, ?1) WHERE grant_id = ?2", params![now_iso, grant_id])?;
                connection.execute("UPDATE suplex_oauth_access_tokens SET revoked_at = COALESCE(revoked_at, ?1) WHERE family_id IN (SELECT id FROM suplex_oauth_token_families WHERE grant_id = ?2)", params![now_iso, grant_id])?;
                connection.execute("UPDATE suplex_oauth_authorization_codes SET consumed_at = COALESCE(consumed_at, ?1) WHERE grant_id = ?2", params![now_iso, grant_id])?;
                if connection.execute("UPDATE suplex_external_agents SET status = 'paired', revoked_at = NULL, paired_at = COALESCE(paired_at, ?1), updated_at = ?1 WHERE id = ?2 AND company_id = ?3", params![now_iso, agent_id, company_id])? != 1 {
                    return Err(OAuthFailure::boxed("access_denied", "Connection is not available", 403));
                }
                connection.execute("DELETE FROM suplex_external_agent_project_grants WHERE agent_id = ?1", [&agent_id])?;
                let mut unique = project_ids.to_vec();
                unique.sort();
                unique.dedup();
                for project_id in unique {
                    if connection.execute("INSERT INTO suplex_external_agent_project_grants (agent_id, company_id, project_id, created_at) SELECT ?1, ?2, id, ?3 FROM suplex_projects WHERE id = ?4 AND company_id = ?2", params![agent_id, company_id, now_iso, project_id])? != 1 {
                        return Err(OAuthFailure::boxed("invalid_request", "Project selection is invalid", 400));
                    }
                }
                if project_ids.is_empty() {
                    return Err(OAuthFailure::boxed("invalid_request", "Select at least one project", 400));
                }
                connection.execute("UPDATE suplex_oauth_grants SET scope = ?1, resource = ?2, revoked_at = NULL, updated_at = ?3 WHERE id = ?4", params![SCOPE, self.resource, now_iso, grant_id])?;
                grant_id
            } else {
                let grant_id = random_hex_id("oauth_grant")?;
                let mut key = [0_u8; 32];
                rand_bytes(&mut key)?;
                let cursor_key = URL_SAFE_NO_PAD.encode(key);
                let principal = external_agents::provision_oauth_agent(
                    database,
                    OAuthAgentInput {
                        actor_user_id: user_id,
                        client_id: &pending.client_id,
                        client_name: &pending.client_name,
                        company_id,
                        project_ids,
                        cursor_key: &cursor_key,
                    },
                    now,
                )?;
                database.connection().execute(
                    "INSERT INTO suplex_oauth_grants (id, client_id, user_id, company_id, agent_id, scope, resource, cursor_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![grant_id, pending.client_id, user_id, company_id, principal.agent_id, SCOPE, self.resource, cursor_key, now_iso],
                )?;
                grant_id
            };
            if database.connection().execute(
                "UPDATE suplex_oauth_pending_authorizations SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL",
                params![now_iso, pending.id],
            )? != 1
            {
                return Err(OAuthFailure::boxed("invalid_request", "Authorization request was already used", 400));
            }
            database.connection().execute(
                "INSERT INTO suplex_oauth_authorization_codes (id, grant_id, code_hash, redirect_uri, resource, code_challenge, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![random_hex_id("oauth_code")?, grant_id, hash_secret(&raw_code), pending.redirect_uri, pending.resource, pending.code_challenge, timestamp(now + Duration::minutes(CODE_TTL_MINUTES)), now_iso],
            )?;
            Ok((pending.redirect_uri, pending.state))
        })?;
        let mut values = vec![("code", raw_code.as_str()), ("iss", self.issuer.as_str())];
        if let Some(state) = &state {
            values.push(("state", state));
        }
        Ok(with_params(&redirect_uri, &values))
    }

    pub fn deny(
        &self,
        database: &mut SuplexDatabase,
        user_id: &str,
        request_id: &str,
        now: DateTime<Utc>,
    ) -> DatabaseResult<String> {
        let now_iso = timestamp(now);
        let pending = database.transaction(true, |database| {
            let pending = Self::live_pending(database, request_id, now)?;
            if auth::public_user(database, user_id)?.is_none_or(|user| user.status != "active") {
                return Err(OAuthFailure::boxed("access_denied", "Authentication is necessary", 401));
            }
            if database.connection().execute(
                "UPDATE suplex_oauth_pending_authorizations SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL",
                params![now_iso, request_id],
            )? != 1
            {
                return Err(OAuthFailure::boxed("invalid_request", "Authorization request was already used", 400));
            }
            Ok(pending)
        })?;
        let mut values = vec![("error", "access_denied"), ("iss", self.issuer.as_str())];
        if let Some(state) = &pending.state {
            values.push(("state", state));
        }
        Ok(with_params(&pending.redirect_uri, &values))
    }

    /// The approving administrator, their company access, and the agent must all still be live.
    fn assert_grant_authority(database: &SuplexDatabase, grant: &Grant) -> DatabaseResult<()> {
        let inactive =
            || OAuthFailure::boxed("invalid_grant", "Authorization is no longer active", 400);
        let admin = auth::public_user(database, &grant.user_id)?
            .is_some_and(|user| user.status == "active" && user.role == "admin");
        if !admin
            || companies::require_company_access(database, &grant.user_id, &grant.company_id)
                .is_err()
            || !external_agents::oauth_agent_active(database, &grant.agent_id).unwrap_or(false)
        {
            return Err(inactive());
        }
        Ok(())
    }

    fn insert_tokens(
        database: &SuplexDatabase,
        family_id: &str,
        access_token: &str,
        refresh_token: &str,
        generation: i64,
        now: DateTime<Utc>,
    ) -> DatabaseResult<()> {
        let now_iso = timestamp(now);
        database.connection().execute(
            "INSERT INTO suplex_oauth_access_tokens (id, family_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![random_hex_id("oauth_access")?, family_id, hash_secret(access_token), timestamp(now + Duration::seconds(ACCESS_TOKEN_TTL_SECONDS)), now_iso],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_oauth_refresh_tokens (id, family_id, token_hash, generation, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![random_hex_id("oauth_refresh")?, family_id, hash_secret(refresh_token), generation, timestamp(now + Duration::days(REFRESH_TOKEN_TTL_DAYS)), now_iso],
        )?;
        Ok(())
    }

    fn tokens(access_token: String, refresh_token: String) -> Tokens {
        Tokens {
            access_token,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token,
            scope: SCOPE,
        }
    }

    pub fn exchange_code(
        &self,
        database: &mut SuplexDatabase,
        input: CodeExchange<'_>,
        now: DateTime<Utc>,
    ) -> DatabaseResult<Tokens> {
        let invalid = || OAuthFailure::boxed("invalid_grant", "Authorization code is invalid", 400);
        let verifier_valid = (43..=128).contains(&input.verifier.len())
            && input.verifier.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-')
            });
        if !verifier_valid {
            return Err(invalid());
        }
        let access_token = raw_secret("foa")?;
        let refresh_token = raw_secret("for")?;
        database.transaction(true, |database| {
            let row = database
                .connection()
                .query_row(
                    "SELECT c.id AS code_id, c.redirect_uri AS code_redirect_uri, c.code_challenge, c.expires_at, c.consumed_at, g.* FROM suplex_oauth_authorization_codes c JOIN suplex_oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = ?1",
                    [hash_secret(input.code)],
                    |row| Ok((grant_row(row)?, row.get::<_, String>("code_id")?, row.get::<_, String>("code_redirect_uri")?, row.get::<_, String>("code_challenge")?, row.get::<_, String>("expires_at")?, row.get::<_, Option<String>>("consumed_at")?, row.get::<_, String>("id")?)),
                )
                .optional()?;
            let Some((grant, code_id, redirect_uri, challenge, expires_at, consumed_at, grant_id)) = row else {
                return Err(invalid());
            };
            if consumed_at.is_some()
                || grant.revoked_at.is_some()
                || expired(&expires_at, now)
                || grant.client_id != input.client_id
                || redirect_uri != input.redirect_uri
                || grant.resource != input.resource
                || input.resource != self.resource
                || pkce_challenge(input.verifier) != challenge
            {
                return Err(invalid());
            }
            Self::assert_grant_authority(database, &grant)?;
            if database.connection().execute(
                "UPDATE suplex_oauth_authorization_codes SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL",
                params![timestamp(now), code_id],
            )? != 1
            {
                return Err(invalid());
            }
            let family_id = random_hex_id("oauth_family")?;
            database.connection().execute(
                "INSERT INTO suplex_oauth_token_families (id, grant_id, client_id, resource, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![family_id, grant_id, grant.client_id, grant.resource, timestamp(now)],
            )?;
            Self::insert_tokens(database, &family_id, &access_token, &refresh_token, 0, now)
        })?;
        Ok(Self::tokens(access_token, refresh_token))
    }

    pub fn refresh(
        &self,
        database: &mut SuplexDatabase,
        input: Refresh<'_>,
        now: DateTime<Utc>,
    ) -> DatabaseResult<Tokens> {
        if input.scope.is_some_and(|scope| scope != SCOPE) {
            return Err(OAuthFailure::boxed(
                "invalid_scope",
                "Requested scope is not available",
                400,
            ));
        }
        let access_token = raw_secret("foa")?;
        let refresh_token = raw_secret("for")?;
        let now_iso = timestamp(now);
        // A reused refresh token revokes its family and commits that revocation before failing.
        let issued = database.transaction(true, |database| {
            let row = database
                .connection()
                .query_row(
                    "SELECT r.id AS refresh_id, r.generation, r.expires_at, r.consumed_at, f.id AS family_id, f.revoked_at AS family_revoked_at, g.* FROM suplex_oauth_refresh_tokens r JOIN suplex_oauth_token_families f ON f.id = r.family_id JOIN suplex_oauth_grants g ON g.id = f.grant_id WHERE r.token_hash = ?1",
                    [hash_secret(input.refresh_token)],
                    |row| Ok((grant_row(row)?, row.get::<_, String>("refresh_id")?, row.get::<_, i64>("generation")?, row.get::<_, String>("expires_at")?, row.get::<_, Option<String>>("consumed_at")?, row.get::<_, String>("family_id")?, row.get::<_, Option<String>>("family_revoked_at")?)),
                )
                .optional()?;
            let Some((grant, refresh_id, generation, expires_at, consumed_at, family_id, family_revoked_at)) = row else {
                return Ok(false);
            };
            if family_revoked_at.is_some()
                || grant.revoked_at.is_some()
                || grant.client_id != input.client_id
                || grant.resource != input.resource
                || input.resource != self.resource
                || expired(&expires_at, now)
            {
                return Ok(false);
            }
            if consumed_at.is_some() {
                database.connection().execute(
                    "UPDATE suplex_oauth_token_families SET revoked_at = ?1, reuse_detected_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
                    params![now_iso, family_id],
                )?;
                database.connection().execute(
                    "UPDATE suplex_oauth_access_tokens SET revoked_at = ?1 WHERE family_id = ?2 AND revoked_at IS NULL",
                    params![now_iso, family_id],
                )?;
                return Ok(false);
            }
            Self::assert_grant_authority(database, &grant)?;
            if database.connection().execute(
                "UPDATE suplex_oauth_refresh_tokens SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL",
                params![now_iso, refresh_id],
            )? != 1
            {
                return Ok(false);
            }
            Self::insert_tokens(database, &family_id, &access_token, &refresh_token, generation + 1, now)?;
            Ok(true)
        })?;
        if !issued {
            return Err(OAuthFailure::boxed(
                "invalid_grant",
                "Refresh token is invalid",
                400,
            ));
        }
        Ok(Self::tokens(access_token, refresh_token))
    }

    pub fn authenticate_access_token(
        &self,
        database: &mut SuplexDatabase,
        raw_token: &str,
        now: DateTime<Utc>,
    ) -> DatabaseResult<Principal> {
        let grant = database.transaction(true, |database| {
            let row = database
                .connection()
                .query_row(
                    "SELECT a.id AS token_id, a.expires_at, f.revoked_at AS family_revoked_at, g.* FROM suplex_oauth_access_tokens a JOIN suplex_oauth_token_families f ON f.id = a.family_id JOIN suplex_oauth_grants g ON g.id = f.grant_id WHERE a.token_hash = ?1 AND a.revoked_at IS NULL",
                    [hash_secret(raw_token)],
                    |row| Ok((grant_row(row)?, row.get::<_, String>("token_id")?, row.get::<_, String>("expires_at")?, row.get::<_, Option<String>>("family_revoked_at")?)),
                )
                .optional()?;
            let invalid = || OAuthFailure::boxed("invalid_token", "Access token is invalid", 401);
            let Some((grant, token_id, expires_at, family_revoked_at)) = row else {
                return Err(invalid());
            };
            if family_revoked_at.is_some()
                || grant.revoked_at.is_some()
                || grant.resource != self.resource
                || expired(&expires_at, now)
            {
                return Err(invalid());
            }
            Self::assert_grant_authority(database, &grant)?;
            database.connection().execute(
                "UPDATE suplex_oauth_access_tokens SET last_used_at = ?1 WHERE id = ?2",
                params![timestamp(now), token_id],
            )?;
            Ok(grant)
        })?;
        external_agents::oauth_principal(database, &grant.agent_id, &grant.cursor_key, now)
    }

    pub fn revoke(
        &self,
        database: &mut SuplexDatabase,
        raw_token: &str,
        client_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> DatabaseResult<()> {
        let now_iso = timestamp(now);
        database.transaction(true, |database| {
            let hash = hash_secret(raw_token);
            let row: Option<(String, String)> = database
                .connection()
                .query_row(
                    "SELECT f.id, f.client_id FROM suplex_oauth_token_families f WHERE f.id = (SELECT family_id FROM suplex_oauth_access_tokens WHERE token_hash = ?1) OR f.id = (SELECT family_id FROM suplex_oauth_refresh_tokens WHERE token_hash = ?1)",
                    [&hash],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((family_id, family_client)) = row else {
                return Ok(());
            };
            if client_id.is_some_and(|client| !client.is_empty() && client != family_client) {
                return Ok(());
            }
            database.connection().execute(
                "UPDATE suplex_oauth_token_families SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2",
                params![now_iso, family_id],
            )?;
            database.connection().execute(
                "UPDATE suplex_oauth_access_tokens SET revoked_at = COALESCE(revoked_at, ?1) WHERE family_id = ?2",
                params![now_iso, family_id],
            )?;
            Ok(())
        })
    }
}
