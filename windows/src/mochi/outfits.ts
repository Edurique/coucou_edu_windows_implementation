// What Mochi wears — port of MochiOutfitDrawing.swift.
//
// Everything is drawn in code, in the body's own space: origin at its centre,
// y down. The head is a superellipsoid whose ring at height y (y up, -1…1) has
// the radius r(y) = (1-|y|^2.7)^(1/2.7), so its outline is the body's at rest.
// A hat is laid on that head and turns with it; glasses sit on the eyes.

import { Ease } from "../core/anim";
import type { Outfit } from "./wardrobe";

const EXP = 2.7;
/** Accessories are seen slightly from above: their rings show as ellipses. */
const VIEW_TILT = -0.3;
/** They follow the head's pitch only partly, so a hat never shows its inside. */
const ACC_PITCH = 0.4;
const EYE_W = 0.25;
const EYE_H = 0.27;
const EYE_SP = 0.37;
const EYE_P = -0.12;
/** Under this radius the small details are left out. */
const SIMPLIFIED_UNDER = 16;

type Ctx = CanvasRenderingContext2D;
type V3 = readonly [number, number, number];
/** A point on screen, with how far towards the viewer it is. */
interface P3 { x: number; y: number; z: number }
interface XY { x: number; y: number }
type Stops = readonly (readonly [number, string])[];

/** The head: its size, where it looks, and how its soft parts lag behind. */
export interface MochiH {
  R: number; rx: number; ry: number;
  yaw: number; pitch: number;
  view: number;
  /** The lag of what dangles — a pompom, a hat's tip — from -1 to 1. */
  physDx: number; physDy: number;
  roll: number;
}

export function mochiH(R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0, roll = 0): MochiH {
  return { R, rx: R * 1.14, ry: R * 0.88, yaw, pitch, view: VIEW_TILT, physDx, physDy, roll };
}

// ── Eyes ──────────────────────────────────────────────────────────────────────

export interface EyeFrame {
  /** -1 left, +1 right. */
  sd: number;
  x: number; y: number;
  /** How much the turn of the head narrows it. */
  fx: number; fy: number;
  visible: boolean;
  w: number; h: number;
}

/** Where the eyes are, as the engine draws them: glasses go there. */
export function eyeFrames(H: MochiH): EyeFrame[] {
  return [-1, 1].map((sd) => {
    const eyeYaw = sd * EYE_SP + H.yaw;
    const eyePitch = EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    return {
      sd,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(0.18, Math.cos(eyeYaw)),
      fy: Math.max(0.18, cp),
      visible: Math.cos(eyeYaw) * cp > 0.04,
      w: H.R * EYE_W,
      h: H.R * EYE_H,
    };
  });
}

// ── The head in three dimensions ──────────────────────────────────────────────

/** Radius of the head's ring at height y. */
function ringR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, EXP), 1 / EXP);
}

/** A head-local point (x right, y up, z to the viewer) turned by yaw, then pitch. */
function rot3(p: V3, yaw: number, pitch: number): V3 {
  const [x, y, z] = p;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x1, y * cp + z1 * sp, -y * sp + z1 * cp];
}

