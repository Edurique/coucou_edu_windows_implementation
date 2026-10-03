// Claude plan usage, as the island shows it — the helpers of
// ClaudePlanGauge.swift. The figures come from Claude Code's status line
// (see plan.rs); nothing here asks anybody for anything.

export interface PlanWindow {
  /** 0–100. */
  usedPct: number;
  /** Unix seconds. */
  resetsAt: number;
}

export interface PlanUsage {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  /** Unix milliseconds: when Claude Code last said so. */
  updatedAt: number;
}

/** Under this much of a limit used, the gauge is green; under the next, amber; then red. */
const CALM_BELOW = 50;
const WARN_BELOW = 80;
const COLORS = { none: "#6B7079", calm: "#22C55E", warn: "#F59E0B", high: "#F4505E" };

/** What a window counts for now: nothing once its reset time has passed. */
export function effectivePct(window: PlanWindow, now = Date.now()): number {
  return window.resetsAt * 1000 <= now ? 0 : window.usedPct;
}

/** The higher of the two windows; null when there is neither. */
export function dominantPct(usage: PlanUsage | null, now = Date.now()): number | null {
  if (!usage) return null;
  const both = [usage.fiveHour, usage.sevenDay].filter((w): w is PlanWindow => w != null).map((w) => effectivePct(w, now));
  return both.length > 0 ? Math.max(...both) : null;
}

/** The colour a percentage is shown in; grey for none. */
export function planColor(pct: number | null): string {
  if (pct == null) return COLORS.none;
  return pct < CALM_BELOW ? COLORS.calm : pct < WARN_BELOW ? COLORS.warn : COLORS.high;
}

/** What the header's pill says. */
export function planLabel(usage: PlanUsage | null, now = Date.now()): string {
  const pct = dominantPct(usage, now);
  return pct == null ? "Claude —" : `Claude ${Math.round(pct)}%`;
}

/** How long ago the figures came, in the card's words. */
export function planAge(usage: PlanUsage | null, now = Date.now()): string {
  if (!usage) return "Waiting for a Claude Code reply";
  const minutes = Math.floor((now - usage.updatedAt) / 60_000);
  if (minutes < 1) return "just now";
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** When a window resets: "in 1 h 20" for the short one, "Mon 9:00" for the week. */
export function resetLabel(window: PlanWindow, weekly: boolean, now = Date.now()): string {
  const seconds = window.resetsAt - now / 1000;
  if (seconds <= 0) return "Resetting…";
  if (weekly) {
    const at = new Date(window.resetsAt * 1000);
    return `${WEEKDAYS[at.getDay()]} ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `in ${hours} h ${minutes}` : `in ${minutes} min`;
}
