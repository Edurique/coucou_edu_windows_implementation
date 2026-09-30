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
  type GithubActivity, type GithubBuild, type GithubCommitsDetail, type GithubContributions, type GithubDay,
  type GithubDeploy, type GithubDetail, type GithubFile, type GithubIssueDetail, type GithubLabel,
  type GithubProject, type GithubPull, type GithubPullDetail, type GithubReleaseDetail, type GithubRepo,
  type GithubTarget,
} from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
import { Sound } from "../core/sound";
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

/**
 * Something the panel fetches on a click — a project's sheet, a day of the
 * graph — and how that fetch is going.
 */
interface Pending<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** The loader is up — only for a fetch slow enough to notice. */
  waiting: boolean;
  /** Arrived after a visible wait: the next draw makes an entrance of it. */
  react: boolean;
}

function pending<T>(): Pending<T> {
  return { data: null, error: null, loading: false, waiting: false, react: false };
}

/** A project's sheet. */
interface ProjectScreen extends Pending<GithubProject> {
  type: "project";
  fullName: string;
}

/** The sheet behind a line of activity: a pull request, an issue, commits, a release. */
interface DetailScreen extends Pending<GithubDetail> {
  type: "detail";
  target: GithubTarget;
  /** What the line said: the head's title while the sheet loads. */
  label: string;
  /** Where the line used to go — GitHub's page, the way out of a locked sheet. */
  url: string;
}

/** One file's diff, opened from a pull request's or a commit's sheet. Nothing to fetch. */
interface DiffScreen {
  type: "diff";
  file: GithubFile;
  /** The GitHub page the diff belongs to. */
  url: string;
}

type Screen = ProjectScreen | DetailScreen | DiffScreen;

/** The day picked on the graph, by its index in the calendar. */
interface DayPick extends Pending<GithubDay> {
  index: number;
  /** "YYYY-MM-DD". */
  date: string;
}

/**
 * What the panel shows over its lists, deepest last — a project's sheet, the
 * sheet behind a line of activity, a file's diff. Each ‹ goes back one, so
 * GitHub's own site stays the last place to go rather than the first.
 */
let stack: Screen[] = [];
const top = (): Screen | null => stack[stack.length - 1] ?? null;
let day: DayPick | null = null;
/** Bumped on every change to a sheet or a day, so the view knows to redraw. */
let stamp = 0;

/** An answer from the cache comes back at once: no loader for that. */
const LOADER_DELAY_MS = 150;

function touch() {
  stamp += 1;
  State.notify();
}

/**
 * While something is fetched Mochi searches — eyes sweeping, indigo, the "…"
 * badge — the look he has whenever something is being looked up. Only from
 * idle, so a finished or failed state from the pollers is never talked over.
 */
let searchingFor: object | null = null;

function startSearching(for_: object) {
  searchingFor = for_;
  const task = State.tasks.find((t) => t.id === ID);
  if (task?.state === "idle") State.updateTask(ID, "searching");
}

function stopSearching(for_: object) {
  if (searchingFor !== for_) return;
  searchingFor = null;
  const task = State.tasks.find((t) => t.id === ID);
  if (task?.state === "searching") State.updateTask(ID, "idle");
}

/**
 * Fetches into `target`, with the loader and Mochi's search once it has taken
 * long enough to notice. `isCurrent` says whether `target` is still what's on
 * screen: another click may have replaced it, and then it gets no draw.
 */
async function load<T>(target: Pending<T>, isCurrent: () => boolean, fetch: () => Promise<T>) {
  target.loading = true;
  touch();
  const loader = window.setTimeout(() => {
    if (!isCurrent() || !target.loading) return;
    target.waiting = true;
    startSearching(target);
    touch();
  }, LOADER_DELAY_MS);
  try {
    target.data = await fetch();
    target.error = null;
    target.react = target.waiting;
  } catch (err) {
    target.error = String(err).replace(/^Error:\s*/, "");
  } finally {
    window.clearTimeout(loader);
    target.loading = false;
    target.waiting = false;
    stopSearching(target);
    if (isCurrent()) touch();
  }
}

/** One level deeper — with the island's small click. */
function push(screen: Screen) {
  Sound.play("blip");
  stack.push(screen);
  touch();
}

/** One level back. */
function pop() {
  const left = stack.pop();
  if (left) stopSearching(left);
  touch();
}