function proj(H: MochiH, p: V3): P3 {
  const r = rot3(p, H.yaw, H.view + H.pitch * ACC_PITCH);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** The same for what turns with the body when it rolls. */
function projRoll(H: MochiH, p: V3): P3 {
  const r = rot3(p, H.yaw, H.view + H.pitch * ACC_PITCH + H.roll);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** The point of the head's surface at height y and longitude lon (0 faces the viewer). */
function surf(y: number, lon: number, s = 1): V3 {
  const r = ringR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/** Of a closed ring's points, the half that faces the viewer, left to right. */
function frontSilhouetteArc(pts: P3[]): P3[] {
  const n = pts.length;
  if (n <= 1) return pts;
  let minIdx = 0;
  let maxIdx = 0;
  pts.forEach((p, i) => {
    if (p.x < pts[minIdx].x) minIdx = i;
    if (p.x > pts[maxIdx].x) maxIdx = i;
  });
  if (minIdx === maxIdx) return [pts[minIdx]];
  const walk = (step: number) => {
    const arc: P3[] = [];
    for (let i = minIdx; arc.length <= n; i = (i + step + n) % n) {
      arc.push(pts[i]);
      if (i === maxIdx) break;
    }
    return arc;
  };
  const depth = (arc: P3[]) => arc.reduce((sum, p) => sum + p.z, 0) / Math.max(1, arc.length);
  const forward = walk(1);
  const backward = walk(-1);
  return depth(forward) >= depth(backward) ? forward : backward;
}

function frontArc(H: MochiH, y: number, s: number, project = proj): P3[] {
  const n = 120;
  return frontSilhouetteArc(Array.from({ length: n }, (_, i) => project(H, surf(y, -Math.PI + (i / n) * 2 * Math.PI, s))));
}

// ── Paths and paint ───────────────────────────────────────────────────────────

/** The body's outline at rest. */
export function outfitBodyPath(rx: number, ry: number): Path2D {
  const n = 96;
  const e = 2 / EXP;
  const p = new Path2D();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = rx * (ca >= 0 ? Math.pow(ca, e) : -Math.pow(-ca, e));
    const py = ry * (sa >= 0 ? Math.pow(sa, e) : -Math.pow(-sa, e));
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  p.closePath();
  return p;
}

/** What is above the front of the ring at height y: the part a cap covers. */
function capClip(H: MochiH, y: number, s: number, extraTop = 3): Path2D {
  const arc = frontArc(H, y, s);
  const p = new Path2D();
  if (arc.length === 0) return p;
  const last = arc[arc.length - 1];
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  p.lineTo(last.x + H.rx, last.y);
  p.lineTo(H.rx * 2, -H.ry * extraTop);
  p.lineTo(-H.rx * 2, -H.ry * extraTop);
  p.closePath();
  return p;
}

/** A rectangle well past the body on every side. */
function everywhere(H: MochiH): Path2D {
  const p = new Path2D();
  p.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  return p;
}

/** Everything but `p` — to clip with the even-odd rule. */
function invert(p: Path2D, H: MochiH): Path2D {
  const q = everywhere(H);
  q.addPath(p);
  return q;
}

function line(pts: readonly XY[], close = false): Path2D {
  const p = new Path2D();
  pts.forEach((q, i) => (i === 0 ? p.moveTo(q.x, q.y) : p.lineTo(q.x, q.y)));
  if (close) p.closePath();
  return p;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Path2D {
  const p = new Path2D();
  p.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
  return p;
}

function roundRect(X: number, Y: number, W: number, Hh: number, R: number): Path2D {
  const r = Math.max(0, Math.min(R, W / 2, Hh / 2));
  const p = new Path2D();
  p.moveTo(X + r, Y);
  p.arcTo(X + W, Y, X + W, Y + Hh, r);
  p.arcTo(X + W, Y + Hh, X, Y + Hh, r);
  p.arcTo(X, Y + Hh, X, Y, r);
  p.arcTo(X, Y, X + W, Y, r);
  p.closePath();
  return p;
}

function lin(x: Ctx, x0: number, y0: number, x1: number, y1: number, stops: Stops): CanvasGradient {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

function rad(x: Ctx, cx: number, cy: number, r: number, stops: Stops): CanvasGradient {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(0.001, r));
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

function fill(x: Ctx, path: Path2D, paint: string | CanvasGradient) {
  x.fillStyle = paint;
  x.fill(path);
}

function stroke(x: Ctx, path: Path2D, color: string, width: number, cap: CanvasLineCap = "round", join: CanvasLineJoin = "miter") {
  x.strokeStyle = color;
  x.lineWidth = width;
  x.lineCap = cap;
  x.lineJoin = join;
  x.stroke(path);
}

/** Draws inside the given clips, and leaves the context as it found it. */
function within(x: Ctx, clips: readonly (Path2D | readonly [Path2D, "evenodd"])[], draw: () => void) {
  x.save();
  for (const c of clips) {
    if (c instanceof Path2D) x.clip(c);
    else x.clip(c[0], c[1]);
  }
  draw();
  x.restore();
}

const WHITE = "#FFFFFF";
const CLEAR = "rgba(255,255,255,0)";
const white = (a: number) => `rgba(255,255,255,${a})`;
const black = (a: number) => `rgba(0,0,0,${a})`;

let scratch: HTMLCanvasElement | null = null;

/**
 * Draws a whole accessory at one opacity. Its parts overlap, and fading them
 * one by one would show through each other: it is drawn aside, opaque, and
 * laid down faded as one piece. Fully there, it is drawn straight.
 */
function layer(x: Ctx, alpha: number, draw: (x: Ctx) => void) {
  if (alpha >= 0.995) {
    draw(x);
    return;
  }
  scratch ??= document.createElement("canvas");
  const { width, height } = x.canvas;
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const s = scratch.getContext("2d");
  if (!s) return;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, width, height);
  s.setTransform(x.getTransform());
  draw(s);
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha *= alpha;
  x.drawImage(scratch, 0, 0);
  x.restore();
}

// ── Pieces several accessories share ──────────────────────────────────────────

function pompom(x: Ctx, px: number, py: number, r: number, base = WHITE, shade = "rgb(213,217,226)") {
  x.save();
  x.translate(px, py);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78;
    const by = Math.sin(a) * r * 0.78;
    fill(x, ellipse(bx, by, br, br), rad(x, bx - br * 0.4, by - br * 0.5, br * 1.3, [[0, base], [1, shade]]));
  }
  fill(x, ellipse(0, 0, r * 0.86, r * 0.86), rad(x, -r * 0.3, -r * 0.35, r * 1.05, [[0, base], [0.7, base], [1, shade]]));
  x.restore();
}

function fuzzyBand(x: Ctx, arc: P3[], thick: number, base = WHITE, shade = "rgb(218,221,228)") {
  if (arc.length < 2) return;
  const path = line(arc);
  stroke(x, path, shade, thick, "round", "round");
  stroke(x, path, base, thick * 0.78, "round", "round");
  const step = Math.max(2, Math.floor(arc.length / 16));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i];
    const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    fill(x, ellipse(q.x, q.y - thick * 0.32, r, r), rad(x, q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, r * 1.2, [[0, base], [1, shade]]));
  }
}

/** The faint shade a hat casts on the head under its edge. */
function hatShadow(x: Ctx, H: MochiH, body: Path2D, y: number, color: string) {
  within(x, [body, capClip(H, y, 1)], () => fill(x, everywhere(H), color));
}

// ── The outfits ───────────────────────────────────────────────────────────────

const CROWN_YB = 0.46;

/** `rollProgress`: 0 upright, 1 at the height of a roll, where the ears lie flat. */
function bunnyEarsBack(x: Ctx, H: MochiH, rollProgress: number) {
  const R = H.R;
  const earH = R * 0.85;
  for (const sd of [-1, 1]) {
    const root = proj(H, [sd * 0.45, 0.92, 0]);
    const rootL = proj(H, [sd * 0.45 - 0.22, 0.92, 0]);
    const rootR = proj(H, [sd * 0.45 + 0.22, 0.92, 0]);
    const halfW = Math.max(R * 0.04, Math.abs(rootR.x - rootL.x) / 2);
    const flatten = Math.sin(rollProgress * Math.PI);
    const h = earH * (1 - 0.8 * flatten);
    x.save();
    x.translate(root.x, root.y - h * 0.65 + h * 0.5);
    x.rotate(sd * 0.6 * flatten);
    const outer = ellipse(0, 0, halfW, h / 2);
    fill(x, outer, "#F9F0F0");
    stroke(x, outer, black(0.06), 0.8, "butt");
    fill(x, ellipse(0, -h / 2 + R * 0.1 + h * 0.325, halfW * 0.5, h * 0.325), "rgba(252,165,165,0.7)");
    x.restore();
  }
}

function beanie(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  const s = 1.035;
  const yEdge = 0.42;
  const yCuff = 0.58;
  const head = outfitBodyPath(H.rx * s, H.ry * s);

  hatShadow(x, H, body, yEdge - 0.12, "rgba(30,40,70,0.1)");

  // The knit, and its ribs.
  within(x, [capClip(H, yCuff, s)], () => {
    fill(x, head, lin(x, H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2, [[0, "#7DB6FF"], [1, "#2F6FE0"]]));
    if (simplified) return;
    x.clip(head);
    for (let k = -6; k <= 6; k++) {
      const pts: P3[] = [];
      for (let i = 0; i <= 16; i++) {
        const q = proj(H, surf(yCuff + ((1.05 - yCuff) * i) / 16, k * 0.24, s));
        if (q.z > 0) pts.push(q);
      }
      if (pts.length >= 2) stroke(x, line(pts), "rgba(20,50,140,0.16)", H.R * 0.045);
    }
  });

  // The cuff: the band between the edge and the fold.
  const cuffS = s * 1.04;
  const cuffHead = outfitBodyPath(H.rx * cuffS, H.ry * cuffS);
  within(x, [capClip(H, yEdge, cuffS), [invert(capClip(H, yCuff, cuffS), H), "evenodd"]], () => {
    fill(x, cuffHead, lin(x, 0, -H.ry * 0.6, 0, -H.ry * 0.2, [[0, "#3C7BEA"], [1, "#2257C4"]]));
    x.clip(cuffHead);
    for (let k = -14; k <= 14; k++) {
      const a = proj(H, surf(yEdge, k * 0.115, cuffS));
      if (a.z < 0) continue;
      stroke(x, line([a, proj(H, surf(yCuff, k * 0.115, cuffS))]), "rgba(10,30,100,0.22)", H.R * 0.035, "butt");
    }
  });

  within(x, [capClip(H, yCuff, s), head], () => {
    fill(x, head, rad(x, H.rx * 0.3, -H.ry * 0.85, H.R * 0.45, [[0, white(0.35)], [1, CLEAR]]));
  });

  // The pompom, on its short spring.
  const top = proj(H, [0, 1.08 * s, 0]);
  pompom(x, top.x + H.physDx * H.rx * 0.25, top.y - H.R * 0.12 + H.physDy * H.ry * 0.15, H.R * 0.24);
}

function santaHat(x: Ctx, H: MochiH, body: Path2D) {
  const s = 1.05;
  const yEdge = 0.52;
  const arc = frontArc(H, yEdge, s);
  if (arc.length === 0) return;
  const L = arc[0];
  const Rt = arc[arc.length - 1];
  const crown = proj(H, [0, 1.05, 0]);
  // The tip flops to the right, and lags.
  const tip = { x: crown.x + H.rx * (0.95 + H.physDx * 0.35), y: crown.y + H.ry * (0.05 + H.physDy * 0.2) };
  const peak = { x: crown.x + H.rx * 0.25, y: crown.y - H.ry * 0.62 };

  const bag = new Path2D();
  bag.moveTo(L.x, L.y);
  bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
  bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
  for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
  bag.closePath();

  hatShadow(x, H, body, yEdge - 0.14, "rgba(120,10,10,0.1)");
  fill(x, bag, lin(x, -H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3, [[0, "#FF6B6B"], [0.55, "#E53935"], [1, "#B71C1C"]]));

  within(x, [bag], () => {
    for (const [a, b, w] of [[0.15, 0.55, 0.1], [0.45, 0.85, 0.08]]) {
      const fold = new Path2D();
      fold.moveTo(peak.x - H.rx * 0.1 + (Rt.x - L.x) * a * 0.3, peak.y + H.ry * 0.15);
      fold.quadraticCurveTo(peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3), tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12);
      stroke(x, fold, "rgba(90,0,0,0.2)", H.R * w);
    }
    fill(x, bag, rad(x, peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, H.R * 0.5, [[0, white(0.32)], [1, CLEAR]]));
  });

  fuzzyBand(x, arc, H.R * 0.3);
  pompom(x, tip.x, tip.y + H.R * 0.04, H.R * 0.22);
}

