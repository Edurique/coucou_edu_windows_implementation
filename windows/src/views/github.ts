// The GitHub panel — the view behind the `…` of the GitHub card.
//
// Windows only for now, with no macOS view to port from, so it is built from the
// island's own pieces — the card, the rows, the dots, Mochi's state colours —
// rather than from GitHub's look.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { ACTIVITY_STYLE, compact, githubData, repoName, timeAgo } from "./integrations";
import {
  Bridge,
  type GithubActivity, type GithubBuild, type GithubContributions, type GithubDeploy,
  type GithubProject, type GithubPull, type GithubRepo,
} from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
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

/** The project whose sheet is open, fetched on the click that opened it. */
interface Sheet {
  fullName: string;
  data: GithubProject | null;
  error: string | null;
  loading: boolean;
  /** The loader is up — only for a fetch slow enough to notice. */
  waiting: boolean;
  /** News just arrived after a visible wait: Mochi reacts on the next draw. */
  react: boolean;
}
let sheet: Sheet | null = null;
/** Bumped on every change to the sheet, so the view knows to redraw it. */
let sheetStamp = 0;

/** An answer from the minute of cache comes back at once: no loader for that. */
const LOADER_DELAY_MS = 150;

function touchSheet() {
  sheetStamp += 1;
  State.notify();
}

/**
 * While a sheet is fetched Mochi searches — eyes sweeping, indigo, the "…"
 * badge — the look he has whenever something is being looked up. Only from
 * idle, so a finished or failed state from the pollers is never talked over.
 */
let searchingFor: Sheet | null = null;

function startSearching(for_: Sheet) {
  searchingFor = for_;
  const task = State.tasks.find((t) => t.id === ID);
  if (task?.state === "idle") State.updateTask(ID, "searching");
}

function stopSearching(for_: Sheet | null) {
  if (!searchingFor || (for_ && searchingFor !== for_)) return;
  searchingFor = null;
  const task = State.tasks.find((t) => t.id === ID);
  if (task?.state === "searching") State.updateTask(ID, "idle");
}

async function loadSheet(current: Sheet, force: boolean) {
  current.loading = true;
  touchSheet();
  const loader = window.setTimeout(() => {
    if (sheet !== current || !current.loading) return;
    current.waiting = true;
    startSearching(current);
    touchSheet();
  }, LOADER_DELAY_MS);
  try {
    const data = await Bridge.githubProject(current.fullName, force);
    current.data = data;
    current.error = null;
    current.react = current.waiting;
  } catch (err) {
    current.error = String(err).replace(/^Error:\s*/, "");
  } finally {
    window.clearTimeout(loader);
    current.loading = false;
    current.waiting = false;
    stopSearching(current);
    // Another project may have been opened meanwhile; it has its own draw.
    if (sheet === current) touchSheet();
  }
}

function openSheet(fullName: string) {
  sheet = { fullName, data: null, error: null, loading: false, waiting: false, react: false };
  void loadSheet(sheet, false);
}

function closeSheet() {
  stopSearching(null);
  sheet = null;
  touchSheet();
}

/** What Mochi makes of a sheet: stars for all green, a start for a failure. */
function mood(p: GithubProject): BotEmoteName {
  const failed = p.runs[0]?.state === "failure" || p.deploy?.state === "failure";
  if (failed) return "surprised";
  const green = p.runs[0]?.state === "success" && (!p.deploy || p.deploy.state === "success");
  return green ? "proud" : "happy";
}

/** The graph sweeps in on the next draw: on entering the panel and on its tab. */
let sweepNext = true;

/**
 * On the way into the panel from the card: start from the lists, and refetch
 * when what they hold is old news.
 *
 * The sheet is closed through closeSheet(), never by setting it to null here:
 * the view redraws only when its key changes, and a sheet dropped without a
 * new stamp left the old one on screen — with ‹ then leaving the panel, since
 * as far as it knew no sheet was open.
 */
