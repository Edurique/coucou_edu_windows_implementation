// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

/** Which Credential Manager key backs each pill. */
const KEY_FOR: Record<string, string> = {
  integration_stripe: "stripe-api-key",
  integration_github: "github-token",
  integration_vercel: "vercel-token",
  integration_n8n: "n8n-api-key",
  integration_resend: "resend-api-key",
  integration_notion: "notion-api-key",
  integration_calcom: "calcom-api-key",
};

const clearTimers = new Map<string, number>();

/**
 * Integrations whose news takes the pill for itself: their Mochi steps to the
 * front and the pill says the news in words. Among four mini Mochis a badge on
 * one is easy to miss, and "a build broke" is worth more than a dot.
 */
const SPEAKS_UP = new Set(["integration_github"]);
/** The pill each of them took the front from, to hand it back. */
const borrowedFrom = new Map<string, string>();
/** States that are waiting for the user: nothing takes the front from those. */
const WAITING = new Set(["approval", "question"]);

/** Hands the front of the pill back, unless the user moved it since. */
function giveBack(id: string) {
  const previous = borrowedFrom.get(id);
  borrowedFrom.delete(id);
  if (previous && State.focusId === id) State.setFocus(previous);
}

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void refreshConfigured();
}

/** Asks Rust which keys exist so the idle cards can say so. */
export async function refreshConfigured() {
  for (const [id, key] of Object.entries(KEY_FOR)) {
    const present = (await Bridge.secretPresent(key)) ?? false;
    const info = State.integrations[id] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[id] = { ...info, configured: present };
  }
  const hooks = State.settings.hooksInstalled;
  const claude = State.integrations.integration_claude ?? {
    data: {}, error: null, loaded: false, configured: false,
  };
  State.integrations.integration_claude = { ...claude, configured: hooks };
  State.notify();
}

function handle(island: Island, update: IntegrationUpdate) {
  if (State.paused) return;

  const previous = State.integrations[update.id];
  // A failed poll normally carries no data and keeps what was there. GitHub's
  // carries its last good snapshot, so the panel can go on showing it next to
  // the reason it isn't fresh.
  const hasData = Object.keys(update.data).length > 0;
  State.integrations[update.id] = {
    data: hasData ? update.data : (previous?.data ?? {}),
    error: update.error,
    loaded: hasData || (previous?.loaded ?? false),
    configured: previous?.configured ?? true,
    news: update.event ?? previous?.news ?? null,
  };

  const event = update.event;
  if (event) {
    const task = State.tasks.find((t) => t.id === update.id);
    if (task) {
      task.state = event.success ? "finished" : "error";
      task.steps = event.detail ? [event.label, event.detail] : [event.label];
      task.stepIndex = task.steps.length - 1;
      // Only while the island is away or folded: open, it is showing something
      // the user is reading, and the news has its own place there.
      const front = State.focusTask;
      if (
        SPEAKS_UP.has(update.id) && State.mode !== "expanded" && State.focusId !== update.id &&
        State.focusId && !(front && WAITING.has(front.state))
      ) {
        if (!borrowedFrom.has(update.id)) borrowedFrom.set(update.id, State.focusId);
        State.setFocus(update.id);
      }
      if (State.focusId !== update.id) {
        task.pillBadge = event.success ? "finished" : "error";
      }
      Sound.play(event.success ? "finish" : "error");
      // Same as the Swift pollers: show the compact island so the badge is seen,
      // but never steal the screen for a successful deploy.
      island.reveal();

      const existing = clearTimers.get(update.id);
      if (existing != null) window.clearTimeout(existing);
      clearTimers.set(
        update.id,
        window.setTimeout(() => {
          clearTimers.delete(update.id);
          const info = State.integrations[update.id];
          if (info) info.news = null;
          giveBack(update.id);
          const t = State.tasks.find((x) => x.id === update.id);
          if (!t || (t.state !== "finished" && t.state !== "error")) {
            State.notify();
            return;
          }
          t.state = "idle";
          t.steps = [];
          t.stepIndex = 0;
          t.pillBadge = null;
          State.notify();
        }, 60_000),
      );
    }
  }

  State.notify();
}
