// Settings window — a sidebar of sections and the one that is picked, laid out
// like SettingsView.swift: General, Active pills, Agents, Chat, Integrations.
// Anything that writes outside Coucou's own files is confirmed here first.

import "./settings.css";
import { Bridge, onEvent, type GithubAccount, type HookStatus, type PlanRelayStatus } from "../core/bridge";
import { PROVIDERS, PROVIDER_IDS, serverUrl, type ChatProvider } from "../core/chat";
import { DEFAULT_SETTINGS, INTEGRATION_AGENTS, CLAUDE_ID, type Settings } from "../core/state";
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
/** Which keys are in the keychain, by name. Never their values. */
const present: Record<string, boolean> = {};

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** Green for what is in place, red for what is missing. */
const statusColor = (ok: boolean) => (ok ? "var(--green)" : "var(--red)");

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${statusColor(ok)}` });
}

function colorDot(color: string): HTMLElement {
  return h("i", { class: "dot", style: `background:${color}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/** A titled box of a section, like a GroupBox. */
function group(title: string | null, ...children: (Node | null)[]): HTMLElement {
  return h("section", {}, title ? h("h2", {}, h("span", { text: title })) : null, ...children);
}

const cleanError = (err: unknown) => String(err).replace(/^Error:\s*/, "");

/** The line at the bottom of the window: what the last action did. */
const statusLine = h("div", { class: "status-line" });

function say(message: string) {
  statusLine.textContent = message;
  statusLine.classList.toggle("err", message.startsWith("❌"));
  statusLine.classList.toggle("on", message !== "");
}

// ── A key, kept in the keychain ───────────────────────────────────────────────

/**
 * A field for a key and its Save button. The value goes to the keychain and
 * never comes back: the field only ever says whether one is stored.
 */
function keyField(key: string, placeholder: string, saved: string, opts: { secret?: boolean; after?: () => void } = {}): HTMLElement {
  const secret = opts.secret ?? true;
  const stored = () => (present[key] ? "••••••••••••  (stored)" : placeholder);
  const field = h("input", {
    type: secret ? "password" : "text", placeholder: stored(), autocomplete: "off", spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const dot = statusDot(present[key] ?? false);
  const remove = h("button", { class: "danger", text: "Remove" });
  const show = () => {
    field.placeholder = stored();
    dot.style.background = statusColor(present[key] ?? false);
    remove.style.display = present[key] ? "" : "none";
  };
  const saveBtn = h("button", { class: "primary", text: "Save" });
  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet(key, value);
      present[key] = true;
      field.value = "";
      show();
      say(saved);
      opts.after?.();
    } catch (err) {
      say(`❌ Could not save: ${cleanError(err)}`);
    }
  });
  remove.addEventListener("click", async () => {
    try {
      await Bridge.secretClear(key);
      present[key] = false;
      show();
      say("Key removed.");
      opts.after?.();
    } catch (err) {
      say(`❌ Could not remove: ${cleanError(err)}`);
    }
  });
  show();
  return h("div", { class: "row" }, field, saveBtn, remove, dot);
}

// ── General ───────────────────────────────────────────────────────────────────

/** The volume slider's range, as the island's own sound engine has it. */
const VOLUME_MAX = 0.2;

function generalSection(): HTMLElement[] {
  const percent = h("span", { class: "figure" });
  const showPercent = () => (percent.textContent = `${Math.round((settings.soundVolume / VOLUME_MAX) * 100)} %`);
  const volume = h("input", {
    type: "range", min: "0", max: String(VOLUME_MAX), step: "0.005", value: String(settings.soundVolume),
    style: "flex:1 1 auto",
  }) as HTMLInputElement;
  volume.disabled = !settings.soundEnabled;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    showPercent();
    void save();
  });
  showPercent();

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1", value: String(Math.round(settings.autoCloseInterval)), style: "width:64px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return [
    group(
      "Sound",
      h("div", { class: "row" },
        toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; volume.disabled = !v; void save(); }),
        h("span", { text: "Enable sounds" }),
      ),
      h("div", { class: "row" }, h("label", { style: "min-width:56px", text: "Volume" }), volume, percent),
    ),
    group(
      "Behavior",
      h("div", { class: "row" }, h("span", { text: "Close after" }), autoClose, h("span", { text: "s inactive" })),
      h("div", { class: "row" }, h("label", { text: "Island lives on" }), screen),
      h("div", { class: "row" },
        toggle(settings.hideInFullscreen, (v) => { settings.hideInFullscreen = v; void save(); }),
        h("span", { text: "Hide in full screen" }),
        h("span", { class: "hint", text: "only a request from Claude brings the island out" }),
      ),
    ),
    group(
      "Startup",
      h("div", { class: "row" },
        toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
        h("span", { text: "Launch at startup" }),
      ),
    ),
  ];
}

