// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { IntegrationNews } from "./bridge";

export type AgentSource = "claudeCode" | "n8n";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** For an edit: what it would do to its file, to read before allowing it. */
  proposal: FileProposal | null;
}

/** An edit that has not happened yet, as the diff it would make. */
export interface FileProposal {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** The file does not exist yet. */
  created: boolean;
}

/** One thing Claude asks with its question tool, as the tool words it. */
export interface Question {
  question: string;
  /** A word or two saying what the question is about. */
  header: string | null;
  options: { label: string; description: string | null }[];
  multiSelect: boolean;
}

/** A question Claude is waiting on — up to four at once, answered together. */
export interface QuestionInfo {
  requestId: string;
  sessionId: string;
  questions: Question[];
}

/** The app a Claude Code session runs in. */
export type ClaudeClient = "desktop" | "vscode" | "terminal";

/** What the Claude pill is called while it follows a session from that app. */
export const CLIENT_NAMES: Record<ClaudeClient, string> = {
  desktop: "Claude",
  vscode: "VS Code",
  terminal: "Terminal",
};
/** Until a session has spoken, the pill keeps the name it always had. */
export const CLIENT_UNKNOWN = "VS Code";

/** One edit Claude made to a file: its unified diff, as coucou-hook built it. */
export interface FileEdit {
  patch: string;
  additions: number;
  deletions: number;
  /** The diff was longer than the relay forwards. */
  truncated: boolean;
  at: number;
}

/** A file Claude touched in a session, with every edit it made to it, oldest first. */
export interface ChangedFile {
  /** Relative to the session's folder when it is inside it, with forward slashes. */
  path: string;
  /** Written new in this session. */
  created: boolean;
  additions: number;
  deletions: number;
  edits: FileEdit[];
  at: number;
}

/** One tool of the turn under way, by its own name: going, done, or failed. */
export interface SessionStep {
  tool: string;
  state: "running" | "done" | "failed";
}

/** The Claude Code session the island is following: the last one heard from. */
export interface ClaudeSession {
  id: string;
  client: ClaudeClient | null;
  /** The conversation's title, when Claude Code has given it one. */
  title: string | null;
  /** The tools of the turn under way, oldest first; "Done" closes a turn. */
  steps: SessionStep[];
  /** What the user asked last, and what Claude said to end its turn. */
  asked: string | null;
  answer: string | null;
  /** When that answer came. */
  answeredAt: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** The pill that follows Claude Code sessions. */
export const CLAUDE_ID = "integration_claude";

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
  /** What just happened, for as long as the pill says it. */
  news?: IntegrationNews | null;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;
  pendingQuestion: QuestionInfo | null = null;

  session: ClaudeSession = {
    id: "", client: null, title: null, steps: [], asked: null, answer: null, answeredAt: 0,
  };
  /** What each session changed, by session id — the few last sessions only. */
  changes = new Map<string, ChangedFile[]>();

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** The Claude pill's name: the app of the session it follows. */
  get clientName(): string {
    return this.session.client ? CLIENT_NAMES[this.session.client] : CLIENT_UNKNOWN;
  }

  /** The files the session being followed has changed, the last touched first. */
  get sessionFiles(): ChangedFile[] {
    return this.changes.get(this.session.id) ?? [];
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Keep the declared order so pills never shuffle.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
