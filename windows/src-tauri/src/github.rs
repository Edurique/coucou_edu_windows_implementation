// GitHub — everything behind the GitHub pill: the panel's data (profile and
// recent activity), the client, the rate-limit bookkeeping and the connection
// test in the settings window.
//
// The token is a fine-grained, read-only personal access token kept in the
// Credential Manager under `github-token`. It goes into the Authorization header
// and nowhere else: never into a URL, never into the log, never back to the
// front end.
//
// When things happen: integrations.rs ticks every five minutes, as for every
// other pill. A tick while the island is hidden fetches nothing, since nobody
// can look at the panel; a tick while it is on screen, the Refresh button and
// opening the panel fetch everything.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use reqwest::{Method, RequestBuilder};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::integrations::{emit, IntegrationUpdate};
use crate::log;
use crate::secrets;

const ID: &str = "integration_github";

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
        self.send(request, path).await?.ok_or(GhError::BadResponse)
    }

    /// REST GET that sends back the ETag of the previous answer. `None` means
    /// "unchanged since then" — a 304, which GitHub does not count against the
    /// rate limit, and the reason polling stays free when nothing happens.
    pub async fn get_if_changed(&self, path: &str, etag: Option<&str>) -> Result<Option<Reply>, GhError> {
        let mut request = self.request(Method::GET, &format!("{API}{path}"));
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        self.send(request, path).await
    }

    /// GraphQL query → its `data`. A partial answer (some fields refused) still
    /// comes back as data, with those fields null; only a query that produced no
    /// data at all is an error.
    pub async fn graphql(&self, query: &str) -> Result<Value, GhError> {
        let request = self
            .request(Method::POST, &format!("{API}/graphql"))
            .json(&json!({ "query": query }));
        let reply = self.send(request, "/graphql").await?.ok_or(GhError::BadResponse)?;
        match reply.json.get("data") {
            Some(data) if !data.is_null() => Ok(data.clone()),
            _ => Err(graphql_error(&reply.json)),
        }
    }

    /// `Ok(None)` is a 304 Not Modified.
    async fn send(&self, request: RequestBuilder, what: &str) -> Result<Option<Reply>, GhError> {
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
                Ok(Some(Reply { json, headers }))
            }
            304 => Ok(None),
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

// ── What the island receives ──────────────────────────────────────────────────

/// The `data` of the `integration_github` update.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub login: String,
    pub name: Option<String>,
    pub profile_url: String,
    pub total_repos: i64,
    pub total_stars: i64,
    /// Newest first.
    pub activity: Vec<Activity>,
    /// Unix milliseconds of the last complete refresh, so the panel can say how
    /// old what it shows is when GitHub can't be reached.
    pub fetched_at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    /// push, pr_opened, pr_merged, pr_closed, issue_opened, issue_closed,
    /// release or create.
    pub kind: &'static str,
    /// "owner/name".
    pub repo: String,
    pub title: String,
    /// "#12", a branch, a tag — whatever tells two similar lines apart.
    pub detail: Option<String>,
    pub url: String,
    /// ISO 8601, as GitHub sends it.
    pub at: String,
}

/// Enough for the panel, with room left for the kinds we skip.
const MAX_ACTIVITY: usize = 20;
/// The events feed goes back 30 days and 300 events; 50 is plenty once
/// comments, stars and branch creations are filtered out.
const EVENTS_PAGE: usize = 50;
/// GitHub's own floor when it doesn't send X-Poll-Interval.
const DEFAULT_POLL_INTERVAL: u64 = 60;

