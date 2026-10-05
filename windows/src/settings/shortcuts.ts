// Settings → Shortcuts — port of ShortcutsSettingsView.swift: the shortcuts
// that work from any app, each with its switch and its keys to change, and
// the list of those the island answers to once it has the keyboard.

import { Bridge, type ShortcutKey, type Shortcuts, type ShortcutState } from "../core/bridge";
import { h, clear } from "../views/dom";

// Win32's MOD_* bits, as shortcuts.rs keeps them.
const ALT = 1;
const CTRL = 2;
const SHIFT = 4;
const WIN = 8;

/** The actions by the Mac's names for them, in its words. */
const NAMES: Record<string, string> = {
  toggleIsland: "Open / close island",
  openChat: "Open chat",
  goToAlert: "Go to alert",
  jumpToTerminal: "Jump to terminal",
  nextPill: "Next pill",
  prevPill: "Previous pill",
  muteToggle: "Mute / unmute sounds",
  desktopToggle: "Mochi on / off desktop",
  wardrobeToggle: "Open / close wardrobe",
};

/** What the island answers to once it has the keyboard — the Mac's ⌘ shortcuts, on Ctrl. */
const ISLAND_SHORTCUTS: readonly (readonly [string, string])[] = [
  ["Ctrl+→ / Ctrl+←", "Next / previous pill"],
  ["Ctrl+1 – Ctrl+9", "Switch to pill by number"],
  ["Ctrl+↓ / Ctrl+↑", "Navigate list items"],
  ["Ctrl+O", "Open selected item"],
  ["Ctrl+E", "Open / close what Claude changed"],
  ["Enter", "Send chat message"],
  ["Ctrl+K", "New conversation"],
  ["Ctrl+,", "Open Settings"],
  ["Ctrl+P", "Pin / unpin island"],
  ["Esc", "Close island (if not pinned)"],
];

/** Virtual-key codes that have a name of their own. */
const KEY_NAMES: Record<number, string> = {
  0x08: "Backspace", 0x09: "Tab", 0x0d: "Enter", 0x1b: "Esc", 0x20: "Space",
  0x21: "PageUp", 0x22: "PageDown", 0x23: "End", 0x24: "Home",
  0x25: "←", 0x26: "↑", 0x27: "→", 0x28: "↓", 0x2d: "Insert", 0x2e: "Delete",
  0xba: ";", 0xbb: "=", 0xbc: ",", 0xbd: "-", 0xbe: ".", 0xbf: "/", 0xc0: "`",
  0xdb: "[", 0xdc: "\\", 0xdd: "]", 0xde: "'",
};
const VK_F1 = 0x70;
const VK_F24 = 0x87;
/** Shift, Ctrl, Alt, and the two Windows keys: pressed alone, they are not a shortcut yet. */
const MODIFIER_KEYS: ReadonlySet<number> = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c]);
const VK_ESCAPE = 0x1b;

function keyName(vk: number): string {
  if (KEY_NAMES[vk]) return KEY_NAMES[vk];
  if (vk >= VK_F1 && vk <= VK_F24) return `F${vk - VK_F1 + 1}`;
  // Digits and letters are their own character.
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a)) return String.fromCharCode(vk);
  return `Key ${vk}`;
}

/** "Ctrl+Alt+A". */
export function keysLabel(key: ShortcutKey): string {
  const parts: string[] = [];
  if (key.mods & CTRL) parts.push("Ctrl");
  if (key.mods & ALT) parts.push("Alt");
  if (key.mods & SHIFT) parts.push("Shift");
  if (key.mods & WIN) parts.push("Win");
  parts.push(keyName(key.vk));
  return parts.join("+");
}

const modsOf = (e: KeyboardEvent) => (e.ctrlKey ? CTRL : 0) | (e.altKey ? ALT : 0) | (e.shiftKey ? SHIFT : 0) | (e.metaKey ? WIN : 0);

