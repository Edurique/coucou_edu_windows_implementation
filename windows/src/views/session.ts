// The session panel — a Claude Code session at work, watched from the island.
//
// The view the prototype draws for a session: Mochi's column on the left with
// the session's name and its last steps (Read, Edit, Bash… done, or going), and
// on the right the file being written, as an editor shows it — the old line
// struck, the new one typed under it. Behind it, the files the session has
// changed and each one's whole diff, and once the turn is over, what Claude
// said to end it. It is for watching: to answer, there is Claude Code.
//
// Windows only for now. It is the GitHub panel's layout and diff again, and
// nothing here is fetched: it is all in the hooks Claude Code already sends.
// An edit is shown the moment Claude Code says it is done, so the typing is a
// replay of it, a second behind. The session itself stays where it runs — the
// Claude app, VS Code, a terminal.

import { h, svg, clear, dot } from "./dom";
import { diffLine, extBadge, fileKind, plusMinus, readPatch, splitPath, type FileKind } from "./code";
import { ICONS } from "./icons";
import { COLOR } from "./palette";
import { timeAgo } from "./integrations";
import { markdown } from "./markdown";
import { CLAUDE_ID, State, type AgentTask, type ChangedFile, type ClaudeSession, type SessionStep } from "../core/state";
import { botGlowColor } from "../core/layout";
import type { ViewActions, ViewHost } from "./views";

/** What a session is called until it has a project or a title to go by. */
const UNNAMED = "Claude Code";
/** Steps the column has room for: the last ones. */
const STEPS_SHOWN = 4;
/** An edit is typed out when it reached the island less than this ago; older, it is just shown. */
const FRESH_MS = 4_000;
/** However long the edit, typing it takes about this long, a tick at a time. */
const TYPE_MS = 1_800;
const TICK_MS = 16;

/** What is on screen: the file being written, the list of changes, or one file's diff. */
type Screen = { kind: "live" } | { kind: "list" } | { kind: "file"; path: string };
let screen: Screen = { kind: "live" };
/** Bumped by every action: what the view shows has changed. */
let stamp = 0;

function go(next: Screen) {
  screen = next;
  stamp++;
  State.notify();
}

/**
 * Back on the session as it is now — the file being written, or what Claude
 * said once it is done — or, asked for its changes, on their list.
 */
export function enterSessionPanel(changes = false) {
  screen = { kind: changes ? "list" : "live" };
  stamp++;
}

/**
 * The end of a turn: what was asked, then Claude's reply as it wrote it,
 * under a line that says whose words these are and how old.
 */
function talkView(asked: string | null, answer: string, at: number): HTMLElement {
  const el = h("div", { class: "sess-talk" });
  if (asked) el.append(h("div", { class: "sess-asked", text: asked }));
  const ago = timeAgo(at);
  el.append(
    h("div", { class: "sess-said" }, dot(COLOR.green, 6), h("b", { text: "Claude's last reply" }), h("span", { text: ago === "just now" ? ago : `${ago} ago` })),
    markdown(answer),
  );
  return el;
}

/** Tools by a name short enough for the column, where their own is not. */
const STEP_NAMES: Record<string, string> = {
  AskUserQuestion: "Question",
  NotebookEdit: "Notebook",
  TodoWrite: "Todos",
  WebSearch: "Search",
  WebFetch: "Fetch",
};


const counted = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// ── Several sessions ──────────────────────────────────────────────────────────

/** A session by its name: the conversation's title, or untitled, the folder it works in. */
export const sessionName = (session: ClaudeSession) => session.title ?? session.project;

/** Where a session is at, as a colour and in words: what its tab shows and says. */
function standing(session: ClaudeSession): { color: string; words: string } {
  if (session.question) return { color: COLOR.cyan, words: "is asking a question" };
  if (session.approval) return { color: COLOR.amber, words: "needs permission" };
  if (session.news === "error" || session.state === "error") return { color: COLOR.red, words: "stopped on an error" };
  if (session.news === "finished" || session.state === "finished") return { color: COLOR.green, words: "finished" };
  if (session.state === "question") return { color: COLOR.cyan, words: "is waiting for you" };
  if (session.state === "idle" || session.state === "sleeping") return { color: COLOR.grey, words: "at rest" };
  return { color: botGlowColor(session.state), words: "at work" };
}

/**
 * A session's tab: a dot for where it is at, and its name. One waiting for an
 * answer, or with news nobody has seen, stands out in its colour.
 */
