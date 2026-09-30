// The GitHub panel — the view behind the `…` of the GitHub card.
//
// Windows only for now, with no macOS view to port from, so it is built from the
// island's own pieces — the card, the rows, the dots, Mochi's state colours —
// rather than from GitHub's look.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { ACTIVITY_STYLE, compact, githubData, repoName, timeAgo } from "./integrations";
import { Bridge, type GithubActivity, type GithubBuild, type GithubRepo } from "../core/bridge";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

const ID = "integration_github";
const GITHUB_RED = "#F4505E";
/** Opening the panel refetches first when what it holds is older than this. */
const STALE_MS = 60_000;
/** A refresh that comes back instantly still turns the arrow once. */
const MIN_SPIN_MS = 500;

type Tab = "activity" | "projects";
/** Kept across openings: the panel comes back on the tab it was left on. */
let tab: Tab = "activity";

/** Same colours as the pill badges: green check, red cross, amber for "going". */
const BUILD_STYLE: Record<GithubBuild["state"], { color: string; label: string }> = {
  success: { color: "#22C55E", label: "passed" },
  failure: { color: "#F4505E", label: "failed" },
  running: { color: "#F5A524", label: "running" },
  neutral: { color: "#6B7079", label: "stopped" },
};

/** Called on the way into the panel, so it never opens on old news. */
export function refreshGithubIfStale() {
  const d = githubData();
  if (!d || Date.now() - d.fetchedAt > STALE_MS) void Bridge.refreshIntegration(ID);
}

function activityRow(a: GithubActivity, login: string): HTMLElement {
  const style = ACTIVITY_STYLE[a.kind];
  const where = [repoName(a.repo, login), a.detail].filter(Boolean).join(" · ");
  return h(
    "button",
    { class: "gh-row", onclick: () => void Bridge.openUrl(a.url) },
    h("i", { class: "gh-row-icon", style: `color:${style.color}` }, svg(style.icon, 12, { stroke: 2 })),
    h("span", { class: "gh-row-title", text: a.title }),
    h("span", { class: "gh-row-where", text: where }),
    h("span", { class: "int-ago", text: timeAgo(a.at) }),
  );
}

/** The last Actions run as a small round badge; it opens the run itself. */
function buildBadge(build: GithubBuild | null): HTMLElement {
  if (!build) return h("span", { class: "gh-build none" });
  const style = BUILD_STYLE[build.state];
  const inner =
    build.state === "running"
      ? h("i", { class: "gh-ring" })
      : build.state === "success"
        ? svg(ICONS.check, 9, { stroke: 3 })
        : build.state === "failure"
          ? svg(ICONS.xmark, 8)
          : svg(ICONS.dash, 9, { stroke: 3 });
  const where = build.branch ? ` on ${build.branch}` : "";
  const badge = h(
    "button",
    {
      class: "gh-build",
      title: `${build.workflow}${where} · ${style.label} ${timeAgo(build.at)} ago`,
      onclick: (e: Event) => {
        e.stopPropagation();
        void Bridge.openUrl(build.url);
      },
    },
    inner,
  );
  badge.style.setProperty("--c", style.color);
  badge.style.setProperty("--tint", `${style.color}26`);
  return badge;
}