export function enterGithubPanel() {
  sweepNext = true;
  // Either way the view gets a new stamp, so it redraws — and sweeps.
  if (sheet) closeSheet();
  else touchSheet();
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

/**
 * Your own repositories by name; somebody else's with their owner in front.
 * The row opens the project's sheet; the badge and the PR count stay shortcuts
 * straight to GitHub.
 */
function repoRow(repo: GithubRepo, login: string, onOpen: () => void): HTMLElement {
  return h(
    "div",
    { class: "gh-row", onclick: onOpen },
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

// ── Contribution graph ────────────────────────────────────────────────────────
//
// GitHub's year of squares, redrawn as the island draws everything else: tiny
// squircles — Mochi's own shape — in Mochi's `finished` green, growing and
// brightening with GitHub's own levels. Under the mouse, Mochi takes the colour
// of the day.

const DAY_MS = 86_400_000;

/** Mochi's `finished` green — the colour of work done. */
const GRAPH_GREEN = "#34D399";
/** Mochi at rest, the `idle` colour: what an empty day turns him. */
const IDLE = "#E6E9EE";

/** a → b by t, as a hex colour. */
function mixHex(a: string, b: string, t: number): string {
  const ca = parseInt(a.slice(1), 16);
  const cb = parseInt(b.slice(1), 16);
  const channel = (shift: number) => {
    const x = (ca >> shift) & 255;
    const y = (cb >> shift) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, "0")}`;
}

/**
 * Per GitHub level, 0 (nothing) to 4 (busiest): how big and how green the cell
 * is, and how green Mochi turns — with how bright his glow — over that day.
 */
const LEVEL_LOOK = [0, 0.4, 0.6, 0.8, 1].map((t, level) => ({
  scale: [0.42, 0.62, 0.76, 0.9, 1][level],
  cell: level === 0 ? "rgba(255,255,255,0.1)" : `${GRAPH_GREEN}${Math.round((0.25 + 0.75 * t) * 255).toString(16).padStart(2, "0")}`,
  mochi: mixHex(IDLE, GRAPH_GREEN, t),
  glow: 0.15 + 0.5 * t,
}));

function dayDate(start: string, i: number): Date {
  return new Date(Date.parse(`${start}T00:00:00Z`) + i * DAY_MS);
}

function dayLabel(date: Date, count: number): string {
  const when = date.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
  const what = count === 0 ? "No contributions" : count === 1 ? "1 contribution" : `${count} contributions`;
  return `${what} · ${when}`;
}

/** Days in a row with something, back from today — or from yesterday, when today is still blank. */
function currentStreak(counts: number[]): number {
  let i = counts.length - 1;
  if (i >= 0 && counts[i] === 0) i -= 1;
  let days = 0;
  while (i >= 0 && counts[i] > 0) {
    days += 1;
    i -= 1;
  }
  return days;
}

function contributionGraph(
  c: GithubContributions,
  sweep: boolean,
  tint: ViewActions["tintMochi"],
): HTMLElement {
  // Sunday-first columns, like the profile page; GitHub's first week is partial.
  const offset = dayDate(c.start, 0).getUTCDay();
  const weeks = Math.ceil((offset + c.counts.length) / 7);
  const columns = `repeat(${weeks}, 1fr)`;

  const months = h("div", { class: "gh-months" });
  months.style.gridTemplateColumns = columns;
  let previousMonth = -1;
  for (let col = 0; col < weeks; col++) {
    const month = dayDate(c.start, col * 7 - offset).getUTCMonth();
    // The partial month at the very start gets no label: it would sit on top
    // of the next one.
    if (month !== previousMonth && col > 0 && col < weeks - 2) {
      const label = h("span", {
        text: dayDate(c.start, col * 7 - offset).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }),
      });
      label.style.gridColumn = String(col + 1);
      months.append(label);
    }
    previousMonth = month;
  }

  const grid = h("div", { class: sweep ? "gh-grid sweep" : "gh-grid" });
  grid.style.gridTemplateColumns = columns;
  for (let i = 0; i < offset; i++) grid.append(h("i", { class: "pad" }));
  c.counts.forEach((_, i) => {
    const level = c.levels[i] ?? 0;
    const look = LEVEL_LOOK[level] ?? LEVEL_LOOK[0];
    const classes = [level > 0 ? "lit" : "", i === c.counts.length - 1 ? "today" : ""].join(" ").trim();
    const cell = h("i", { class: classes, "data-i": String(i) });
    cell.style.setProperty("--s", String(look.scale));
    cell.style.setProperty("--c", look.cell);
    cell.style.setProperty("--col", String(Math.floor((offset + i) / 7)));
    grid.append(cell);
  });

  const streak = currentStreak(c.counts);
  const summary =
    `${c.total.toLocaleString()} contribution${c.total === 1 ? "" : "s"} in the last year` +
    (streak >= 2 ? ` · ${streak} days in a row` : "");
  const caption = h("div", { class: "gh-caption", text: summary });

  // Hovering a day says what it holds and turns Mochi that day's green;
  // leaving the grid gives the year back, and Mochi his own colour.
  grid.addEventListener("mouseover", (e) => {
    const index = (e.target as HTMLElement).dataset.i;
    if (index == null) return;
    const i = Number(index);
    caption.textContent = dayLabel(dayDate(c.start, i), c.counts[i] ?? 0);
    caption.classList.add("day");
    const look = LEVEL_LOOK[c.levels[i] ?? 0] ?? LEVEL_LOOK[0];
    tint({ color: look.mochi, glow: look.glow });
  });
  grid.addEventListener("mouseleave", () => {
    caption.textContent = summary;
    caption.classList.remove("day");
    tint(null);
  });

  return h("div", { class: "gh-graph" }, months, grid, caption);
}

// ── Project sheet ─────────────────────────────────────────────────────────────

/** "2m 14s", "45s", "1h 3m" — how long a run took, or has been going. */
function duration(fromIso: string | null, toMs: number): string | null {
  if (!fromIso) return null;
  const seconds = Math.round((toMs - Date.parse(fromIso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "just now" stays as is; everything else reads "2h ago". */
function ago(iso: string): string {
  const t = timeAgo(iso);
  return t === "just now" || t === "" ? t : `${t} ago`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A round tinted icon in a state colour — the pill badge, one size up. */
function roundIcon(color: string, icon: Node): HTMLElement {
  const el = h("i", { class: "gh-block-icon" }, icon);
  el.style.setProperty("--c", color);
  el.style.setProperty("--tint", `${color}26`);
  return el;
}

interface BlockParts {
  icon: HTMLElement;
  title: string;
  right?: Node | string;
  /** The grey second line. */
  sub?: Node[];
  /** Anything that rides at the end of the second line (the CI streak). */
  aside?: Node;
  url?: string | null;
}

/** One section of the sheet: a tinted icon, a sentence, a grey line under it. */
function block(parts: BlockParts): HTMLElement {
  const text = h(
    "div",
    { class: "gh-block-text" },
    h(
      "div",
      { class: "gh-block-title" },
      h("span", { text: parts.title }),
      parts.right ? h("span", { class: "gh-block-right" }, parts.right) : null,
    ),
  );
  if (parts.sub || parts.aside) {
    text.append(
      h("div", { class: "gh-block-sub" }, h("span", { class: "txt" }, ...(parts.sub ?? [])), parts.aside ?? null),
    );
  }
  const url = parts.url;
  return url
    ? h("button", { class: "gh-block", onclick: () => void Bridge.openUrl(url) }, parts.icon, text)
    : h("div", { class: "gh-block" }, parts.icon, text);
}

/** A section the token may not read here: say which permission would open it. */
function notGranted(what: string, permission: string): HTMLElement {
  return h(
    "div",
    { class: "gh-block muted" },
    roundIcon("#6B7079", svg(ICONS.lock, 9, { stroke: 2.2 })),
    h(
      "div",
      { class: "gh-block-text" },
      h("div", { class: "gh-block-title" }, h("span", { text: `${what} aren't readable with this token` })),
      h("div", { class: "gh-block-sub" }, h("span", { class: "txt", text: `Add “${permission}: Read-only” to it on GitHub.` })),
    ),
  );
}