// ── Active pills ──────────────────────────────────────────────────────────────

const MAX_ACTIVE = 4;

/** The pills, by what they are — the categories of PillCatalog.swift. */
const PILL_CATEGORIES: { title: string; ids: string[] }[] = [
  { title: "Where you code", ids: [CLAUDE_ID] },
  { title: "AI for the chat", ids: PROVIDER_IDS.map((id) => PROVIDERS[id].pill) },
  {
    title: "Services",
    ids: [
      "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
      "integration_notion", "integration_calcom", "integration_stripe", "integration_spotify",
    ],
  },
];

/** The key a service's pill cannot do without. */
const SERVICE_KEYS: Record<string, string> = {
  integration_resend: "resend-api-key", integration_n8n: "n8n-api-key", integration_vercel: "vercel-token",
  integration_github: "github-token", integration_notion: "notion-api-key", integration_calcom: "calcom-api-key",
  integration_stripe: "stripe-api-key",
};

/** What a pill still needs before it has anything to show, or null. */
function pillHint(id: string): string | null {
  const provider = PROVIDER_IDS.find((p) => PROVIDERS[p].pill === id);
  if (provider) {
    const { secret } = PROVIDERS[provider];
    if (!secret) return serverUrl(settings, provider) === "" ? "Not connected" : null;
    return present[secret] ? null : "Key not configured";
  }
  const key = SERVICE_KEYS[id];
  return key && !present[key] ? "Key not configured" : null;
}

function activePillsSection(): HTMLElement[] {
  const slots = h("div", { class: "hint" });
  const rows = h("div", { class: "pill-rows" });

  function draw() {
    const used = settings.activeIntegrations.length;
    slots.textContent = `${used}/${MAX_ACTIVE} slots used`;
    slots.classList.toggle("full", used >= MAX_ACTIVE);
    clear(rows);
    for (const category of PILL_CATEGORIES) {
      rows.append(h("hr", {}), h("div", { class: "pill-category", text: category.title }));
      for (const id of category.ids) {
        const def = INTEGRATION_AGENTS.find((t) => t.id === id);
        if (!def) continue;
        const main = id === CLAUDE_ID;
        const on = settings.activeIntegrations.includes(id);
        const atMax = used >= MAX_ACTIVE && !on && !main;
        const hint = main ? null : pillHint(id);
        const sw = h("button", { class: on ? "switch on" : "switch" });
        sw.disabled = atMax;
        sw.addEventListener("click", () => {
          settings.activeIntegrations = on
            ? settings.activeIntegrations.filter((x) => x !== id)
            : [...settings.activeIntegrations, id];
          void save();
          draw();
        });
        rows.append(
          h("div", { class: atMax ? "pill-row off" : "pill-row" },
            colorDot(def.color),
            h("span", { text: def.name }),
            h("span", { class: "spacer" }),
            main ? h("span", { class: "hint", text: "Main" }) : hint ? h("span", { class: "hint", text: hint }) : null,
            main ? null : sw,
          ),
        );
      }
    }
  }

  draw();
  return [
    group(
      null,
      h("div", { class: "hint", text: "Choose the tools you use. Coucou only shows what you declare here." }),
      slots,
      rows,
    ),
  ];
}

// ── Agents: the Claude Code hooks, and the plan usage relay ───────────────────

function hooksGroup(status: HookStatus): HTMLElement {
  const body = h("div", { class: "stack" });
  const head = h("h2", {});
  const section = h("section", {}, head, body);

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
  };

  function draw() {
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code Hooks" }));
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", { class: "danger", text: "Uninstall hooks…", onclick: () => showPreview(false) }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: cleanError(err) }),
        h("div", { class: "row" }, h("button", { text: "Back", onclick: () => { clear(body); draw(); } })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" }, h("span", { class: "path", text: `Backup → ${preview.backup}` })),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", { text: "Cancel", onclick: () => { clear(body); draw(); } })));
  }

  draw();
  return section;
}

