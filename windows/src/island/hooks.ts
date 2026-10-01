// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// client — the Claude desktop app, VS Code, Windows Terminal, PowerShell… — and
// all of them are handled.
//
// Windows goes a step further than the Swift app on two things, both read from
// what the hooks already carry: what Claude is doing — each file it changes,
// what it said to end its turn (the session panel) — and the questions it asks
// with its question tool, answered on the island.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { CLAUDE_ID, State, type ChangedFile, type ClaudeClient, type Question } from "../core/state";
import type { Island } from "./island";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** CLAUDE_CODE_ENTRYPOINT and TERM_PROGRAM, added by coucou-hook. */
  entrypoint?: string;
  term_program?: string;
  /** What an edit tool did to its file — added by coucou-hook to PostToolUse. */
  change?: { patch: string; additions: number; deletions: number; truncated: boolean; created: boolean };
  /** What an edit asking for permission would do — added by coucou-hook to PermissionRequest. */
  proposal?: { patch: string; additions: number; deletions: number; truncated: boolean; created: boolean };
  /** The conversation's title, read by coucou-hook from the session's transcript. */
  session_title?: string;
  /** On a Stop: what Claude said to end its turn. */
  last_message?: string;
}

/** The tool Claude asks its questions with. */
const QUESTION_TOOL = "AskUserQuestion";

/** Sessions whose changes are kept: the one followed and the few before it. */
const MAX_SESSIONS = 4;
/** Files kept for a session, and edits kept for a file. */
const MAX_FILES = 40;
const MAX_EDITS = 30;
/** Steps kept for the turn under way; the session panel shows the last few. */
const MAX_STEPS = 12;

/** The step that closes a turn, in the place of a tool's name. */
const TURN_DONE = "Done";

/** A tool starts: one more step, going. */
function startStep(tool: string) {
  const steps = State.session.steps;
  steps.push({ tool, state: "running" });
  if (steps.length > MAX_STEPS) steps.shift();
}

/** A tool ends: its last step still going takes the outcome. */
function endStep(tool: string, state: "done" | "failed") {
  const step = [...State.session.steps].reverse().find((s) => s.tool === tool && s.state === "running");
  if (step) step.state = state;
}

/** The turn ends: nothing is going any more, and the column says so. */
function closeSteps() {
  for (const step of State.session.steps) if (step.state === "running") step.state = "done";
  State.session.steps.push({ tool: TURN_DONE, state: "done" });
}

function clientOf(payload: HookPayload): ClaudeClient {
  const entry = (payload.entrypoint ?? "").toLowerCase();
  if (entry.includes("desktop")) return "desktop";
  if (entry.includes("vscode") || (payload.term_program ?? "").toLowerCase().includes("vscode")) return "vscode";
  return "terminal";
}

/** The island follows one session: the last one heard from. */
function follow(payload: HookPayload) {
  const id = payload.session_id ?? "";
  if (!id) return;
  if (State.session.id === id) {
    State.session.client = clientOf(payload);
    if (payload.session_title) State.session.title = payload.session_title;
    return;
  }
  State.session = {
    id, client: clientOf(payload), title: payload.session_title ?? null,
    steps: [], asked: null, answer: null, answeredAt: 0,
  };
  if (!State.changes.has(id)) State.changes.set(id, []);
  for (const old of State.changes.keys()) {
    if (State.changes.size <= MAX_SESSIONS) break;
    if (old !== id) State.changes.delete(old);
  }
}

/** "C:\\work\\app\\src\\a.ts" in "C:\\work\\app" → "src/a.ts". Outside the folder, the whole path. */
function sessionPath(file: string, cwd: string): string {
  const path = file.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
}

/** One more edit to a file: the file moves to the top of the session's changes. */
function recordChange(payload: HookPayload) {
  const change = payload.change;
  const file = payload.tool_input?.file_path;
  if (!change || typeof file !== "string" || !State.session.id) return;
  const path = sessionPath(file, payload.cwd ?? "");
  const files = State.changes.get(State.session.id) ?? [];
  const at = files.findIndex((f) => f.path === path);
  const entry: ChangedFile =
    at >= 0 ? files.splice(at, 1)[0] : { path, created: change.created, additions: 0, deletions: 0, edits: [], at: 0 };
  entry.edits.push({
    patch: change.patch, additions: change.additions, deletions: change.deletions,
    truncated: change.truncated, at: Date.now(),
  });
  if (entry.edits.length > MAX_EDITS) entry.edits.shift();
  entry.additions += change.additions;
  entry.deletions += change.deletions;
  entry.at = Date.now();
  files.unshift(entry);
  if (files.length > MAX_FILES) files.pop();
  State.changes.set(State.session.id, files);
}