function clearStack() {
  for (const screen of stack) stopSearching(screen);
  stack = [];
}

function loadProject(screen: ProjectScreen, force: boolean) {
  return load(screen, () => top() === screen, () => Bridge.githubProject(screen.fullName, force));
}

function loadDetail(screen: DetailScreen, force: boolean) {
  return load(screen, () => top() === screen, () => Bridge.githubDetail(screen.target, force));
}

function openProject(fullName: string) {
  const screen: ProjectScreen = { ...pending<GithubProject>(), type: "project", fullName };
  push(screen);
  void loadProject(screen, false);
}

/** A line of activity: its sheet in the panel when it has one, GitHub otherwise. */
function openTarget(target: GithubTarget | null, label: string, url: string) {
  if (!target) {
    void Bridge.openUrl(url);
    return;
  }
  if (target.kind === "project") {
    openProject(target.repo);
    return;
  }
  const screen: DetailScreen = { ...pending<GithubDetail>(), type: "detail", target, label, url };
  push(screen);
  void loadDetail(screen, false);
}

function openDiff(file: GithubFile, url: string) {
  push({ type: "diff", file, url });
}

/** A day's bounds as the island's clock sees it: local midnight to midnight. */
function localDay(date: string): { from: string; to: string; today: boolean } {
  const [y, m, d] = date.split("-").map(Number);
  const from = new Date(y, m - 1, d);
  const next = new Date(y, m - 1, d + 1);
  const now = Date.now();
  return {
    from: from.toISOString(),
    to: new Date(next.getTime() - 1000).toISOString(),
    today: now >= from.getTime() && now < next.getTime(),
  };
}

function loadDay(current: DayPick) {
  const { from, to, today } = localDay(current.date);
  return load(current, () => day === current, () => Bridge.githubDay(from, to, today));
}

/** A second click on the same day lets go of it, as on GitHub. */
function pickDay(index: number, date: string) {
  if (day?.index === index) {
    unpickDay();
    return;
  }
  if (day) stopSearching(day);
  const picked: DayPick = { ...pending<GithubDay>(), index, date };
  day = picked;
  void loadDay(picked);
}