/**
 * Plan usage: a switch to show the gauge in the island's header, and the
 * relay it reads from — a status line in ~/.claude/settings.json, written
 * only after its diff was looked at.
 */
function planGroup(relay: PlanRelayStatus): HTMLElement {
  const body = h("div", { class: "stack" });
  /** The switch was turned on with no relay yet: it holds until the relay is written, or given up. */
  let pending = false;

  const rebuild = async () => {
    const fresh = await Bridge.planRelayStatus();
    if (fresh) Object.assign(relay, fresh);
    draw();
  };

  function draw() {
    clear(body);
    const sw = toggle(settings.showPlanInNotch || pending, (on) => {
      if (!on) {
        settings.showPlanInNotch = false;
        pending = false;
        void save();
      } else if (relay.installed) {
        settings.showPlanInNotch = true;
        void save();
      } else {
        pending = true;
        void showPreview(true);
      }
    });
    body.append(
      h("div", {
        class: "hint",
        text: "Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Coucou adds a status line relay to ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only.",
      }),
      h("div", { class: "row" }, sw, h("span", { text: "Show in the island" })),
      h("div", { class: "row" },
        h("span", { class: "hint", text: relay.installed ? "Relay: installed" : "Relay: not installed" }),
        relay.installed
          ? h("button", { text: "Uninstall relay…", onclick: () => void showPreview(false) })
          : h("button", { class: "primary", text: "Install relay…", onclick: () => void showPreview(true) }),
      ),
    );
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.planRelayPreview(install);
    } catch (err) {
      pending = false;
      draw();
      say(`❌ ${cleanError(err)}`);
      return;
    }
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json: only the status line. A status line of your own keeps running, through Coucou's relay."
          : "This takes Coucou's relay out and puts your own status line back, if you had one.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" }, h("span", { class: "path", text: `Backup → ${preview.backup}` })),
    );
    const confirm = h("button", { class: install ? "primary" : "danger", text: install ? "Back up and write" : "Back up and remove" });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await Bridge.planRelayApply(install, preview.fingerprint);
        if (install && pending) settings.showPlanInNotch = true;
        if (!install) settings.showPlanInNotch = false;
        pending = false;
        void save();
        say(install ? "✓ Status line installed." : "✓ Status line removed.");
        await rebuild();
      } catch (err) {
        confirm.disabled = false;
        say(`❌ ${cleanError(err)}`);
      }
    });
    body.append(
      h("div", { class: "row" }, confirm, h("button", { text: "Cancel", onclick: () => { pending = false; draw(); } })),
    );
  }

  draw();
  return h("section", {}, h("h2", {}, h("span", { text: "Plan usage" })), body);
}

// ── Chat ──────────────────────────────────────────────────────────────────────

/** Shown until the account's own list is here, and when it cannot be had. */
const FALLBACK_MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];
const CUSTOM_MODEL = "__custom__";

function anthropicGroup(): HTMLElement {
  const model = h("select", { style: "flex:1 1 auto;min-width:0" }) as HTMLSelectElement;
  const custom = h("input", { type: "text", placeholder: "Model ID (e.g. claude-sonnet-5)", style: "flex:1 1 auto;min-width:0", spellcheck: "false" }) as HTMLInputElement;
  const customRow = h("div", { class: "row" }, custom);
  let models: [string, string][] = FALLBACK_MODELS;

  function draw() {
    clear(model);
    for (const [id, label] of models) model.append(h("option", { value: id, text: label }));
    model.append(h("option", { value: CUSTOM_MODEL, text: "Custom…" }));
    const listed = models.some(([id]) => id === settings.model);
    model.value = listed ? settings.model : CUSTOM_MODEL;
    custom.value = listed ? "" : settings.model;
    customRow.style.display = listed ? "none" : "";
  }

  async function load() {
    if (!present["anthropic-api-key"]) return;
    try {
      const fetched = await Bridge.chatModels("anthropic");
      if (fetched.length > 0) {
        models = fetched.map((m) => [m.id, m.label]);
        draw();
      }
    } catch {
      /* the static list stays */
    }
  }

  model.addEventListener("change", () => {
    if (model.value === CUSTOM_MODEL) {
      customRow.style.display = "";
      custom.focus();
      return;
    }
    customRow.style.display = "none";
    settings.model = model.value;
    void save();
  });
  custom.addEventListener("change", () => {
    const id = custom.value.trim();
    if (!id) return;
    settings.model = id;
    void save();
  });

  draw();
  void load();
  return group(
    "Anthropic API",
    keyField("anthropic-api-key", "API key (sk-ant-…)", "✓ Key saved.", { after: () => void load() }),
    h("hr", {}),
    h("div", { class: "row" }, h("label", { style: "min-width:56px", text: "Model" }), model),
    customRow,
    h("div", { class: "hint", text: "Used by the chat. The list comes from your Anthropic account." }),
  );
}

