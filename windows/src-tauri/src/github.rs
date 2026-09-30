// GitHub — everything behind the GitHub pill: the client, the rate-limit
// bookkeeping and the connection test in the settings window.
//
// The token is a fine-grained, read-only personal access token kept in the
// Credential Manager under `github-token`. It goes into the Authorization header
// and nowhere else: never into a URL, never into the log, never back to the
// front end.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use reqwest::{Method, RequestBuilder};
use serde::Serialize;
use serde_json::{json, Value};

use crate::log;
use crate::secrets;

const API: &str = "https://api.github.com";
/// Pinned so a change of default on GitHub's side can't reshape the answers.
const API_VERSION: &str = "2022-11-28";
const TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_KEY: &str = "github-token";

/// Why a GitHub call gave nothing usable. `message()` is what the island and the
/// settings window show, so it has to make sense to someone who never saw an
/// HTTP status code.
#[derive(Debug, Clone, PartialEq)]
pub enum GhError {
    NoToken,
    /// 401 — wrong, revoked or expired token.
    Unauthorized,
    /// 403 that is not a rate limit: the token can't see this.
    Forbidden,
    NotFound,
    /// Nothing goes out before this Unix time (seconds).
    RateLimited(u64),
    Offline,
    Status(u16),
    BadResponse,
}

