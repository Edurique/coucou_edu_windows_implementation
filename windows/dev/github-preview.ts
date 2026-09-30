// Dev harness: the real island with made-up GitHub data, in a plain browser, so
// the card and the panel can be looked at without a token or the Rust side.
// Not part of the app bundle. `npm run dev`, then /dev/github-preview.html.

import "../src/style.css";
import type { GithubActivity, GithubData, GithubRepo } from "../src/core/bridge";
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
  repo("coucou", ["Rust", "#dea584"], 1204, 2, run("running", 1), 4),
  repo("tour-convention-geneve", ["TypeScript", "#3178c6"], 38, 5, run("failure", 50), 50),
  repo("dotfiles", ["Shell", "#89e051"], 12, 0, run("success", 60 * 26), 60 * 26),
  repo("notes", null, 0, 0, null, 60 * 30, true),
  repo("sandbox", ["Python", "#3572A5"], 3, 1, run("neutral", 60 * 24 * 6), 60 * 24 * 6),
  repo("portfolio", ["Astro", "#ff5a03"], 27, 0, run("success", 60 * 24 * 9), 60 * 24 * 9),
];

const data: GithubData = {
  login: "mochi",
  name: "Mochi",
  profileUrl: "https://github.com",
  totalRepos: 23,
  totalStars: 1284,
  activity: params.has("empty") ? [] : activity,
  repos: params.has("empty") ? [] : repos,
  fetchedAt: Date.now() - (params.has("error") ? 12 * 60_000 : 0),
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
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".gh-tabs button:nth-child(2)")?.click());
}