function otherProvidersGroup(): HTMLElement {
  const head = (provider: ChatProvider, name: string) =>
    h("div", { class: "row tight" }, colorDot(PROVIDERS[provider].accent), h("b", { text: name }));
  return group(
    "Chat — other providers",
    h("div", { class: "hint", text: "To use Google Gemini or OpenAI from the chat. Keys are stored in the Windows Credential Manager." }),
    head("google", "Google AI"),
    keyField("google-api-key", "API key (AI Studio)", "✓ Google key saved."),
    h("hr", {}),
    head("openai", "OpenAI"),
    keyField("openai-api-key", "API key (sk-…)", "✓ OpenAI key saved."),
  );
}

/** Where each local server listens when nothing was changed. */
const LOCAL_DEFAULTS: Partial<Record<ChatProvider, string>> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
};

function localModelsGroup(): HTMLElement {
  const body = h("div", { class: "stack" });

  function setUrl(provider: ChatProvider, url: string) {
    if (provider === "ollama") settings.ollamaServerUrl = url;
    else settings.lmstudioServerUrl = url;
  }

  function server(provider: ChatProvider): HTMLElement {
    const def = PROVIDERS[provider];
    const url = serverUrl(settings, provider);
    const box = h("div", { class: "stack tight" });
    box.append(
      h("div", { class: "row tight" },
        colorDot(def.accent), h("b", { text: def.name }),
        url ? h("span", { class: "connected", text: "Connected" }) : null,
      ),
    );
    if (url) {
      box.append(
        h("div", { class: "path", text: url }),
        h("div", { class: "row" },
          h("button", {
            text: "Disconnect",
            onclick: () => {
              setUrl(provider, "");
              // The chat cannot go on talking to a server that is gone.
              if (settings.chatProvider === provider) settings.chatProvider = "anthropic";
              void save();
              say(`${def.name} disconnected.`);
              draw();
            },
          }),
        ),
      );
      return box;
    }
    const field = h("input", { type: "text", placeholder: LOCAL_DEFAULTS[provider] ?? "", spellcheck: "false", style: "flex:1 1 auto;min-width:0" }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: "Connect" });
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      connect.textContent = "Connecting…";
      say("");
      try {
        const found = await Bridge.localConnect(provider, field.value);
        setUrl(provider, found.url);
        void save();
        say(`✓ Connected · ${found.models} model${found.models === 1 ? "" : "s"}`);
        draw();
      } catch (err) {
        connect.disabled = false;
        connect.textContent = "Connect";
        say(cleanError(err));
      }
    });
    box.append(h("div", { class: "row" }, field, connect));
    return box;
  }

  function draw() {
    clear(body);
    body.append(
      h("div", { class: "hint", text: "Connect to a local model server. No API key needed." }),
      server("ollama"),
      h("hr", {}),
      server("lmstudio"),
    );
  }

  draw();
  return h("section", {}, h("h2", {}, h("span", { text: "Local models" })), body);
}

// ── Integrations ──────────────────────────────────────────────────────────────

const GITHUB_ID = "integration_github";
const GITHUB_KEY = "github-token";
const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const DAY_MS = 86_400_000;
/** A token this close to its end gets a word about it. */
const EXPIRES_SOON_DAYS = 7;