export function shortcutsSection(say: (message: string) => void): HTMLElement[] {
  const rows = h("div", { class: "shortcut-rows" });
  const resetAll = h("button", { text: "Reset all to defaults" });
  const global = h("section", {}, h("h2", {}, h("span", { text: "Global shortcuts — work from any app" })), rows, h("div", { class: "row" }, h("span", { class: "spacer" }), resetAll));
  /** The row waiting for keys, and how to stop it listening. */
  let recording: (() => void) | null = null;

  async function change(action: string, key: ShortcutKey | null) {
    try {
      draw(await Bridge.shortcutSet(action, key));
    } catch (err) {
      say(String(err).replace(/^Error:\s*/, ""));
    }
  }

  function row(s: ShortcutState): HTMLElement {
    const sw = h("button", { class: s.enabled ? "switch on" : "switch" });
    sw.addEventListener("click", () => void change(s.action, { vk: s.vk, mods: s.mods, enabled: !s.enabled }));

    const keys = h("button", { class: "shortcut-keys", text: keysLabel(s), title: "Click, then press the new keys" });
    keys.addEventListener("click", () => {
      recording?.();
      keys.textContent = "Press keys…";
      keys.classList.add("recording");
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (MODIFIER_KEYS.has(e.keyCode)) return;
        const mods = modsOf(e);
        stop();
        // Escape alone gives up; a key without a modifier would be taken from every app.
        if (e.keyCode === VK_ESCAPE && mods === 0) return;
        if (mods === 0) {
          say("A shortcut needs Ctrl, Alt, Shift or the Windows key.");
          return;
        }
        void change(s.action, { vk: e.keyCode, mods, enabled: true });
      };
      const stop = () => {
        window.removeEventListener("keydown", onKey, true);
        keys.textContent = keysLabel(s);
        keys.classList.remove("recording");
        recording = null;
      };
      recording = stop;
      window.addEventListener("keydown", onKey, true);
    });

    const conflict =
      s.conflict === "duplicate" ? h("span", { class: "shortcut-tag duplicate", text: "Duplicate", title: "Another of Coucou's shortcuts is on the same keys." })
      : s.conflict === "taken" ? h("span", { class: "shortcut-tag taken", text: "System conflict", title: "Another app already uses these keys." })
      : null;
    const reset = s.isDefault ? null : h("button", { class: "link", text: "Reset", onclick: () => void change(s.action, null) });

    return h("div", { class: s.enabled ? "shortcut-row" : "shortcut-row off" }, sw, h("span", { text: NAMES[s.action] ?? s.action }), h("span", { class: "spacer" }), conflict, reset, keys);
  }

  let listed: ShortcutState[] = [];

  function draw(shortcuts: Shortcuts | null) {
    recording?.();
    clear(rows);
    if (!shortcuts) return;
    listed = shortcuts.items;
    if (!shortcuts.supported) {
      rows.append(h("div", { class: "hint", text: "Shortcuts from other apps are not available on this system: it gives an app none to register." }));
      resetAll.disabled = true;
      return;
    }
    for (const s of listed) rows.append(row(s));
    resetAll.disabled = listed.every((s) => s.isDefault);
  }

  resetAll.addEventListener("click", async () => {
    for (const s of listed.filter((s) => !s.isDefault)) await change(s.action, null);
  });

  void Bridge.shortcutsList().then(draw);

  const island = h("section", {}, h("h2", {}, h("span", { text: "Island shortcuts — active when the island has the keyboard" })));
  for (const [keys, what] of ISLAND_SHORTCUTS) {
    island.append(h("div", { class: "shortcut-row" }, h("span", { class: "shortcut-keys fixed", text: keys }), h("span", { class: "hint", text: what })));
  }
  island.append(h("div", { class: "hint", text: "The island takes the keyboard when a shortcut opens it, and in the chat." }));

  return [global, island];
}