/** Joins the non-empty pieces of a grey line with " · ". */
function line(...pieces: (Node | string | null | false | undefined)[]): Node[] {
  const out: Node[] = [];
  for (const piece of pieces) {
    if (!piece) continue;
    if (out.length) out.push(document.createTextNode(" · "));
    out.push(typeof piece === "string" ? document.createTextNode(piece) : piece);
  }
  return out;
}

const RUN_VERB: Record<GithubBuild["state"], string> = {
  success: "passed",
  failure: "failed",
  running: "is running",
  neutral: "was stopped",
};

function ciBlock(p: GithubProject): HTMLElement {
  if (p.missing.includes("actions")) return notGranted("Actions", "Actions");
  const run = p.runs[0];
  if (!run) {
    return block({
      icon: roundIcon("#6B7079", svg(ICONS.dash, 9, { stroke: 3 })),
      title: "No CI here yet",
      sub: line("No GitHub Actions workflow has run in this repository."),
    });
  }
  const style = BUILD_STYLE[run.state];
  const icon =
    run.state === "running"
      ? h("i", { class: "gh-ring" })
      : run.state === "success"
        ? svg(ICONS.check, 10, { stroke: 3 })
        : run.state === "failure"
          ? svg(ICONS.xmark, 9)
          : svg(ICONS.dash, 10, { stroke: 3 });
  const took = run.state === "running"
    ? duration(run.startedAt, Date.now())
    : duration(run.startedAt, Date.parse(run.updatedAt));

  // Oldest on the left, so the streak reads like a timeline.
  const history = [...p.runs].reverse();
  const passed = p.runs.filter((r) => r.state === "success").length;
  const streak = h("span", { class: "gh-streak", title: `${passed} of the last ${p.runs.length} runs passed` });
  for (const r of history) {
    const d = h("i");
    d.style.setProperty("--c", BUILD_STYLE[r.state].color);
    streak.append(d);
  }
  streak.append(h("span", { text: `${passed}/${p.runs.length}` }));

  return block({
    icon: roundIcon(style.color, icon),
    title: `${run.workflow} ${RUN_VERB[run.state]}${run.branch ? ` on ${run.branch}` : ""}`,
    right: run.state === "running" ? `for ${took ?? "a moment"}` : ago(run.updatedAt),
    sub: line(run.title && `“${run.title}”`, run.actor, run.state !== "running" && took && `in ${took}`),
    aside: streak,
    url: run.url,
  });
}