function partyHat(x: Ctx, H: MochiH, simplified: boolean) {
  const baseY = 0.82;
  const baseR = 0.42;
  const lean = -0.24 + H.physDx * 0.12;
  const c = proj(H, [0.16, baseY + 0.06, 0]);
  const ring: P3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(proj(H, [0.16 + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)]));
  }
  const left = ring.reduce((m, p) => (p.x < m.x ? p : m));
  const right = ring.reduce((m, p) => (p.x > m.x ? p : m));
  const h = H.ry * 1.6;
  const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
  const front = frontSilhouetteArc(ring);

  const cone = new Path2D();
  cone.moveTo(left.x, left.y);
  cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
  for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
  cone.closePath();

  fill(x, cone, lin(x, left.x, apex.y, right.x, left.y, [[0, "#FF9BD0"], [0.5, "#F15BAE"], [1, "#C2187A"]]));

  within(x, [cone], () => {
    if (!simplified) {
      const dots = [[0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28], [0.8, -0.3], [0.45, 0.6], [0.48, -0.65]];
      for (const [t, u] of dots) {
        const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
        const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
        const r = H.R * 0.075 * (0.6 + t * 0.5);
        fill(x, ellipse(bx + (apex.x - bx) * (1 - t), by + (apex.y - by) * (1 - t), r, r * 0.9), white(0.92));
      }
    }
    fill(x, cone, lin(x, left.x, 0, right.x, 0, [[0, white(0.28)], [0.35, CLEAR], [1, "rgba(80,0,40,0.18)"]]));
  });

  if (front.length > 0) stroke(x, line(front), "#FFD84D", H.R * 0.07);
  pompom(x, apex.x, apex.y - H.R * 0.04, H.R * 0.16, "#FFE27A", "#F2B705");
}