/** The question tool's input as the island shows it — null when it is not one it can answer. */
function questionsOf(input: Record<string, unknown>): Question[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    const options = Array.isArray(q?.options) ? (q.options as Record<string, unknown>[]) : [];
    if (typeof q?.question !== "string" || options.some((o) => typeof o?.label !== "string")) return null;
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : null,
      options: options.map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : null,
      })),
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}

/**
 * The card waiting for an answer is no longer needed: it was answered in
 * Claude Code itself, or the relay stopped waiting. The island lets go of it.
 */
function dropPending(island: Island) {
  if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
  pendingTimeout = null;
  if (!State.pendingApproval && !State.pendingQuestion) return;
  State.pendingApproval = null;
  State.pendingQuestion = null;
  State.isPinned = false;
  island.dropPin();
  State.updateTask(CLAUDE_ID, "working");
  State.setPillBadge(CLAUDE_ID, null);
  if (State.view === "approval" || State.view === "question") island.setView(State.defaultView());
}

/** True when this event says the pending card's tool has run: someone answered elsewhere. */
function answeredElsewhere(payload: HookPayload): boolean {
  const pending = State.pendingQuestion ?? State.pendingApproval;
  if (!pending || pending.sessionId !== (payload.session_id ?? "")) return false;
  const tool = State.pendingQuestion ? QUESTION_TOOL : State.pendingApproval?.tool;
  return payload.tool_name === tool;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = State.clientName;
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

/** Exported for the dev preview, which plays a session without Claude Code. */
export function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  follow(payload);

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  const focused = State.focusId === CLAUDE_ID;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      upsert(projectName, cwd);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      State.session.steps = [];
      const asked = payload.prompt ?? payload.message;
      if (asked && !asked.trimStart().startsWith("<")) {
        State.session.asked = asked;
        State.session.answer = null;
      }
      // What Claude Code feeds itself as a prompt — a task's notification, a
      // reminder — comes as markup, and is nobody's words to show.
      if (asked && !asked.trimStart().startsWith("<")) State.appendStep(CLAUDE_ID, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "working");
      const tool = payload.tool_name ?? "Tool";
      startStep(tool);
      State.appendStep(CLAUDE_ID, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      if (answeredElsewhere(payload)) dropPending(island);
      endStep(payload.tool_name ?? "Tool", "done");
      recordChange(payload);
      State.updateTask(CLAUDE_ID, "working");
      break;

    case "PostToolUseFailure":
      if (answeredElsewhere(payload)) dropPending(island);
      endStep(payload.tool_name ?? "Tool", "failed");
      State.updateTask(CLAUDE_ID, "working");
      State.appendStep(CLAUDE_ID, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(CLAUDE_ID, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(CLAUDE_ID, "question");
        State.appendStep(CLAUDE_ID, message);
      }
      break;
    }

    case "Stop":
      closeSteps();
      if (payload.last_message) {
        State.session.answer = payload.last_message;
        State.session.answeredAt = Date.now();
      }
      State.updateTask(CLAUDE_ID, "finished");
      if (payload.message) State.appendStep(CLAUDE_ID, payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(CLAUDE_ID, "finished");
      window.setTimeout(() => {
        State.updateTask(CLAUDE_ID, "idle");
        State.setPillBadge(CLAUDE_ID, null);
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(CLAUDE_ID, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(CLAUDE_ID, "error");
      break;

    case "SessionEnd":
      State.updateTask(CLAUDE_ID, "idle");
      clearSession();
      break;

    case "SubagentStart":
      State.appendStep(CLAUDE_ID, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(CLAUDE_ID, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      const held = State.pendingApproval ?? State.pendingQuestion;
      if (held && held.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      const sessionId = payload.session_id ?? "";
      // Claude's question tool asks for permission like any other: allowing it
      // with the answers is how a question gets answered from here.
      const questions = tool === QUESTION_TOOL ? questionsOf(input) : null;
      if (questions) State.pendingQuestion = { requestId, sessionId, questions };
      else {
        const file = input.file_path;
        const proposal =
          payload.proposal && typeof file === "string" ? { path: sessionPath(file, cwd), ...payload.proposal } : null;
        State.pendingApproval = { requestId, sessionId, tool, command: approvalTarget(tool, input), proposal };
      }
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(CLAUDE_ID, questions ? "question" : "approval");
      State.isPinned = true;
      Sound.play(questions ? "question" : "approval");
      if (focused) {
        island.alert(questions ? "question" : "approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        dropPending(island);
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