const PULL_STYLE: Record<GithubPull["state"], { color: string; icon: string }> = {
  open: { color: "#6366F1", icon: ICONS.pullRequest },
  draft: { color: "#9398A1", icon: ICONS.pullRequest },
  merged: { color: "#34D399", icon: ICONS.merge },
  closed: { color: "#6B7079", icon: ICONS.pullRequest },
};

const REVIEW_COLOR: Record<NonNullable<GithubPull["review"]>, string> = {
  approved: "#34D399",
  "changes requested": "#F5A524",
  "review required": "#9398A1",
};

function pullBlock(p: GithubProject): HTMLElement {
  if (p.missing.includes("pull requests")) return notGranted("Pull requests", "Pull requests");
  const pr = p.pull;
  if (!pr) {
    return block({
      icon: roundIcon("#6B7079", svg(ICONS.pullRequest, 10, { stroke: 2 })),
      title: "No pull request yet",
    });
  }
  const style = PULL_STYLE[pr.state];
  const chip = h("span", { class: "gh-chip", text: pr.state });
  chip.style.setProperty("--c", style.color);
  chip.style.setProperty("--tint", `${style.color}26`);
  const size = h(
    "span",
    {},
    h("span", { class: "gh-add", text: `+${pr.additions}` }),
    " ",
    h("span", { class: "gh-del", text: `−${pr.deletions}` }),
  );
  const review = pr.review ? h("span", { text: pr.review, style: `color:${REVIEW_COLOR[pr.review]}` }) : null;
  const files = pr.changedFiles === 1 ? "1 file" : `${pr.changedFiles} files`;
  const comments = pr.comments === 1 ? "1 comment" : `${pr.comments} comments`;
  return block({
    icon: roundIcon(style.color, svg(style.icon, 10, { stroke: 2 })),
    title: `#${pr.number} ${pr.title}`,
    right: chip,
    sub: line(pr.author && `by ${pr.author}`, size, files, review, pr.comments > 0 && comments, ago(pr.at)),
    url: pr.url,
  });
}