/** GitHub's token, how to make one, and a test of what it can reach. */
function githubSetup(): HTMLElement {
  const feedback = h("div", {});
  const testBtn = h("button", { text: "Test connection" });

  // The test only ever runs on the stored token, so the value never has to
  // travel anywhere else.
  testBtn.addEventListener("click", async () => {
    clear(feedback);
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    try {
      feedback.append(githubResult(await Bridge.githubTest()));
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: cleanError(err) }));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test connection";
    }
  });

  const newToken = h("button", {
    class: "link",
    text: "fine-grained token",
    onclick: () => void Bridge.openUrl(GITHUB_NEW_TOKEN_URL),
  });

  return h(
    "div",
    { class: "stack tight" },
    keyField(GITHUB_KEY, "github_pat_…", "✓ Token saved. It never touches disk — test it below.", {
      // Fill the pill now rather than at the next poll.
      after: () => void Bridge.refreshIntegration(GITHUB_ID),
    }),
    h(
      "div",
      { class: "hint" },
      "Create a ", newToken, " with ",
      h("b", { text: "Repository access: All repositories" }), ", then under ",
      h("b", { text: "Repository permissions" }), " set ",
      h("b", { text: "Actions" }), ", ", h("b", { text: "Contents" }), ", ",
      h("b", { text: "Deployments" }), ", ", h("b", { text: "Issues" }), " and ",
      h("b", { text: "Pull requests" }),
      " to Read-only (Metadata is added on its own). Under ",
      h("b", { text: "Account permissions" }), ", ", h("b", { text: "Events" }),
      " Read-only is optional and adds your private activity. Nothing else — Coucou only reads.",
    ),
    h("div", { class: "row" }, testBtn),
    feedback,
  );
}

function githubResult(account: GithubAccount): HTMLElement {
  const missing = account.checks.some((c) => !c.ok);
  const who = account.name ? `@${account.login} (${account.name})` : `@${account.login}`;
  const list = h("ul", { class: "checks" });
  for (const c of account.checks) {
    list.append(
      h("li", {}, statusDot(c.ok), h("span", { text: c.label }), c.note ? h("span", { class: "check-note", text: c.note }) : null),
    );
  }
  return h(
    "div",
    { class: missing ? "notice warn" : "notice ok" },
    h("div", { text: `Connected as ${who}.` }),
    h("div", { text: tokenExpiry(account.expiresAt) }),
    list,
  );
}

/** "2026-12-12 10:00:00 +0100" → a date, with a nudge when it is close. */
function tokenExpiry(raw: string | null): string {
  if (!raw) return "This token has no expiry date.";
  const date = new Date(raw.slice(0, 10));
  if (Number.isNaN(date.getTime())) return `Token expires ${raw}.`;
  const when = date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const days = Math.ceil((date.getTime() - Date.now()) / DAY_MS);
  if (days < 0) return `This token expired on ${when}.`;
  if (days <= EXPIRES_SOON_DAYS) return `Token expires on ${when} — in ${days} day${days === 1 ? "" : "s"}. Make a new one soon.`;
  return `Token expires on ${when}.`;
}

interface ServiceDef {
  name: string;
  color: string;
  /** Keychain keys, in the order they are shown. */
  fields: { key: string; placeholder: string; secret: boolean }[];
  /** For a service that needs more than its fields. */
  setup?: () => HTMLElement;
  /** For one that needs nothing: what it reads, in a line. */
  note?: string;
  /** A choice of its own, kept with the settings: a switch and what it does. */
  option?: { setting: "announceSongs"; label: string };
}

const SERVICES: ServiceDef[] = [
  { name: "Resend", color: "#22C55E", fields: [{ key: "resend-api-key", placeholder: "API key  (re_…)", secret: true }] },
  { name: "n8n", color: "#F29B38", fields: [
    { key: "n8n-url", placeholder: "Instance URL  (https://…)", secret: false },
    { key: "n8n-api-key", placeholder: "API key", secret: true },
  ] },
  { name: "Vercel", color: "#7C5CFF", fields: [{ key: "vercel-token", placeholder: "Token", secret: true }] },
  { name: "GitHub", color: "#F4505E", fields: [], setup: githubSetup },
  { name: "Stripe", color: "#0570DE", fields: [{ key: "stripe-api-key", placeholder: "Secret key  (sk_live_… or sk_test_…)", secret: true }] },
  { name: "Cal.com", color: "#C9956A", fields: [{ key: "calcom-api-key", placeholder: "API key  (cal_live_…)", secret: true }] },
  { name: "Notion", color: "#E8E8E8", fields: [{ key: "notion-api-key", placeholder: "Integration token  (ntn_…)", secret: true }] },
  { name: "Spotify", color: "#1DB954", fields: [],
    note: "No key: asks Windows what the Spotify desktop app is playing. Nothing is asked of Spotify.",
    option: { setting: "announceSongs", label: "Show each new song: the island unfolds for a moment when the song changes" } },
];

