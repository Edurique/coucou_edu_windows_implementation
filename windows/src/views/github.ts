// The GitHub panel — the view behind the `…` of the GitHub card.
//
// Windows only for now, with no macOS view to port from, so it is built from the
// island's own pieces — the card, the rows, the dots, Mochi's state colours —
// rather than from GitHub's look.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { ACTIVITY_STYLE, githubData, repoName, timeAgo } from "./integrations";
import { Bridge, type GithubActivity } from "../core/bridge";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

const ID = "integration_github";
const GITHUB_RED = "#F4505E";
/** Opening the panel refetches first when what it holds is older than this. */
const STALE_MS = 60_000;
/** A refresh that comes back instantly still turns the arrow once. */
const MIN_SPIN_MS = 500;

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
  const list = h("div", { class: "gh-list" });
  const body = h(
    "div",
    { class: "gh-body" },
    head,
    status,
    h("div", { class: "gh-label", text: "Recent activity" }),
    list,
  );
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));

  let refreshing = false;
  let key = "";

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
      const next = [configured, error, d?.fetchedAt, d?.login].join("~");
      if (next === key) return;
      key = next;

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

      clear(list);
      if (!d || !configured) return;
      if (d.activity.length === 0) {
        list.append(h("div", { class: "int-empty", text: "Nothing in the last 30 days." }));
        return;
      }
      for (const a of d.activity) list.append(activityRow(a, d.login));
    },
  };
}
