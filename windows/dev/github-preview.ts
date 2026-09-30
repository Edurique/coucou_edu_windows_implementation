// Dev harness: the real island with made-up GitHub data, in a plain browser, so
// the card and the panel can be looked at without a token or the Rust side.
// Not part of the app bundle. `npm run dev`, then /dev/github-preview.html.

import "../src/style.css";
import {
  Bridge, type GithubActivity, type GithubData, type GithubDay, type GithubProject, type GithubRepo,
} from "../src/core/bridge";
import { State } from "../src/core/state";
import { Island } from "../src/island/island";

const params = new URLSearchParams(location.search);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const activity: GithubActivity[] = [
  { id: "1", kind: "pr_merged", repo: "mochi/coucou", title: "GitHub panel for the Windows island", detail: "#12", url: "https://github.com", at: minutesAgo(4) },
  { id: "2", kind: "push", repo: "mochi/coucou", title: "Keep the last snapshot through an error", detail: "3 commits · windows-github-panel", url: "https://github.com", at: minutesAgo(38) },
  { id: "3", kind: "pr_opened", repo: "mochi/coucou", title: "Windows: GitHub panel", detail: "#12", url: "https://github.com", at: minutesAgo(95) },
  { id: "4", kind: "issue_opened", repo: "louis-cfm/coucou", title: "Defender flags the installer", detail: "#9", url: "https://github.com", at: minutesAgo(60 * 5) },
  { id: "5", kind: "release", repo: "mochi/tour-convention-geneve", title: "Sprint 3", detail: "v0.3.0", url: "https://github.com", at: minutesAgo(60 * 26) },
  { id: "6", kind: "issue_closed", repo: "mochi/tour-convention-geneve", title: "Map tiles flicker on zoom", detail: "#41", url: "https://github.com", at: minutesAgo(60 * 50) },
  { id: "7", kind: "pr_closed", repo: "mochi/dotfiles", title: "Try another prompt theme", detail: "#3", url: "https://github.com", at: minutesAgo(60 * 72) },
  { id: "8", kind: "create", repo: "mochi/sandbox", title: "Created the repository", detail: null, url: "https://github.com", at: minutesAgo(60 * 24 * 6) },
  { id: "9", kind: "push", repo: "mochi/sandbox", title: "Pushed", detail: "main", url: "https://github.com", at: minutesAgo(60 * 24 * 6) },
];

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
    { kind: "push", repo: "mochi/coucou", title: "4 commits", detail: null, url: "https://github.com" },
    { kind: "push", repo: "mochi/tour-convention-geneve", title: "1 commit", detail: null, url: "https://github.com" },
    { kind: "pr_merged", repo: "mochi/coucou", title: "GitHub panel for the Windows island", detail: "#12", url: "https://github.com" },
    { kind: "review", repo: "louis-cfm/coucou", title: "Fix the hook timeout", detail: "#31", url: "https://github.com" },
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
    document.querySelector<HTMLElement>(".gh-tabs button:nth-child(2)")?.click();
    if (params.has("sheet")) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".gh-list .gh-row:nth-child(2)")?.click());
    }
  });
}