#[derive(Default)]
struct Cache {
    snapshot: Option<Snapshot>,
    /// URL and ETag of the last events answer.
    events_etag: Option<(String, String)>,
    /// X-Poll-Interval: the events feed is not asked again before this.
    events_not_before: u64,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

/// One refresh at a time: the five-minute tick and a Refresh click can land
/// together, and two refreshes racing would each spend the rate limit.
static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

fn island_hidden(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| shared.gate.collapsed.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// The five-minute tick. A hidden island means nobody can look at the panel:
/// once there is something in the cache, the tick waits for the island to come
/// back rather than calling GitHub for nobody.
pub async fn poll(app: AppHandle) {
    let cached = CACHE.lock().unwrap().snapshot.is_some();
    if cached && island_hidden(&app) {
        return;
    }
    refresh(app).await;
}

/// Everything the panel shows. The tick, the Refresh button, opening the panel
/// and saving a token all land here.
pub async fn refresh(app: AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let _busy = BusyGuard;

    match fetch().await {
        Ok(snapshot) => {
            let data = serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({}));
            CACHE.lock().unwrap().snapshot = Some(snapshot);
            emit(&app, IntegrationUpdate { id: ID, data, error: None, event: None });
        }
        // No token: the pill says "Key not configured" on its own. Forget what a
        // previous token showed, so a removed token doesn't leave its data up.
        Err(GhError::NoToken) => {
            *CACHE.lock().unwrap() = Cache::default();
        }
        // Keep what we had: the panel shows it with the reason it's not fresh.
        Err(e) => {
            let data = CACHE
                .lock()
                .unwrap()
                .snapshot
                .as_ref()
                .and_then(|s| serde_json::to_value(s).ok())
                .unwrap_or_else(|| json!({}));
            emit(&app, IntegrationUpdate { id: ID, data, error: Some(e.message()), event: None });
        }
    }
}

const PROFILE_QUERY: &str = "query { viewer { login name url \
    repositories(ownerAffiliations: OWNER, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) { \
    totalCount nodes { stargazerCount } } } }";

async fn fetch() -> Result<Snapshot, GhError> {
    let gh = Gh::from_store()?;
    let data = gh.graphql(PROFILE_QUERY).await?;
    let viewer = data.get("viewer").ok_or(GhError::BadResponse)?;

    let login = viewer
        .get("login")
        .and_then(Value::as_str)
        .ok_or(GhError::BadResponse)?
        .to_string();
    let repos = viewer.get("repositories");
    let total_repos = repos
        .and_then(|r| r.get("totalCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    // Over the hundred most recently pushed, like the macOS poller.
    let total_stars = repos
        .and_then(|r| r.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| n.get("stargazerCount").and_then(Value::as_i64))
                .sum()
        })
        .unwrap_or(0);

    let activity = fetch_activity(&gh, &login).await?;

    Ok(Snapshot {
        name: viewer
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        profile_url: viewer
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://github.com/{login}")),
        login,
        total_repos,
        total_stars,
        activity,
        fetched_at: unix_now() * 1000,
    })
}

/// The events feed, asked with the ETag of the last answer and never more
/// often than GitHub's X-Poll-Interval allows.
async fn fetch_activity(gh: &Gh, login: &str) -> Result<Vec<Activity>, GhError> {
    let path = format!("/users/{login}/events?per_page={EVENTS_PAGE}");
    let now = unix_now();

    let (cached, etag) = {
        let cache = CACHE.lock().unwrap();
        // Only a feed for this same account counts: the token may have changed.
        let cached = cache
            .snapshot
            .as_ref()
            .filter(|s| s.login == login)
            .map(|s| s.activity.clone());
        if let Some(activity) = &cached {
            if now < cache.events_not_before {
                return Ok(activity.clone());
            }
        }
        let etag = cache
            .events_etag
            .as_ref()
            .filter(|(url, _)| *url == path)
            .map(|(_, tag)| tag.clone());
        (cached, etag)
    };

    // Without a cached list, a 304 would leave the panel empty: ask afresh.
    let etag = if cached.is_some() { etag } else { None };
    let Some(reply) = gh.get_if_changed(&path, etag.as_deref()).await? else {
        return Ok(cached.unwrap_or_default());
    };

    let interval = header_u64(&reply.headers, "x-poll-interval").unwrap_or(DEFAULT_POLL_INTERVAL);
    {
        let mut cache = CACHE.lock().unwrap();
        cache.events_not_before = now + interval;
        cache.events_etag = header_str(&reply.headers, "etag").map(|tag| (path, tag));
    }
    Ok(parse_events(&reply.json))
}

fn parse_events(json: &Value) -> Vec<Activity> {
    json.as_array()
        .map(|events| events.iter().filter_map(parse_event).take(MAX_ACTIVITY).collect())
        .unwrap_or_default()
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// One GitHub event → one line of the panel, or None for the kinds the panel
/// doesn't show (comments, stars, forks, branch creations…).
///
/// Every field of `payload` is optional here: GitHub has been trimming what the
/// events feed carries, and a missing title must cost a line its title, not
/// the line itself.
fn parse_event(event: &Value) -> Option<Activity> {
    let id = text(event.get("id"))?;
    let repo = text(event.get("repo").and_then(|r| r.get("name")))?;
    let at = text(event.get("created_at"))?;
    let payload = event.get("payload")?;
    let repo_url = format!("https://github.com/{repo}");
    let action = payload.get("action").and_then(Value::as_str).unwrap_or("");

    let (kind, title, detail, url) = match event.get("type")?.as_str()? {
        "PushEvent" => {
            let branch = text(payload.get("ref")).map(|r| r.trim_start_matches("refs/heads/").to_string());
            let commits = payload.get("commits").and_then(Value::as_array);
            let count = payload
                .get("size")
                .and_then(Value::as_u64)
                .or_else(|| commits.map(|c| c.len() as u64));
            // The last commit of the push is the newest one.
            let message = commits
                .and_then(|c| c.last())
                .and_then(|c| text(c.get("message")))
                .and_then(|m| m.lines().next().map(str::to_string));
            let title = message.unwrap_or_else(|| match count {
                Some(n) if n > 1 => format!("Pushed {n} commits"),
                _ => "Pushed".to_string(),
            });
            let detail = match (count, &branch) {
                (Some(n), Some(b)) if n > 1 => Some(format!("{n} commits · {b}")),
                (_, Some(b)) => Some(b.clone()),
                _ => None,
            };
            let url = match (text(payload.get("head")), &branch) {
                (Some(sha), _) => format!("{repo_url}/commit/{sha}"),
                (None, Some(b)) => format!("{repo_url}/commits/{b}"),
                _ => repo_url.clone(),
            };
            ("push", title, detail, url)
        }
        "PullRequestEvent" => {
            let pr = payload.get("pull_request");
            let number = payload
                .get("number")
                .or_else(|| pr.and_then(|p| p.get("number")))
                .and_then(Value::as_u64);
            let merged = pr
                .map(|p| {
                    p.get("merged").and_then(Value::as_bool).unwrap_or(false)
                        || p.get("merged_at").is_some_and(|m| !m.is_null())
                })
                .unwrap_or(false);
            let kind = match action {
                "opened" | "reopened" => "pr_opened",
                "closed" if merged => "pr_merged",
                "closed" => "pr_closed",
                _ => return None,
            };
            let title = text(pr.and_then(|p| p.get("title")))
                .unwrap_or_else(|| number.map_or("Pull request".into(), |n| format!("Pull request #{n}")));
            let url = text(pr.and_then(|p| p.get("html_url")))
                .or_else(|| number.map(|n| format!("{repo_url}/pull/{n}")))
                .unwrap_or_else(|| repo_url.clone());
            (kind, title, number.map(|n| format!("#{n}")), url)
        }
        "IssuesEvent" => {
            let issue = payload.get("issue");
            let number = issue.and_then(|i| i.get("number")).and_then(Value::as_u64);
            let kind = match action {
                "opened" | "reopened" => "issue_opened",
                "closed" => "issue_closed",
                _ => return None,
            };
            let title = text(issue.and_then(|i| i.get("title")))
                .unwrap_or_else(|| number.map_or("Issue".into(), |n| format!("Issue #{n}")));
            let url = text(issue.and_then(|i| i.get("html_url")))
                .or_else(|| number.map(|n| format!("{repo_url}/issues/{n}")))
                .unwrap_or_else(|| repo_url.clone());
            (kind, title, number.map(|n| format!("#{n}")), url)
        }
        "ReleaseEvent" => {
            if !matches!(action, "published" | "released" | "created") {
                return None;
            }
            let release = payload.get("release");
            let tag = text(release.and_then(|r| r.get("tag_name")));
            let title = text(release.and_then(|r| r.get("name")))
                .or_else(|| tag.clone())
                .unwrap_or_else(|| "Release".into());
            let url = text(release.and_then(|r| r.get("html_url")))
                .or_else(|| tag.as_ref().map(|t| format!("{repo_url}/releases/tag/{t}")))
                .unwrap_or_else(|| format!("{repo_url}/releases"));
            ("release", title, tag, url)
        }
        "CreateEvent" => match payload.get("ref_type").and_then(Value::as_str)? {
            "repository" => ("create", "Created the repository".to_string(), None, repo_url.clone()),
            "tag" => {
                let tag = text(payload.get("ref"))?;
                let url = format!("{repo_url}/releases/tag/{tag}");
                ("create", format!("Tagged {tag}"), None, url)
            }
            _ => return None,
        },
        _ => return None,
    };

    Some(Activity { id, kind, repo, title, detail, url, at })
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

    fn event(kind: &str, payload: Value) -> Value {
        json!({
            "id": "42",
            "type": kind,
            "repo": { "name": "edu/coucou" },
            "created_at": "2026-09-30T18:00:00Z",
            "payload": payload,
        })
    }

    #[test]
    fn a_push_shows_its_newest_commit() {
        let push = event("PushEvent", json!({
            "ref": "refs/heads/main",
            "head": "abc123",
            "size": 3,
            "commits": [
                { "message": "First" },
                { "message": "Fix the hook timeout\n\nLonger body" },
            ],
        }));
        let a = parse_event(&push).unwrap();
        assert_eq!(a.kind, "push");
        assert_eq!(a.title, "Fix the hook timeout");
        assert_eq!(a.detail.as_deref(), Some("3 commits · main"));
        assert_eq!(a.url, "https://github.com/edu/coucou/commit/abc123");
    }

    #[test]
    fn a_push_without_commits_still_makes_a_line() {
        let push = event("PushEvent", json!({ "ref": "refs/heads/dev" }));
        let a = parse_event(&push).unwrap();
        assert_eq!(a.title, "Pushed");
        assert_eq!(a.detail.as_deref(), Some("dev"));
        assert_eq!(a.url, "https://github.com/edu/coucou/commits/dev");
    }

    #[test]
    fn a_closed_pull_request_is_merged_only_when_github_says_so() {
        let merged = event("PullRequestEvent", json!({
            "action": "closed",
            "number": 12,
            "pull_request": { "title": "Panel", "merged": true, "html_url": "https://github.com/edu/coucou/pull/12" },
        }));
        let a = parse_event(&merged).unwrap();
        assert_eq!((a.kind, a.detail.as_deref()), ("pr_merged", Some("#12")));

        let closed = event("PullRequestEvent", json!({
            "action": "closed",
            "number": 13,
            "pull_request": { "title": "Nope", "merged": false, "merged_at": null },
        }));
        let a = parse_event(&closed).unwrap();
        assert_eq!(a.kind, "pr_closed");
        assert_eq!(a.url, "https://github.com/edu/coucou/pull/13");
    }

    #[test]
    fn a_pull_request_without_its_object_keeps_its_number() {
        let opened = event("PullRequestEvent", json!({ "action": "opened", "number": 7 }));
        let a = parse_event(&opened).unwrap();
        assert_eq!((a.kind, a.title.as_str()), ("pr_opened", "Pull request #7"));
    }

    #[test]
    fn issues_and_releases_map_to_their_kinds() {
        let issue = event("IssuesEvent", json!({
            "action": "closed",
            "issue": { "number": 4, "title": "Crash on drop" },
        }));
        let a = parse_event(&issue).unwrap();
        assert_eq!((a.kind, a.title.as_str()), ("issue_closed", "Crash on drop"));
        assert_eq!(a.url, "https://github.com/edu/coucou/issues/4");

        let release = event("ReleaseEvent", json!({
            "action": "published",
            "release": { "tag_name": "v0.2.0", "name": "", "html_url": "https://github.com/edu/coucou/releases/tag/v0.2.0" },
        }));
        let a = parse_event(&release).unwrap();
        assert_eq!((a.kind, a.title.as_str(), a.detail.as_deref()), ("release", "v0.2.0", Some("v0.2.0")));
    }

    #[test]
    fn noise_is_left_out() {
        for skipped in [
            event("WatchEvent", json!({ "action": "started" })),
            event("IssueCommentEvent", json!({ "action": "created" })),
            event("PullRequestEvent", json!({ "action": "synchronize", "number": 3 })),
            event("CreateEvent", json!({ "ref_type": "branch", "ref": "wip" })),
            json!({ "type": "PushEvent", "payload": {} }),
        ] {
            assert_eq!(parse_event(&skipped), None);
        }
    }

    #[test]
    fn the_feed_keeps_its_order_and_is_capped() {
        let many: Vec<Value> = (0..30)
            .map(|i| {
                let mut e = event("PushEvent", json!({ "ref": "refs/heads/main" }));
                e["id"] = json!(i.to_string());
                e
            })
            .collect();
        let list = parse_events(&Value::Array(many));
        assert_eq!(list.len(), MAX_ACTIVITY);
        assert_eq!(list[0].id, "0");
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