const DEPLOY_STYLE: Record<GithubDeploy["state"], { color: string; say: (env: string) => string }> = {
  success: { color: "#22C55E", say: (env) => `Live on ${env}` },
  failure: { color: "#F4505E", say: (env) => `Deploy to ${env} failed` },
  running: { color: "#F5A524", say: (env) => `Deploying to ${env}…` },
  inactive: { color: "#6B7079", say: (env) => `Was live on ${env}` },
};

/** Nothing at all for a repository that never deploys: most don't. */
function deployBlock(p: GithubProject): HTMLElement | null {
  if (p.missing.includes("deployments")) return notGranted("Deployments", "Deployments");
  const d = p.deploy;
  if (!d) return null;
  const style = DEPLOY_STYLE[d.state];
  return block({
    icon: roundIcon(style.color, svg(ICONS.rocket, 11, { stroke: 1.8 })),
    title: style.say(d.environment),
    right: ago(d.at),
    sub: line(
      d.creator && `by ${d.creator}`,
      d.sha && h("span", { class: "gh-sha", text: d.sha }),
      d.url && h("span", { class: "gh-host", text: hostOf(d.url) }),
    ),
    url: d.url ?? `${p.url}/deployments`,
  });
}

function languageBar(p: GithubProject): HTMLElement | null {
  if (p.languages.length === 0) return null;
  const bar = h("div", { class: "gh-lang-bar" });
  const legend = h("div", { class: "gh-lang-legend" });
  for (const lang of p.languages) {
    const color = lang.color ?? "#4B5563";
    const segment = h("i", { title: lang.name });
    segment.style.flex = `${lang.share} 1 0`;
    segment.style.background = color;
    bar.append(segment);
    const percent = lang.share < 0.01 ? "<1" : String(Math.round(lang.share * 100));
    legend.append(h("span", {}, dot(color, 6), `${lang.name} ${percent}%`));
  }
  return h("div", { class: "gh-langs" }, bar, legend);
}

/**
 * What stands in for the sheet while Mochi looks: the island's shimmering
 * text, over three ghosts of the blocks that are coming.
 */
function sheetLoader(name: string): HTMLElement {
  const loader = h("div", { class: "gh-loader" }, h("div", { class: "gh-loader-text shimmer", text: `Mochi is looking into ${name}…` }));
  for (let i = 0; i < 3; i++) {
    const ghost = h("div", { class: "gh-ghost" }, h("i"), h("div", {}, h("b"), h("span")));
    ghost.style.setProperty("--i", String(i));
    loader.append(ghost);
  }
  return loader;
}

function projectSheet(p: GithubProject): HTMLElement {
  const facts = h("div", { class: "gh-facts" });
  const addFact = (...children: (Node | string)[]) => facts.append(h("span", {}, ...children));
  if (p.private) addFact(svg(ICONS.lock, 9, { stroke: 2.2 }), "Private");
  addFact(svg(ICONS.star, 9), p.stars === 1 ? "1 star" : `${compact(p.stars)} stars`);
  if (p.forks > 0) addFact(p.forks === 1 ? "1 fork" : `${compact(p.forks)} forks`);
  if (p.createdAt) addFact(`since ${new Date(p.createdAt).getFullYear()}`);
  const homepage = p.homepage;
  if (homepage) {
    facts.append(h("button", { class: "gh-host", text: hostOf(homepage), onclick: () => void Bridge.openUrl(homepage) }));
  }

  const el = h(
    "div",
    { class: "gh-sheet" },
    p.description ? h("div", { class: "gh-desc", text: p.description }) : null,
    facts,
    ciBlock(p),
    pullBlock(p),
    deployBlock(p),
    languageBar(p),
  );
  // Each part's place in the cascade when the sheet arrives.
  Array.from(el.children).forEach((child, i) => (child as HTMLElement).style.setProperty("--i", String(i)));
  return el;
}

