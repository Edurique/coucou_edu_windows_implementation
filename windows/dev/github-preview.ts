// Dev harness: the real island with made-up GitHub data, in a plain browser, so
// the card and the panel can be looked at without a token or the Rust side.
// Not part of the app bundle. `npm run dev`, then /dev/github-preview.html.

import "../src/style.css";
import {
  Bridge, type GithubActivity, type GithubBuild, type GithubData, type GithubDay, type GithubDetail,
  type GithubFile, type GithubJob, type GithubProject, type GithubRepo, type GithubRunDetail, type GithubStep, type GithubTarget,
} from "../src/core/bridge";
import { State } from "../src/core/state";
import { Island } from "../src/island/island";

const params = new URLSearchParams(location.search);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const pullTarget = (repo: string, number: number): GithubTarget => ({ kind: "pull", repo, number });
const pushTarget = (repo: string, count: number, branch: string): GithubTarget => ({
  kind: "commits", repo, head: "a1b2c3d4e5f6", count, branch, author: null, from: null, to: null,
});

const activity: GithubActivity[] = [
  { id: "1", kind: "pr_merged", repo: "mochi/coucou", title: "GitHub panel for the Windows island", detail: "#12", url: "https://github.com", at: minutesAgo(4), target: pullTarget("mochi/coucou", 12) },
  { id: "2", kind: "push", repo: "mochi/coucou", title: "Keep the last snapshot through an error", detail: "3 commits · windows-github-panel", url: "https://github.com", at: minutesAgo(38), target: pushTarget("mochi/coucou", 3, "windows-github-panel") },
  { id: "3", kind: "pr_opened", repo: "mochi/coucou", title: "Windows: GitHub panel", detail: "#12", url: "https://github.com", at: minutesAgo(95), target: pullTarget("mochi/coucou", 12) },
  { id: "4", kind: "issue_opened", repo: "louis-cfm/coucou", title: "Defender flags the installer", detail: "#9", url: "https://github.com", at: minutesAgo(60 * 5), target: { kind: "issue", repo: "louis-cfm/coucou", number: 9 } },
  { id: "5", kind: "release", repo: "mochi/tour-convention-geneve", title: "Sprint 3", detail: "v0.3.0", url: "https://github.com", at: minutesAgo(60 * 26), target: { kind: "release", repo: "mochi/tour-convention-geneve", tag: "v0.3.0" } },
  { id: "6", kind: "issue_closed", repo: "mochi/tour-convention-geneve", title: "Map tiles flicker on zoom", detail: "#41", url: "https://github.com", at: minutesAgo(60 * 50), target: { kind: "issue", repo: "mochi/tour-convention-geneve", number: 41 } },
  { id: "7", kind: "pr_closed", repo: "mochi/dotfiles", title: "Try another prompt theme", detail: "#3", url: "https://github.com", at: minutesAgo(60 * 72), target: pullTarget("mochi/dotfiles", 3) },
  { id: "8", kind: "create", repo: "mochi/sandbox", title: "Created the repository", detail: null, url: "https://github.com", at: minutesAgo(60 * 24 * 6), target: { kind: "project", repo: "mochi/sandbox" } },
  { id: "9", kind: "push", repo: "mochi/sandbox", title: "Pushed", detail: "main", url: "https://github.com", at: minutesAgo(60 * 24 * 6), target: pushTarget("mochi/sandbox", 1, "main") },
];

