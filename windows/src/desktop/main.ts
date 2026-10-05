// Mochi on the desktop — his own small window (DesktopBotView in
// DesktopMochi.swift). He is drawn by the same engine as in the island, looks
// at the mouse from where he stands, wears his outfit, dances to the music,
// and falls asleep when nothing goes on.
//
// The island tells him what state he is in; Rust tells him where the mouse is
// and moves his window. Hidden, this page draws nothing at all.

import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { wipe } from "../core/canvas";
import type { BotEmoteName, BotStateName } from "../core/layout";
import { Sound } from "../core/sound";
import type { Settings } from "../core/state";
import { BotEngine } from "../mochi/engine";
import { asOutfit } from "../mochi/wardrobe";

/** What the island says of him: his state as it stands, or something to do once. */
export type MochiNews =
  | { kind: "state"; state: BotStateName; outfit: string; dancing: boolean }
  | { kind: "emote"; emote: BotEmoteName; duration: number };

/** Frames a second, awake and asleep: DesktopBotView's own. */
const AWAKE_FPS = 30;
const ASLEEP_FPS = 10;
/** He sleeps once nothing has been going on for this long, with the mouse this far away. */
const SLEEP_AFTER_S = 120;
const SLEEP_MOUSE_PX = 150;
/** How far the mouse has to be for his eyes to turn all the way. */
const LOOK_X_PX = 260;
const LOOK_Y_PX = 200;
/** Two clicks this close together are a double click. */
const DOUBLE_CLICK_MS = 500;
const FADE_MS = 450;
const LEFT_BUTTON = 0;
/** The longest step the engine is given, so a stalled frame does not make him jump. */
const MAX_STEP_S = 0.05;
const RESTING: ReadonlySet<BotStateName> = new Set<BotStateName>(["idle", "sleeping"]);

const canvas = document.getElementById("mochi") as HTMLCanvasElement;
const engine = new BotEngine();

let shown = false;
let frame = 0;
let lastDrawn = 0;
let state: BotStateName = "idle";
let asleep = false;
/** The mouse, from his centre, in pixels. */
let mouse = { x: 0, y: 0 };
let lastActive = performance.now();
let slapTimer: number | null = null;

function fit(): { w: number; h: number; x: CanvasRenderingContext2D } | null {
  const scale = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
  }
  const x = canvas.getContext("2d");
  if (!x) return null;
  x.setTransform(scale, 0, 0, scale, 0, 0);
  return { w, h, x };
}

function draw(nowMs: number) {
  frame = shown ? requestAnimationFrame(draw) : 0;
  if (!shown || nowMs - lastDrawn < 1000 / (asleep ? ASLEEP_FPS : AWAKE_FPS) - 1) return;
  const dt = Math.min(MAX_STEP_S, (nowMs - lastDrawn) / 1000);
  lastDrawn = nowMs;

  // Asleep when nothing has gone on for a while and the mouse keeps away.
  if (!RESTING.has(state)) lastActive = nowMs;
  const sleepy = (nowMs - lastActive) / 1000 > SLEEP_AFTER_S && Math.hypot(mouse.x, mouse.y) >= SLEEP_MOUSE_PX;
  if (sleepy !== asleep) {
    asleep = sleepy;
    engine.setState(asleep ? "sleeping" : state);
  }

  engine.lookX = Math.tanh(mouse.x / LOOK_X_PX);
  engine.lookY = -Math.tanh(mouse.y / LOOK_Y_PX);
  engine.update(dt);

  const c = fit();
  if (!c) return;
  wipe(c.x);
  engine.draw(c.x, c.w, c.h);
}

function show(fade: boolean) {
  shown = true;
  asleep = false;
  lastActive = performance.now();
  lastDrawn = performance.now();
  engine.setState(state, true);
  canvas.style.transition = "none";
  canvas.style.opacity = fade ? "0" : "1";
  if (fade) {
    // Read back, so the next line is a change to animate rather than the start.
    void canvas.offsetWidth;
    canvas.style.transition = `opacity ${FADE_MS}ms ease-in-out`;
    canvas.style.opacity = "1";
  }
  if (!frame) frame = requestAnimationFrame(draw);
}

function hide() {
  shown = false;
  if (slapTimer != null) window.clearTimeout(slapTimer);
  slapTimer = null;
}

function tell(news: MochiNews) {
  if (news.kind === "emote") {
    engine.triggerEmote(news.emote, news.duration);
    return;
  }
  state = news.state;
  if (!asleep) engine.setState(state);
  // He is always himself out here: always dressed.
  engine.setOutfit(asOutfit(news.outfit), shown);
  engine.setDancing(news.dancing);
}

/** A click that was not a drag: once is a slap, twice sends him home. */
function clicked() {
  if (slapTimer != null) {
    window.clearTimeout(slapTimer);
    slapTimer = null;
    void Bridge.mochiAsk("askHome");
    return;
  }
  // The slap waits to see whether a second click comes.
  slapTimer = window.setTimeout(() => {
    slapTimer = null;
    engine.slap();
  }, DOUBLE_CLICK_MS);
}

function applySound(settings: Pick<Settings, "soundEnabled" | "soundVolume">) {
  Sound.setEnabled(settings.soundEnabled);
  Sound.setVolume(settings.soundVolume);
}

async function main() {
  if (!IS_TAURI) return;
  void Sound.preload();
  const boot = await Bridge.boot();
  if (boot) applySound(boot.settings);

  canvas.addEventListener("mousedown", (e) => {
    Sound.resume();
    if (e.button === LEFT_BUTTON) void Bridge.mochiGrab();
  });
  // His wardrobe is in the island: a right click asks for it.
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void Bridge.mochiAsk("wardrobe");
  });

  await onEvent<{ fade: boolean }>("mochi-shown", ({ fade }) => show(fade));
  await onEvent<null>("mochi-hidden", hide);
  await onEvent<MochiNews>("mochi-state", tell);
  await onEvent<{ x: number; y: number }>("mochi-cursor", (at) => {
    mouse = at;
  });
  await onEvent<{ moved: boolean }>("mochi-released", ({ moved }) => {
    if (!moved) clicked();
  });
  await onEvent<Settings>("settings-changed", applySound);
}

void main();
