// The wardrobe — port of WardrobeView in IslandViewContent.swift: a grid of
// small Mochis, each wearing one outfit. The mouse on one tries it on the real
// Mochi; a click keeps it.

import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { drawOutfitBehind, drawOutfitFront, eyeFrames, mochiH, outfitBodyPath, PUMPKIN_BOTTOM, PUMPKIN_TOP, type OutfitPose } from "../mochi/outfits";
import { OUTFIT_NAMES, OUTFITS, seasonal, type Outfit } from "../mochi/wardrobe";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

/** A pill's side, and the Mochi drawn in it. */
const PILL = 30;
const ICON_R = 10;
/** The mark of "nothing on": a struck circle. */
const NONE_R = 6.5;
const NONE_INK = "#454850";
const INK = "rgb(26,20,18)";

/** A small Mochi at rest, wearing `outfit` — the body the engine draws, without its life. */
function drawWearing(x: CanvasRenderingContext2D, outfit: Outfit) {
  const head = mochiH(ICON_R);
  const { rx, ry } = head;
  const cx = PILL / 2;
  const cy = PILL / 2 + ICON_R * 0.62;
  const pose: OutfitPose = { cx, cy, tilt: 0, sx: 1, sy: 1, morph: 0, presence: 1, rollTurns: 1 };
  const body = outfitBodyPath(rx, ry);
  const pumpkin = outfit === "pumpkin";

  drawOutfitBehind(x, outfit, head, pose);

  x.save();
  x.translate(cx, cy);
  const base = x.createLinearGradient(rx * 0.7, -ry * 0.85, -rx * 0.8, ry * 0.9);
  base.addColorStop(0, pumpkin ? PUMPKIN_TOP : "rgb(237,237,239)");
  base.addColorStop(1, pumpkin ? PUMPKIN_BOTTOM : "rgb(196,197,202)");
  x.fillStyle = base;
  x.fill(body);
  const shade = x.createRadialGradient(0, 0, ICON_R * 0.15, 0, 0, ICON_R * 1.25);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(0.6, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.2)");
  x.fillStyle = shade;
  x.fill(body);
  const light = x.createRadialGradient(rx * 0.34, -ry * 0.46, 0, rx * 0.34, -ry * 0.46, ICON_R * 0.42);
  light.addColorStop(0, "rgba(255,255,255,0.55)");
  light.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = light;
  x.fill(body);

  x.clip(body);
  x.fillStyle = INK;
  for (const eye of eyeFrames(head)) {
    if (!eye.visible) continue;
    x.save();
    x.translate(eye.x, eye.y);
    x.scale(eye.fx, eye.fy);
    const tall = Math.max(eye.h, eye.w * 0.3);
    x.beginPath();
    x.roundRect(-eye.w / 2, -tall / 2, eye.w, tall, Math.min(eye.w / 2, tall / 2));
    x.fill();
    x.restore();
  }
  x.restore();

  drawOutfitFront(x, outfit, head, pose);
}

function drawIcon(canvas: HTMLCanvasElement, outfit: Outfit, season: Outfit) {
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(PILL * scale);
  canvas.height = Math.round(PILL * scale);
  const x = canvas.getContext("2d");
  if (!x) return;
  x.setTransform(scale, 0, 0, scale, 0, 0);
  x.clearRect(0, 0, PILL, PILL);

  if (outfit === "none") {
    x.translate(PILL / 2, PILL / 2);
    x.strokeStyle = NONE_INK;
    x.lineWidth = 1.4;
    x.lineCap = "round";
    x.beginPath();
    x.arc(0, 0, NONE_R * 0.82, 0, Math.PI * 2);
    x.moveTo(-NONE_R * 0.56, NONE_R * 0.56);
    x.lineTo(NONE_R * 0.56, -NONE_R * 0.56);
    x.stroke();
    return;
  }
  if (outfit !== "auto") {
    drawWearing(x, outfit);
    return;
  }
  // Auto: what the season picks, under its label.
  drawWearing(x, season);
  const badgeW = 14;
  const badgeH = 6.5;
  x.translate(PILL / 2, PILL / 2 + ICON_R * 0.62 + ICON_R * 0.88 * 0.72);
  x.fillStyle = "rgba(0,0,0,0.6)";
  x.beginPath();
  x.roundRect(-badgeW / 2, -badgeH / 2, badgeW, badgeH, badgeH / 2);
  x.fill();
  x.fillStyle = "#fff";
  x.font = `600 4.2px system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText("AUTO", 0, 0.2);
}

export function buildWardrobe(actions: ViewActions): ViewHost {
  const now = h("span", { class: "wardrobe-now" });
  const grid = h("div", { class: "wardrobe-grid" });
  let hovered: Outfit | null = null;
  /** The season the Auto pill was last drawn for. */
  let drawnSeason: Outfit | null = null;

  const pills = new Map<Outfit, { el: HTMLElement; canvas: HTMLCanvasElement }>();
  for (const outfit of OUTFITS) {
    const canvas = h("canvas", { class: "outfit-icon" }) as HTMLCanvasElement;
    const el = h("button", { class: "outfit-pill", title: OUTFIT_NAMES[outfit] }, canvas);
    el.addEventListener("mouseenter", () => {
      hovered = outfit;
      State.wardrobePreview = outfit === "auto" ? seasonal(new Date()) : outfit;
      say();
    });
    el.addEventListener("mouseleave", () => {
      if (hovered !== outfit) return;
      hovered = null;
      State.wardrobePreview = null;
      say();
    });
    el.addEventListener("click", () => {
      if (State.settings.mochiOutfit === outfit) return;
      State.settings.mochiOutfit = outfit;
      void Bridge.saveSettings(State.settings);
      Sound.play("pop");
      actions.emote("proud");
      State.notify();
    });
    pills.set(outfit, { el, canvas });
    grid.append(el);
    if (outfit !== "auto") drawIcon(canvas, outfit, "none");
  }

  /** The line on the right: the outfit under the mouse, or the one he has on. */
  function say() {
    const season = seasonal(new Date());
    const seasonName = OUTFIT_NAMES[season];
    if (hovered) now.textContent = hovered === "auto" ? `Auto · follows the seasons (now: ${seasonName})` : OUTFIT_NAMES[hovered];
    else if (State.settings.mochiOutfit === "auto") now.textContent = `Auto · ${seasonName}`;
    else now.textContent = OUTFIT_NAMES[State.settings.mochiOutfit];
  }

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "wardrobe" }, h("div", { class: "wardrobe-head" }, h("span", { class: "wardrobe-title", text: "Wardrobe" }), now), grid),
    ),
  );

  return {
    el,
    sync() {
      const on = State.mode === "expanded" && State.view === "wardrobe";
      // Gone from the screen, nothing is being tried on any more.
      if (!on && hovered) {
        hovered = null;
        State.wardrobePreview = null;
      }
      const season = seasonal(new Date());
      if (season !== drawnSeason) {
        drawnSeason = season;
        const auto = pills.get("auto");
        if (auto) drawIcon(auto.canvas, "auto", season);
      }
      for (const [outfit, pill] of pills) pill.el.classList.toggle("on", State.settings.mochiOutfit === outfit);
      say();
    },
  };
}
