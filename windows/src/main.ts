// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import type { PlanUsage } from "./core/plan";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings", true);
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView(), true);
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  await onEvent<boolean>("fullscreen", (full) => island.setFullscreen(full));
  await onEvent<null>("outside-press", () => island.outsidePress());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  // A key saved or removed in the settings window.
  await onEvent<null>("secrets-changed", () => void refreshConfigured());

  // The Claude plan gauge: what was last heard, then each new figure as Claude
  // Code's status line reports it. Figures only — nothing opens for them.
  State.planUsage = (await Bridge.planUsage()) ?? null;
  State.planRelayInstalled = (await Bridge.planRelayStatus())?.installed ?? false;
  await onEvent<PlanUsage>("plan-usage", (usage) => {
    State.planUsage = usage;
    State.notify();
  });
  await onEvent<boolean>("plan-relay-changed", (installed) => {
    State.planRelayInstalled = installed;
    State.notify();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
