// Mochi on the desktop, as the island sees it — the life cycle of
// DesktopMochiController in DesktopMochi.swift. He leaves the island for a
// window of his own (desktop.rs moves it, src/desktop/main.ts draws it), comes
// back with the request when Claude needs an answer, and returns to his place
// once it is given.

import { Bridge } from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { MochiNews } from "../desktop/main";

/** Where he is in his comings and goings (DesktopPhase). */
type Phase =
  /** In the island. */
  | "home"
  /** On his way out, or held by the mouse that pulled him out. */
  | "flyingOut"
  | "onDesktop"
  /** A request came in: surprised, about to fly back with it. */
  | "retracting"
  /** The request was answered before he had left his place. */
  | "alertResolvedDuringRetract"
  /** Back in the island for a request; he returns to his place once it is answered. */
  | "atNotchForAlert";

/** How long he looks surprised before he flies back with a request. */
const SURPRISE_MS = 450;
/** How long after the answer he leaves again. */
const RETURN_MS = 600;
const LANDING_EMOTE_S = 0.6;
const FINISHED_EMOTE_S = 1.2;
const DEFAULT_EMOTE_S = 1.8;

export class DesktopMochi {
  private phase: Phase = "home";
  private alert = false;
  private finished = false;
  /** What his page was last told, so it is told only what changed. */
  private told = "";

  /**
   * @param supported false where a window cannot be placed freely (Linux).
   * @param dancing whether the music has him dance, as the island decides it.
   */
  constructor(private supported: boolean, private dancing: () => boolean) {}

  /** True while a request is waiting for an answer. */
  private get alertNow(): boolean {
    return State.pendingApproval != null || State.pendingQuestion != null;
  }

  private emote(emote: BotEmoteName, duration = DEFAULT_EMOTE_S) {
    const news: MochiNews = { kind: "emote", emote, duration };
    void Bridge.mochiTell(news);
  }

  /** The shortcut: out when he is in, in when he is out. */
  toggle() {
    if (!this.supported) return;
    if (this.phase === "home") {
      State.settings.mochiOnDesktop = true;
      this.launchIfNeeded();
    } else if (this.phase === "onDesktop") this.flyHome();
  }

  /** Out to his place if that is where he lives: after the greeting, and after a request. */
  launchIfNeeded() {
    if (!this.supported || !State.settings.mochiOnDesktop || this.phase !== "home") return;
    // A request is waiting: he stays for it, and leaves once it is answered.
    if (this.alertNow) {
      this.phase = "atNotchForAlert";
      return;
    }
    this.phase = "flyingOut";
    this.leaveIsland();
    void Bridge.mochiFlyOut().then((left) => {
      if (!left) this.backHome();
    });
  }

  /** The mouse pulled him out of the island: his window takes over, already held. */
  takeOut() {
    if (!this.supported || this.phase !== "home") return;
    this.phase = "flyingOut";
    this.leaveIsland();
    void Bridge.mochiTakeOut().then((left) => {
      if (!left) this.backHome();
    });
  }

  /** Home for good: a double click on him, a drop on the island, the shortcut. */
  flyHome() {
    if (this.phase !== "onDesktop") return;
    this.phase = "home";
    void Bridge.mochiFlyHome(false);
  }

  private leaveIsland() {
    State.mochiOnDesktop = true;
    this.told = "";
    this.sync();
    State.notify();
  }

  private backHome() {
    this.phase = "home";
    State.mochiOnDesktop = false;
    State.notify();
  }

  /** What desktop.rs says happened to his window. */
  on(what: string) {
    switch (what) {
      case "landed": {
        // Moved to a new place by a drag: nothing changes for him.
        if (this.phase !== "flyingOut") return;
        this.phase = "onDesktop";
        State.settings.mochiOnDesktop = true;
        this.emote("happy", LANDING_EMOTE_S);
        Sound.play("pop");
        // The request may have come while he was in the air.
        if (this.alertNow) this.surprise();
        break;
      }
      case "home": {
        const forAlert = this.phase === "retracting" || this.phase === "alertResolvedDuringRetract";
        const answered = this.phase === "alertResolvedDuringRetract";
        this.backHome();
        if (!forAlert) {
          State.settings.mochiOnDesktop = false;
          Sound.play("peek");
        } else if (answered) this.launchIfNeeded();
        else this.phase = "atNotchForAlert";
        break;
      }
      case "askHome":
        this.flyHome();
        break;
    }
  }

  /** A request came in while he is out: a start, then back to the island with it. */
  private surprise() {
    this.emote("surprised");
    this.phase = "retracting";
    window.setTimeout(() => {
      if (this.phase === "retracting") void Bridge.mochiFlyHome(true);
      else if (this.phase === "alertResolvedDuringRetract") this.phase = "onDesktop";
    }, SURPRISE_MS);
  }

  /** Called whenever the island's state changed: requests coming and going, his state to pass on. */
  sync() {
    if (!this.supported) return;
    const alert = this.alertNow;
    if (alert !== this.alert) {
      this.alert = alert;
      if (alert) {
        if (this.phase === "onDesktop") this.surprise();
      } else if (this.phase === "atNotchForAlert") {
        this.phase = "home";
        window.setTimeout(() => this.launchIfNeeded(), RETURN_MS);
      } else if (this.phase === "retracting") this.phase = "alertResolvedDuringRetract";
    }

    const finished = State.effectiveState === "finished";
    if (finished !== this.finished) {
      this.finished = finished;
      // A task done: a jump for joy, out there.
      if (finished && this.phase === "onDesktop") this.emote("happy", FINISHED_EMOTE_S);
    }

    if (!State.mochiOnDesktop) return;
    const news: MochiNews = { kind: "state", state: State.effectiveState, outfit: State.outfit, dancing: this.dancing() };
    const told = JSON.stringify(news);
    if (told === this.told) return;
    this.told = told;
    void Bridge.mochiTell(news);
  }
}