impl GhError {
    pub fn message(&self) -> String {
        match self {
            GhError::NoToken => "No token saved — Settings → GitHub".into(),
            GhError::Unauthorized => "Token refused (401): invalid or expired".into(),
            GhError::Forbidden => "Missing permission (403)".into(),
            GhError::NotFound => "Not found (404)".into(),
            GhError::RateLimited(until) => {
                format!("GitHub rate limit — {}", wait_text(*until, unix_now()))
            }
            GhError::Offline => "No connection".into(),
            GhError::Status(code) => format!("GitHub error {code}"),
            GhError::BadResponse => "Unexpected answer from GitHub".into(),
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// "back in 12 min" — relative, so no time zone is involved.
fn wait_text(until: u64, now: u64) -> String {
    let minutes = until.saturating_sub(now).div_ceil(60);
    if minutes <= 1 {
        "back in a minute".into()
    } else {
        format!("back in {minutes} min")
    }
}

// ── Rate limit ────────────────────────────────────────────────────────────────

/// Set from GitHub's own headers. Until then no GitHub request leaves at all:
/// pushing on after a rate-limit answer is what gets a token blocked for longer.
static BLOCKED_UNTIL: Mutex<u64> = Mutex::new(0);

fn blocked(now: u64) -> Option<u64> {
    let until = *BLOCKED_UNTIL.lock().unwrap();
    (until > now).then_some(until)
}

fn block_until(until: u64) {
    let mut current = BLOCKED_UNTIL.lock().unwrap();
    *current = (*current).max(until);
}

/// Until when GitHub asked us to stay quiet, read from one answer.
///
/// Primary limit: `x-ratelimit-remaining` reaches 0 and `x-ratelimit-reset` says
/// when the window reopens — even on a 200, since the next call would fail.
/// Secondary limit: a 403/429 with `retry-after`, or with no hint at all, in
/// which case GitHub's documentation says to wait at least a minute.
fn rate_block(
    status: u16,
    remaining: Option<u64>,
    reset: Option<u64>,
    retry_after: Option<u64>,
    says_rate_limit: bool,
    now: u64,
) -> Option<u64> {
    let refused = status == 403 || status == 429;
    if refused {
        if let Some(secs) = retry_after {
            return Some(now + secs.max(1));
        }
    }
    if remaining == Some(0) {
        return Some(reset.filter(|r| *r > now).unwrap_or(now + 60));
    }
    if status == 429 || (refused && says_rate_limit) {
        return Some(now + 60);
    }
    None
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)?
        .to_str()
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── Client ────────────────────────────────────────────────────────────────────

pub struct Reply {
    pub json: Value,
    pub headers: HeaderMap,
}

pub struct Gh {
    http: reqwest::Client,
    token: String,
}

impl Gh {
    /// Reads the token from the Credential Manager. Called once per poll, so a
    /// token changed in the settings window is picked up on the next one.
    pub fn from_store() -> Result<Self, GhError> {
        let token = secrets::get(TOKEN_KEY).ok_or(GhError::NoToken)?;
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Ok(Self { http, token })
    }

    fn request(&self, method: Method, url: &str) -> RequestBuilder {
        self.http
            .request(method, url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
            .header("User-Agent", "Coucou")
    }

    /// REST GET. `path` starts with `/`.
    pub async fn get(&self, path: &str) -> Result<Reply, GhError> {
        let request = self.request(Method::GET, &format!("{API}{path}"));
        self.send(request, path).await
    }

    /// GraphQL query → its `data`. A partial answer (some fields refused) still
    /// comes back as data, with those fields null; only a query that produced no
    /// data at all is an error.
    pub async fn graphql(&self, query: &str) -> Result<Value, GhError> {
        let request = self
            .request(Method::POST, &format!("{API}/graphql"))
            .json(&json!({ "query": query }));
        let reply = self.send(request, "/graphql").await?;
        match reply.json.get("data") {
            Some(data) if !data.is_null() => Ok(data.clone()),
            _ => Err(graphql_error(&reply.json)),
        }
    }

    async fn send(&self, request: RequestBuilder, what: &str) -> Result<Reply, GhError> {
        let now = unix_now();
        if let Some(until) = blocked(now) {
            return Err(GhError::RateLimited(until));
        }

        let response = request.send().await.map_err(|_| GhError::Offline)?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = response.text().await.map_err(|_| GhError::Offline)?;

        let says_rate_limit = body.to_lowercase().contains("rate limit");
        if let Some(until) = rate_block(
            status,
            header_u64(&headers, "x-ratelimit-remaining"),
            header_u64(&headers, "x-ratelimit-reset"),
            header_u64(&headers, "retry-after"),
            says_rate_limit,
            now,
        ) {
            block_until(until);
            if status >= 400 {
                log::line(format!("github {what} → {status}, rate limited for {}s", until - now));
                return Err(GhError::RateLimited(until));
            }
        }

        match status {
            200..=299 => {
                let json = serde_json::from_str(&body).map_err(|_| GhError::BadResponse)?;
                Ok(Reply { json, headers })
            }
            _ => {
                // The path and the status only: the body can quote the request.
                log::line(format!("github {what} → {status}"));
                Err(match status {
                    401 => GhError::Unauthorized,
                    403 => GhError::Forbidden,
                    404 => GhError::NotFound,
                    other => GhError::Status(other),
                })
            }
        }
    }
}

/// A GraphQL answer comes back as HTTP 200 even when it failed; the reason is
/// in `errors[].type`.
fn graphql_error(json: &Value) -> GhError {
    let kind = json
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|e| e.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "RATE_LIMITED" => {
            let until = unix_now() + 60;
            block_until(until);
            GhError::RateLimited(until)
        }
        "FORBIDDEN" | "INSUFFICIENT_SCOPES" => GhError::Forbidden,
        "NOT_FOUND" => GhError::NotFound,
        _ => GhError::BadResponse,
    }
}

// ── Connection test (settings window) ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub name: Option<String>,
    pub profile_url: String,
    /// As GitHub sends it, e.g. "2026-12-12 10:00:00 +0100". None: no expiry.
    pub expires_at: Option<String>,
    pub checks: Vec<Check>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub label: &'static str,
    pub ok: bool,
    pub note: Option<String>,
}

fn check(label: &'static str, result: Result<(), GhError>) -> Check {
    match result {
        Ok(()) => Check { label, ok: true, note: None },
        Err(GhError::Forbidden) | Err(GhError::NotFound) => Check {
            label,
            ok: false,
            note: Some("not granted to this token".into()),
        },
        Err(e) => Check { label, ok: false, note: Some(e.message()) },
    }
}

/// Settings → GitHub → Test connection. One call per thing the panel needs, so
/// a missing permission is named here rather than discovered as an empty card.
pub async fn test() -> Result<Account, String> {
    let gh = Gh::from_store().map_err(|e| e.message())?;
    let me = gh.get("/user").await.map_err(|e| e.message())?;

    let login = me
        .json
        .get("login")
        .and_then(Value::as_str)
        .ok_or_else(|| GhError::BadResponse.message())?
        .to_string();
    let name = me
        .json
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let profile_url = me
        .json
        .get("html_url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://github.com/{login}"));
    let expires_at = header_str(&me.headers, "github-authentication-token-expiration");

    let mut checks = vec![Check { label: "Account", ok: true, note: None }];

    // The contribution graph and the project list both come from GraphQL.
    let graphql = gh.graphql("query { viewer { login } }").await.map(|_| ());
    checks.push(check("Contributions", graphql));

    // The most recently pushed repository stands in for all of them.
    let repos = gh.get("/user/repos?per_page=1&affiliation=owner&sort=pushed").await;
    let sample = repos
        .as_ref()
        .ok()
        .and_then(|r| r.json.as_array()?.first()?.get("full_name")?.as_str().map(str::to_string));
    match (repos, &sample) {
        (Err(e), _) => checks.push(check("Repositories", Err(e))),
        (Ok(_), None) => checks.push(Check {
            label: "Repositories",
            ok: false,
            note: Some("none visible — set Repository access to All repositories".into()),
        }),
        (Ok(_), Some(_)) => checks.push(check("Repositories", Ok(()))),
    }
    if let Some(repo) = &sample {
        let pulls = gh.get(&format!("/repos/{repo}/pulls?per_page=1")).await.map(|_| ());
        checks.push(check("Pull requests", pulls));
        let runs = gh.get(&format!("/repos/{repo}/actions/runs?per_page=1")).await.map(|_| ());
        checks.push(check("Actions", runs));
    }

    let events = gh.get(&format!("/users/{login}/events?per_page=1")).await.map(|_| ());
    checks.push(check("Activity", events));

    let failed = checks.iter().filter(|c| !c.ok).count();
    log::line(format!("github test: {} checks, {failed} failed", checks.len()));

    Ok(Account { login, name, profile_url, expires_at, checks })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;

    #[test]
    fn a_normal_answer_blocks_nothing() {
        assert_eq!(rate_block(200, Some(4999), Some(NOW + 3600), None, false, NOW), None);
        assert_eq!(rate_block(404, Some(4999), Some(NOW + 3600), None, false, NOW), None);
    }

    #[test]
    fn an_empty_budget_blocks_until_the_reset_even_on_a_200() {
        assert_eq!(rate_block(200, Some(0), Some(NOW + 900), None, false, NOW), Some(NOW + 900));
        assert_eq!(rate_block(403, Some(0), Some(NOW + 900), None, true, NOW), Some(NOW + 900));
    }

    #[test]
    fn a_reset_in_the_past_still_waits_a_minute() {
        assert_eq!(rate_block(403, Some(0), Some(NOW - 5), None, true, NOW), Some(NOW + 60));
        assert_eq!(rate_block(403, Some(0), None, None, true, NOW), Some(NOW + 60));
    }

    #[test]
    fn retry_after_wins_on_a_refusal() {
        assert_eq!(rate_block(403, Some(12), None, Some(30), true, NOW), Some(NOW + 30));
        assert_eq!(rate_block(429, None, None, Some(90), false, NOW), Some(NOW + 90));
        // A retry-after on a success means nothing to us.
        assert_eq!(rate_block(200, Some(12), None, Some(30), false, NOW), None);
    }

    #[test]
    fn a_secondary_limit_without_headers_waits_a_minute() {
        assert_eq!(rate_block(403, Some(40), None, None, true, NOW), Some(NOW + 60));
        assert_eq!(rate_block(429, None, None, None, false, NOW), Some(NOW + 60));
    }

    #[test]
    fn a_plain_403_is_a_permission_problem_not_a_rate_limit() {
        assert_eq!(rate_block(403, Some(4000), Some(NOW + 3600), None, false, NOW), None);
    }

    #[test]
    fn the_wait_is_said_in_minutes_rounded_up() {
        assert_eq!(wait_text(NOW + 30, NOW), "back in a minute");
        assert_eq!(wait_text(NOW + 61, NOW), "back in 2 min");
        assert_eq!(wait_text(NOW + 720, NOW), "back in 12 min");
        assert_eq!(wait_text(NOW - 10, NOW), "back in a minute");
    }

    #[test]
    fn graphql_errors_map_to_something_a_person_can_act_on() {
        let forbidden = json!({ "data": null, "errors": [{ "type": "FORBIDDEN" }] });
        assert_eq!(graphql_error(&forbidden), GhError::Forbidden);
        let scopes = json!({ "errors": [{ "type": "INSUFFICIENT_SCOPES" }] });
        assert_eq!(graphql_error(&scopes), GhError::Forbidden);
        let odd = json!({ "errors": [{ "message": "boom" }] });
        assert_eq!(graphql_error(&odd), GhError::BadResponse);
    }
}