/** One half of the crown: `side` -1 the back, drawn behind the head, +1 the front. */
function crownPart(x: Ctx, H: MochiH, side: number, simplified: boolean) {
  const s = 1.06;
  const yb = CROWN_YB;
  const yt = 0.66;
  const n = 8;
  const spikeH = 0.42;
  const N = 120;
  const seg: { b: P3; tt: P3 }[] = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + (i / N) * 2 * Math.PI;
    const b = proj(H, surf(yb, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const spike = Math.pow(Math.max(0, 1 - Math.abs(phase - Math.floor(phase) - 0.5) * 2), 1.6);
    const sp = surf(yt, lon, s);
    const tt = proj(H, [sp[0] * (1 - 0.08 * spike), yt + spikeH * spike, sp[2] * (1 - 0.08 * spike)]);
    if (side > 0 ? b.z >= 0 : b.z < 0.02) seg.push({ b, tt });
  }
  if (seg.length < 2) return;
  seg.sort((p, q) => p.b.x - q.b.x);

  const shape = line([...seg.map((q) => q.tt), ...seg.map((q) => q.b).reverse()], true);
  const dark = side < 0;
  fill(x, shape, lin(x, 0, -H.ry * 1.05, 0, -H.ry * 0.45, dark
    ? [[0, "#C98A12"], [1, "#8A5A06"]]
    : [[0, "#FFE58A"], [0.5, "#FBBF24"], [1, "#D08A0B"]]));
  if (dark) return;

  within(x, [shape], () => {
    fill(x, shape, lin(x, -H.rx, 0, H.rx, 0, [[0, "rgba(120,70,0,0.25)"], [0.45, CLEAR], [0.62, white(0.35)], [1, "rgba(120,70,0,0.25)"]]));
  });
  if (simplified) return;

  // A ball on each spike that faces the viewer, and a gem under it.
  const gems = ["#EF4444", "#3B82F6", "#22C55E", "#A855F7"];
  for (let k = 0; k < n; k++) {
    const lon = -Math.PI + ((k + 0.5) / n) * 2 * Math.PI;
    const sp = surf(yt, lon, s);
    const tip = proj(H, [sp[0] * 0.92, yt + spikeH, sp[2] * 0.92]);
    const mid = proj(H, surf((yb + yt) / 2, lon, s * 1.01));
    if (mid.z <= 0.12) continue;
    const r = H.R * 0.055;
    fill(x, ellipse(tip.x, tip.y - r * 0.5, r, r), rad(x, tip.x - r * 0.3, tip.y - r, r * 1.2, [[0, "#FFF6CC"], [1, "#E0A21A"]]));
    const gr = H.R * 0.075;
    fill(x, ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr), gems[k % gems.length]);
    fill(x, ellipse(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, gr * 0.28), white(0.75));
  }
}