function sessionTab(session: ClaudeSession, onPick: (id: string) => void): HTMLElement {
  const { color, words } = standing(session);
  const name = sessionName(session);
  const calls = session.news != null || session.question != null || session.approval != null;
  const tab = h(
    "button",
    { class: calls ? "sess-tab calls" : "sess-tab", title: `${name} — ${words}`, onclick: () => onPick(session.id) },
    dot(color, 6),
    h("span", { text: name }),
  );
  tab.style.setProperty("--c", color);
  return tab;
}

/**
 * Keeps a row of tabs in step with the sessions behind the one in front —
 * that one is named right above them. Rebuilt only when a tab would change:
 * between a mouse-down and its mouse-up, a rebuild would swallow the click.
 * Returns how many tabs it shows.
 */
export function sessionTabs(el: HTMLElement, onPick: (id: string) => void): () => number {
  let key = "";
  return () => {
    const behind = State.sessions.filter((s) => s.id !== State.frontId);
    const next = behind.map((s) => [s.id, sessionName(s), standing(s).words].join(":")).join("|");
    if (next !== key) {
      key = next;
      clear(el);
      for (const session of behind) el.append(sessionTab(session, onPick));
    }
    el.style.display = behind.length > 0 ? "" : "none";
    return behind.length;
  };
}

/** The states of a session with a turn under way. */
const AT_WORK = new Set(["working", "thinking", "searching", "approval", "question"]);

/** Claude is at work: a message left now will be read when this turn ends. */
function running(task: AgentTask | null): boolean {
  return task != null && AT_WORK.has(task.state);
}

/** What happened to the file, as the GitHub panel says it: "edited" in grey, "new" in green. */
function statusWord(file: ChangedFile): HTMLElement {
  const word = h("span", { class: "gh-file-status", text: file.created ? "new" : "edited" });
  if (file.created) word.style.color = COLOR.green;
  return word;
}

function fileRow(file: ChangedFile): HTMLElement {
  const { dir, base } = splitPath(file.path);
  return h(
    "button",
    { class: "gh-row gh-file", title: file.path, onclick: () => go({ kind: "file", path: file.path }) },
    h("i", { class: "gh-row-icon" }, extBadge(file.path)),
    h("span", { class: "gh-row-title", text: base }),
    h("span", { class: "gh-row-where", text: dir }),
    h("span", { class: "gh-right" }, statusWord(file), plusMinus(file.additions, file.deletions), h("span", { class: "int-ago", text: timeAgo(file.at) })),
  );
}

/** A quiet line across a diff: lines skipped, or the start of another edit. */
function diffBreak(text: string): HTMLElement {
  return h("div", { class: "gh-diff-line hunk" }, h("span", { class: "n", text: "⋯" }), h("span", { class: "s" }), h("span", { class: "t", text }));
}

/** A line still to be typed: its row, empty for now, and what goes in it. */
interface ToType {
  row: HTMLElement;
  number: number | null;
  text: string;
}

/**
 * Every edit to the file, oldest first, a quiet break between two of them.
 * With `typed`, the last edit's new lines come out empty and hidden, and are
 * handed back to be typed.
 */
function diffView(file: ChangedFile, kind: FileKind, typed: boolean): { el: HTMLElement; toType: ToType[] } {
  const diff = h("div", { class: "gh-diff" });
  const several = file.edits.length > 1;
  const toType: ToType[] = [];
  file.edits.forEach((edit, i) => {
    const last = i === file.edits.length - 1;
    let first = true;
    for (const line of readPatch(edit.patch)) {
      if ("hunk" in line) {
        // Between two edits, which one this is; inside one, where lines were skipped.
        const label = first && several ? `Edit ${i + 1} of ${file.edits.length} · ${timeAgo(edit.at)}` : "";
        if (!first || label) diff.append(diffBreak(label));
        first = false;
        continue;
      }
      const number = line.new ?? line.old;
      if (typed && last && line.sign === "+") {
        const row = diffLine(number, "+", "", kind);
        row.classList.add("untyped");
        toType.push({ row, number, text: line.text });
        diff.append(row);
      } else {
        diff.append(diffLine(number, line.sign, line.text, kind));
      }
    }
    if (edit.truncated) diff.append(diffBreak("The rest of this edit is in Claude Code"));
  });
  return { el: h("div", { class: "gh-code" }, diff), toType };
}

const STEP_ICONS: Record<SessionStep["state"], () => Element> = {
  running: () => h("i", { class: "sess-mark run" }),
  done: () => h("i", { class: "sess-mark done" }, svg(ICONS.check, 8, { stroke: 3.2 })),
  failed: () => h("i", { class: "sess-mark failed" }, svg(ICONS.xmark, 7)),
};