function integrationsSection(): HTMLElement[] {
  const list = h("div", { class: "stack wide" });
  for (const def of SERVICES) {
    const box = h("div", { class: "stack tight" }, h("div", { class: "row tight" }, colorDot(def.color), h("b", { text: def.name })));
    for (const field of def.fields) {
      box.append(keyField(field.key, field.placeholder, `✓ ${def.name} saved.`, { secret: field.secret }));
    }
    if (def.setup) box.append(def.setup());
    if (def.note) box.append(h("div", { class: "hint", text: def.note }));
    if (def.option) {
      const { setting, label } = def.option;
      box.append(
        h("div", { class: "row" },
          toggle(settings[setting], (on) => { settings[setting] = on; void save(); }),
          h("span", { text: label }),
        ),
      );
    }
    list.append(box);
  }
  return [
    group(
      null,
      h("div", { class: "hint", text: "Keys are stored in the Windows Credential Manager, never on disk. Switch a service's pill on in Active pills." }),
      list,
    ),
  ];
}

// ── The window: a sidebar, and the section that is picked ─────────────────────

interface Section {
  id: string;
  title: string;
  icon: string;
  color: string;
  build: () => HTMLElement[];
}

/** Remembered from one opening of the window to the next. */
const SECTION_KEY = "settingsSection";

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const hooks = (await Bridge.hooksStatus()) ?? { installed: false, settingsPath: "", hookPath: "", hookReady: false };
  const relay = (await Bridge.planRelayStatus()) ?? { installed: false };

  const keys = [
    "anthropic-api-key", "google-api-key", "openai-api-key",
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  const sections: Section[] = [
    { id: "general", title: "General", icon: ICONS.gearFill, color: "#8E939C", build: generalSection },
    { id: "activepills", title: "Active pills", icon: ICONS.stack, color: "#F5A524", build: activePillsSection },
    { id: "agents", title: "Agents", icon: ICONS.terminal, color: "#3B9EFF", build: () => [hooksGroup(hooks), planGroup(relay)] },
    { id: "chat", title: "Chat", icon: ICONS.bubble, color: "#E07950", build: () => [anthropicGroup(), otherProvidersGroup(), localModelsGroup()] },
    { id: "integrations", title: "Integrations", icon: ICONS.plus, color: "#7C5CFF", build: integrationsSection },
  ];

  const title = h("h1", {});
  const content = h("div", { class: "detail-content" });
  const nav = h("nav", {});
  let current = "";

  function show(id: string) {
    const section = sections.find((s) => s.id === id) ?? sections[0];
    current = section.id;
    try {
      localStorage.setItem(SECTION_KEY, section.id);
    } catch {
      /* a window that cannot remember still works */
    }
    say("");
    title.textContent = section.title;
    clear(content);
    content.append(...section.build());
    for (const row of nav.children) row.classList.toggle("on", (row as HTMLElement).dataset.id === section.id);
  }

  for (const section of sections) {
    const row = h(
      "button",
      { class: "nav-row", onclick: () => show(section.id) },
      h("i", { class: "nav-icon", style: `background:${section.color}` }, svg(section.icon, 12)),
      h("span", { text: section.title }),
    );
    row.dataset.id = section.id;
    nav.append(row);
  }

  clear(root);
  root.append(
    h("aside", {},
      h("div", { class: "app" }, h("b", { text: "Coucou" }), h("span", { text: version })),
      nav,
      h("div", { class: "spacer" }),
      h("div", { class: "hint footnote", text: "No telemetry. Network requests only go to the services you configure yourself." }),
    ),
    h("main", {}, title, content, statusLine),
  );

  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(SECTION_KEY);
  } catch {
    /* starts on General */
  }
  show(remembered ?? "general");

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
  // The island sends the user to the section that has what they are missing.
  void onEvent<string>("settings-section", (id) => show(id));
  // A key saved or removed elsewhere: the hints must not go stale.
  void onEvent<null>("secrets-changed", async () => {
    for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;
    if (current === "activepills") show(current);
  });
}

void main();
