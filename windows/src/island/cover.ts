// The cover of what Spotify plays, as one picture that belongs to the island
// rather than to a view: small in the folded island, where Mochi sits, and
// large on Spotify's card. Unfolding the island carries it from the one to
// the other on a spring, the way Mochi himself moves between views; a new
// song fades in over the one before.

import { Spring } from "../core/anim";
import { h } from "../views/dom";

/** How long a new cover takes to fade in over the last; the last is dropped after it. */
const FADE_MS = 450;
/** The cover's corners, as a share of its side: a square that is Mochi's cousin. */
const CORNER = 0.16;
/** The spring it moves and grows on: quick, with a little give. */
const RESPONSE = 0.42;
const DAMPING = 0.78;

/** Where the cover goes, in the island's own coordinates. */
export interface CoverPlace {
  x: number;
  y: number;
  size: number;
}

export class FloatingCover {
  readonly el = h("div", { id: "island-cover" });

  private x = new Spring(0, RESPONSE, DAMPING);
  private y = new Spring(0, RESPONSE, DAMPING);
  private size = new Spring(0, RESPONSE, DAMPING);
  private url: string | null = null;
  private shown = false;

  /** True when there is a picture to show. */
  get has(): boolean {
    return this.url != null;
  }

  /** True while it is on its way somewhere: the frame loop keeps going. */
  get moving(): boolean {
    return this.shown && !(this.x.settled && this.y.settled && this.size.settled);
  }

  /** The picture to show. A new one fades in over the one before; none leaves the last to fade with the cover. */
  picture(url: string | null) {
    if (url === this.url) return;
    this.url = url;
    if (!url) return;
    const before = [...this.el.children];
    this.el.append(h("img", { src: url, alt: "" }));
    window.setTimeout(() => before.forEach((old) => old.remove()), FADE_MS);
  }

  /**
   * Puts the cover where it belongs now, or takes it away. Appearing, it is
   * simply there; already there, it travels.
   */
  place(to: CoverPlace | null, dt: number) {
    const on = to != null && this.url != null;
    if (on && to) {
      if (this.shown) {
        this.x.target = to.x;
        this.y.target = to.y;
        this.size.target = to.size;
        this.x.step(dt);
        this.y.step(dt);
        this.size.step(dt);
      } else {
        this.x.set(to.x);
        this.y.set(to.y);
        this.size.set(to.size);
      }
      const side = Math.max(0, this.size.value);
      this.el.style.left = `${this.x.value}px`;
      this.el.style.top = `${this.y.value}px`;
      this.el.style.width = `${side}px`;
      this.el.style.height = `${side}px`;
      this.el.style.borderRadius = `${side * CORNER}px`;
    }
    if (on !== this.shown) this.el.classList.toggle("on", on);
    this.shown = on;
  }
}