export function buildSession(actions: ViewActions): ViewHost {
  const who = h("b", { text: UNNAMED });
  const sub = h("span", { class: "gh-sub" });
  const badge = h("span", { class: "gh-head-badge" });
  const aside = h("span", { class: "gh-head-aside" });
  // One step back: from a file to the changes, from the changes to the file being written.
  const backBtn = h("button", { class: "gh-icon sess-back", title: "Back" }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const filesBtn = h("button", { class: "sess-files", title: "Every file this session changed" });
  const openBtn = h(
    "button",
    { class: "gh-icon", title: "Open the session", onclick: () => actions.openTerminal() },
    svg(ICONS.arrowUpRight, 10),
  );
  const tab = h("div", { class: "gh-tab" }, badge, who);
  const head = h("div", { class: "gh-head" }, backBtn, tab, aside, h("div", { class: "grow" }), sub, filesBtn, openBtn);
  const list = h("div", { class: "gh-list" });

  const main = h("div", { class: "gh-main" }, head, list);
  const name = h("b", { text: UNNAMED });
  const nameSub = h("span", { text: UNNAMED });
  const steps = h("div", { class: "sess-steps" });
  // The sessions behind this one, at the foot of the column: a click puts one in front.
  const others = h("div", { class: "sess-others" });
  const syncOthers = sessionTabs(others, (id) => {
    screen = { kind: "live" };
    stamp++;
    actions.pickSession(id);
  });
  const side = h("div", { class: "gh-side" }, h("div", { class: "gh-side-who" }, name, nameSub), steps, others);
  const el = h("div", { class: "view gh-view session-view" }, h("div", { class: "card gh-card" }, side, h("div", { class: "gh-col" }, main)));

  backBtn.addEventListener("click", () => {
    actions.blip();
    go(screen.kind === "file" ? { kind: "list" } : { kind: "live" });
  });
  filesBtn.addEventListener("click", () => {
    actions.blip();
    go({ kind: "list" });
  });

  const updateFade = () => list.classList.toggle("more", list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  list.addEventListener("scroll", updateFade, { passive: true });
  new ResizeObserver(updateFade).observe(list);

  // ── Typing ──────────────────────────────────────────────────────────────────

  let typing: number | null = null;
  /** The edit typed last, by when it came: it is typed once. */
  let typedAt = 0;

  function stopTyping() {
    if (typing != null) window.clearInterval(typing);
    typing = null;
    tab.classList.remove("writing");
  }

  /**
   * Types the new lines of an edit one after the other, a caret at the end,
   * each line taking its colours once it is whole. Out of sight — the island
   * folded, another view up — it has nobody to type for and ends at once.
   */
  function type(lines: ToType[], kind: FileKind) {
    stopTyping();
    if (lines.length === 0) return;
    const total = lines.reduce((n, l) => n + l.text.length + 1, 0);
    const perTick = Math.max(1, Math.ceil(total / (TYPE_MS / TICK_MS)));
    const caret = h("span", { class: "sess-caret" });
    let at = 0;
    let letters = 0;
    tab.classList.add("writing");

    const finish = (line: ToType) => line.row.replaceWith(diffLine(line.number, "+", line.text, kind));
    const begin = (line: ToType) => {
      line.row.classList.remove("untyped");
      line.row.scrollIntoView({ block: "nearest" });
    };
    begin(lines[0]);

    typing = window.setInterval(() => {
      const seen = State.mode === "expanded" && State.view === "session" && lines[at].row.isConnected;
      let budget = seen ? perTick : total;
      while (budget > 0 && at < lines.length) {
        const line = lines[at];
        const step = Math.min(budget, line.text.length - letters);
        letters += step;
        budget -= step;
        if (letters < line.text.length) break;
        // The end of a line costs a letter: the pause of a carriage return.
        finish(line);
        budget -= 1;
        at++;
        letters = 0;
        if (at < lines.length) begin(lines[at]);
      }
      if (at >= lines.length) {
        stopTyping();
        updateFade();
        return;
      }
      const cell = lines[at].row.querySelector(".t");
      if (cell) {
        cell.textContent = lines[at].text.slice(0, letters);
        cell.append(caret);
      }
    }, TICK_MS);
  }

  let key = "";
  let stepsKey = "";
  /** What the list last drew, to keep its scroll when it draws the same again. */
  let drawn = "";

  return {
    el,
    sync() {
      const task = State.tasks.find((t) => t.id === CLAUDE_ID) ?? null;
      const files = State.sessionFiles;
      const live = running(task);

      // The column: whose session, where it runs, and its last steps — fewer
      // of them when other sessions take a line each at its foot.
      const shown = State.session.steps.slice(-Math.max(1, STEPS_SHOWN - syncOthers()));
      const nextSteps = [task?.name, State.session.title, ...shown.map((s) => `${s.tool}:${s.state}`)].join("~");
      if (nextSteps !== stepsKey) {
        stepsKey = nextSteps;
        // The conversation by its title, and under it the project it works in;
        // untitled, the project is its name.
        const title = State.session.title;
        const project = task?.name ?? UNNAMED;
        name.textContent = title ?? project;
        name.title = title ?? "";
        nameSub.textContent = title ? project : UNNAMED;
        clear(steps);
        for (const s of shown) {
          steps.append(h("div", { class: `sess-step ${s.state}` }, STEP_ICONS[s.state](), h("span", { text: STEP_NAMES[s.tool] ?? s.tool, title: s.tool })));
        }
      }

      // Rebuilding the rows between a mouse-down and its mouse-up would swallow
      // the click, so only rebuild when something they show has changed.
      const total = files.reduce((n, f) => n + f.edits.length, 0);
      // Once the turn is over, the live screen is what Claude said to end it.
      const answer = !live ? State.session.answer : null;
      const next = [State.session.id, stamp, screen.kind, total, files[0]?.path, answer].join("~");
      if (next === key) return;
      key = next;

      // A file opened and gone since (another session took over): the list.
      const opened = screen.kind === "file" ? screen.path : null;
      const picked = opened ? (files.find((f) => f.path === opened) ?? null) : null;
      if (screen.kind === "file" && !picked) screen = { kind: "list" };
      const talking = screen.kind === "live" && answer != null;
      const file = talking ? null : screen.kind === "live" ? (files[0] ?? null) : picked;

      const now = `${screen.kind}:${file?.path ?? ""}:${talking}`;
      const scroll = now === drawn ? list.scrollTop : 0;
      drawn = now;
      stopTyping();
      clear(list);
      clear(badge);
      clear(aside);
      sub.classList.toggle("path", file != null);
      who.classList.toggle("file", file != null);
      list.classList.toggle("gh-edge", file != null);
      backBtn.style.display = screen.kind === "live" ? "none" : "";
      filesBtn.style.display = screen.kind === "live" && files.length > 0 ? "" : "none";
      filesBtn.textContent = counted(files.length, "file");

      if (file) {
        const kind = fileKind(file.path);
        const newest = file.edits[file.edits.length - 1];
        // Typed once, and only while it is news: opened later, the edit is just there.
        const fresh = screen.kind === "live" && newest != null && newest.at > typedAt && Date.now() - newest.at < FRESH_MS;
        if (newest) typedAt = Math.max(typedAt, newest.at);
        who.textContent = splitPath(file.path).base;
        sub.textContent = file.path;
        badge.append(extBadge(file.path));
        main.style.setProperty("--accent", file.created ? COLOR.green : COLOR.amber);
        aside.append(statusWord(file), plusMinus(file.additions, file.deletions));
        const view = diffView(file, kind, fresh);
        list.append(view.el);
        if (fresh) type(view.toType, kind);
        else if (screen.kind === "live") {
          // The file being written opens on what was written last.
          const rows = view.el.querySelectorAll<HTMLElement>(".gh-diff-line.add, .gh-diff-line.del");
          rows[rows.length - 1]?.scrollIntoView({ block: "center" });
        } else list.scrollTop = scroll;
      } else {
        who.textContent = screen.kind === "list" ? "Changes" : talking ? "Reply" : UNNAMED;
        badge.append(dot(task?.color ?? COLOR.idle, 7));
        main.style.setProperty("--accent", "rgba(0,0,0,0)");
        sub.textContent = screen.kind === "list" && files.length > 0 ? counted(files.length, "file") : "";
        if (screen.kind === "list" && files.length > 0) {
          aside.append(plusMinus(files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0)));
        }
        if (talking && answer) {
          list.append(talkView(State.session.asked, answer, State.session.answeredAt));
        } else if (files.length === 0) {
          list.append(
            h("div", {
              class: "int-empty",
              text: State.session.id ? "Nothing written in this session yet." : "No Claude Code session yet.",
            }),
          );
        }
        if (screen.kind === "list") for (const f of files) list.append(fileRow(f));
        list.scrollTop = scroll;
      }
      updateFade();
    },
  };
}
