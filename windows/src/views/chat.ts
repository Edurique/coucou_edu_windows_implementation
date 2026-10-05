// Chat view — DOM port of PromptView / ModelPickerView / ChatBubble /
// TypingDotsView from IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { markdown } from "./markdown";
import { Bridge, onEvent, type ChatContext, type ChatModel } from "../core/bridge";
import {
  PROVIDERS, PROVIDER_IDS, chatModel, fallbackModel, serverUrl, setChatModel, type ChatProvider,
} from "../core/chat";
import { PANEL_H } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

/** The whole of an answer's code block goes to the clipboard; the button says so for this long. */
const COPIED_MS = 1500;

function bubble(message: ChatMessage, openUrl: (url: string) => void): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = markdown(message.content, {
    quotes: true,
    open: openUrl,
    copy: (code, button) => {
      void navigator.clipboard?.writeText(code).then(() => {
        button.classList.add("copied");
        button.replaceChildren(svg(ICONS.check, 10, { stroke: 3 }));
        window.setTimeout(() => {
          button.classList.remove("copied");
          button.replaceChildren(svg(ICONS.copy, 10));
        }, COPIED_MS);
      });
    },
  });
  reply.classList.add("chat-md");
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

// ── Models, as the picker knows them ──────────────────────────────────────────

/** What each provider offers, once asked; an error is said in the list's place. */
const fetched = new Map<ChatProvider, ChatModel[]>();
const fetchError = new Map<ChatProvider, string>();
const loading = new Set<ChatProvider>();

/** Asks a provider for its models unless they are here or on their way. */
function fetchModelsIfNeeded(provider: ChatProvider) {
  if (loading.has(provider) || fetched.has(provider)) return;
  loading.add(provider);
  fetchError.delete(provider);
  State.notify();
  void Bridge.chatModels(provider)
    .then((models) => {
      fetched.set(provider, models);
      // A model that is not in the list cannot be asked for: take the one the provider is best started on.
      if (!models.some((m) => m.id === chatModel(State.settings, provider))) {
        const next = fallbackModel(provider, models);
        if (next) {
          setChatModel(State.settings, provider, next);
          void Bridge.saveSettings(State.settings);
        }
      }
    })
    .catch((err) => fetchError.set(provider, String(err).replace(/^Error:\s*/, "")))
    .finally(() => {
      loading.delete(provider);
      State.notify();
    });
}

/** A local server's models change as the user downloads them: asked for again each time. */
function forget(provider: ChatProvider) {
  fetched.delete(provider);
  fetchError.delete(provider);
}

/**
 * Sets who the chat talks to — the picker's chips, an AI pill's button. Mochi
 * is surprised, with a pop, when it is somebody new.
 */
export function switchChatProvider(provider: ChatProvider, surprise: () => void) {
  if (provider === State.settings.chatProvider) return;
  State.settings.chatProvider = provider;
  void Bridge.saveSettings(State.settings);
  surprise();
  Sound.play("pop");
  State.notify();
}

