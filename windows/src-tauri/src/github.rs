// GitHub — everything behind the GitHub pill: the panel's data (profile, recent
// activity, projects and their last Actions run), the client, the rate-limit
// bookkeeping and the connection test in the settings window.
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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use reqwest::{Method, RequestBuilder};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::github_detail::Target;
use crate::integrations::{emit, IntegrationEvent, IntegrationUpdate};
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

pub(crate) fn unix_now() -> u64 {
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

pub(crate) fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
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
        self.graphql_with(query, json!({})).await.map(|(data, _)| data)
    }

    /// Same, with variables — so a repository name is never pasted into the
    /// query text — and the errors of a partial answer, which say which fields
    /// the token was refused.
    pub async fn graphql_with(&self, query: &str, variables: Value) -> Result<(Value, Vec<Value>), GhError> {
        let request = self
            .request(Method::POST, &format!("{API}/graphql"))
            .json(&json!({ "query": query, "variables": variables }));
        let reply = self.send(request, "/graphql").await?.ok_or(GhError::BadResponse)?;
        let errors = reply
            .json
            .get("errors")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        match reply.json.get("data") {
            Some(data) if !data.is_null() => Ok((data.clone(), errors)),
            _ => {
                // An HTTP 200 that failed: `send` logged nothing. Only GitHub's
                // own words about the query — no data, no token.
                let message: String = reply
                    .json
                    .pointer("/errors/0/message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect();
                log::line(format!("github /graphql → {message}"));
                Err(graphql_error(&reply.json))
            }
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
    let first = json
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first());
    let kind = first.and_then(|e| e.get("type")).and_then(Value::as_str).unwrap_or("");
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
    /// Most recently pushed first.
    pub repos: Vec<Repo>,
    /// The year of contributions behind the graph; None if GitHub gave none.
    pub contributions: Option<Contributions>,
    /// Unix milliseconds of the last complete refresh, so the panel can say how
    /// old what it shows is when GitHub can't be reached.
    pub fetched_at: u64,
}

/// The contribution calendar, day by day from `start`. Two flat lists rather
/// than 371 objects: this rides along with every update of the pill.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub total: i64,
    /// First day, "YYYY-MM-DD"; the lists run one entry per day from there.
    pub start: String,
    pub counts: Vec<u32>,
    /// GitHub's own quartiles, 0 (none) to 4 (busiest), so the graph shades
    /// days the way the profile page does.
    pub levels: Vec<u8>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    /// "owner/name".
    pub full_name: String,
    pub url: String,
    pub private: bool,
    pub language: Option<String>,
    /// GitHub's colour for the language, e.g. "#dea584" for Rust.
    pub language_color: Option<String>,
    pub stars: i64,
    pub open_prs: i64,
    pub pushed_at: Option<String>,
    /// The newest Actions run on any branch. None: no workflow, or the token
    /// can't read Actions for this repository.
    pub build: Option<Build>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub id: u64,
    /// success, failure, running or neutral (cancelled, skipped…).
    pub state: &'static str,
    /// The workflow's name, e.g. "CI".
    pub workflow: String,
    pub branch: Option<String>,
    pub url: String,
    pub at: String,
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
    /// The sheet a click on the line opens in the panel; None: straight to GitHub.
    pub target: Option<Target>,
}

/// Enough for the panel, with room left for the kinds we skip.
const MAX_ACTIVITY: usize = 20;
/// The events feed goes back 30 days and 300 events; 50 is plenty once
/// comments, stars and branch creations are filtered out.
const EVENTS_PAGE: usize = 50;
/// GitHub's own floor when it doesn't send X-Poll-Interval.
const DEFAULT_POLL_INTERVAL: u64 = 60;
/// Projects in the panel, each costing one Actions request per refresh — a free
/// one (304) as long as nothing ran.
const MAX_REPOS: usize = 8;

#[derive(Default)]
struct Cache {
    snapshot: Option<Snapshot>,
    /// URL and ETag of the last events answer.
    events_etag: Option<(String, String)>,
    /// X-Poll-Interval: the events feed is not asked again before this.
    events_not_before: u64,
    /// Per Actions URL: the ETag of the last answer and what it said.
    runs: HashMap<String, (String, Option<Build>)>,
    /// The merged pull requests already known, so each is announced once.
    /// None until the first refresh, which announces nothing.
    merged: Option<Vec<String>>,
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

/// The tick. It runs with the island hidden too: a build that just broke or a
/// pull request that just went in is news for the pill, and the pill is what
/// shows while the island is away. It stays cheap there — one GraphQL point,
/// and the Actions and events calls answer 304, which GitHub doesn't count,
/// as long as nothing happened.
pub async fn poll(app: AppHandle) {
    refresh(app).await;
}

/// Development builds only: a way to see the pill's news without breaking a
/// build for it. Writing "fail" or "merge" to coucou-github-demo in the temp
/// folder sends that news once, through the same event as the real thing.
#[cfg(debug_assertions)]
pub fn watch_demo(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let trigger = std::env::temp_dir().join("coucou-github-demo");
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let Ok(what) = std::fs::read_to_string(&trigger) else { continue };
            let _ = std::fs::remove_file(&trigger);
            let event = match what.trim() {
                "fail" => IntegrationEvent {
                    success: false,
                    label: "CI failed on coucou".into(),
                    detail: Some("main".into()),
                    open: Some(json!({
                        "title": "CI failed on coucou",
                        "facts": [
                            { "kind": "step", "text": "test \u{203a} cargo test" },
                            { "kind": "branch", "text": "main" },
                            { "kind": "commit", "text": "Keep the last snapshot through an error" },
                            { "kind": "by", "verb": "by", "text": "mochi" },
                        ],
                    })),
                },
                "merge" => IntegrationEvent {
                    success: true,
                    label: "#12 merged".into(),
                    detail: Some("GitHub panel for the Windows island".into()),
                    open: Some(json!({
                        "title": "#12 GitHub panel for the Windows island",
                        "facts": [
                            { "kind": "repo", "text": "coucou" },
                            { "kind": "by", "verb": "merged by", "text": "louis" },
                            { "kind": "diff", "additions": 1332, "deletions": 64 },
                            { "kind": "files", "text": "14 files" },
                        ],
                    })),
                },
                _ => continue,
            };
            // No data: the island keeps what it shows and only takes the news.
            emit(&app, IntegrationUpdate { id: ID, data: json!({}), error: None, event: Some(event) });
        }
    });
}

/// A pull request of yours that went in.
#[derive(Clone, Debug, PartialEq)]
struct Merged {
    /// "owner/name#12".
    key: String,
    repo: String,
    number: u64,
    title: String,
    url: String,
    /// Who merged it, and its size: what the island's card says about it.
    merged_by: Option<String>,
    additions: i64,
    deletions: i64,
    files: i64,
}