// The sheets behind those lines, one per kind, with a real-looking diff.
const PATCH = [
  "@@ -12,9 +12,14 @@ export function enterGithubPanel() {",
  "   sweepNext = true;",
  "-  if (sheet) closeSheet();",
  "-  else touchSheet();",
  "+  if (day) stopSearching(day);",
  "+  day = null;",
  "+  clearStack();",
  "+  touch();",
  "   const d = githubData();",
  "   if (!d || Date.now() - d.fetchedAt > STALE_MS) void Bridge.refreshIntegration(ID);",
  " }",
  "@@ -40,6 +45,8 @@ function eventRow(",
  "   const style = ACTIVITY_STYLE[item.kind];",
  "+  // A line of activity opens its sheet; GitHub is the last resort.",
  "+  const open = () => openTarget(item.target, item.title, item.url);",
  "   return h(",
  "\\ No newline at end of file",
].join("\n");
const files: GithubFile[] = [
  { path: "windows/src/views/github.ts", status: "modified", additions: 612, deletions: 58, patch: PATCH, truncated: true },
  { path: "windows/src-tauri/src/github_detail.rs", status: "added", additions: 540, deletions: 0, patch: PATCH, truncated: false },
  { path: "windows/src/style.css", status: "modified", additions: 180, deletions: 6, patch: PATCH, truncated: false },
  { path: "windows/screenshots/panel.png", status: "added", additions: 0, deletions: 0, patch: null, truncated: false },
];
const ci = (state: "success" | "failure" | "running" | "neutral"): GithubBuild => ({
  id: 1, state, workflow: "CI", branch: "windows-github-panel", url: "https://github.com", at: minutesAgo(6),
});
// A run with its jobs side by side; `running` catches it halfway.
const live = params.has("running");
const runStart = Date.now() - (live ? 100 : 7 * 60) * 1000;
const t = (s: number) => new Date(runStart + s * 1000).toISOString();
const step = (number: number, name: string, from: number, to: number | null, outcome = "passed"): GithubStep => ({
  number, name, outcome,
  state: outcome === "failed" ? "failure" : outcome === "skipped" ? "neutral" : to == null ? "running" : "success",
  startedAt: outcome === "skipped" ? null : t(from), endedAt: to == null ? null : t(to),
});
const jobs: GithubJob[] = [
  {
    id: 1, name: "lint", state: "success", outcome: "passed", url: "https://github.com", runner: "ubuntu-latest",
    startedAt: t(4), endedAt: t(46),
    steps: [step(1, "Set up job", 4, 6), step(2, "Checkout", 6, 8), step(3, "npm ci", 8, 31), step(4, "Type-check", 31, 45), step(5, "Complete job", 45, 46)],
  },
  {
    id: 2, name: "build (windows)", state: live ? "running" : "success", outcome: live ? "running" : "passed",
    url: "https://github.com", runner: "windows-latest", startedAt: t(5), endedAt: live ? null : t(212),
    steps: [
      step(1, "Set up job", 5, 9), step(2, "Checkout", 9, 12), step(3, "Set up Rust", 12, 41), step(4, "Restore cache", 41, 52),
      live ? step(5, "cargo build --release", 52, null) : step(5, "cargo build --release", 52, 198),
      ...(live ? [] : [step(6, "Save cache", 198, 210), step(7, "Complete job", 210, 212)]),
    ],
  },
  {
    id: 3, name: "test", state: live ? "running" : "failure", outcome: live ? "running" : "failed",
    url: "https://github.com", runner: "ubuntu-latest", startedAt: t(5), endedAt: live ? null : t(141),
    steps: [
      step(1, "Set up job", 5, 7), step(2, "Checkout", 7, 9), step(3, "Set up Rust", 9, 35),
      live ? step(4, "cargo test", 35, null) : step(4, "cargo test", 35, 139, "failed"),
      ...(live ? [] : [step(5, "Upload report", 139, 139, "skipped"), step(6, "Complete job", 139, 141)]),
    ],
  },
  {
    id: 4, name: "deploy", state: live ? "running" : "neutral", outcome: live ? "queued" : "skipped",
    url: "https://github.com", runner: null, startedAt: null, endedAt: null, steps: [],
  },
];
const runDetail: GithubRunDetail = {
  kind: "run", repo: "mochi/coucou", id: 1, workflow: "CI", title: "Keep the last snapshot through an error",
  branch: "windows-github-panel", event: "push", actor: "mochi", attempt: 1, url: "https://github.com",
  state: live ? "running" : "failure", outcome: live ? "running" : "failed",
  startedAt: t(0), endedAt: live ? null : t(212), jobs, moreJobs: 0,
};