/** Stars and open pull requests keep their column even at zero, so rows line up. */
function meta(icon: SVGSVGElement, count: number, onClick?: () => void): HTMLElement {
  if (count <= 0) return h("span", { class: "gh-meta none" });
  const el = h("span", { class: onClick ? "gh-meta link" : "gh-meta" }, icon, compact(count));
  if (onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return el;
}

/** Your own repositories by name; somebody else's with their owner in front. */
function repoRow(repo: GithubRepo, login: string): HTMLElement {
  return h(
    "div",
    { class: "gh-row", onclick: () => void Bridge.openUrl(repo.url) },
    dot(repo.languageColor ?? "#4B5563", 6),
    h("span", { class: "gh-row-title", text: repoName(repo.fullName, login) }),
    repo.private ? h("i", { class: "gh-lock", title: "Private" }, svg(ICONS.lock, 9, { stroke: 2.2 })) : null,
    h("span", { class: "gh-row-where", text: repo.language ?? "" }),
    h(
      "span",
      { class: "gh-right" },
      buildBadge(repo.build),
      meta(svg(ICONS.star, 9), repo.stars),
      meta(svg(ICONS.pullRequest, 9, { stroke: 2 }), repo.openPrs, () => void Bridge.openUrl(`${repo.url}/pulls`)),
      h("span", { class: "int-ago", text: repo.pushedAt ? timeAgo(repo.pushedAt) : "" }),
    ),
  );
}

export function buildGithub(actions: ViewActions): ViewHost {
  const back = h(
    "button",
    {
      class: "int-back",
      title: "Back",
      onclick: () => {
        actions.blip();
        actions.setView("overview");
      },
    },
    svg(ICONS.chevronLeft, 10, { stroke: 2.4 }),
  );
  const who = h("b", { text: "GitHub" });
  const sub = h("span", { class: "gh-sub" });
  const refreshBtn = h("button", { class: "gh-icon", title: "Refresh" }, svg(ICONS.refresh, 12, { stroke: 2 }));
  const openBtn = h(
    "button",
    {
      class: "gh-icon",
      title: "Open on GitHub",
      onclick: () => void Bridge.openUrl(githubData()?.profileUrl ?? "https://github.com"),
    },
    svg(ICONS.arrowUpRight, 10),
  );
  const head = h(
    "div",
    { class: "gh-head" },
    back, dot(GITHUB_RED, 7), who, sub, h("div", { class: "grow" }), refreshBtn, openBtn,
  );
  const status = h("div", { class: "gh-status" });

  const tabButtons: Record<Tab, HTMLButtonElement> = {
    activity: h("button", { text: "Activity" }),
    projects: h("button", { text: "Projects" }),
  };
  for (const [name, button] of Object.entries(tabButtons) as [Tab, HTMLButtonElement][]) {
    button.addEventListener("click", () => {
      if (tab === name) return;
      actions.blip();
      tab = name;
      State.notify();
    });
  }
  const tabs = h("div", { class: "seg gh-tabs" }, tabButtons.activity, tabButtons.projects);

  const list = h("div", { class: "gh-list" });
  const body = h("div", { class: "gh-body" }, head, status, tabs, list);
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));

  let refreshing = false;
  let key = "";
  let listTab: Tab | null = null;

  refreshBtn.addEventListener("click", async () => {
    if (refreshing) return;
    actions.blip();
    refreshing = true;
    State.notify();
    const started = performance.now();
    // Resolves once Rust has finished — the new data has already arrived by then.
    await Bridge.refreshIntegration(ID);
    const left = MIN_SPIN_MS - (performance.now() - started);
    if (left > 0) await new Promise((r) => window.setTimeout(r, left));
    refreshing = false;
    State.notify();
  });

  return {
    el,
    sync() {
      const info = State.integrations[ID];
      const d = githubData();
      const configured = info?.configured !== false;
      const error = info?.error ?? null;

      refreshBtn.classList.toggle("spin", refreshing);
      refreshBtn.style.display = configured ? "" : "none";

      // Rebuilding the rows between a mouse-down and its mouse-up would swallow
      // the click, so only rebuild when something they show has changed.
      const next = [configured, error, d?.fetchedAt, d?.login, tab].join("~");
      if (next === key) return;
      key = next;

      tabs.style.display = d && configured ? "" : "none";
      for (const [name, button] of Object.entries(tabButtons)) {
        button.classList.toggle("on", name === tab);
      }
      // A broken build is worth a glance even from the other tab.
      const failing = d?.repos.some((r) => r.build?.state === "failure") ?? false;
      clear(tabButtons.projects);
      tabButtons.projects.append("Projects");
      if (failing) tabButtons.projects.append(dot(GITHUB_RED, 5));

      who.textContent = d ? `@${d.login}` : "GitHub";
      sub.textContent = d?.name ?? "";

      clear(status);
      if (!configured) {
        status.append(
          dot(GITHUB_RED, 5),
          h("span", { text: "No token yet" }),
          h("button", {
            class: "link-btn",
            style: "color:#8e939c",
            text: "Settings…",
            onclick: () => actions.openSettingsWindow(),
          }),
        );
      } else if (error) {
        // What's below is the last good answer: say why, and how old it is.
        const when = d ? timeAgo(d.fetchedAt) : "";
        const age = when && when !== "just now" ? ` · data from ${when} ago` : "";
        status.append(dot(GITHUB_RED, 5), h("span", { text: `${error}${age}` }));
      } else if (!d) {
        status.append(h("span", { text: "Loading…" }));
      }

      // A refresh lands while the list may be scrolled: stay where the reader was,
      // unless they just switched tabs.
      const scroll = tab === listTab ? list.scrollTop : 0;
      listTab = tab;
      clear(list);
      if (!d || !configured) return;
      if (tab === "projects") {
        if (d.repos.length === 0) {
          list.append(h("div", { class: "int-empty", text: "No repositories yet." }));
        }
        for (const repo of d.repos) list.append(repoRow(repo, d.login));
      } else if (d.activity.length === 0) {
        list.append(h("div", { class: "int-empty", text: "Nothing in the last 30 days." }));
      } else {
        for (const a of d.activity) list.append(activityRow(a, d.login));
      }
      list.scrollTop = scroll;
    },
  };
}