export function buildPrompt(onHeightChange: () => void, openUrl: (url: string) => void, surprise: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  // The model the chat talks to, under the conversation: a click opens the picker.
  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span");
  const modelChip = h("button", { class: "model-chip", title: "Choose who answers" }, modelDot, modelName, svg(ICONS.chevronUpDown, 8, { stroke: 2.4 }));
  const modelRow = h("div", { class: "model-row" }, modelChip);

  const providerChips = h("div", { class: "picker-providers" });
  const modelList = h("div", { class: "picker-models" });
  const picker = h("div", { class: "model-picker" }, providerChips, h("hr", { class: "picker-rule" }), modelList);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, modelRow, bar), picker),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let rendered = "";
  let pickerOpen = false;
  let pickerKey = "";
  /** The answer a local model is writing: its place in the conversation, until it is whole. */
  const stream: { message: ChatMessage | null } = { message: null };
  /** Read through a call: what it holds changes while a turn is awaited. */
  const written = (): ChatMessage | null => stream.message;

  function setPicker(open: boolean) {
    if (open === pickerOpen) return;
    pickerOpen = open;
    picker.classList.toggle("open", open);
    modelChip.classList.toggle("on", open);
    if (open) {
      const provider = State.settings.chatProvider;
      if (PROVIDERS[provider].local) forget(provider);
      fetchModelsIfNeeded(provider);
    }
    State.notify();
    onHeightChange();
  }

  modelChip.addEventListener("click", () => setPicker(!pickerOpen));
  // A click anywhere else in the chat shuts it, as a popover would.
  el.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (pickerOpen && !picker.contains(target) && !modelChip.contains(target)) setPicker(false);
  });

  function drawPicker() {
    const settings = State.settings;
    const provider = settings.chatProvider;
    // A local server that was never connected has no place among the choices, unless it is the one in use.
    const visible = PROVIDER_IDS.filter((id) => !PROVIDERS[id].local || serverUrl(settings, id) !== "" || id === provider);
    clear(providerChips);
    for (const id of visible) {
      const def = PROVIDERS[id];
      const chip = h(
        "button",
        {
          class: id === provider ? "provider-chip on" : "provider-chip",
          onclick: () => {
            if (id === provider) return;
            switchChatProvider(id, surprise);
            if (def.local) forget(id);
            fetchModelsIfNeeded(id);
          },
        },
        h("i", { style: `background:${def.accent}` }),
        h("span", { text: def.name }),
      );
      chip.style.setProperty("--accent", def.accent);
      providerChips.append(chip);
    }

    clear(modelList);
    modelList.style.setProperty("--accent", PROVIDERS[provider].accent);
    const error = fetchError.get(provider);
    const models = fetched.get(provider);
    if (loading.has(provider)) {
      modelList.append(h("div", { class: "picker-note" }, h("i", { class: "picker-spin" }), h("span", { text: "Loading models…" })));
    } else if (error) {
      modelList.append(h("div", { class: "picker-note", text: error }));
    } else if (models) {
      const current = chatModel(settings, provider);
      for (const model of models) {
        const chosen = model.id === current;
        modelList.append(
          h(
            "button",
            {
              class: chosen ? "picker-model on" : "picker-model",
              onclick: () => {
                setChatModel(State.settings, provider, model.id);
                void Bridge.saveSettings(State.settings);
                Sound.play("blip");
                setPicker(false);
              },
            },
            h("span", { text: model.label }),
            chosen ? svg(ICONS.check, 10, { stroke: 3 }) : null,
          ),
        );
      }
    }
  }

  // What a local model has written so far, a few times a second while it writes.
  void onEvent<string>("chat-stream", (visible) => {
    if (!sending) return;
    if (!stream.message) {
      if (!visible) return;
      // First words: the dots give way to the answer.
      stream.message = { id: nextId++, role: "assistant", content: visible };
      State.chatHistory.push(stream.message);
      State.stateOverride = null;
      onHeightChange();
    } else {
      stream.message.content = visible;
    }
    State.notify();
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    stream.message = null;
    setPicker(false);
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      // An answer that streamed is already there: it takes its final words.
      const answer = written();
      if (answer) answer.content = reply.text;
      else State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      const partial = written();
      if (partial) State.chatHistory = State.chatHistory.filter((m) => m !== partial);
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      stream.message = null;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      // Ctrl+K: a new conversation, the field ready for its first words.
      e.preventDefault();
      if (sending) return;
      input.value = "";
      State.chatHistory = [];
      void Bridge.chatReset();
      State.notify();
      onHeightChange();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  let shown = false;

  return {
    el,
    // The picker needs room for a list: the island is as tall as it gets while it is open.
    get height() {
      return pickerOpen ? PANEL_H : undefined;
    },
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      // Coming into the chat: the models of who it talks to, for the picker.
      const here = State.view === "prompt";
      if (here && !shown) fetchModelsIfNeeded(State.settings.chatProvider);
      if (!here && pickerOpen) setPicker(false);
      shown = here;

      const thinking = State.stateOverride === "thinking";
      const last = State.chatHistory.at(-1);
      const key = `${State.chatHistory.length}|${thinking}|${last?.content.length ?? 0}`;
      if (key !== rendered) {
        rendered = key;
        clear(log);
        for (const m of State.chatHistory) if (m.content) log.append(bubble(m, openUrl));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      const provider = State.settings.chatProvider;
      modelDot.style.background = PROVIDERS[provider].accent;
      modelName.textContent = chatModel(State.settings, provider);

      const nextPickerKey = [
        pickerOpen, provider, chatModel(State.settings, provider), loading.has(provider), fetchError.get(provider) ?? "",
        fetched.get(provider)?.length ?? -1, State.settings.ollamaServerUrl, State.settings.lmstudioServerUrl,
      ].join("|");
      if (pickerOpen && nextPickerKey !== pickerKey) drawPicker();
      pickerKey = nextPickerKey;

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