const details: Record<GithubTarget["kind"], GithubDetail> = {
  run: runDetail,
  pull: {
    kind: "pull", repo: "mochi/coucou", number: 12, title: "GitHub panel for the Windows island", url: "https://github.com",
    state: "merged", author: "mochi", base: "main", head: "windows-github-panel",
    additions: 1332, deletions: 64, changedFiles: 14, commits: 18, comments: 3, review: "approved",
    reviewers: [{ login: "louis", state: "approved" }, { login: "kirzen", state: "commented" }],
    labels: [{ name: "windows", color: "#0e8a16" }, { name: "enhancement", color: "#a2eeef" }],
    files, createdAt: minutesAgo(60 * 50), mergedAt: minutesAgo(4), mergedBy: "louis", closedAt: minutesAgo(4),
    ci: ci("success"), missing: [],
  },
  issue: {
    kind: "issue", repo: "louis-cfm/coucou", number: 9, title: "Defender flags the installer", url: "https://github.com",
    state: "open", author: "mochi", comments: 4, assignees: ["louis"],
    body: "Windows Defender reports Trojan:Win32/Wacatac.H!ml on the unsigned installer. It's a machine-learning false positive; a report is under review.",
    labels: [{ name: "windows", color: "#0e8a16" }, { name: "bug", color: "#d73a4a" }],
    createdAt: minutesAgo(60 * 5), closedAt: null,
  },
  commits: {
    kind: "commits", repo: "mochi/coucou", branch: "windows-github-panel", total: 3,
    commits: [
      { sha: "a1b2c3d", id: "a1b2c3d4e5f6", message: "Keep the last snapshot through an error", author: "mochi", at: minutesAgo(38), url: "https://github.com" },
      { sha: "9f8e7d6", id: "9f8e7d6c5b4a", message: "Fade the list only while there is more", author: "mochi", at: minutesAgo(52), url: "https://github.com" },
      { sha: "5a4b3c2", id: "5a4b3c2d1e0f", message: "Close the sheet when the panel reopens", author: "mochi", at: minutesAgo(70), url: "https://github.com" },
    ],
    additions: 22, deletions: 4, files: files.slice(0, 2), ci: ci("failure"), url: "https://github.com", missing: [],
  },
  release: {
    kind: "release", repo: "mochi/tour-convention-geneve", tag: "v0.3.0", name: "Sprint 3", url: "https://github.com",
    body: "What's new: the interactive map, the torch relay journal, and the partner pages.", author: "mochi",
    publishedAt: minutesAgo(60 * 26), prerelease: false, downloads: 1284,
    assets: [{ name: "site-build.zip", downloads: 1200, size: 18_400_000 }, { name: "checksums.txt", downloads: 84, size: 512 }],
  },
  project: { kind: "locked", permission: "Contents" },
};
Bridge.githubDetail = async (target) => {
  await new Promise((r) => setTimeout(r, 700));
  return params.has("locked") ? { kind: "locked", permission: "Contents" } : details[target.kind];
};

const repo = (
  name: string, language: [string, string] | null, stars: number, openPrs: number,
  build: GithubRepo["build"], pushedMinutesAgo: number, priv = false,
): GithubRepo => ({
  name, fullName: `mochi/${name}`, url: "https://github.com", private: priv,
  language: language?.[0] ?? null, languageColor: language?.[1] ?? null,
  stars, openPrs, pushedAt: minutesAgo(pushedMinutesAgo), build,
});
const run = (state: "success" | "failure" | "running" | "neutral", m: number) => ({
  id: m, state, workflow: "CI", branch: "main", url: "https://github.com", at: minutesAgo(m),
});

const repos: GithubRepo[] = [
  // A project you contribute to without owning it: shown with its owner.
  { ...repo("coucou", ["Swift", "#F05138"], 1204, 3, run("success", 20), 2), fullName: "louis-cfm/coucou" },
  repo("coucou", ["Rust", "#dea584"], 4, 2, run("running", 1), 4),
  repo("tour-convention-geneve", ["TypeScript", "#3178c6"], 38, 5, run("failure", 50), 50),
  repo("dotfiles", ["Shell", "#89e051"], 12, 0, run("success", 60 * 26), 60 * 26),
  repo("notes", null, 0, 0, null, 60 * 30, true),
  repo("sandbox", ["Python", "#3572A5"], 3, 1, run("neutral", 60 * 24 * 6), 60 * 24 * 6),
  repo("portfolio", ["Astro", "#ff5a03"], 27, 0, run("success", 60 * 24 * 9), 60 * 24 * 9),
];

// A plausible year: quiet weekends, a few busy stretches, a streak up to today.
// Seeded, so every reload draws the same graph.
const today = new Date();
const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
const firstSunday = todayUtc - (new Date(todayUtc).getUTCDay() + 52 * 7) * 86_400_000;
const days = Math.round((todayUtc - firstSunday) / 86_400_000) + 1;
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const counts = Array.from({ length: days }, (_, i) => {
  const weekday = new Date(firstSunday + i * 86_400_000).getUTCDay();
  const busy = Math.sin(i / 23) > 0.3 ? 2.2 : 1;
  const base = weekday === 0 || weekday === 6 ? 0.25 : 1;
  const n = Math.floor(rand() * 6 * busy * base - (rand() < 0.35 ? 3 : 0));
  return i >= days - 6 ? Math.max(1, n) : Math.max(0, n);
});
const level = (n: number) => (n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 8 ? 3 : 4);