function unpickDay() {
  if (day) stopSearching(day);
  day = null;
  touch();
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
 * On the way into the panel from the card: start from the lists — no sheet,
 * no picked day — and refetch when what they hold is old news.
 *
 * It must end in touch(): the view redraws only when its key changes, and a
 * sheet dropped without a new stamp stayed on screen, with ‹ then leaving the
 * panel since, as far as it knew, no sheet was open.
 */
export function enterGithubPanel() {
  sweepNext = true;
  if (day) stopSearching(day);
  day = null;
  clearStack();
  touch();
  const d = githubData();
  if (!d || Date.now() - d.fetchedAt > STALE_MS) void Bridge.refreshIntegration(ID);
}

/** One line of GitHub activity — the recent feed, or a picked day. It opens its sheet. */
function eventRow(
  item: {
    kind: keyof typeof ACTIVITY_STYLE; repo: string; title: string; detail: string | null; url: string;
    target: GithubTarget | null;
  },
  login: string,
  ago?: string,
): HTMLElement {
  const style = ACTIVITY_STYLE[item.kind];
  const where = [repoName(item.repo, login), item.detail].filter(Boolean).join(" · ");
  return h(
    "button",
    { class: "gh-row", onclick: () => openTarget(item.target, item.title, item.url) },
    h("i", { class: "gh-row-icon", style: `color:${style.color}` }, svg(style.icon, 12, { stroke: 2 })),
    h("span", { class: "gh-row-title", text: item.title }),
    h("span", { class: "gh-row-where", text: where }),
    ago != null ? h("span", { class: "int-ago", text: ago }) : null,
  );
}

function activityRow(a: GithubActivity, login: string): HTMLElement {
  return eventRow(a, login, timeAgo(a.at));
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
// GitHub's year of squares, in GitHub's own colours, drawn as tiny squircles —
// Mochi's shape. Under the mouse, Mochi takes the colour of the day.

const DAY_MS = 86_400_000;

/**
 * GitHub's dark-theme contribution colours, level 0 to 4 (Primer's
 * contribution-default-bgColor-*). The empty day is lifted a shade, since the
 * island's card is a little lighter than GitHub's page and #151B23 would
 * vanish on it.
 */
const GITHUB_LEVELS = ["#1C2128", "#033A16", "#196C2E", "#2EA043", "#56D364"];
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
 * Per GitHub level, 0 (nothing) to 4 (busiest): the cell's colour, and how
 * green Mochi turns over that day. His shades run from his resting colour to
 * GitHub's brightest green, never through the dark ones: his eyes are
 * ink-dark and would vanish on a dark green body.
 */
const LEVEL_LOOK = [0, 0.4, 0.6, 0.8, 1].map((t, level) => ({
  cell: GITHUB_LEVELS[level],
  mochi: mixHex(IDLE, GITHUB_LEVELS[4], t),
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

/** A calendar day's colour for Mochi, by its index. */
function mochiShade(c: GithubContributions, i: number): string {
  return (LEVEL_LOOK[c.levels[i] ?? 0] ?? LEVEL_LOOK[0]).mochi;
}

interface GraphOptions {
  sweep: boolean;
  tint: ViewActions["tintMochi"];
  /** The picked day, if any: the others fade, as on GitHub. */
  picked: number | null;
  onPick(index: number, date: string): void;
}

function contributionGraph(c: GithubContributions, o: GraphOptions): HTMLElement {
  const { sweep, tint, picked } = o;
  // Sunday-first columns, like the profile page; GitHub's first week is partial.
  const offset = dayDate(c.start, 0).getUTCDay();
  const weeks = Math.ceil((offset + c.counts.length) / 7);

  const months = h("div", { class: "gh-months" });
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

  const grid = h("div", {
    class: ["gh-grid", sweep ? "sweep" : "", picked != null ? "picked" : ""].join(" ").trim(),
  });
  for (let i = 0; i < offset; i++) grid.append(h("i", { class: "pad" }));
  c.counts.forEach((_, i) => {
    const level = c.levels[i] ?? 0;
    const look = LEVEL_LOOK[level] ?? LEVEL_LOOK[0];
    const classes = [
      level > 0 ? "lit" : "",
      i === c.counts.length - 1 ? "today" : "",
      i === picked ? "on" : "",
    ].join(" ").trim();
    const cell = h("i", { class: classes, "data-i": String(i) });
    cell.style.setProperty("--c", look.cell);
    cell.style.setProperty("--col", String(Math.floor((offset + i) / 7)));
    grid.append(cell);
  });

  const streak = currentStreak(c.counts);
  const summary =
    `${c.total.toLocaleString()} contribution${c.total === 1 ? "" : "s"} in the last year` +
    (streak >= 2 ? ` · ${streak} days in a row` : "");
  const caption = h("span", { class: "gh-caption" });
  /** What the caption says when no day is hovered: the picked day, or the year. */
  const restCaption = () => {
    caption.textContent = picked != null ? dayLabel(dayDate(c.start, picked), c.counts[picked] ?? 0) : summary;
    caption.classList.toggle("day", picked != null);
  };
  restCaption();
  // GitHub's key, so the colours read the same as on the profile page.
  const legend = h("span", { class: "gh-legend" }, "Less");
  for (const color of GITHUB_LEVELS) {
    const swatch = h("i");
    swatch.style.setProperty("--c", color);
    legend.append(swatch);
  }
  legend.append("More");

  // Hovering a day says what it holds and turns Mochi that day's green;
  // leaving the grid gives the year back, and Mochi the picked day's colour,
  // or his own. A click picks the day.
  grid.addEventListener("mouseover", (e) => {
    const index = (e.target as HTMLElement).dataset.i;
    if (index == null) return;
    const i = Number(index);
    caption.textContent = dayLabel(dayDate(c.start, i), c.counts[i] ?? 0);
    caption.classList.add("day");
    tint(mochiShade(c, i));
  });
  grid.addEventListener("mouseleave", () => {
    restCaption();
    tint(picked != null ? mochiShade(c, picked) : null);
  });
  grid.addEventListener("click", (e) => {
    const index = (e.target as HTMLElement).dataset.i;
    if (index == null) return;
    const i = Number(index);
    o.onPick(i, dayDate(c.start, i).toISOString().slice(0, 10));
  });

  const graph = h("div", { class: "gh-graph" }, months, grid, h("div", { class: "gh-graph-foot" }, caption, legend));
  graph.style.setProperty("--weeks", String(weeks));

  // Cells sized as fractions of the width landed on fractions of a screen
  // pixel, so at 125 % some were drawn a pixel wider than others. Sizing them
  // in whole device pixels draws every one alike; the grid is refitted
  // whenever its width changes (a scrollbar appearing, for one).
  new ResizeObserver(() => {
    const available = grid.clientWidth;
    if (!available) return;
    const ratio = window.devicePixelRatio || 1;
    const gap = Math.max(1, Math.round(1.6 * ratio));
    const pitch = Math.floor((available * ratio + gap) / weeks);
    graph.style.setProperty("--cell", `${(pitch - gap) / ratio}px`);
    graph.style.setProperty("--gap", `${gap / ratio}px`);
  }).observe(grid);

  return graph;
}

/**
 * What stands under the graph once a day is picked, in place of the recent
 * activity: that day's commits, pull requests, reviews, issues and new
 * repositories, as GitHub's profile lists them.
 */
function daySection(pick: DayPick, login: string, onClose: () => void): HTMLElement {
  const when = new Date(`${pick.date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });
  const section = h(
    "div",
    { class: "gh-day" },
    h(
      "div",
      { class: "gh-day-head" },
      h("span", { text: `Activity on ${when}` }),
      h("button", { class: "int-back gh-day-close", title: "Back to recent activity", onclick: onClose }, svg(ICONS.xmark, 8)),
    ),
  );

  if (pick.error) {
    section.append(h("div", { class: "int-empty", text: pick.error }));
    return section;
  }
  if (!pick.data) {
    if (pick.waiting) section.append(h("div", { class: "gh-loader-text shimmer", text: "Mochi is looking at that day…" }));
    return section;
  }

  for (const item of pick.data.items) section.append(eventRow(item, login));
  if (pick.data.privateCount > 0) {
    const n = pick.data.privateCount;
    section.append(
      h(
        "div",
        { class: "gh-row muted" },
        h("i", { class: "gh-row-icon" }, svg(ICONS.lock, 10, { stroke: 2.2 })),
        h("span", { class: "gh-row-where", text: `${n} contribution${n === 1 ? "" : "s"} in private repositories` }),
      ),
    );
  }
  if (pick.data.items.length === 0 && pick.data.privateCount === 0) {
    section.append(h("div", { class: "int-empty", text: "Nothing public that day." }));
  }
  if (pick.react) {
    pick.react = false;
    section.classList.add("enter");
    Array.from(section.children).forEach((child, i) => (child as HTMLElement).style.setProperty("--i", String(i)));
  }
  return section;
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
  /** A deeper sheet in the island — preferred to `url`, which leaves for GitHub. */
  open?: () => void;
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
  const open = parts.open ?? (url ? () => void Bridge.openUrl(url) : null);
  return open
    ? h("button", { class: "gh-block", onclick: open }, parts.icon, text)
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
    open: () => openTarget({ kind: "pull", repo: p.fullName, number: pr.number }, `#${pr.number}`, pr.url),
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

// ── Activity sheets (a click on a line of activity) ───────────────────────────

/** A title that may take two lines, with its state chip. */
function titleRow(title: string, ...chips: (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "gh-title" }, h("span", { text: title }), ...chips);
}

function chip(text: string, color: string): HTMLElement {
  const el = h("span", { class: "gh-chip", text });
  el.style.setProperty("--c", color);
  el.style.setProperty("--tint", `${color}26`);
  return el;
}

/** The grey line of facts under a title; the repository goes one level deeper. */
function facts(repo: string, login: string, ...pieces: (Node | string | null | false | undefined)[]): HTMLElement {
  const repoLink = h("button", { class: "gh-host", text: repoName(repo, login), onclick: () => openProject(repo) });
  return h("div", { class: "gh-facts" }, ...line(repoLink, ...pieces));
}

/** GitHub's own label colours. */
function labelChips(labels: GithubLabel[]): HTMLElement | null {
  if (labels.length === 0) return null;
  const row = h("div", { class: "gh-labels" });
  for (const label of labels) {
    const el = h("span", { class: "gh-label", text: label.name });
    el.style.setProperty("--c", label.color);
    row.append(el);
  }
  return row;
}

function description(body: string | null): HTMLElement | null {
  return body ? h("div", { class: "gh-desc long", text: body }) : null;
}

/** A small grey heading inside a sheet ("Files", "Commits"). */
function heading(text: string, aside?: Node): HTMLElement {
  return h("div", { class: "gh-heading" }, h("span", { text }), aside ?? null);
}

function plusMinus(additions: number, deletions: number): HTMLElement {
  return h(
    "span",
    { class: "gh-pm" },
    h("span", { class: "gh-add", text: `+${additions}` }),
    " ",
    h("span", { class: "gh-del", text: `−${deletions}` }),
  );
}

/** "windows/src/views/" and "github.ts". */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** Mochi's state colours again: new green, gone red, moved indigo, changed amber. */
const FILE_STATUS: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "#34D399" },
  removed: { letter: "D", color: "#F4505E" },
  renamed: { letter: "R", color: "#6366F1" },
  copied: { letter: "C", color: "#6366F1" },
};
const MODIFIED = { letter: "M", color: "#F5A524" };

/** One file touched; it opens the file's diff. */
function fileRow(file: GithubFile, url: string): HTMLElement {
  const status = FILE_STATUS[file.status ?? ""] ?? MODIFIED;
  const { dir, base } = splitPath(file.path);
  return h(
    "button",
    { class: "gh-row gh-file", onclick: () => openDiff(file, url) },
    h("i", { class: "gh-row-icon gh-status", style: `color:${status.color}`, text: status.letter }),
    h("span", { class: "gh-row-title", text: base }),
    h("span", { class: "gh-row-where", text: dir }),
    plusMinus(file.additions, file.deletions),
  );
}

function fileList(files: GithubFile[], url: string, title: string): Node[] {
  if (files.length === 0) return [];
  return [heading(title), ...files.map((f) => fileRow(f, url))];
}

/** A run of Actions on a commit or a pull request, as a block that opens the run. */
function runBlock(build: GithubBuild | null, missing: string[]): HTMLElement | null {
  if (missing.includes("actions")) return notGranted("Actions", "Actions");
  if (!build) return null;
  const style = BUILD_STYLE[build.state];
  const icon =
    build.state === "running"
      ? h("i", { class: "gh-ring" })
      : build.state === "success"
        ? svg(ICONS.check, 10, { stroke: 3 })
        : build.state === "failure"
          ? svg(ICONS.xmark, 9)
          : svg(ICONS.dash, 10, { stroke: 3 });
  return block({
    icon: roundIcon(style.color, icon),
    title: `${build.workflow} ${RUN_VERB[build.state]}${build.branch ? ` on ${build.branch}` : ""}`,
    right: ago(build.at),
    url: build.url,
  });
}

const REVIEW_TITLE: Record<string, string> = {
  approved: "Approved",
  "changes requested": "Changes requested",
  "review required": "Waiting for a review",
};

function reviewBlock(p: GithubPullDetail): HTMLElement {
  const color = p.review ? REVIEW_COLOR[p.review] : "#6B7079";
  const who = p.reviewers.map((r) => `${r.login} ${r.state}`);
  return block({
    icon: roundIcon(color, svg(p.review === "approved" ? ICONS.check : ICONS.pullRequest, 10, { stroke: 2.4 })),
    title: p.review ? REVIEW_TITLE[p.review] : p.reviewers.length ? "Reviewed" : "No review yet",
    sub: who.length ? line(...who) : undefined,
  });
}

function pullView(p: GithubPullDetail, login: string): HTMLElement {
  const style = PULL_STYLE[p.state];
  const branches = p.head && p.base ? h("span", { class: "gh-sha", text: `${p.head} → ${p.base}` }) : null;
  const when =
    p.state === "merged" && p.mergedAt
      ? `merged ${ago(p.mergedAt)}${p.mergedBy ? ` by ${p.mergedBy}` : ""}`
      : p.state === "closed" && p.closedAt
        ? `closed ${ago(p.closedAt)}`
        : p.createdAt && `opened ${ago(p.createdAt)}`;
  const commits = p.commits === 1 ? "1 commit" : `${p.commits} commits`;
  const comments = p.comments === 1 ? "1 comment" : `${p.comments} comments`;
  return h(
    "div",
    { class: "gh-sheet" },
    titleRow(`#${p.number} ${p.title}`, chip(p.state, style.color)),
    facts(p.repo, login, p.author && `by ${p.author}`, branches, when),
    labelChips(p.labels),
    runBlock(p.ci, p.missing),
    reviewBlock(p),
    block({
      icon: roundIcon("#9398A1", svg(ICONS.doc, 10)),
      title: `${p.changedFiles} file${p.changedFiles === 1 ? "" : "s"} changed`,
      right: plusMinus(p.additions, p.deletions),
      sub: line(commits, p.comments > 0 && comments),
    }),
    ...fileList(p.files, p.url, "Files"),
    description(p.body),
  );
}

const ISSUE_COLOR: Record<GithubIssueDetail["state"], string> = {
  open: "#F5A524",
  completed: "#34D399",
  "not planned": "#6B7079",
  closed: "#6B7079",
};

function issueView(i: GithubIssueDetail, login: string): HTMLElement {
  const when = i.closedAt ? `closed ${ago(i.closedAt)}` : i.createdAt && `opened ${ago(i.createdAt)}`;
  return h(
    "div",
    { class: "gh-sheet" },
    titleRow(`#${i.number} ${i.title}`, chip(i.state, ISSUE_COLOR[i.state])),
    facts(
      i.repo, login,
      i.author && `by ${i.author}`,
      when,
      i.comments > 0 && (i.comments === 1 ? "1 comment" : `${i.comments} comments`),
      i.assignees.length > 0 && `assigned to ${i.assignees.join(", ")}`,
    ),
    labelChips(i.labels),
    description(i.body) ?? h("div", { class: "int-empty", text: "No description." }),
  );
}

function commitsView(c: GithubCommitsDetail, login: string): HTMLElement {
  const count = c.total ?? c.commits.length;
  const single = c.commits.length === 1 && count <= 1;
  const newest = c.commits[0];
  const title = single && newest
    ? newest.message
    : `${count} commit${count === 1 ? "" : "s"}${c.branch ? ` on ${c.branch}` : ""}`;
  const rows = c.commits.map((commit) => {
    // From a list, a commit opens its own sheet; alone, it is already open.
    const open = single
      ? () => void Bridge.openUrl(commit.url)
      : () => openTarget(
          { kind: "commits", repo: c.repo, head: commit.id, count: 1, branch: c.branch, author: null, from: null, to: null },
          commit.message,
          commit.url,
        );
    return h(
      "button",
      { class: "gh-row", onclick: open },
      h("i", { class: "gh-row-icon", style: "color:#3B9EFF" }, svg(ICONS.commit, 12, { stroke: 2 })),
      h("span", { class: "gh-row-title", text: commit.message }),
      h("span", { class: "gh-row-where" }, h("span", { class: "gh-sha", text: commit.sha }), commit.author ? ` · ${commit.author}` : ""),
      h("span", { class: "int-ago", text: commit.at ? timeAgo(commit.at) : "" }),
    );
  });
  const more = count > c.commits.length ? h("div", { class: "int-empty", text: `and ${count - c.commits.length} more on GitHub` }) : null;
  const changed = c.additions != null && c.deletions != null ? plusMinus(c.additions, c.deletions) : undefined;
  return h(
    "div",
    { class: "gh-sheet" },
    titleRow(title, single && newest ? chip(newest.sha, "#3B9EFF") : null),
    facts(c.repo, login, newest?.author && `by ${newest.author}`, newest?.at && ago(newest.at)),
    runBlock(c.ci, c.missing),
    ...(single ? [] : [heading("Commits"), ...rows, more]).filter((n): n is HTMLElement => n != null),
    ...(c.files.length ? [heading(single ? "Files" : "Latest commit", changed), ...c.files.map((f) => fileRow(f, newest?.url ?? c.url))] : []),
  );
}

/** 12345678 → "11.8 MB". */
function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function releaseView(r: GithubReleaseDetail, login: string): HTMLElement {
  const assets = r.assets.map((a) =>
    h(
      "div",
      { class: "gh-row" },
      h("i", { class: "gh-row-icon", style: "color:#22D3EE" }, svg(ICONS.tag, 11, { stroke: 2 })),
      h("span", { class: "gh-row-title", text: a.name }),
      h("span", { class: "gh-row-where", text: size(a.size) }),
      h("span", { class: "int-ago", text: `${compact(a.downloads)} ↓` }),
    ),
  );
  return h(
    "div",
    { class: "gh-sheet" },
    titleRow(r.name, chip(r.tag, "#22D3EE"), r.prerelease ? chip("pre-release", "#F5A524") : null),
    facts(
      r.repo, login,
      r.author && `by ${r.author}`,
      r.publishedAt && `published ${ago(r.publishedAt)}`,
      r.downloads > 0 && `${compact(r.downloads)} download${r.downloads === 1 ? "" : "s"}`,
    ),
    ...(assets.length ? [heading("Files"), ...assets] : []),
    description(r.body),
  );
}

const LOCKED_WHAT: Record<string, string> = {
  "Pull requests": "Pull requests",
  Issues: "Issues",
  Contents: "Commits and releases",
};

function detailView(d: GithubDetail, login: string, url: string): HTMLElement {
  switch (d.kind) {
    case "pull":
      return pullView(d, login);
    case "issue":
      return issueView(d, login);
    case "commits":
      return commitsView(d, login);
    case "release":
      return releaseView(d, login);
    case "locked":
      return h(
        "div",
        { class: "gh-sheet" },
        notGranted(LOCKED_WHAT[d.permission] ?? d.permission, d.permission),
        h("button", { class: "gh-host", text: "Open it on GitHub instead", onclick: () => void Bridge.openUrl(url) }),
      );
  }
}

/** What Mochi makes of a sheet that took a moment: pleased, proud, or startled by a failure. */
function detailMood(d: GithubDetail): BotEmoteName | null {
  switch (d.kind) {
    case "pull":
      return d.ci?.state === "failure" ? "surprised" : d.state === "merged" ? "proud" : "happy";
    case "commits":
      return d.ci?.state === "failure" ? "surprised" : "happy";
    case "issue":
      return d.state === "completed" ? "proud" : "happy";
    case "release":
      return "proud";
    case "locked":
      return null;
  }
}

/** "#12", "#4", "Commits", "v0.2.0" — what the head says while a sheet is open. */
function detailHead(target: GithubTarget): string {
  switch (target.kind) {
    case "pull":
    case "issue":
      return `#${target.number}`;
    case "commits":
      return target.count === 1 ? "Commit" : "Commits";
    case "release":
      return target.tag;
    case "project":
      return target.repo;
  }
}

// ── A file's diff ─────────────────────────────────────────────────────────────
//
// The unified diff GitHub sends, drawn the way the settings window already
// draws the hooks' diff: monospace, added lines green, removed lines red —
// with GitHub's old and new line numbers in the gutter.

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function diffView(file: GithubFile, url: string): HTMLElement {
  const status = FILE_STATUS[file.status ?? ""] ?? MODIFIED;
  const wrap = h(
    "div",
    { class: "gh-sheet" },
    h(
      "div",
      { class: "gh-diff-head" },
      chip(file.status ?? "modified", status.color),
      h("span", { class: "gh-diff-path", text: file.path }),
      plusMinus(file.additions, file.deletions),
    ),
  );
  if (!file.patch) {
    wrap.append(h("div", { class: "int-empty", text: "No text diff for this file — binary, or too large for GitHub to show." }));
    return wrap;
  }

  const diff = h("div", { class: "gh-diff" });
  let oldLine = 0;
  let newLine = 0;
  for (const raw of file.patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      diff.append(h("div", { class: "gh-diff-line hunk" }, h("span", { class: "t", text: raw })));
      continue;
    }
    const sign = raw.charAt(0);
    let kind = "ctx";
    let before = "";
    let after = "";
    if (sign === "+") {
      kind = "add";
      after = String(newLine++);
    } else if (sign === "-") {
      kind = "del";
      before = String(oldLine++);
    } else if (sign === "\\") {
      kind = "meta";
    } else {
      before = String(oldLine++);
      after = String(newLine++);
    }
    diff.append(
      h(
        "div",
        { class: `gh-diff-line ${kind}` },
        h("span", { class: "n", text: before }),
        h("span", { class: "n", text: after }),
        h("span", { class: "s", text: kind === "add" || kind === "del" ? sign : "" }),
        h("span", { class: "t", text: kind === "meta" ? raw : raw.slice(1) }),
      ),
    );
  }
  wrap.append(diff);
  if (file.truncated) {
    wrap.append(h("button", { class: "gh-host", text: "The rest of this diff is on GitHub", onclick: () => void Bridge.openUrl(url) }));
  }
  return wrap;
}

export function buildGithub(actions: ViewActions): ViewHost {
  const back = h(
    "button",
    {
      class: "int-back",
      title: "Back",
      // One level back through the sheets; from the lists, back to the card.
      onclick: () => {
        actions.blip();
        if (stack.length > 0) pop();
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
      // Whatever is on screen, on GitHub — the way out, never the way in.
      onclick: () => {
        const s = top();
        const target = !s
          ? (githubData()?.profileUrl ?? "https://github.com")
          : s.type === "project"
            ? (s.data?.url ?? `https://github.com/${s.fullName}`)
            : s.type === "detail"
              ? (s.data && s.data.kind !== "locked" ? s.data.url : s.url)
              : s.url;
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

  /**
   * Fresh news after a wait: the parts come in one by one, and Mochi says what
   * he thinks of them.
   */
  function arrive(content: HTMLElement, screen: Pending<unknown>, emote: BotEmoteName | null) {
    if (!screen.react) return;
    screen.react = false;
    Array.from(content.children).forEach((child, i) => (child as HTMLElement).style.setProperty("--i", String(i)));
    content.classList.add("enter");
    if (emote) actions.emote(emote);
  }

  /** A screen of the stack takes the list's place; the head names what it shows. */
  function drawScreen(screen: Screen, login: string) {
    tabs.style.display = "none";
    clear(status);
    listTab = null;
    clearList();
    if (screen.type === "diff") {
      const { dir, base } = splitPath(screen.file.path);
      who.textContent = base;
      sub.textContent = dir;
      list.append(diffView(screen.file, screen.url));
    } else if (screen.type === "project") {
      who.textContent = repoName(screen.fullName, login);
      sub.textContent = screen.data?.languages[0]?.name ?? "";
      if (screen.error) status.append(dot(GITHUB_RED, 5), h("span", { text: screen.error }));
      if (screen.data) {
        const content = projectSheet(screen.data);
        arrive(content, screen, mood(screen.data));
        list.append(content);
      } else if (screen.waiting) {
        list.append(sheetLoader(repoName(screen.fullName, login)));
      }
    } else {
      who.textContent = detailHead(screen.target);
      sub.textContent = repoName(screen.target.repo, login);
      if (screen.error) status.append(dot(GITHUB_RED, 5), h("span", { text: screen.error }));
      if (screen.data) {
        const content = detailView(screen.data, login, screen.url);
        arrive(content, screen, detailMood(screen.data));
        list.append(content);
      } else if (screen.waiting) {
        list.append(sheetLoader(screen.label));
      }
    }
    list.scrollTop = 0;
    updateFade();
  }

  refreshBtn.addEventListener("click", async () => {
    const s = top();
    if (refreshing || (s && s.type !== "diff" && s.loading)) return;
    actions.blip();
    if (s?.type === "project") {
      void loadProject(s, true);
      return;
    }
    if (s?.type === "detail") {
      void loadDetail(s, true);
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

      const s = top();
      refreshBtn.classList.toggle("spin", refreshing || (s != null && s.type !== "diff" && s.loading));
      // A diff is part of the sheet under it: nothing of its own to refresh.
      refreshBtn.style.display = configured && s?.type !== "diff" ? "" : "none";

      // Rebuilding the rows between a mouse-down and its mouse-up would swallow
      // the click, so only rebuild when something they show has changed.
      const next = [configured, error, d?.fetchedAt, d?.login, tab, stamp].join("~");
      if (next === key) return;
      key = next;

      if (s && d && configured) {
        drawScreen(s, d.login);
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
          list.append(repoRow(repo, d.login, () => openProject(repo.fullName)));
        }
      } else {
        // The year first, then what happened lately — or on the picked day.
        const picked = day && d.contributions ? day : null;
        if (d.contributions) {
          list.append(
            contributionGraph(d.contributions, {
              sweep,
              tint: actions.tintMochi,
              picked: picked?.index ?? null,
              onPick: (index, date) => {
                actions.blip();
                pickDay(index, date);
              },
            }),
          );
          // Mochi wears the picked day's colour for as long as it is picked.
          if (picked) actions.tintMochi(mochiShade(d.contributions, picked.index));
        }
        if (picked) {
          list.append(
            daySection(picked, d.login, () => {
              actions.blip();
              unpickDay();
            }),
          );
        } else {
          if (d.activity.length === 0) {
            list.append(h("div", { class: "int-empty", text: "Nothing in the last 30 days." }));
          }
          for (const a of d.activity) list.append(activityRow(a, d.login));
        }
      }
      list.scrollTop = scroll;
      updateFade();
    },
  };
}