export function buildGithub(actions: ViewActions): ViewHost {
  const back = h(
    "button",
    {
      class: "int-back",
      title: "Back",
      // From a project's sheet, back to the list; from the lists, back to the card.
      onclick: () => {
        actions.blip();
        if (sheet) closeSheet();
        else actions.setView("overview");
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
      onclick: () => {
        const target = sheet
          ? (sheet.data?.url ?? `https://github.com/${sheet.fullName}`)
          : (githubData()?.profileUrl ?? "https://github.com");
        void Bridge.openUrl(target);
      },
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

  /** The bottom fade says "there's more": it goes once the end is on screen. */
  const updateFade = () => {
    const more = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
    list.classList.toggle("more", more);
  };
  list.addEventListener("scroll", updateFade, { passive: true });
  // The island grows and shrinks around the list as it opens and closes.
  new ResizeObserver(updateFade).observe(list);

  let refreshing = false;
  let key = "";
  let listTab: Tab | null = null;

  /**
   * A graph removed from under the mouse never gets its mouseleave, which
   * would leave Mochi green: every emptying of the list gives him his colour.
   */
  function clearList() {
    clear(list);
    actions.tintMochi(null);
  }

  /** The sheet takes the list's place; the head names the project. */
  function drawSheet(open: Sheet, login: string) {
    tabs.style.display = "none";
    who.textContent = repoName(open.fullName, login);
    sub.textContent = open.data?.languages[0]?.name ?? "";
    clear(status);
    if (open.error) status.append(dot(GITHUB_RED, 5), h("span", { text: open.error }));
    listTab = null;
    clearList();
    if (open.data) {
      const content = projectSheet(open.data);
      if (open.react) {
        // Fresh news after a wait: the blocks come in one by one, and Mochi
        // says what he thinks of them.
        open.react = false;
        content.classList.add("enter");
        actions.emote(mood(open.data));
      }
      list.append(content);
    } else if (open.waiting) {
      list.append(sheetLoader(repoName(open.fullName, login)));
    }
    list.scrollTop = 0;
    updateFade();
  }

  refreshBtn.addEventListener("click", async () => {
    if (refreshing || sheet?.loading) return;
    actions.blip();
    if (sheet) {
      void loadSheet(sheet, true);
      return;
    }
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

      refreshBtn.classList.toggle("spin", refreshing || (sheet?.loading ?? false));
      refreshBtn.style.display = configured ? "" : "none";

      // Rebuilding the rows between a mouse-down and its mouse-up would swallow
      // the click, so only rebuild when something they show has changed.
      const next = [configured, error, d?.fetchedAt, d?.login, tab, sheetStamp].join("~");
      if (next === key) return;
      key = next;

      if (sheet && d && configured) {
        drawSheet(sheet, d.login);
        return;
      }

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
      const freshTab = tab !== listTab;
      const scroll = freshTab ? 0 : list.scrollTop;
      const sweep = freshTab || sweepNext;
      sweepNext = false;
      listTab = tab;
      clearList();
      if (!d || !configured) {
        updateFade();
        return;
      }
      if (tab === "projects") {
        if (d.repos.length === 0) {
          list.append(h("div", { class: "int-empty", text: "No repositories yet." }));
        }
        for (const repo of d.repos) {
          list.append(
            repoRow(repo, d.login, () => {
              actions.blip();
              openSheet(repo.fullName);
            }),
          );
        }
      } else {
        // The year first, then what happened lately.
        if (d.contributions) list.append(contributionGraph(d.contributions, sweep, actions.tintMochi));
        if (d.activity.length === 0) {
          list.append(h("div", { class: "int-empty", text: "Nothing in the last 30 days." }));
        }
        for (const a of d.activity) list.append(activityRow(a, d.login));
      }
      list.scrollTop = scroll;
      updateFade();
    },
  };
}