const data: GithubData = {
  login: "mochi",
  name: "Mochi",
  profileUrl: "https://github.com",
  totalRepos: 23,
  totalStars: 1284,
  activity: params.has("empty") ? [] : activity,
  repos: params.has("empty") ? [] : repos,
  contributions: {
    total: counts.reduce((a, b) => a + b, 0),
    start: new Date(firstSunday).toISOString().slice(0, 10),
    counts,
    levels: counts.map(level),
  },
  fetchedAt: Date.now() - (params.has("error") ? 12 * 60_000 : 0),
};

// A project's sheet normally comes from Rust; here every project gets this one.
const runState = ["success", "success", "failure", "success", "success", "neutral", "success", "success"] as const;
const sheet: GithubProject = {
  fullName: "mochi/coucou",
  url: "https://github.com",
  description: "A tiny friend that lives at the top of your screen and keeps an eye on your Claude Code sessions.",
  homepage: "https://coucou.example.com",
  private: false,
  createdAt: "2024-03-12T09:00:00Z",
  stars: 4,
  forks: 1,
  languages: [
    { name: "Rust", color: "#dea584", share: 0.46 },
    { name: "TypeScript", color: "#3178c6", share: 0.38 },
    { name: "CSS", color: "#663399", share: 0.12 },
    { name: "Other", color: null, share: 0.04 },
  ],
  runs: runState.map((state, i) => ({
    id: i, state, workflow: "CI", branch: "main",
    title: i === 0 ? "Keep the last snapshot through an error" : "Earlier work",
    actor: "mochi", url: "https://github.com",
    startedAt: minutesAgo(62 + i * 90), updatedAt: minutesAgo(60 + i * 90),
  })),
  pull: {
    number: 12, title: "GitHub panel for the Windows island", url: "https://github.com",
    state: "merged", author: "mochi", additions: 1320, deletions: 94, changedFiles: 14,
    review: "approved", comments: 3, at: minutesAgo(4),
  },
  deploy: {
    environment: "Production", state: "success", url: "https://coucou.example.com",
    creator: "vercel", sha: "a1b2c3d", at: minutesAgo(58),
  },
  missing: params.has("locked") ? ["deployments"] : [],
};
// `slow` stands in for a real network, long enough to watch Mochi search.
Bridge.githubProject = async () => {
  const ms = Number(params.get("slow"));
  if (params.has("slow")) await new Promise((r) => setTimeout(r, ms > 100 ? ms : 2500));
  return sheet;
};

// Any clicked day gets this one, after a short wait so the loader shows.
const aDay: GithubDay = {
  items: [
    { kind: "push", repo: "mochi/coucou", title: "4 commits", detail: null, url: "https://github.com", target: pushTarget("mochi/coucou", 4, "main") },
    { kind: "push", repo: "mochi/tour-convention-geneve", title: "1 commit", detail: null, url: "https://github.com", target: pushTarget("mochi/tour-convention-geneve", 1, "main") },
    { kind: "pr_merged", repo: "mochi/coucou", title: "GitHub panel for the Windows island", detail: "#12", url: "https://github.com", target: pullTarget("mochi/coucou", 12) },
    { kind: "review", repo: "louis-cfm/coucou", title: "Fix the hook timeout", detail: "#31", url: "https://github.com", target: pullTarget("louis-cfm/coucou", 31) },
  ],
  privateCount: 2,
};
Bridge.githubDay = async () => {
  await new Promise((r) => setTimeout(r, 900));
  return aDay;
};

State.loadIntegrationTasks();
State.integrations.integration_github = {
  data: data as unknown as Record<string, unknown>,
  error: params.has("error") ? "No connection" : null,
  loaded: true,
  configured: true,
};
State.setFocus("integration_github");
// Pinned, so the island doesn't fold away while it's being looked at.
State.isPinned = true;

const island = new Island(document.getElementById("root")!);
island.alert(params.get("view") === "overview" ? "overview" : "github");

// The tab is the panel's own state; get there the way a person would.
if (params.get("tab") === "projects") {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".gh-trail .gh-step:nth-child(2)")?.click();
    if (params.has("sheet")) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".gh-list .gh-row:nth-child(2)")?.click());
    }
  });
}