fn parse_merged(viewer: &Value) -> Vec<Merged> {
    viewer
        .pointer("/merged/nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    let number = n.get("number")?.as_u64()?;
                    let repo = text(n.pointer("/repository/nameWithOwner"))?;
                    Some(Merged {
                        key: format!("{repo}#{number}"),
                        number,
                        title: text(n.get("title")).unwrap_or_default(),
                        url: text(n.get("url")).unwrap_or_else(|| format!("https://github.com/{repo}/pull/{number}")),
                        merged_by: text(n.pointer("/mergedBy/login")),
                        additions: n.get("additions").and_then(Value::as_i64).unwrap_or(0),
                        deletions: n.get("deletions").and_then(Value::as_i64).unwrap_or(0),
                        files: n.get("changedFiles").and_then(Value::as_i64).unwrap_or(0),
                        repo,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What changed since the last refresh that the pill should say: a build that
/// broke, else a pull request that went in. Nothing on the first refresh —
/// it only learns how things stand — and nothing for a failure already told.
fn news(before: Option<&Snapshot>, now: &Snapshot, known: Option<&[String]>, merged: &[Merged]) -> Option<IntegrationEvent> {
    let before = before?;
    let broke = now.repos.iter().find_map(|repo| {
        let build = repo.build.as_ref().filter(|b| b.state == "failure")?;
        // A project that just entered the list has no "before" to compare with.
        let was = before.repos.iter().find(|r| r.full_name == repo.full_name)?;
        let told = was.build.as_ref().is_some_and(|b| b.id == build.id && b.state == "failure");
        (!told).then(|| IntegrationEvent {
            success: false,
            label: format!("{} failed on {}", build.workflow, repo.name),
            detail: build.branch.clone(),
            // The card's title and facts are filled in by `tell_failure`, which
            // asks GitHub which job and which step broke.
            open: Some(json!({ "target": Target::Run { repo: repo.full_name.clone(), id: build.id }, "label": build.workflow, "url": build.url })),
        })
    });
    broke.or_else(|| {
        let known = known?;
        let pull = merged.iter().find(|m| !known.contains(&m.key))?;
        Some(IntegrationEvent {
            success: true,
            label: format!("#{} merged", pull.number),
            detail: Some(pull.title.clone()).filter(|t| !t.is_empty()),
            open: Some(json!({
                "target": Target::Pull { repo: pull.repo.clone(), number: pull.number },
                "label": format!("#{}", pull.number),
                "url": pull.url,
                "title": format!("#{} {}", pull.number, pull.title),
                "facts": merge_facts(pull),
            })),
        })
    })
}

/// What the card says under a merged pull request: where, by whom, how big.
///
/// Each fact says what it is (`kind`), so the island can draw it as what it
/// is — a name, a size in green and red, a branch — rather than as one grey
/// sentence.
fn merge_facts(pull: &Merged) -> Vec<Value> {
    let mut facts = vec![json!({ "kind": "repo", "text": pull.repo.rsplit('/').next().unwrap_or(&pull.repo) })];
    if let Some(who) = &pull.merged_by {
        facts.push(json!({ "kind": "by", "verb": "merged by", "text": who }));
    }
    facts.push(json!({ "kind": "diff", "additions": pull.additions, "deletions": pull.deletions }));
    facts.push(json!({ "kind": "files", "text": if pull.files == 1 { "1 file".to_string() } else { format!("{} files", pull.files) } }));
    facts
}

/// What the card says under a build that broke: the job and the step it broke
/// at, the branch, the commit it ran for, who started it, how long it lasted.
fn failure_facts(run: &crate::github_detail::RunDetail) -> Vec<Value> {
    let mut facts = Vec::new();
    if let Some(job) = run.jobs.iter().find(|j| j.state == "failure") {
        let at = match job.steps.iter().find(|s| s.state == "failure") {
            Some(step) => format!("{} \u{203a} {}", job.name, step.name),
            None => job.name.clone(),
        };
        facts.push(json!({ "kind": "step", "text": at }));
    }
    if let Some(branch) = &run.branch {
        facts.push(json!({ "kind": "branch", "text": branch }));
    }
    if let Some(title) = &run.title {
        facts.push(json!({ "kind": "commit", "text": title }));
    }
    if let Some(actor) = &run.actor {
        facts.push(json!({ "kind": "by", "verb": "by", "text": actor }));
    }
    facts
}

/// A build broke: one more question to GitHub — which job, which step — so
/// the card can say more than "it failed". Asked only then, and the answer
/// stays in the sheets' cache for the click that opens the run. If it can't
/// be had, the news goes out as it is.
async fn tell_failure(event: &mut IntegrationEvent) {
    let Some(open) = event.open.as_mut().filter(|_| !event.success) else { return };
    let Some(target) = open.get("target").cloned().and_then(|t| serde_json::from_value::<Target>(t).ok()) else { return };
    if let Ok(crate::github_detail::Detail::Run(run)) = crate::github_detail::detail(target, false).await {
        open["title"] = json!(event.label);
        open["facts"] = json!(failure_facts(&run));
    }
}

/// Everything the panel shows. The tick, the Refresh button, opening the panel
/// and saving a token all land here.
pub async fn refresh(app: AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let _busy = BusyGuard;

    match fetch().await {
        Ok((snapshot, merged)) => {
            log::line(format!(
                "github refresh: {} events, {} projects, {} with a build, {} contribution days",
                snapshot.activity.len(),
                snapshot.repos.len(),
                snapshot.repos.iter().filter(|r| r.build.is_some()).count(),
                snapshot.contributions.as_ref().map_or(0, |c| c.counts.len()),
            ));
            let data = serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({}));
            let event = {
                let mut cache = CACHE.lock().unwrap();
                let event = news(cache.snapshot.as_ref(), &snapshot, cache.merged.as_deref(), &merged);
                cache.snapshot = Some(snapshot);
                cache.merged = Some(merged.into_iter().map(|m| m.key).collect());
                event
            };
            let mut event = event;
            if let Some(e) = &mut event {
                log::line(format!("github news: {} ({})", e.label, if e.success { "good" } else { "bad" }));
                tell_failure(e).await;
            }
            emit(&app, IntegrationUpdate { id: ID, data, error: None, event });
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

/// Profile, star count and projects in one request, both lists sorted by last
/// push. The star count and the repository count stay about what you own, as
/// on macOS; the Projects tab also takes what you contributed to elsewhere —
/// as far as the token can see, which for a fine-grained token means your own
/// repositories, organisations it was made for, and public ones.
const PROFILE_QUERY: &str = "query { viewer { login name url \
    contributionsCollection { contributionCalendar { totalContributions \
    weeks { contributionDays { date contributionCount contributionLevel } } } } \
    repositories(ownerAffiliations: OWNER, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) { \
    totalCount nodes { ...Project } } \
    repositoriesContributedTo(first: 25, includeUserRepositories: true, \
    orderBy: {field: PUSHED_AT, direction: DESC}) { nodes { ...Project } } \
    merged: pullRequests(states: MERGED, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) { \
    nodes { number title url additions deletions changedFiles mergedBy { login } repository { nameWithOwner } } } } } \
    fragment Project on Repository { name nameWithOwner url isPrivate isArchived pushedAt \
    stargazerCount primaryLanguage { name color } pullRequests(states: OPEN) { totalCount } }";

async fn fetch() -> Result<(Snapshot, Vec<Merged>), GhError> {
    let gh = Gh::from_store()?;
    let data = gh.graphql(PROFILE_QUERY).await?;
    let viewer = data.get("viewer").ok_or(GhError::BadResponse)?;

    let login = viewer
        .get("login")
        .and_then(Value::as_str)
        .ok_or(GhError::BadResponse)?
        .to_string();
    let repositories = viewer.get("repositories");
    let total_repos = repositories
        .and_then(|r| r.get("totalCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let nodes = repositories
        .and_then(|r| r.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    // Over the hundred most recently pushed, like the macOS poller.
    let total_stars = nodes
        .iter()
        .filter_map(|n| n.get("stargazerCount").and_then(Value::as_i64))
        .sum();

    let activity = fetch_activity(&gh, &login).await?;

    let contributed = viewer
        .get("repositoriesContributedTo")
        .and_then(|r| r.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut repos = parse_repos(nodes, contributed);
    for repo in &mut repos {
        repo.build = latest_build(&gh, &repo.full_name).await?;
    }

    let merged = parse_merged(viewer);
    Ok((Snapshot {
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
        contributions: parse_contributions(viewer.pointer("/contributionsCollection/contributionCalendar")),
        login,
        total_repos,
        total_stars,
        activity,
        repos,
        fetched_at: unix_now() * 1000,
    }, merged))
}

fn parse_contributions(calendar: Option<&Value>) -> Option<Contributions> {
    let calendar = calendar?;
    let days: Vec<&Value> = calendar
        .get("weeks")?
        .as_array()?
        .iter()
        .filter_map(|w| w.get("contributionDays")?.as_array())
        .flatten()
        .collect();
    let start = text(days.first()?.get("date"))?;
    let counts = days
        .iter()
        .map(|d| d.get("contributionCount").and_then(Value::as_u64).unwrap_or(0) as u32)
        .collect();
    let levels = days
        .iter()
        .map(|d| match d.get("contributionLevel").and_then(Value::as_str) {
            Some("FIRST_QUARTILE") => 1,
            Some("SECOND_QUARTILE") => 2,
            Some("THIRD_QUARTILE") => 3,
            Some("FOURTH_QUARTILE") => 4,
            _ => 0,
        })
        .collect();
    Some(Contributions {
        total: calendar.get("totalContributions").and_then(Value::as_i64).unwrap_or(0),
        start,
        counts,
        levels,
    })
}

/// The projects tab: what you own and what you contributed to, merged, most
/// recently pushed first. Archived repositories are left out since nothing
/// happens there any more.
fn parse_repos(owned: &[Value], contributed: &[Value]) -> Vec<Repo> {
    let mut seen = std::collections::HashSet::new();
    let mut repos: Vec<Repo> = owned
        .iter()
        .chain(contributed)
        .filter(|n| !n.get("isArchived").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|n| {
            let full_name = text(n.get("nameWithOwner"))?;
            let language = n.get("primaryLanguage");
            Some(Repo {
                name: text(n.get("name")).unwrap_or_else(|| full_name.clone()),
                url: text(n.get("url")).unwrap_or_else(|| format!("https://github.com/{full_name}")),
                full_name,
                private: n.get("isPrivate").and_then(Value::as_bool).unwrap_or(false),
                language: text(language.and_then(|l| l.get("name"))),
                language_color: text(language.and_then(|l| l.get("color"))),
                stars: n.get("stargazerCount").and_then(Value::as_i64).unwrap_or(0),
                // Null when the token may not read pull requests: shown as none.
                open_prs: n
                    .get("pullRequests")
                    .and_then(|p| p.get("totalCount"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                pushed_at: text(n.get("pushedAt")),
                build: None,
            })
        })
        // Your own repositories you contributed to come back in both lists.
        .filter(|r| seen.insert(r.full_name.clone()))
        .collect();
    // ISO 8601 sorts as text; a repository never pushed to goes last.
    repos.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
    repos.truncate(MAX_REPOS);
    repos
}

/// The newest Actions run of a repository, whatever its branch, asked with the
/// ETag of the last answer.
///
/// A repository the token can't read Actions for, or that has no workflow, has
/// no build — the connection test is where a missing permission gets named.
/// Anything that concerns every request (rate limit, bad token, no network)
/// stops the refresh instead.
async fn latest_build(gh: &Gh, repo: &str) -> Result<Option<Build>, GhError> {
    let path = format!("/repos/{repo}/actions/runs?per_page=1");
    let cached = CACHE.lock().unwrap().runs.get(&path).cloned();
    let etag = cached.as_ref().map(|(tag, _)| tag.as_str());

    match gh.get_if_changed(&path, etag).await {
        Ok(None) => Ok(cached.and_then(|(_, build)| build)),
        Ok(Some(reply)) => {
            let build = parse_run(&reply.json);
            if let Some(tag) = header_str(&reply.headers, "etag") {
                CACHE.lock().unwrap().runs.insert(path, (tag, build.clone()));
            }
            Ok(build)
        }
        Err(GhError::Forbidden) | Err(GhError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Four states are all the island needs: it passed, it broke, it's going, or
/// it ended without saying either (cancelled, skipped, waiting for a click).
pub(crate) fn build_state(status: &str, conclusion: Option<&str>) -> &'static str {
    if status != "completed" {
        return "running";
    }
    match conclusion {
        Some("success") => "success",
        Some("failure") | Some("timed_out") | Some("startup_failure") => "failure",
        _ => "neutral",
    }
}

pub(crate) fn parse_run(json: &Value) -> Option<Build> {
    let run = json.get("workflow_runs")?.as_array()?.first()?;
    let status = run.get("status").and_then(Value::as_str).unwrap_or("completed");
    let conclusion = run.get("conclusion").and_then(Value::as_str);
    Some(Build {
        id: run.get("id")?.as_u64()?,
        state: build_state(status, conclusion),
        workflow: text(run.get("name")).unwrap_or_else(|| "Workflow".into()),
        branch: text(run.get("head_branch")),
        url: text(run.get("html_url"))?,
        at: text(run.get("updated_at")).or_else(|| text(run.get("created_at")))?,
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

pub(crate) fn text(value: Option<&Value>) -> Option<String> {
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

    let (kind, title, detail, url, target) = match event.get("type")?.as_str()? {
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
            let head = text(payload.get("head"));
            let url = match (&head, &branch) {
                (Some(sha), _) => format!("{repo_url}/commit/{sha}"),
                (None, Some(b)) => format!("{repo_url}/commits/{b}"),
                _ => repo_url.clone(),
            };
            let target = head.map(|head| Target::Commits {
                repo: repo.clone(),
                head: Some(head),
                count,
                branch: branch.clone(),
                author: None,
                from: None,
                to: None,
            });
            ("push", title, detail, url, target)
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
            let target = number.map(|number| Target::Pull { repo: repo.clone(), number });
            (kind, title, number.map(|n| format!("#{n}")), url, target)
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
            let target = number.map(|number| Target::Issue { repo: repo.clone(), number });
            (kind, title, number.map(|n| format!("#{n}")), url, target)
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
            let target = tag.clone().map(|tag| Target::Release { repo: repo.clone(), tag });
            ("release", title, tag, url, target)
        }
        "CreateEvent" => match payload.get("ref_type").and_then(Value::as_str)? {
            "repository" => (
                "create",
                "Created the repository".to_string(),
                None,
                repo_url.clone(),
                Some(Target::Project { repo: repo.clone() }),
            ),
            "tag" => {
                let tag = text(payload.get("ref"))?;
                let url = format!("{repo_url}/releases/tag/{tag}");
                ("create", format!("Tagged {tag}"), None, url, None)
            }
            _ => return None,
        },
        _ => return None,
    };

    Some(Activity { id, kind, repo, title, detail, url, at, target })
}

// ── Project sheet (a click on a project) ──────────────────────────────────────
//
// Fetched on demand only — never by the tick — and kept a minute, so going
// back and forth between projects costs nothing.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub full_name: String,
    pub url: String,
    pub description: Option<String>,
    pub homepage: Option<String>,
    pub private: bool,
    pub created_at: Option<String>,
    pub stars: i64,
    pub forks: i64,
    /// Largest first, the long tail folded into "Other".
    pub languages: Vec<LanguageShare>,
    /// Newest first.
    pub runs: Vec<Run>,
    /// The pull request touched most recently, whoever opened it.
    pub pull: Option<Pull>,
    pub deploy: Option<Deploy>,
    /// Sections the token may not read for this repository: "actions",
    /// "deployments", "pull requests". The sheet says so rather than looking empty.
    pub missing: Vec<&'static str>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanguageShare {
    pub name: String,
    pub color: Option<String>,
    /// 0…1 of the repository's code.
    pub share: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: u64,
    pub state: &'static str,
    pub workflow: String,
    pub branch: Option<String>,
    /// The commit or pull request title the run is about.
    pub title: Option<String>,
    pub actor: Option<String>,
    pub url: String,
    pub started_at: Option<String>,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// open, draft, merged or closed.
    pub state: &'static str,
    pub author: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    /// approved, changes requested or review required; None when not asked.
    pub review: Option<&'static str>,
    pub comments: i64,
    /// Merged at for a merged one, last update otherwise.
    pub at: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deploy {
    pub environment: String,
    /// success, failure, running or inactive (replaced by a newer one).
    pub state: &'static str,
    /// Where it went live, when the deployment says.
    pub url: Option<String>,
    pub creator: Option<String>,
    pub sha: Option<String>,
    pub at: String,
}

const PROJECT_QUERY: &str = "query($owner: String!, $name: String!) { \
    repository(owner: $owner, name: $name) { \
    nameWithOwner url description homepageUrl isPrivate createdAt stargazerCount forkCount \
    languages(first: 6, orderBy: {field: SIZE, direction: DESC}) { totalSize edges { size node { name color } } } \
    pullRequests(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { \
    number title url state isDraft merged mergedAt updatedAt additions deletions changedFiles \
    reviewDecision author { login } comments { totalCount } } } \
    deployments(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { \
    environment createdAt commitOid creator { login } latestStatus { state environmentUrl createdAt } } } } }";

/// Runs shown as the CI streak.
const STREAK: usize = 8;
const PROJECT_TTL: u64 = 60;
/// Languages named in the bar before the rest becomes "Other".
const MAX_LANGUAGES: usize = 4;

static PROJECTS: LazyLock<Mutex<HashMap<String, (u64, Project)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// "owner/name" with nothing else in it: the name ends up in a URL path.
pub(crate) fn split_full_name(full_name: &str) -> Option<(&str, &str)> {
    let (owner, name) = full_name.split_once('/')?;
    let valid = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (valid(owner) && valid(name)).then_some((owner, name))
}

/// True when a partial GraphQL answer refused the field `field`.
fn refused(errors: &[Value], field: &str) -> bool {
    errors.iter().any(|e| {
        e.get("path")
            .and_then(Value::as_array)
            .is_some_and(|path| path.iter().any(|p| p.as_str() == Some(field)))
    })
}

pub async fn project(full_name: &str, force: bool) -> Result<Project, String> {
    let (owner, name) = split_full_name(full_name).ok_or("Unknown repository")?;
    let now = unix_now();
    if !force {
        if let Some((at, cached)) = PROJECTS.lock().unwrap().get(full_name) {
            if now.saturating_sub(*at) < PROJECT_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let gh = Gh::from_store().map_err(|e| e.message())?;
    let (data, errors) = gh
        .graphql_with(PROJECT_QUERY, json!({ "owner": owner, "name": name }))
        .await
        .map_err(|e| e.message())?;
    let repo = data
        .get("repository")
        .filter(|r| !r.is_null())
        .ok_or_else(|| GhError::NotFound.message())?;

    let mut missing = Vec::new();
    if refused(&errors, "pullRequests") {
        missing.push("pull requests");
    }
    if refused(&errors, "deployments") {
        missing.push("deployments");
    }
    let runs = match gh.get(&format!("/repos/{owner}/{name}/actions/runs?per_page={STREAK}")).await {
        Ok(reply) => parse_runs(&reply.json),
        Err(GhError::Forbidden) => {
            missing.push("actions");
            Vec::new()
        }
        // Actions switched off for this repository.
        Err(GhError::NotFound) => Vec::new(),
        Err(e) => return Err(e.message()),
    };

    let project = parse_project(repo, runs, missing).ok_or_else(|| GhError::BadResponse.message())?;
    PROJECTS
        .lock()
        .unwrap()
        .insert(full_name.to_string(), (now, project.clone()));
    Ok(project)
}

fn parse_runs(json: &Value) -> Vec<Run> {
    let Some(runs) = json.get("workflow_runs").and_then(Value::as_array) else {
        return Vec::new();
    };
    runs.iter()
        .filter_map(|run| {
            let status = run.get("status").and_then(Value::as_str).unwrap_or("completed");
            let conclusion = run.get("conclusion").and_then(Value::as_str);
            Some(Run {
                id: run.get("id")?.as_u64()?,
                state: build_state(status, conclusion),
                workflow: text(run.get("name")).unwrap_or_else(|| "Workflow".into()),
                branch: text(run.get("head_branch")),
                title: text(run.get("display_title"))
                    .or_else(|| text(run.pointer("/head_commit/message")))
                    .and_then(|t| t.lines().next().map(str::to_string)),
                actor: text(run.pointer("/triggering_actor/login"))
                    .or_else(|| text(run.pointer("/actor/login"))),
                url: text(run.get("html_url"))?,
                started_at: text(run.get("run_started_at")),
                updated_at: text(run.get("updated_at")).or_else(|| text(run.get("created_at")))?,
            })
        })
        .take(STREAK)
        .collect()
}

fn parse_languages(languages: Option<&Value>) -> Vec<LanguageShare> {
    let Some(languages) = languages else { return Vec::new() };
    let total = languages.get("totalSize").and_then(Value::as_f64).unwrap_or(0.0);
    let Some(edges) = languages.get("edges").and_then(Value::as_array) else {
        return Vec::new();
    };
    if total <= 0.0 {
        return Vec::new();
    }
    let mut shares: Vec<LanguageShare> = edges
        .iter()
        .filter_map(|edge| {
            Some(LanguageShare {
                name: text(edge.pointer("/node/name"))?,
                color: text(edge.pointer("/node/color")),
                share: edge.get("size")?.as_f64()? / total,
            })
        })
        .collect();
    if shares.len() > MAX_LANGUAGES {
        let rest: f64 = shares.drain(MAX_LANGUAGES..).map(|l| l.share).sum();
        shares.push(LanguageShare { name: "Other".into(), color: None, share: rest });
    }
    // What the six largest don't cover also counts as "Other".
    let covered: f64 = shares.iter().map(|l| l.share).sum();
    if covered < 0.995 {
        match shares.last_mut().filter(|l| l.name == "Other") {
            Some(other) => other.share += 1.0 - covered,
            None => shares.push(LanguageShare { name: "Other".into(), color: None, share: 1.0 - covered }),
        }
    }
    shares
}

fn parse_pull(node: &Value) -> Option<Pull> {
    let merged = node.get("merged").and_then(Value::as_bool).unwrap_or(false);
    let state = match (merged, node.get("state").and_then(Value::as_str)?) {
        (true, _) => "merged",
        (false, "CLOSED") => "closed",
        _ if node.get("isDraft").and_then(Value::as_bool).unwrap_or(false) => "draft",
        _ => "open",
    };
    let review = match node.get("reviewDecision").and_then(Value::as_str) {
        Some("APPROVED") => Some("approved"),
        Some("CHANGES_REQUESTED") => Some("changes requested"),
        Some("REVIEW_REQUIRED") => Some("review required"),
        _ => None,
    };
    let merged_at = if merged { text(node.get("mergedAt")) } else { None };
    let at = merged_at.or_else(|| text(node.get("updatedAt")))?;
    Some(Pull {
        number: node.get("number")?.as_u64()?,
        title: text(node.get("title")).unwrap_or_else(|| "Untitled".into()),
        url: text(node.get("url"))?,
        state,
        author: text(node.pointer("/author/login")),
        additions: node.get("additions").and_then(Value::as_i64).unwrap_or(0),
        deletions: node.get("deletions").and_then(Value::as_i64).unwrap_or(0),
        changed_files: node.get("changedFiles").and_then(Value::as_i64).unwrap_or(0),
        review,
        comments: node.pointer("/comments/totalCount").and_then(Value::as_i64).unwrap_or(0),
        at,
    })
}

fn parse_deploy(node: &Value) -> Option<Deploy> {
    let status = node.get("latestStatus").filter(|s| !s.is_null());
    let state = match status.and_then(|s| s.get("state")).and_then(Value::as_str) {
        Some("SUCCESS") => "success",
        Some("FAILURE") | Some("ERROR") => "failure",
        Some("INACTIVE") => "inactive",
        _ => "running",
    };
    Some(Deploy {
        environment: text(node.get("environment")).unwrap_or_else(|| "production".into()),
        state,
        url: text(status.and_then(|s| s.get("environmentUrl"))),
        creator: text(node.pointer("/creator/login")),
        sha: text(node.get("commitOid")).map(|sha| sha.chars().take(7).collect()),
        at: text(status.and_then(|s| s.get("createdAt"))).or_else(|| text(node.get("createdAt")))?,
    })
}

fn parse_project(repo: &Value, runs: Vec<Run>, missing: Vec<&'static str>) -> Option<Project> {
    let full_name = text(repo.get("nameWithOwner"))?;
    Some(Project {
        url: text(repo.get("url")).unwrap_or_else(|| format!("https://github.com/{full_name}")),
        full_name,
        description: text(repo.get("description")),
        homepage: text(repo.get("homepageUrl")),
        private: repo.get("isPrivate").and_then(Value::as_bool).unwrap_or(false),
        created_at: text(repo.get("createdAt")),
        stars: repo.get("stargazerCount").and_then(Value::as_i64).unwrap_or(0),
        forks: repo.get("forkCount").and_then(Value::as_i64).unwrap_or(0),
        languages: parse_languages(repo.get("languages")),
        runs,
        pull: repo.pointer("/pullRequests/nodes/0").and_then(parse_pull),
        deploy: repo.pointer("/deployments/nodes/0").and_then(parse_deploy),
        missing,
    })
}

// ── One day of the graph (a click on a day) ───────────────────────────────────
//
// What GitHub's profile page lists under the graph when a day is clicked:
// contributionsCollection narrowed to that day. The events feed can't do it —
// it only goes back thirty days.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub items: Vec<DayItem>,
    /// Contributions that day in repositories the token can't see into.
    pub private_count: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayItem {
    /// push (commits), pr_opened, pr_merged, review, issue_opened or create.
    pub kind: &'static str,
    /// "owner/name".
    pub repo: String,
    pub title: String,
    pub detail: Option<String>,
    pub url: String,
    /// The sheet a click on the line opens in the panel.
    pub target: Option<Target>,
}

const DAY_QUERY: &str = "query($from: DateTime!, $to: DateTime!) { viewer { login \
    contributionsCollection(from: $from, to: $to) { restrictedContributionsCount \
    commitContributionsByRepository(maxRepositories: 10) { repository { nameWithOwner url } contributions { totalCount } } \
    pullRequestContributions(first: 10) { nodes { pullRequest { number title url merged repository { nameWithOwner } } } } \
    pullRequestReviewContributions(first: 10) { nodes { pullRequest { number title url repository { nameWithOwner } } } } \
    issueContributions(first: 10) { nodes { issue { number title url repository { nameWithOwner } } } } \
    repositoryContributions(first: 10) { nodes { repository { nameWithOwner url } } } } } }";

/// A day that's over doesn't change; today still can.
const PAST_DAY_TTL: u64 = 3600;
const TODAY_TTL: u64 = 60;

static DAYS: LazyLock<Mutex<HashMap<String, (u64, Day)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// An ISO 8601 timestamp and nothing else: it goes to GitHub as a variable.
pub(crate) fn is_timestamp(s: &str) -> bool {
    (10..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_digit() || "-:T.Z+".contains(c))
}

/// `from` and `to` bound the day in the user's own time zone, worked out by
/// the island, so the list matches the day they clicked on.
pub async fn day(from: &str, to: &str, today: bool) -> Result<Day, String> {
    if !is_timestamp(from) || !is_timestamp(to) {
        return Err("Unknown day".into());
    }
    let key = format!("{from}/{to}");
    let now = unix_now();
    let ttl = if today { TODAY_TTL } else { PAST_DAY_TTL };
    if let Some((at, cached)) = DAYS.lock().unwrap().get(&key) {
        if now.saturating_sub(*at) < ttl {
            return Ok(cached.clone());
        }
    }

    let gh = Gh::from_store().map_err(|e| e.message())?;
    let (data, _) = gh
        .graphql_with(DAY_QUERY, json!({ "from": from, "to": to }))
        .await
        .map_err(|e| e.message())?;
    let collection = data
        .pointer("/viewer/contributionsCollection")
        .ok_or_else(|| GhError::BadResponse.message())?;
    let login = text(data.pointer("/viewer/login"));
    let day = parse_day(collection, login.as_deref(), from, to);
    DAYS.lock().unwrap().insert(key, (now, day.clone()));
    Ok(day)
}

fn nodes<'a>(collection: &'a Value, field: &str) -> impl Iterator<Item = &'a Value> {
    collection
        .pointer(&format!("/{field}/nodes"))
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
}

/// `login`, `from` and `to` go into the commits' target, so their sheet lists
/// exactly the commits counted here.
fn parse_day(collection: &Value, login: Option<&str>, from: &str, to: &str) -> Day {
    let mut items = Vec::new();

    // Commits come grouped by repository, as on the profile page.
    for group in collection
        .get("commitContributionsByRepository")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
    {
        let (Some(repo), Some(count)) = (
            text(group.pointer("/repository/nameWithOwner")),
            group.pointer("/contributions/totalCount").and_then(Value::as_i64),
        ) else {
            continue;
        };
        let url = text(group.pointer("/repository/url")).unwrap_or_else(|| format!("https://github.com/{repo}"));
        let title = if count == 1 { "1 commit".to_string() } else { format!("{count} commits") };
        let target = Target::Commits {
            repo: repo.clone(),
            head: None,
            count: u64::try_from(count).ok(),
            branch: None,
            author: login.map(str::to_string),
            from: Some(from.to_string()),
            to: Some(to.to_string()),
        };
        items.push(DayItem { kind: "push", repo, title, detail: None, url: format!("{url}/commits"), target: Some(target) });
    }

    let pull = |node: &Value, kind_for: &dyn Fn(bool) -> &'static str| -> Option<DayItem> {
        let pr = node.get("pullRequest")?;
        let merged = pr.get("merged").and_then(Value::as_bool).unwrap_or(false);
        let number = pr.get("number")?.as_u64()?;
        let repo = text(pr.pointer("/repository/nameWithOwner"))?;
        Some(DayItem {
            kind: kind_for(merged),
            target: Some(Target::Pull { repo: repo.clone(), number }),
            repo,
            title: text(pr.get("title")).unwrap_or_else(|| format!("Pull request #{number}")),
            detail: Some(format!("#{number}")),
            url: text(pr.get("url"))?,
        })
    };
    items.extend(nodes(collection, "pullRequestContributions").filter_map(|n| {
        pull(n, &|merged| if merged { "pr_merged" } else { "pr_opened" })
    }));
    items.extend(nodes(collection, "pullRequestReviewContributions").filter_map(|n| pull(n, &|_| "review")));

    items.extend(nodes(collection, "issueContributions").filter_map(|n| {
        let issue = n.get("issue")?;
        let number = issue.get("number")?.as_u64()?;
        let repo = text(issue.pointer("/repository/nameWithOwner"))?;
        Some(DayItem {
            kind: "issue_opened",
            target: Some(Target::Issue { repo: repo.clone(), number }),
            repo,
            title: text(issue.get("title")).unwrap_or_else(|| format!("Issue #{number}")),
            detail: Some(format!("#{number}")),
            url: text(issue.get("url"))?,
        })
    }));

    items.extend(nodes(collection, "repositoryContributions").filter_map(|n| {
        let repo = text(n.pointer("/repository/nameWithOwner"))?;
        Some(DayItem {
            kind: "create",
            url: text(n.pointer("/repository/url")).unwrap_or_else(|| format!("https://github.com/{repo}")),
            target: Some(Target::Project { repo: repo.clone() }),
            repo,
            title: "Created the repository".into(),
            detail: None,
        })
    }));

    Day {
        items,
        private_count: collection
            .get("restrictedContributionsCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
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
        let deployments = gh.get(&format!("/repos/{repo}/deployments?per_page=1")).await.map(|_| ());
        checks.push(check("Deployments", deployments));
        // Commits, their diffs and releases.
        let contents = gh.get(&format!("/repos/{repo}/commits?per_page=1")).await.map(|_| ());
        checks.push(check("Contents", contents));
        let issues = gh.get(&format!("/repos/{repo}/issues?per_page=1")).await.map(|_| ());
        checks.push(check("Issues", issues));
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

    fn snapshot_with(builds: &[(&str, Option<(u64, &'static str)>)]) -> Snapshot {
        Snapshot {
            login: "edu".into(),
            name: None,
            profile_url: String::new(),
            total_repos: 0,
            total_stars: 0,
            activity: Vec::new(),
            repos: builds
                .iter()
                .map(|(name, build)| Repo {
                    name: name.to_string(),
                    full_name: format!("edu/{name}"),
                    url: String::new(),
                    private: false,
                    language: None,
                    language_color: None,
                    stars: 0,
                    open_prs: 0,
                    pushed_at: None,
                    build: build.map(|(id, state)| Build {
                        id,
                        state,
                        workflow: "CI".into(),
                        branch: Some("main".into()),
                        url: String::new(),
                        at: String::new(),
                    }),
                })
                .collect(),
            contributions: None,
            fetched_at: 0,
        }
    }

    #[test]
    fn the_pill_hears_of_a_build_once_it_breaks_and_only_once() {
        let green = snapshot_with(&[("coucou", Some((1, "success")))]);
        let running = snapshot_with(&[("coucou", Some((2, "running")))]);
        let red = snapshot_with(&[("coucou", Some((2, "failure")))]);

        // The first refresh only learns how things stand, broken or not.
        assert!(news(None, &red, None, &[]).is_none());
        // A new run that failed, and a run that was going and ended badly.
        let event = news(Some(&green), &red, Some(&[]), &[]).unwrap();
        assert_eq!((event.success, event.label.as_str(), event.detail.as_deref()), (false, "CI failed on coucou", Some("main")));
        assert!(news(Some(&running), &red, Some(&[]), &[]).is_some());
        // Still the same failure on the next refresh: already told.
        assert!(news(Some(&red), &red, Some(&[]), &[]).is_none());
        // A project that just entered the list has nothing to compare with.
        assert!(news(Some(&snapshot_with(&[])), &red, Some(&[]), &[]).is_none());
    }

    #[test]
    fn the_pill_hears_of_a_merged_pull_request_once() {
        let calm = snapshot_with(&[("coucou", Some((1, "success")))]);
        let merged = parse_merged(&json!({ "merged": { "nodes": [
            { "number": 12, "title": "Panel", "repository": { "nameWithOwner": "edu/coucou" } },
            { "number": 3, "title": "Older", "repository": { "nameWithOwner": "edu/notes" } },
        ]}}));
        assert_eq!(merged[0].key, "edu/coucou#12");

        // Nothing known yet: the first refresh announces none of them.
        assert!(news(Some(&calm), &calm, None, &merged).is_none());
        let known = vec!["edu/notes#3".to_string()];
        let event = news(Some(&calm), &calm, Some(&known), &merged).unwrap();
        assert_eq!((event.success, event.label.as_str(), event.detail.as_deref()), (true, "#12 merged", Some("Panel")));
        let all = vec!["edu/notes#3".to_string(), "edu/coucou#12".to_string()];
        assert!(news(Some(&calm), &calm, Some(&all), &merged).is_none());
        // A build that broke comes before a merge.
        let red = snapshot_with(&[("coucou", Some((2, "failure")))]);
        assert!(!news(Some(&calm), &red, Some(&known), &merged).unwrap().success);
    }

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
    fn projects_skip_the_archived_and_keep_the_push_order() {
        let nodes = vec![
            json!({
                "name": "coucou", "nameWithOwner": "edu/coucou", "url": "https://github.com/edu/coucou",
                "isPrivate": false, "isArchived": false, "pushedAt": "2026-09-30T18:00:00Z",
                "stargazerCount": 12, "primaryLanguage": { "name": "Rust", "color": "#dea584" },
                "pullRequests": { "totalCount": 2 },
            }),
            json!({ "name": "old", "nameWithOwner": "edu/old", "isArchived": true }),
            json!({
                "name": "notes", "nameWithOwner": "edu/notes", "isPrivate": true,
                "primaryLanguage": null, "pullRequests": null,
            }),
        ];
        let repos = parse_repos(&nodes, &[]);
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].name, "coucou");
        assert_eq!(repos[0].language.as_deref(), Some("Rust"));
        assert_eq!(repos[0].language_color.as_deref(), Some("#dea584"));
        assert_eq!((repos[0].stars, repos[0].open_prs), (12, 2));
        assert_eq!(repos[1].name, "notes");
        assert!(repos[1].private);
        assert_eq!((repos[1].language.as_deref(), repos[1].open_prs), (None, 0));
        assert_eq!(repos[1].url, "https://github.com/edu/notes");
    }

    #[test]
    fn projects_are_capped() {
        let nodes: Vec<Value> = (0..20)
            .map(|i| json!({ "name": format!("r{i}"), "nameWithOwner": format!("edu/r{i}") }))
            .collect();
        assert_eq!(parse_repos(&nodes, &[]).len(), MAX_REPOS);
    }

    #[test]
    fn contributions_elsewhere_join_the_projects_once_in_push_order() {
        let repo = |full: &str, pushed: &str| {
            let name = full.split('/').nth(1).unwrap();
            json!({ "name": name, "nameWithOwner": full, "pushedAt": pushed })
        };
        let owned = vec![
            repo("edu/coucou", "2026-09-30T10:00:00Z"),
            repo("edu/notes", "2026-08-01T10:00:00Z"),
        ];
        let contributed = vec![
            repo("louis/coucou", "2026-09-30T12:00:00Z"),
            repo("edu/coucou", "2026-09-30T10:00:00Z"),
            json!({ "name": "old", "nameWithOwner": "org/old", "isArchived": true, "pushedAt": "2026-09-30T23:00:00Z" }),
        ];
        let names: Vec<String> = parse_repos(&owned, &contributed).into_iter().map(|r| r.full_name).collect();
        assert_eq!(names, ["louis/coucou", "edu/coucou", "edu/notes"]);
    }

    #[test]
    fn a_run_is_one_of_four_states() {
        assert_eq!(build_state("in_progress", None), "running");
        assert_eq!(build_state("queued", None), "running");
        assert_eq!(build_state("waiting", None), "running");
        assert_eq!(build_state("completed", Some("success")), "success");
        assert_eq!(build_state("completed", Some("failure")), "failure");
        assert_eq!(build_state("completed", Some("timed_out")), "failure");
        assert_eq!(build_state("completed", Some("startup_failure")), "failure");
        assert_eq!(build_state("completed", Some("cancelled")), "neutral");
        assert_eq!(build_state("completed", Some("skipped")), "neutral");
        assert_eq!(build_state("completed", None), "neutral");
    }

    #[test]
    fn the_newest_run_becomes_the_build() {
        let runs = json!({ "total_count": 40, "workflow_runs": [{
            "id": 99, "name": "CI", "head_branch": "main", "status": "completed",
            "conclusion": "failure", "html_url": "https://github.com/edu/coucou/actions/runs/99",
            "created_at": "2026-09-30T17:00:00Z", "updated_at": "2026-09-30T17:04:00Z",
        }]});
        let build = parse_run(&runs).unwrap();
        assert_eq!((build.id, build.state, build.workflow.as_str()), (99, "failure", "CI"));
        assert_eq!(build.branch.as_deref(), Some("main"));
        assert_eq!(build.at, "2026-09-30T17:04:00Z");
    }

    #[test]
    fn a_repository_without_workflows_has_no_build() {
        assert_eq!(parse_run(&json!({ "total_count": 0, "workflow_runs": [] })), None);
        assert_eq!(parse_run(&json!({})), None);
    }

    #[test]
    fn the_calendar_flattens_into_days_from_its_first_date() {
        let day = |date: &str, count: u64, level: &str| {
            json!({ "date": date, "contributionCount": count, "contributionLevel": level })
        };
        let calendar = json!({
            "totalContributions": 9,
            "weeks": [
                // A first week that starts mid-week, as GitHub's does.
                { "contributionDays": [day("2025-10-01", 0, "NONE"), day("2025-10-02", 1, "FIRST_QUARTILE")] },
                { "contributionDays": [day("2025-10-03", 8, "FOURTH_QUARTILE"), day("2025-10-04", 0, "NONE")] },
            ],
        });
        let c = parse_contributions(Some(&calendar)).unwrap();
        assert_eq!((c.total, c.start.as_str()), (9, "2025-10-01"));
        assert_eq!(c.counts, [0, 1, 8, 0]);
        assert_eq!(c.levels, [0, 1, 4, 0]);
    }

    #[test]
    fn no_calendar_means_no_graph() {
        assert_eq!(parse_contributions(None), None);
        assert_eq!(parse_contributions(Some(&json!({ "weeks": [] }))), None);
    }

    #[test]
    fn a_day_lists_commits_by_repository_then_pull_requests_reviews_issues_and_repos() {
        let collection = json!({
            "restrictedContributionsCount": 3,
            "commitContributionsByRepository": [
                { "repository": { "nameWithOwner": "edu/coucou", "url": "https://github.com/edu/coucou" }, "contributions": { "totalCount": 4 } },
                { "repository": { "nameWithOwner": "edu/notes", "url": "https://github.com/edu/notes" }, "contributions": { "totalCount": 1 } },
            ],
            "pullRequestContributions": { "nodes": [
                { "pullRequest": { "number": 12, "title": "Panel", "url": "https://github.com/edu/coucou/pull/12", "merged": true, "repository": { "nameWithOwner": "edu/coucou" } } },
            ]},
            "pullRequestReviewContributions": { "nodes": [
                { "pullRequest": { "number": 3, "title": "Typo", "url": "https://github.com/louis/coucou/pull/3", "repository": { "nameWithOwner": "louis/coucou" } } },
            ]},
            "issueContributions": { "nodes": [
                { "issue": { "number": 4, "title": "Crash", "url": "https://github.com/edu/coucou/issues/4", "repository": { "nameWithOwner": "edu/coucou" } } },
            ]},
            "repositoryContributions": { "nodes": [
                { "repository": { "nameWithOwner": "edu/sandbox", "url": "https://github.com/edu/sandbox" } },
            ]},
        });
        let day = parse_day(&collection, Some("edu"), "2026-09-29T22:00:00.000Z", "2026-09-30T21:59:59.000Z");
        let summary: Vec<(&str, &str)> = day.items.iter().map(|i| (i.kind, i.title.as_str())).collect();
        assert_eq!(summary, [
            ("push", "4 commits"),
            ("push", "1 commit"),
            ("pr_merged", "Panel"),
            ("review", "Typo"),
            ("issue_opened", "Crash"),
            ("create", "Created the repository"),
        ]);
        assert_eq!(day.items[0].url, "https://github.com/edu/coucou/commits");
        assert_eq!(day.items[3].repo, "louis/coucou");
        assert_eq!(day.private_count, 3);
    }

    #[test]
    fn an_empty_day_is_empty() {
        let day = parse_day(&json!({ "restrictedContributionsCount": 0 }), None, "a", "b");
        assert!(day.items.is_empty());
        assert_eq!(day.private_count, 0);
    }

    #[test]
    fn only_timestamps_go_to_github() {
        assert!(is_timestamp("2026-09-29T22:00:00.000Z"));
        assert!(is_timestamp("2026-09-30T00:00:00+02:00"));
        for bad in ["", "yesterday", "2026-09-30\") { x }", "2026-09-30T00:00:00Z; drop"] {
            assert!(!is_timestamp(bad), "{bad}");
        }
    }

    #[test]
    fn only_a_plain_owner_slash_name_reaches_a_url() {
        assert_eq!(split_full_name("edu/coucou"), Some(("edu", "coucou")));
        assert_eq!(split_full_name("louis-cfm/my_repo.rs"), Some(("louis-cfm", "my_repo.rs")));
        for bad in ["coucou", "edu/", "/coucou", "edu/../x", "edu/co?x=1", "a/b/c", "../etc", "edu/.."] {
            assert_eq!(split_full_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_refused_field_is_found_in_the_error_path() {
        let errors = vec![json!({ "type": "FORBIDDEN", "path": ["repository", "deployments"] })];
        assert!(refused(&errors, "deployments"));
        assert!(!refused(&errors, "pullRequests"));
        assert!(!refused(&[], "deployments"));
    }

    #[test]
    fn languages_keep_four_and_fold_the_rest() {
        let langs = json!({ "totalSize": 1000, "edges": [
            { "size": 500, "node": { "name": "Rust", "color": "#dea584" } },
            { "size": 200, "node": { "name": "TypeScript", "color": "#3178c6" } },
            { "size": 100, "node": { "name": "CSS", "color": "#663399" } },
            { "size": 80, "node": { "name": "HTML", "color": "#e34c26" } },
            { "size": 60, "node": { "name": "Shell", "color": "#89e051" } },
            { "size": 40, "node": { "name": "Nix", "color": null } },
        ]});
        let shares = parse_languages(Some(&langs));
        let names: Vec<&str> = shares.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Rust", "TypeScript", "CSS", "HTML", "Other"]);
        // Shell + Nix + the 2 % the six largest didn't cover.
        assert!((shares[4].share - 0.12).abs() < 1e-9);
        assert!((shares.iter().map(|l| l.share).sum::<f64>() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn an_empty_repository_has_no_language_bar() {
        assert!(parse_languages(Some(&json!({ "totalSize": 0, "edges": [] }))).is_empty());
        assert!(parse_languages(None).is_empty());
    }

    #[test]
    fn a_pull_request_says_where_it_stands() {
        let pr = |merged: bool, state: &str, draft: bool| json!({
            "number": 12, "title": "Panel", "url": "https://github.com/edu/coucou/pull/12",
            "state": state, "isDraft": draft, "merged": merged,
            "mergedAt": if merged { json!("2026-09-30T18:00:00Z") } else { Value::Null },
            "updatedAt": "2026-09-30T19:00:00Z", "additions": 320, "deletions": 40, "changedFiles": 9,
            "reviewDecision": "APPROVED", "author": { "login": "edu" }, "comments": { "totalCount": 3 },
        });
        let merged = parse_pull(&pr(true, "MERGED", false)).unwrap();
        assert_eq!((merged.state, merged.at.as_str()), ("merged", "2026-09-30T18:00:00Z"));
        assert_eq!((merged.additions, merged.deletions, merged.comments), (320, 40, 3));
        assert_eq!(merged.review, Some("approved"));
        assert_eq!(parse_pull(&pr(false, "OPEN", true)).unwrap().state, "draft");
        assert_eq!(parse_pull(&pr(false, "OPEN", false)).unwrap().state, "open");
        let closed = parse_pull(&pr(false, "CLOSED", false)).unwrap();
        assert_eq!((closed.state, closed.at.as_str()), ("closed", "2026-09-30T19:00:00Z"));
    }

    #[test]
    fn a_deployment_reads_its_latest_status() {
        let live = json!({
            "environment": "Production", "createdAt": "2026-09-30T10:00:00Z",
            "commitOid": "a1b2c3d4e5f6", "creator": { "login": "vercel" },
            "latestStatus": { "state": "SUCCESS", "environmentUrl": "https://coucou.vercel.app", "createdAt": "2026-09-30T10:02:00Z" },
        });
        let d = parse_deploy(&live).unwrap();
        assert_eq!((d.state, d.environment.as_str(), d.sha.as_deref()), ("success", "Production", Some("a1b2c3d")));
        assert_eq!((d.url.as_deref(), d.at.as_str()), (Some("https://coucou.vercel.app"), "2026-09-30T10:02:00Z"));

        let pending = json!({ "environment": "Preview", "createdAt": "2026-09-30T11:00:00Z", "latestStatus": null });
        let d = parse_deploy(&pending).unwrap();
        assert_eq!((d.state, d.at.as_str(), d.url), ("running", "2026-09-30T11:00:00Z", None));
    }

    #[test]
    fn runs_carry_what_the_ci_line_says() {
        let runs = json!({ "workflow_runs": [{
            "id": 7, "name": "CI", "head_branch": "main", "status": "completed", "conclusion": "success",
            "display_title": "Fix the hook timeout\nmore", "triggering_actor": { "login": "edu" },
            "html_url": "https://github.com/edu/coucou/actions/runs/7",
            "run_started_at": "2026-09-30T10:00:00Z", "updated_at": "2026-09-30T10:02:14Z",
        }, { "id": 6 }]});
        let list = parse_runs(&runs);
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].state, list[0].title.as_deref(), list[0].actor.as_deref()), ("success", Some("Fix the hook timeout"), Some("edu")));
        assert_eq!(list[0].started_at.as_deref(), Some("2026-09-30T10:00:00Z"));
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
