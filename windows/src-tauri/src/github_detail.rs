// GitHub, one level deeper: the sheet behind a line of activity — a pull
// request, an issue, a push's commits, a release, a run of Actions — so that
// GitHub's own site is the last place to go, not the first.
//
// Fetched on the click only, never by the tick, and kept a minute. What to
// fetch comes as a Target that github.rs built from GitHub's answers; it
// travels through the island and back, so it is checked again here before any
// of it reaches a URL or a query.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::github::{build_state, is_timestamp, parse_run, split_full_name, text, unix_now, Build, Gh, GhError};

/// What a line of activity leads to.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Target {
    Pull { repo: String, number: u64 },
    Issue { repo: String, number: u64 },
    /// A push (its `head` and how many commits), or a day's commits in one
    /// repository (`author` between `from` and `to`).
    Commits {
        repo: String,
        head: Option<String>,
        count: Option<u64>,
        branch: Option<String>,
        author: Option<String>,
        from: Option<String>,
        to: Option<String>,
    },
    Release { repo: String, tag: String },
    /// A repository: the island opens its project sheet; nothing to fetch here.
    Project { repo: String },
    /// A run of Actions, from a CI line of a project, a pull request or a commit.
    Run { repo: String, id: u64 },
}

/// A line's sheet. `Locked` is a sheet the token may not read, with the
/// permission that would open it.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Detail {
    /// Boxed: a pull request's sheet is twice the size of any other.
    Pull(Box<PullDetail>),
    Issue(IssueDetail),
    Commits(CommitsDetail),
    Release(ReleaseDetail),
    Run(RunDetail),
    Locked { permission: &'static str },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// "#rrggbb".
    pub color: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// added, modified, removed, renamed…, as GitHub says.
    pub status: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    /// The unified diff of the file, as GitHub gives it; None for a binary
    /// file or one too large for GitHub to diff.
    pub patch: Option<String>,
    /// The patch was cut to MAX_PATCH; the whole of it is on GitHub.
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub login: String,
    /// approved, changes requested, commented or dismissed.
    pub state: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullDetail {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    /// open, draft, merged or closed.
    pub state: &'static str,
    pub author: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    pub commits: i64,
    pub comments: i64,
    /// approved, changes requested or review required.
    pub review: Option<&'static str>,
    pub reviewers: Vec<Review>,
    pub labels: Vec<Label>,
    /// The files touched, each with its diff.
    pub files: Vec<FileChange>,
    pub created_at: Option<String>,
    pub merged_at: Option<String>,
    pub merged_by: Option<String>,
    pub closed_at: Option<String>,
    /// The newest Actions run on the pull request's last commit.
    pub ci: Option<Build>,
    /// "actions" when the token may not read the runs.
    pub missing: Vec<&'static str>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    /// open, completed, not planned or closed.
    pub state: &'static str,
    pub author: Option<String>,
    pub body: Option<String>,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub comments: i64,
    pub created_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitLine {
    /// Seven characters, to show.
    pub sha: String,
    /// The whole SHA, to open the commit's own sheet.
    pub id: String,
    /// The first line of the message.
    pub message: String,
    pub author: Option<String>,
    pub at: Option<String>,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitsDetail {
    pub repo: String,
    pub branch: Option<String>,
    /// How many commits the push or the day counted; `commits` may show fewer.
    pub total: Option<u64>,
    /// Newest first.
    pub commits: Vec<CommitLine>,
    /// What the newest commit changed, file by file with its diff.
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub files: Vec<FileChange>,
    /// The newest Actions run on the newest commit.
    pub ci: Option<Build>,
    /// Where GitHub shows the same commits.
    pub url: String,
    pub missing: Vec<&'static str>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub downloads: i64,
    /// Bytes.
    pub size: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetail {
    pub repo: String,
    pub tag: String,
    pub name: String,
    pub url: String,
    /// The release notes as plain text, cut short.
    pub body: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
    pub downloads: i64,
}

/// A run, its jobs, and each job's steps, with when each one started and
/// ended: how long everything took is worked out from those, by the island.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub repo: String,
    pub id: u64,
    pub workflow: String,
    /// The commit or pull request title the run is about.
    pub title: Option<String>,
    pub branch: Option<String>,
    /// What started it: push, pull_request, schedule, workflow_dispatch…
    pub event: Option<String>,
    pub actor: Option<String>,
    /// success, failure, running or neutral — the colour.
    pub state: &'static str,
    /// passed, failed, running, queued, cancelled, skipped… — the word.
    pub outcome: &'static str,
    /// 2 and up for a re-run.
    pub attempt: u64,
    pub url: String,
    pub started_at: Option<String>,
    /// None while it runs.
    pub ended_at: Option<String>,
    pub jobs: Vec<Job>,
    /// Jobs of the run beyond the ones carried.
    pub more_jobs: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    pub name: String,
    pub state: &'static str,
    pub outcome: &'static str,
    /// The job's page on GitHub, with its logs.
    pub url: String,
    /// The machine it asked for, e.g. "ubuntu-latest".
    pub runner: Option<String>,
    /// None while it waits for a runner.
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub steps: Vec<Step>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub number: u64,
    pub name: String,
    pub state: &'static str,
    pub outcome: &'static str,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

const TTL: u64 = 60;
/// A run still going is worth asking again sooner: its jobs finish one by one.
const LIVE_TTL: u64 = 10;
/// Jobs carried per run; a matrix can have hundreds.
const MAX_JOBS: usize = 30;
/// Descriptions and notes are a taste, not the whole text: GitHub has that.
const EXCERPT: usize = 320;
/// Files carried per sheet, and the most of one file's diff: enough to read on
/// a small panel, without shipping a whole refactor through the island.
const MAX_FILES: usize = 20;
const MAX_PATCH: usize = 12_000;
const MAX_COMMITS: u64 = 10;

static CACHE: LazyLock<Mutex<HashMap<String, (u64, Detail)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

const PULL_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { \
    number title url state isDraft merged mergedAt createdAt closedAt \
    additions deletions changedFiles baseRefName headRefName headRefOid reviewDecision \
    author { login } mergedBy { login } commits { totalCount } comments { totalCount } \
    latestReviews(first: 6) { nodes { state author { login } } } \
    labels(first: 6) { nodes { name color } } } } }";

const ISSUE_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
    repository(owner: $owner, name: $name) { issue(number: $number) { \
    number title url state stateReason createdAt closedAt bodyText author { login } \
    comments { totalCount } labels(first: 6) { nodes { name color } } \
    assignees(first: 4) { nodes { login } } } } }";

pub async fn detail(target: Target, force: bool) -> Result<Detail, String> {
    let key = serde_json::to_string(&target).map_err(|e| e.to_string())?;
    let now = unix_now();
    if !force {
        if let Some((at, cached)) = CACHE.lock().unwrap().get(&key) {
            if now.saturating_sub(*at) < ttl(cached) {
                return Ok(cached.clone());
            }
        }
    }

    let gh = Gh::from_store().map_err(|e| e.message())?;
    let fetched = match &target {
        Target::Pull { repo, number } => pull(&gh, repo, *number).await,
        Target::Issue { repo, number } => issue(&gh, repo, *number).await,
        Target::Commits { repo, head, count, branch, author, from, to } => {
            commits(&gh, repo, head.as_deref(), *count, branch.clone(), author.as_deref(), from.as_deref(), to.as_deref()).await
        }
        Target::Release { repo, tag } => release(&gh, repo, tag).await,
        Target::Run { repo, id } => run(&gh, repo, *id).await,
        Target::Project { .. } => Err(GhError::BadResponse),
    };
    let detail = fetched.map_err(|e| e.message())?;
    CACHE.lock().unwrap().insert(key, (now, detail.clone()));
    Ok(detail)
}

fn ttl(detail: &Detail) -> u64 {
    match detail {
        Detail::Run(run) if run.state == "running" => LIVE_TTL,
        _ => TTL,
    }
}

fn owner_name(repo: &str) -> Result<(&str, &str), GhError> {
    split_full_name(repo).ok_or(GhError::NotFound)
}

/// The newest Actions run on a commit. A token that may not read Actions
/// leaves the sheet without CI rather than without everything.
async fn ci_for(gh: &Gh, repo: &str, sha: &str, missing: &mut Vec<&'static str>) -> Result<Option<Build>, GhError> {
    match gh.get(&format!("/repos/{repo}/actions/runs?head_sha={sha}&per_page=1")).await {
        Ok(reply) => Ok(parse_run(&reply.json)),
        Err(GhError::Forbidden) => {
            missing.push("actions");
            Ok(None)
        }
        Err(GhError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

// ── Pull request ──────────────────────────────────────────────────────────────

async fn pull(gh: &Gh, repo: &str, number: u64) -> Result<Detail, GhError> {
    let (owner, name) = owner_name(repo)?;
    let (data, _) = gh
        .graphql_with(PULL_QUERY, json!({ "owner": owner, "name": name, "number": number }))
        .await
        .or_else(locked_on_refusal)?;
    let Some(node) = data.pointer("/repository/pullRequest").filter(|n| !n.is_null()) else {
        return Ok(Detail::Locked { permission: "Pull requests" });
    };
    let mut detail = parse_pull(repo, node).ok_or(GhError::BadResponse)?;
    // The files with their diffs: GraphQL has no patch, the REST list does.
    match gh.get(&format!("/repos/{repo}/pulls/{number}/files?per_page={MAX_FILES}")).await {
        Ok(reply) => detail.files = files(Some(&reply.json)),
        Err(GhError::Forbidden) | Err(GhError::NotFound) => {}
        Err(e) => return Err(e),
    }
    if let Some(sha) = text(node.get("headRefOid")) {
        detail.ci = ci_for(gh, repo, &sha, &mut detail.missing).await?;
    }
    Ok(Detail::Pull(Box::new(detail)))
}

/// A GraphQL query refused as a whole reads as "no data", which the callers
/// turn into a locked sheet.
fn locked_on_refusal(e: GhError) -> Result<(Value, Vec<Value>), GhError> {
    match e {
        GhError::Forbidden | GhError::NotFound => Ok((Value::Null, Vec::new())),
        other => Err(other),
    }
}

fn labels(node: &Value) -> Vec<Label> {
    node.pointer("/labels/nodes")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|l| {
                    Some(Label {
                        name: text(l.get("name"))?,
                        color: format!("#{}", text(l.get("color")).unwrap_or_else(|| "6b7079".into())),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `files` of a REST commit or pull request answer.
fn files(list: Option<&Value>) -> Vec<FileChange> {
    list.and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|f| {
                    let (patch, truncated) = match text(f.get("patch")) {
                        Some(p) => cut_patch(p),
                        None => (None, false),
                    };
                    Some(FileChange {
                        path: text(f.get("filename"))?,
                        status: text(f.get("status")),
                        additions: f.get("additions").and_then(Value::as_i64).unwrap_or(0),
                        deletions: f.get("deletions").and_then(Value::as_i64).unwrap_or(0),
                        patch,
                        truncated,
                    })
                })
                .take(MAX_FILES)
                .collect()
        })
        .unwrap_or_default()
}

/// A patch cut at a line boundary before MAX_PATCH, and whether it was cut.
fn cut_patch(patch: String) -> (Option<String>, bool) {
    if patch.len() <= MAX_PATCH {
        return (Some(patch), false);
    }
    let mut end = MAX_PATCH;
    while !patch.is_char_boundary(end) {
        end -= 1;
    }
    let cut = patch[..end].rfind('\n').map_or(&patch[..end], |i| &patch[..i]);
    (Some(cut.to_string()), true)
}

fn parse_pull(repo: &str, node: &Value) -> Option<PullDetail> {
    let merged = node.get("merged").and_then(Value::as_bool).unwrap_or(false);
    let state = match (merged, node.get("state").and_then(Value::as_str)) {
        (true, _) => "merged",
        (false, Some("CLOSED")) => "closed",
        _ if node.get("isDraft").and_then(Value::as_bool).unwrap_or(false) => "draft",
        _ => "open",
    };
    let review = match node.get("reviewDecision").and_then(Value::as_str) {
        Some("APPROVED") => Some("approved"),
        Some("CHANGES_REQUESTED") => Some("changes requested"),
        Some("REVIEW_REQUIRED") => Some("review required"),
        _ => None,
    };
    let reviewers = node
        .pointer("/latestReviews/nodes")
        .and_then(Value::as_array)
        .map(|reviews| {
            reviews
                .iter()
                .filter_map(|r| {
                    let state = match r.get("state").and_then(Value::as_str)? {
                        "APPROVED" => "approved",
                        "CHANGES_REQUESTED" => "changes requested",
                        "COMMENTED" => "commented",
                        "DISMISSED" => "dismissed",
                        _ => return None,
                    };
                    Some(Review { login: text(r.pointer("/author/login"))?, state })
                })
                .collect()
        })
        .unwrap_or_default();
    let count = |path: &str| node.pointer(path).and_then(Value::as_i64).unwrap_or(0);
    Some(PullDetail {
        repo: repo.to_string(),
        number: node.get("number")?.as_u64()?,
        title: text(node.get("title")).unwrap_or_else(|| "Untitled".into()),
        url: text(node.get("url"))?,
        state,
        author: text(node.pointer("/author/login")),
        base: text(node.get("baseRefName")),
        head: text(node.get("headRefName")),
        additions: count("/additions"),
        deletions: count("/deletions"),
        changed_files: count("/changedFiles"),
        commits: count("/commits/totalCount"),
        comments: count("/comments/totalCount"),
        review,
        reviewers,
        labels: labels(node),
        files: Vec::new(),
        created_at: text(node.get("createdAt")),
        merged_at: text(node.get("mergedAt")),
        merged_by: text(node.pointer("/mergedBy/login")),
        closed_at: text(node.get("closedAt")),
        ci: None,
        missing: Vec::new(),
    })
}

// ── Issue ─────────────────────────────────────────────────────────────────────

async fn issue(gh: &Gh, repo: &str, number: u64) -> Result<Detail, GhError> {
    let (owner, name) = owner_name(repo)?;
    let (data, _) = gh
        .graphql_with(ISSUE_QUERY, json!({ "owner": owner, "name": name, "number": number }))
        .await
        .or_else(locked_on_refusal)?;
    let Some(node) = data.pointer("/repository/issue").filter(|n| !n.is_null()) else {
        return Ok(Detail::Locked { permission: "Issues" });
    };
    parse_issue(repo, node).map(Detail::Issue).ok_or(GhError::BadResponse)
}

fn parse_issue(repo: &str, node: &Value) -> Option<IssueDetail> {
    let state = match (node.get("state").and_then(Value::as_str), node.get("stateReason").and_then(Value::as_str)) {
        (Some("OPEN"), _) => "open",
        (_, Some("COMPLETED")) => "completed",
        (_, Some("NOT_PLANNED")) => "not planned",
        _ => "closed",
    };
    Some(IssueDetail {
        repo: repo.to_string(),
        number: node.get("number")?.as_u64()?,
        title: text(node.get("title")).unwrap_or_else(|| "Untitled".into()),
        url: text(node.get("url"))?,
        state,
        author: text(node.pointer("/author/login")),
        body: text(node.get("bodyText")).map(|b| excerpt(&b)),
        labels: labels(node),
        assignees: node
            .pointer("/assignees/nodes")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|n| text(n.get("login"))).collect())
            .unwrap_or_default(),
        comments: node.pointer("/comments/totalCount").and_then(Value::as_i64).unwrap_or(0),
        created_at: text(node.get("createdAt")),
        closed_at: text(node.get("closedAt")),
    })
}

// ── Commits ───────────────────────────────────────────────────────────────────

fn is_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_login(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A timestamp for a query string: `+` would read as a space.
fn query_time(s: &str) -> String {
    s.replace('+', "%2B")
}

#[allow(clippy::too_many_arguments)]
async fn commits(
    gh: &Gh,
    repo: &str,
    head: Option<&str>,
    count: Option<u64>,
    branch: Option<String>,
    author: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Detail, GhError> {
    owner_name(repo)?;
    let (list_path, url) = match (head, author, from, to) {
        (Some(sha), _, _, _) if is_sha(sha) => {
            let n = count.unwrap_or(1).clamp(1, MAX_COMMITS);
            (format!("/repos/{repo}/commits?sha={sha}&per_page={n}"), format!("https://github.com/{repo}/commits/{sha}"))
        }
        (None, Some(login), Some(from), Some(to)) if is_login(login) && is_timestamp(from) && is_timestamp(to) => {
            let window = format!("author={login}&since={}&until={}", query_time(from), query_time(to));
            (
                format!("/repos/{repo}/commits?{window}&per_page={MAX_COMMITS}"),
                format!("https://github.com/{repo}/commits?{window}"),
            )
        }
        _ => return Err(GhError::NotFound),
    };

    let list = match gh.get(&list_path).await {
        Ok(reply) => reply.json,
        // A private repository's commits need Contents; GitHub answers 404 as
        // often as 403 for what a token may not see.
        Err(GhError::Forbidden) | Err(GhError::NotFound) => return Ok(Detail::Locked { permission: "Contents" }),
        Err(e) => return Err(e),
    };
    let lines = parse_commit_lines(&list);

    let mut detail = CommitsDetail {
        repo: repo.to_string(),
        branch,
        total: count,
        commits: lines,
        additions: None,
        deletions: None,
        files: Vec::new(),
        ci: None,
        url,
        missing: Vec::new(),
    };

    // What the newest one changed, and whether it built.
    if let Some(newest) = list.pointer("/0/sha").and_then(Value::as_str).map(str::to_string) {
        if let Ok(reply) = gh.get(&format!("/repos/{repo}/commits/{newest}")).await {
            detail.additions = reply.json.pointer("/stats/additions").and_then(Value::as_i64);
            detail.deletions = reply.json.pointer("/stats/deletions").and_then(Value::as_i64);
            detail.files = files(reply.json.get("files"));
        }
        detail.ci = ci_for(gh, repo, &newest, &mut detail.missing).await?;
    }
    Ok(Detail::Commits(detail))
}

fn parse_commit_lines(list: &Value) -> Vec<CommitLine> {
    list.as_array()
        .map(|commits| {
            commits
                .iter()
                .filter_map(|c| {
                    let sha = text(c.get("sha"))?;
                    Some(CommitLine {
                        message: text(c.pointer("/commit/message"))
                            .and_then(|m| m.lines().next().map(str::to_string))
                            .unwrap_or_default(),
                        author: text(c.pointer("/author/login")).or_else(|| text(c.pointer("/commit/author/name"))),
                        at: text(c.pointer("/commit/author/date")),
                        url: text(c.get("html_url")).unwrap_or_default(),
                        sha: sha.chars().take(7).collect(),
                        id: sha,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ── Release ───────────────────────────────────────────────────────────────────

fn is_tag(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-+/".contains(c))
}

async fn release(gh: &Gh, repo: &str, tag: &str) -> Result<Detail, GhError> {
    owner_name(repo)?;
    if !is_tag(tag) {
        return Err(GhError::NotFound);
    }
    let path_tag = tag.replace('/', "%2F").replace('+', "%2B");
    match gh.get(&format!("/repos/{repo}/releases/tags/{path_tag}")).await {
        Ok(reply) => parse_release(repo, tag, &reply.json).map(Detail::Release).ok_or(GhError::BadResponse),
        Err(GhError::Forbidden) | Err(GhError::NotFound) => Ok(Detail::Locked { permission: "Contents" }),
        Err(e) => Err(e),
    }
}

fn parse_release(repo: &str, tag: &str, json: &Value) -> Option<ReleaseDetail> {
    let assets: Vec<Asset> = json
        .get("assets")
        .and_then(Value::as_array)
        .map(|assets| {
            assets
                .iter()
                .filter_map(|a| {
                    Some(Asset {
                        name: text(a.get("name"))?,
                        downloads: a.get("download_count").and_then(Value::as_i64).unwrap_or(0),
                        size: a.get("size").and_then(Value::as_i64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ReleaseDetail {
        repo: repo.to_string(),
        tag: tag.to_string(),
        name: text(json.get("name")).unwrap_or_else(|| tag.to_string()),
        url: text(json.get("html_url"))?,
        body: text(json.get("body")).map(|b| excerpt(&plain(&b))),
        author: text(json.pointer("/author/login")),
        published_at: text(json.get("published_at")),
        prerelease: json.get("prerelease").and_then(Value::as_bool).unwrap_or(false),
        downloads: assets.iter().map(|a| a.downloads).sum(),
        assets: assets.into_iter().take(5).collect(),
    })
}

// ── Run of Actions ────────────────────────────────────────────────────────────

async fn run(gh: &Gh, repo: &str, id: u64) -> Result<Detail, GhError> {
    owner_name(repo)?;
    // The run says what it was about; its jobs, with their steps, say how long
    // each part took.
    let run = match gh.get(&format!("/repos/{repo}/actions/runs/{id}")).await {
        Ok(reply) => reply.json,
        // A private repository's runs need Actions; GitHub answers 404 as often
        // as 403 for what a token may not see.
        Err(GhError::Forbidden) | Err(GhError::NotFound) => return Ok(Detail::Locked { permission: "Actions" }),
        Err(e) => return Err(e),
    };
    let jobs = match gh.get(&format!("/repos/{repo}/actions/runs/{id}/jobs?per_page={MAX_JOBS}")).await {
        Ok(reply) => reply.json,
        Err(GhError::Forbidden) | Err(GhError::NotFound) => Value::Null,
        Err(e) => return Err(e),
    };
    parse_run_detail(repo, &run, &jobs).map(Detail::Run).ok_or(GhError::BadResponse)
}

/// The word for a run, a job or a step, finer than its colour: a cancelled run
/// and a skipped step are both grey, but not the same news.
fn outcome(status: &str, conclusion: Option<&str>) -> &'static str {
    match status {
        "completed" => match conclusion {
            Some("success") => "passed",
            Some("failure") => "failed",
            Some("timed_out") => "timed out",
            Some("startup_failure") => "failed to start",
            Some("cancelled") => "cancelled",
            Some("skipped") => "skipped",
            Some("action_required") => "waiting for approval",
            _ => "stopped",
        },
        "queued" | "requested" | "pending" => "queued",
        "waiting" => "waiting",
        _ => "running",
    }
}

/// (state, outcome) of a run, a job or a step: the colour and the word.
fn states(node: &Value) -> (&'static str, &'static str) {
    let status = node.get("status").and_then(Value::as_str).unwrap_or("completed");
    let conclusion = node.get("conclusion").and_then(Value::as_str);
    (build_state(status, conclusion), outcome(status, conclusion))
}

/// The start of something still waiting for its turn. GitHub gives a queued
/// job a start time already; drawn, it would look like it was running.
fn start(node: &Value, outcome: &str) -> Option<String> {
    if matches!(outcome, "queued" | "waiting") {
        return None;
    }
    text(node.get("started_at"))
}

fn parse_run_detail(repo: &str, run: &Value, jobs: &Value) -> Option<RunDetail> {
    let (state, outcome) = states(run);
    let list: Vec<Job> = jobs
        .get("jobs")
        .and_then(Value::as_array)
        .map(|jobs| jobs.iter().filter_map(parse_job).take(MAX_JOBS).collect())
        .unwrap_or_default();
    let total = jobs.get("total_count").and_then(Value::as_u64).unwrap_or(list.len() as u64);
    // A finished run ends with its last job. `updated_at` moves on afterwards
    // (logs expiring, a re-run's bookkeeping), so it is only the fallback.
    let ended_at = if state == "running" {
        None
    } else {
        list.iter()
            .filter_map(|j| j.ended_at.clone())
            .max()
            .or_else(|| text(run.get("updated_at")))
    };
    Some(RunDetail {
        repo: repo.to_string(),
        id: run.get("id")?.as_u64()?,
        workflow: text(run.get("name")).unwrap_or_else(|| "Workflow".into()),
        title: text(run.get("display_title"))
            .or_else(|| text(run.pointer("/head_commit/message")))
            .and_then(|t| t.lines().next().map(str::to_string)),
        branch: text(run.get("head_branch")),
        event: text(run.get("event")),
        actor: text(run.pointer("/triggering_actor/login")).or_else(|| text(run.pointer("/actor/login"))),
        state,
        outcome,
        attempt: run.get("run_attempt").and_then(Value::as_u64).unwrap_or(1),
        url: text(run.get("html_url"))?,
        started_at: text(run.get("run_started_at")),
        ended_at,
        more_jobs: total.saturating_sub(list.len() as u64),
        jobs: list,
    })
}

fn parse_job(job: &Value) -> Option<Job> {
    let (state, outcome) = states(job);
    let steps = job
        .get("steps")
        .and_then(Value::as_array)
        .map(|steps| steps.iter().filter_map(parse_step).collect())
        .unwrap_or_default();
    Some(Job {
        id: job.get("id")?.as_u64()?,
        name: text(job.get("name")).unwrap_or_else(|| "Job".into()),
        state,
        outcome,
        url: text(job.get("html_url"))?,
        runner: job.pointer("/labels/0").and_then(|l| text(Some(l))),
        started_at: start(job, outcome),
        ended_at: text(job.get("completed_at")),
        steps,
    })
}

fn parse_step(step: &Value) -> Option<Step> {
    let (state, outcome) = states(step);
    Some(Step {
        number: step.get("number")?.as_u64()?,
        name: text(step.get("name"))?,
        state,
        outcome,
        started_at: start(step, outcome),
        ended_at: text(step.get("completed_at")),
    })
}

// ── Text ──────────────────────────────────────────────────────────────────────

/// Markdown release notes read as plain text: headings, emphasis, code
/// marks, quotes and list bullets dropped, a link kept as its words.
fn plain(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    for line in markdown.lines() {
        let line = line
            .trim_start()
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim_start();
        let line = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .unwrap_or(line);
        let mut rest = line;
        while let Some(open) = rest.find('[') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            match (after.find("]("), after.find(')')) {
                (Some(close), Some(end)) if close < end => {
                    out.push_str(&after[..close]);
                    rest = &after[end + 1..];
                }
                _ => {
                    out.push('[');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out.push('\n');
    }
    out.replace(['*', '`', '_'], "")
}

/// One paragraph, whitespace collapsed, cut at a word near EXCERPT characters.
fn excerpt(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT {
        return flat;
    }
    let cut: String = flat.chars().take(EXCERPT).collect();
    let at_word = cut.rfind(' ').map_or(cut.as_str(), |i| &cut[..i]);
    format!("{at_word}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_travels_as_the_island_sends_it_back() {
        let push = json!({ "kind": "commits", "repo": "edu/coucou", "head": "abc1234", "count": 3, "branch": "main", "author": null, "from": null, "to": null });
        let target: Target = serde_json::from_value(push).unwrap();
        assert_eq!(target, Target::Commits {
            repo: "edu/coucou".into(), head: Some("abc1234".into()), count: Some(3), branch: Some("main".into()),
            author: None, from: None, to: None,
        });
        let pull = serde_json::to_value(Target::Pull { repo: "edu/coucou".into(), number: 12 }).unwrap();
        assert_eq!(pull, json!({ "kind": "pull", "repo": "edu/coucou", "number": 12 }));
    }

    #[test]
    fn a_pull_request_sheet_reads_every_part() {
        let node = json!({
            "number": 12, "title": "Panel", "url": "https://github.com/edu/coucou/pull/12",
            "state": "MERGED", "isDraft": false, "merged": true, "mergedAt": "2026-09-30T18:00:00Z",
            "createdAt": "2026-09-28T10:00:00Z", "closedAt": "2026-09-30T18:00:00Z",
            "additions": 320, "deletions": 40, "changedFiles": 9,
            "baseRefName": "main", "headRefName": "windows-github-panel", "reviewDecision": "APPROVED",
            "author": { "login": "edu" }, "mergedBy": { "login": "louis" },
            "commits": { "totalCount": 5 }, "comments": { "totalCount": 3 },
            "latestReviews": { "nodes": [
                { "state": "APPROVED", "author": { "login": "louis" } },
                { "state": "PENDING", "author": { "login": "ghost" } },
            ]},
            "labels": { "nodes": [{ "name": "windows", "color": "0e8a16" }] },
        });
        let pr = parse_pull("edu/coucou", &node).unwrap();
        assert_eq!((pr.state, pr.review, pr.merged_by.as_deref()), ("merged", Some("approved"), Some("louis")));
        assert_eq!((pr.base.as_deref(), pr.head.as_deref()), (Some("main"), Some("windows-github-panel")));
        assert_eq!((pr.commits, pr.comments, pr.changed_files), (5, 3, 9));
        assert_eq!(pr.reviewers, [Review { login: "louis".into(), state: "approved" }]);
        assert_eq!(pr.labels, [Label { name: "windows".into(), color: "#0e8a16".into() }]);
    }

    #[test]
    fn files_carry_their_diff_and_a_huge_one_is_cut_on_a_line() {
        let list = json!([
            { "filename": "a.rs", "status": "modified", "additions": 1, "deletions": 1, "patch": "@@ -1 +1 @@\n-old\n+new" },
            { "filename": "logo.png", "status": "added", "additions": 0, "deletions": 0 },
        ]);
        let f = files(Some(&list));
        assert_eq!((f[0].path.as_str(), f[0].status.as_deref(), f[0].truncated), ("a.rs", Some("modified"), false));
        assert_eq!(f[0].patch.as_deref(), Some("@@ -1 +1 @@\n-old\n+new"));
        assert_eq!(f[1].patch, None);

        let huge = "+line\n".repeat(MAX_PATCH);
        let (cut, truncated) = cut_patch(huge);
        let cut = cut.unwrap();
        assert!(truncated && cut.len() <= MAX_PATCH && cut.ends_with("+line"));
    }

    #[test]
    fn an_issue_says_how_it_was_closed() {
        let issue = |state: &str, reason: Value| json!({
            "number": 4, "title": "Crash", "url": "https://github.com/edu/coucou/issues/4",
            "state": state, "stateReason": reason,
        });
        assert_eq!(parse_issue("r/r", &issue("OPEN", Value::Null)).unwrap().state, "open");
        assert_eq!(parse_issue("r/r", &issue("CLOSED", json!("COMPLETED"))).unwrap().state, "completed");
        assert_eq!(parse_issue("r/r", &issue("CLOSED", json!("NOT_PLANNED"))).unwrap().state, "not planned");
        assert_eq!(parse_issue("r/r", &issue("CLOSED", Value::Null)).unwrap().state, "closed");
    }

    #[test]
    fn commit_lines_keep_the_first_line_and_a_short_sha() {
        let list = json!([{
            "sha": "abcdef1234567890", "html_url": "https://github.com/edu/coucou/commit/abcdef1",
            "author": { "login": "edu" },
            "commit": { "message": "Fix the hook\n\nBecause.", "author": { "name": "Edu", "date": "2026-09-30T10:00:00Z" } },
        }, {
            "sha": "1234567aaaa", "author": null,
            "commit": { "message": "Anonymous", "author": { "name": "Someone", "date": "2026-09-30T09:00:00Z" } },
        }]);
        let lines = parse_commit_lines(&list);
        assert_eq!((lines[0].sha.as_str(), lines[0].message.as_str(), lines[0].author.as_deref()), ("abcdef1", "Fix the hook", Some("edu")));
        assert_eq!(lines[0].id, "abcdef1234567890");
        assert_eq!(lines[1].author.as_deref(), Some("Someone"));
    }

    #[test]
    fn a_release_adds_its_downloads() {
        let json = json!({
            "name": "", "html_url": "https://github.com/edu/coucou/releases/tag/v1", "prerelease": true,
            "body": "## What's new\n- **Faster** [panel](https://x.y)\n",
            "author": { "login": "edu" }, "published_at": "2026-09-30T10:00:00Z",
            "assets": [{ "name": "a.exe", "download_count": 40, "size": 1000 }, { "name": "b.zip", "download_count": 2, "size": 10 }],
        });
        let r = parse_release("edu/coucou", "v1", &json).unwrap();
        assert_eq!((r.name.as_str(), r.downloads, r.prerelease), ("v1", 42, true));
        assert_eq!(r.body.as_deref(), Some("What's new Faster panel"));
    }

    #[test]
    fn only_plain_values_reach_a_url() {
        assert!(is_sha("abc1234") && is_sha("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_sha("abc") && !is_sha("abc123z") && !is_sha("abc1234&x=1"));
        assert!(is_login("louis-cfm") && !is_login("a b") && !is_login("x&y"));
        assert!(is_tag("v0.1.1") && is_tag("windows/v1") && !is_tag("v1?x") && !is_tag("../x y"));
        assert_eq!(query_time("2026-09-30T00:00:00+02:00"), "2026-09-30T00:00:00%2B02:00");
    }

    #[test]
    fn a_run_carries_each_job_and_step_with_its_times() {
        let run = json!({
            "id": 77, "name": "CI", "display_title": "Fix the hook\n\nBody", "head_branch": "main",
            "event": "push", "status": "completed", "conclusion": "failure", "run_attempt": 2,
            "html_url": "https://github.com/edu/coucou/actions/runs/77",
            "run_started_at": "2026-09-30T10:00:00Z", "updated_at": "2026-09-30T11:30:00Z",
            "actor": { "login": "edu" },
        });
        let jobs = json!({ "total_count": 3, "jobs": [
            {
                "id": 1, "name": "build", "status": "completed", "conclusion": "success",
                "html_url": "https://github.com/edu/coucou/actions/runs/77/job/1", "labels": ["ubuntu-latest"],
                "started_at": "2026-09-30T10:00:05Z", "completed_at": "2026-09-30T10:02:00Z",
                "steps": [
                    { "number": 1, "name": "Set up job", "status": "completed", "conclusion": "success",
                      "started_at": "2026-09-30T10:00:05Z", "completed_at": "2026-09-30T10:00:08Z" },
                    { "number": 2, "name": "Lint", "status": "completed", "conclusion": "skipped",
                      "started_at": null, "completed_at": null },
                ],
            },
            {
                "id": 2, "name": "test", "status": "completed", "conclusion": "failure",
                "html_url": "https://github.com/edu/coucou/actions/runs/77/job/2",
                "started_at": "2026-09-30T10:02:03Z", "completed_at": "2026-09-30T10:04:40Z", "steps": [],
            },
        ]});
        let r = parse_run_detail("edu/coucou", &run, &jobs).unwrap();
        assert_eq!((r.state, r.outcome, r.attempt, r.more_jobs), ("failure", "failed", 2, 1));
        assert_eq!((r.title.as_deref(), r.actor.as_deref()), (Some("Fix the hook"), Some("edu")));
        // The run ends with its last job, not when GitHub last touched it.
        assert_eq!(r.ended_at.as_deref(), Some("2026-09-30T10:04:40Z"));
        assert_eq!(r.jobs[0].runner.as_deref(), Some("ubuntu-latest"));
        assert_eq!((r.jobs[0].steps[1].state, r.jobs[0].steps[1].outcome), ("neutral", "skipped"));
        assert_eq!((r.jobs[1].state, r.jobs[1].runner.as_deref()), ("failure", None));
    }

    #[test]
    fn a_run_still_going_has_no_end_and_a_queued_job_no_start() {
        let run = json!({
            "id": 78, "name": "CI", "status": "in_progress", "conclusion": null,
            "html_url": "https://github.com/edu/coucou/actions/runs/78",
            "run_started_at": "2026-09-30T10:00:00Z", "updated_at": "2026-09-30T10:01:00Z",
        });
        let jobs = json!({ "total_count": 1, "jobs": [{
            "id": 3, "name": "deploy", "status": "queued", "conclusion": null,
            "html_url": "https://github.com/edu/coucou/actions/runs/78/job/3",
            "started_at": "2026-09-30T10:00:30Z", "completed_at": null,
        }]});
        let r = parse_run_detail("edu/coucou", &run, &jobs).unwrap();
        assert_eq!((r.state, r.outcome, r.ended_at.as_deref()), ("running", "running", None));
        assert_eq!((r.jobs[0].outcome, r.jobs[0].started_at.as_deref()), ("queued", None));
        assert_eq!(ttl(&Detail::Run(r)), LIVE_TTL);

        // The jobs refused: the run still says what it was.
        let bare = parse_run_detail("edu/coucou", &run, &Value::Null).unwrap();
        assert!(bare.jobs.is_empty() && bare.more_jobs == 0);
    }

    #[test]
    fn a_run_target_travels_by_its_id() {
        let target: Target = serde_json::from_value(json!({ "kind": "run", "repo": "edu/coucou", "id": 77 })).unwrap();
        assert_eq!(target, Target::Run { repo: "edu/coucou".into(), id: 77 });
    }

    #[test]
    fn long_text_is_cut_at_a_word() {
        let long = "word ".repeat(200);
        let cut = excerpt(&long);
        assert!(cut.ends_with('…'));
        assert!(cut.chars().count() <= EXCERPT + 1);
        assert!(!cut.contains("  "));
    }
}