function crownFront(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  within(x, [body, capClip(H, CROWN_YB - 0.1, 1), [invert(capClip(H, CROWN_YB, 1), H), "evenodd"]], () => {
    fill(x, everywhere(H), "rgba(80,50,0,0.12)");
  });
  crownPart(x, H, 1, simplified);
}

function witchBrimPts(H: MochiH): P3[] {
  const y = 0.7;
  const rr = 1.42;
  return Array.from({ length: 121 }, (_, i) => {
    const a = -Math.PI + (i / 120) * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.1 * Math.pow(Math.abs(Math.sin(a)), 2);
    return proj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]);
  });
}

function witchHatBack(x: Ctx, H: MochiH) {
  const pts = witchBrimPts(H);
  if (!pts.some((p) => p.z < 0.05)) return;
  fill(x, line(pts, true), lin(x, 0, -H.ry, 0, -H.ry * 0.4, [[0, "#2A0A4F"], [1, "#3B0F6B"]]));
}

function witchHatFront(x: Ctx, H: MochiH, body: Path2D) {
  const all = witchBrimPts(H);
  const fr = all.filter((p) => p.z >= 0).sort((a, b) => a.x - b.x);

  hatShadow(x, H, body, 0.5, "rgba(40,0,70,0.1)");
  fill(x, line(all, true), lin(x, 0, -H.ry * 0.9, 0, -H.ry * 0.3, [[0, "#5B21B6"], [1, "#3B0764"]]));
  if (fr.length > 0) stroke(x, line(fr), "rgba(190,150,255,0.35)", H.R * 0.035);

  const baseR = 0.62;
  const by = 0.74;
  const bl = proj(H, [-baseR, by, 0]);
  const br = proj(H, [baseR, by, 0]);
  const c = proj(H, [0, by, 0]);
  const lean = 0.1 + H.physDx * 0.15;
  const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
  const tip = { x: top.x + H.rx * (0.45 + H.physDx * 0.25), y: top.y + H.ry * (0.22 + H.physDy * 0.1) };
  const capFront = frontArc(H, by, baseR / ringR(by)).filter((p) => p.x >= bl.x - 1 && p.x <= br.x + 1);

  const cone = new Path2D();
  cone.moveTo(bl.x, bl.y);
  cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25, top.x - H.rx * 0.02, top.y - H.ry * 0.02);
  cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
  cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
  cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
  for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y);
  cone.closePath();

  fill(x, cone, lin(x, bl.x, top.y, br.x, bl.y, [[0, "#7C3AED"], [0.55, "#4C1D95"], [1, "#2E1065"]]));

  const front = proj(H, [0, by, baseR]);
  const lift = H.ry * 0.11;
  within(x, [cone], () => {
    fill(x, cone, lin(x, bl.x, 0, br.x, 0, [[0, white(0.22)], [0.4, CLEAR], [1, black(0.15)]]));
    const crease = new Path2D();
    crease.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05);
    crease.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
    stroke(x, crease, "rgba(20,0,40,0.35)", H.R * 0.05);
    // The orange band.
    const band = new Path2D();
    band.moveTo(bl.x - 2, bl.y - lift);
    band.quadraticCurveTo(front.x, 2 * (front.y - lift) - (bl.y + br.y) / 2, br.x + 2, br.y - lift);
    stroke(x, band, "#F97316", H.ry * 0.17, "butt");
  });

  // Its buckle.
  const bw = H.R * 0.2;
  const bh = H.R * 0.16;
  x.save();
  x.translate(front.x, front.y - lift);
  fill(x, roundRect(-bw / 2, -bh / 2, bw, bh, bh * 0.25), "#FCD34D");
  fill(x, roundRect(-bw / 2 + bw * 0.24, -bh / 2 + bh * 0.28, bw * 0.52, bh * 0.44, bh * 0.1), "#C2410C");
  x.restore();
}

/** The eyes as they stand once the roll is counted in: glasses stay on them. */
const rolledEyes = (H: MochiH) => eyeFrames(mochiH(H.R, H.yaw, H.pitch + H.roll, H.physDx, H.physDy));

function sunglasses(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = rolledEyes(H);
  const w = H.R * 0.62;
  const h = H.R * 0.46;
  const [le, re] = eyes;
  within(x, [body], () => {
    if (le.visible && re.visible) {
      const bridge = new Path2D();
      bridge.moveTo(le.x + (w / 2) * le.fx * 0.9, le.y - h * 0.18);
      bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - h * 0.42, re.x - (w / 2) * re.fx * 0.9, re.y - h * 0.18);
      stroke(x, bridge, "#111317", H.R * 0.07);
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      stroke(x, line([{ x: e.x + ((e.sd * w) / 2) * e.fx, y: e.y - h * 0.2 }, { x: e.sd * H.rx * 1.05, y: e.y - h * 0.35 }]), "#111317", H.R * 0.06);
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      x.save();
      x.translate(e.x, e.y);
      x.scale(e.fx, e.fy);
      const lens = roundRect(-w / 2, -h / 2, w, h, h * 0.42);
      fill(x, lens, "rgba(17,19,23,0.82)");
      stroke(x, lens, "#0B0C0F", H.R * 0.05, "butt");
      stroke(x, line([{ x: -w * 0.28, y: -h * 0.05 }, { x: -w * 0.05, y: -h * 0.3 }]), white(0.45), H.R * 0.05);
      x.restore();
    }
  });
}

function roundGlasses(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = rolledEyes(H);
  const d = H.R * 0.56;
  const [le, re] = eyes;
  within(x, [body], () => {
    if (le.visible && re.visible) {
      const bridge = new Path2D();
      bridge.moveTo(le.x + (d / 2) * le.fx, le.y - d * 0.08);
      bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - d * 0.3, re.x - (d / 2) * re.fx, re.y - d * 0.08);
      stroke(x, bridge, "#8A4B12", H.R * 0.055);
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      stroke(x, line([{ x: e.x + ((e.sd * d) / 2) * e.fx, y: e.y - d * 0.1 }, { x: e.sd * H.rx * 1.05, y: e.y - d * 0.25 }]), "#8A4B12", H.R * 0.05);
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      x.save();
      x.translate(e.x, e.y);
      x.scale(e.fx, e.fy);
      const circle = ellipse(0, 0, d / 2, d / 2);
      fill(x, circle, "rgba(190,225,255,0.18)");
      stroke(x, circle, "#9A5A1A", H.R * 0.065);
      const glint = new Path2D();
      glint.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45);
      stroke(x, glint, white(0.55), H.R * 0.03);
      x.restore();
    }
  });
}

function scarf(x: Ctx, H: MochiH) {
  const s = 1.05;
  const y0 = -0.34;
  const y1 = -0.66;
  const top = frontArc(H, y0, s, projRoll);
  const bot = frontArc(H, y1, s, projRoll);
  if (top.length === 0 || bot.length === 0) return;
  const band = line([...top, ...[...bot].reverse()], true);

  within(x, [outfitBodyPath(H.rx * s, H.ry * s)], () => {
    fill(x, band, lin(x, 0, -H.ry * 0.2, 0, H.ry * 0.7, [[0, "#F87171"], [1, "#B91C1C"]]));
    within(x, [band], () => {
      for (const lon of [-1, -0.45, 0.1, 0.65, 1.2]) {
        const a = proj(H, surf(y0, lon, s));
        const b = proj(H, surf(y1, lon, s));
        if (a.z < 0) continue;
        stroke(x, line([{ x: a.x, y: a.y - 4 }, { x: b.x, y: b.y + 4 }]), white(0.85), H.R * 0.09 * Math.max(0.3, a.z));
      }
    });
    fill(x, band, lin(x, 0, -H.ry * 0.5, 0, H.ry * 0.3, [[0, white(0.18)], [1, black(0.1)]]));
  });

  // The end that hangs, swinging a little.
  const k = proj(H, surf((y0 + y1) / 2, -0.55, s * 1.03));
  if (k.z <= 0) return;
  const sw = H.physDx * H.rx * 0.12;
  const end = new Path2D();
  end.moveTo(k.x - H.R * 0.16, k.y);
  end.quadraticCurveTo(k.x - H.R * 0.24 + sw, k.y + H.ry * 0.35, k.x - H.R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
  end.lineTo(k.x + H.R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
  end.quadraticCurveTo(k.x + H.R * 0.02 + sw, k.y + H.ry * 0.3, k.x + H.R * 0.12, k.y);
  end.closePath();
  fill(x, end, lin(x, 0, k.y, 0, k.y + H.ry * 0.6, [[0, "#EF4444"], [1, "#B91C1C"]]));
  within(x, [end], () => {
    for (const t of [0.35, 0.7]) {
      const stripe = new Path2D();
      stripe.rect(k.x - H.R * 0.4 + sw, k.y + H.ry * 0.62 * t, H.R * 0.8, H.R * 0.07);
      fill(x, stripe, white(0.85));
    }
  });
  for (let i = 0; i < 4; i++) {
    const fx = k.x - H.R * 0.17 + sw * 1.4 + i * H.R * 0.075;
    stroke(x, line([{ x: fx, y: k.y + H.ry * 0.6 }, { x: fx, y: k.y + H.ry * 0.72 }]), "#DC2626", H.R * 0.035);
  }
  x.save();
  x.translate(k.x, k.y);
  x.rotate(0.2);
  fill(x, ellipse(0, 0, H.R * 0.17, H.R * 0.14), rad(x, -H.R * 0.05, -H.R * 0.05, H.R * 0.2, [[0, "#F87171"], [1, "#B91C1C"]]));
  x.restore();
}

/** The pumpkin's ribs, stem and leaf — its orange is the body's own, set by the engine. */
function pumpkin(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  if (!simplified) {
    within(x, [body], () => {
      for (const lon of [-1.15, -0.55, 0, 0.55, 1.15]) {
        const pts: P3[] = [];
        for (let i = 0; i <= 30; i++) {
          const q = projRoll(H, surf(-0.98 + (1.96 * i) / 30, lon, 1));
          if (q.z > 0) pts.push(q);
        }
        if (pts.length < 2) continue;
        const zz = pts[Math.floor(pts.length / 2)].z;
        stroke(x, line(pts), `rgba(150,50,0,${0.22 * zz})`, H.R * 0.12);
        stroke(x, line(pts.map((p) => ({ x: p.x + H.R * 0.07, y: p.y }))), `rgba(255,220,170,${0.18 * zz})`, H.R * 0.04);
      }
    });
  }

  const t = projRoll(H, [0.02, 1, 0]);
  const stem = new Path2D();
  stem.moveTo(t.x - H.R * 0.09, t.y + H.R * 0.04);
  stem.quadraticCurveTo(t.x - H.R * 0.08, t.y - H.R * 0.22, t.x + H.R * 0.08, t.y - H.R * 0.3);
  stem.lineTo(t.x + H.R * 0.13, t.y - H.R * 0.22);
  stem.quadraticCurveTo(t.x + H.R * 0.04, t.y - H.R * 0.15, t.x + H.R * 0.08, t.y + H.R * 0.04);
  stem.closePath();
  fill(x, stem, lin(x, t.x - H.R * 0.1, 0, t.x + H.R * 0.1, 0, [[0, "#65A30D"], [1, "#3F6212"]]));

  x.save();
  x.translate(t.x - H.R * 0.06, t.y - H.R * 0.02);
  x.rotate(-0.5);
  const leaf = new Path2D();
  leaf.moveTo(0, 0);
  leaf.quadraticCurveTo(-H.R * 0.18, -H.R * 0.2, -H.R * 0.38, -H.R * 0.02);
  leaf.quadraticCurveTo(-H.R * 0.18, H.R * 0.1, 0, 0);
  fill(x, leaf, lin(x, 0, -H.R * 0.15, -H.R * 0.3, 0, [[0, "#84CC16"], [1, "#4D7C0F"]]));
  const vein = new Path2D();
  vein.moveTo(-H.R * 0.02, -H.R * 0.01);
  vein.quadraticCurveTo(-H.R * 0.18, -H.R * 0.08, -H.R * 0.32, -H.R * 0.03);
  stroke(x, vein, "rgba(30,60,0,0.4)", H.R * 0.02);
  x.restore();

  if (simplified) return;
  const tendril = new Path2D();
  tendril.moveTo(t.x + H.R * 0.1, t.y - H.R * 0.12);
  tendril.bezierCurveTo(t.x + H.R * 0.3, t.y - H.R * 0.25, t.x + H.R * 0.35, t.y - H.R * 0.02, t.x + H.R * 0.22, t.y - H.R * 0.06);
  stroke(x, tendril, "#4D7C0F", H.R * 0.03);
}

function bow(x: Ctx, H: MochiH) {
  const a = projRoll(H, surf(0.86, 0.55, 1.02));
  if (a.z < -0.2) return;
  const s = H.R * 0.26;
  x.save();
  x.translate(a.x, a.y);
  x.rotate(0.35 + H.yaw * 0.3);
  x.scale(Math.max(0.45, Math.cos(0.55 + H.yaw)), 1);
  for (const sd of [-1, 1]) {
    const wing = new Path2D();
    wing.moveTo(0, 0);
    wing.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
    wing.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
    fill(x, wing, lin(x, 0, -s, 0, s, [[0, "#FF8CC6"], [1, "#DB2777"]]));
    const crease = new Path2D();
    crease.moveTo(sd * s * 0.25, -s * 0.05);
    crease.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
    stroke(x, crease, "rgba(140,10,70,0.35)", s * 0.08);
  }
  fill(x, ellipse(0, 0, s * 0.24, s * 0.3), rad(x, -s * 0.06, -s * 0.1, s * 0.35, [[0, "#FFB3D9"], [1, "#C2185B"]]));
  x.restore();
}

// ── What the engine calls ─────────────────────────────────────────────────────

/** Where and how the body stands, so its outfit stands the same. */
export interface OutfitPose {
  cx: number; cy: number; tilt: number; sx: number; sy: number;
  /** How far the body has turned into the mailbox: the outfit is gone by then. */
  morph: number;
  /** 0 not there, 1 fully on: an outfit comes and goes. */
  presence: number;
  /** How many turns the roll under way makes. */
  rollTurns: number;
}

const HATS: ReadonlySet<Outfit> = new Set(["beanie", "santaHat", "partyHat", "crown", "witchHat"]);
/** These are on the body and turn with it when it rolls; a hat flies off instead. */
const FOLLOWS_ROLL: ReadonlySet<Outfit> = new Set(["sunglasses", "roundGlasses", "bow", "scarf", "pumpkin"]);

export const outfitFollowsRoll = (outfit: Outfit) => FOLLOWS_ROLL.has(outfit);

function enter(x: Ctx, p: OutfitPose) {
  x.translate(p.cx, p.cy);
  if (p.tilt !== 0) x.rotate(p.tilt);
  x.scale(p.sx, p.sy);
}

/** How visible the outfit is: it fades as the body morphs, and in as it is put on. */
function opacityOf(p: OutfitPose): number {
  const morphFade = 1 - Math.min(1, Math.max(0, (p.morph - 0.3) / 0.2));
  return morphFade > 0.01 ? morphFade * Math.min(1, p.presence * 2.5) : 0;
}

/** How far through its roll the body is, 0…1; 0 when it is not rolling. */
function rollProgress(H: MochiH, p: OutfitPose): number {
  return Math.abs(H.roll) > 0.01 ? Math.min(1, Math.abs(H.roll) / (2 * Math.PI * Math.max(1, p.rollTurns))) : 0;
}

/** A hat thrown up by a roll: up and back down, swinging flat. */
function flyOff(x: Ctx, H: MochiH, u: number) {
  x.translate(H.physDx * H.rx * 0.2 * Math.sin(u * Math.PI), -H.ry * 0.45 * Math.sin(u * Math.PI));
  x.rotate(Math.sin(2 * Math.PI * u) * 0.35);
}

/** A hat being put on: it comes down from above, growing to its size. */
function settle(x: Ctx, H: MochiH, presence: number) {
  const posP = Ease.back(presence);
  const scale = 0.85 + 0.15 * posP;
  x.translate(0, -(1 - posP) * H.ry);
  x.scale(scale, scale);
}

function drawOnBody(x: Ctx, outfit: Outfit, H: MochiH, body: Path2D, simplified: boolean) {
  switch (outfit) {
    case "beanie": return beanie(x, H, body, simplified);
    case "santaHat": return santaHat(x, H, body);
    case "partyHat": return partyHat(x, H, simplified);
    case "crown": return crownFront(x, H, body, simplified);
    case "witchHat": return witchHatFront(x, H, body);
    case "sunglasses": return sunglasses(x, H, body);
    case "roundGlasses": return roundGlasses(x, H, body);
    case "scarf": return scarf(x, H);
    case "pumpkin": return pumpkin(x, H, body, simplified);
    case "bow": return bow(x, H);
  }
}

/** What of the outfit is in front of the body. Drawn after it. */
export function drawOutfitFront(x: Ctx, outfit: Outfit, H: MochiH, p: OutfitPose) {
  if (outfit === "none" || outfit === "auto" || outfit === "bunnyEars") return;
  const opacity = opacityOf(p);
  if (opacity <= 0.005) return;
  // Rolled past the back of the body, it is the other pass that draws it.
  if (FOLLOWS_ROLL.has(outfit) && projRoll(H, [0, 0, 1]).z < 0) return;

  const simplified = H.R < SIMPLIFIED_UNDER;
  const body = outfitBodyPath(H.rx, H.ry);
  x.save();
  enter(x, p);
  if (HATS.has(outfit)) {
    const u = rollProgress(H, p);
    if (u > 0) flyOff(x, H, u);
    else settle(x, H, p.presence);
  } else if (outfit === "sunglasses" || outfit === "roundGlasses") {
    x.translate(0, (1 - p.presence) * 0.25 * H.ry);
  } else if (outfit === "scarf") {
    x.translate(0, (1 - p.presence) * 0.3 * H.ry);
  } else if (outfit === "bow") {
    const s = Math.max(0.001, Ease.back(p.presence));
    x.scale(s, s);
  }
  layer(x, opacity, (l) => drawOnBody(l, outfit, H, body, simplified));
  x.restore();
}

/** What of the outfit is behind the body. Drawn before it. */
export function drawOutfitBehind(x: Ctx, outfit: Outfit, H: MochiH, p: OutfitPose) {
  if (outfit === "none" || outfit === "auto") return;
  const opacity = opacityOf(p);
  if (opacity <= 0.005) return;

  const simplified = H.R < SIMPLIFIED_UNDER;
  x.save();
  enter(x, p);
  if (FOLLOWS_ROLL.has(outfit)) {
    if (projRoll(H, [0, 0, 1]).z < 0) {
      const body = outfitBodyPath(H.rx, H.ry);
      layer(x, opacity, (l) => drawOnBody(l, outfit, H, body, simplified));
    }
  } else if (outfit === "bunnyEars") {
    // Always behind, and they do not turn with a roll: they lie flat through it.
    const u = rollProgress(H, p);
    settle(x, H, p.presence);
    layer(x, opacity, (l) => bunnyEarsBack(l, H, u));
  } else if (outfit === "crown" || outfit === "witchHat") {
    const u = rollProgress(H, p);
    if (u > 0) flyOff(x, H, u);
    else settle(x, H, p.presence);
    layer(x, opacity, (l) => (outfit === "crown" ? crownPart(l, H, -1, simplified) : witchHatBack(l, H)));
  }
  x.restore();
}

/** The body's colours under the pumpkin. */
export const PUMPKIN_TOP = "#FFA94D";
export const PUMPKIN_BOTTOM = "#E8590C";
