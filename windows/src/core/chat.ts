// Who the chat talks to — the ChatProvider of IslandTypes.swift: names,
// colours and pills as on macOS.

import type { Settings } from "./state";

export type ChatProvider = "anthropic" | "google" | "openai" | "ollama" | "lmstudio";

interface ProviderDef {
  name: string;
  /** Its colour: the dot beside its name, its pill, a chosen model. */
  accent: string;
  /** The pill that stands for it among the active pills. */
  pill: string;
  /** Its key's name in the keychain; a local server has none. */
  secret: string | null;
  /** Runs on the user's own machine (Ollama, LM Studio). */
  local: boolean;
}

export const PROVIDERS: Record<ChatProvider, ProviderDef> = {
  anthropic: { name: "Anthropic", accent: "#E07950", pill: "ai_anthropic", secret: "anthropic-api-key", local: false },
  google: { name: "Google", accent: "#4285F4", pill: "ai_google", secret: "google-api-key", local: false },
  openai: { name: "OpenAI", accent: "#10A37F", pill: "ai_openai", secret: "openai-api-key", local: false },
  ollama: { name: "Ollama", accent: "#FACC15", pill: "ai_ollama", secret: null, local: true },
  lmstudio: { name: "LM Studio", accent: "#A3E635", pill: "ai_lmstudio", secret: null, local: true },
};

/** In the order the picker shows them. */
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ChatProvider[];

/** The provider a pill stands for, or null for any other pill. */
export function providerOfPill(pill: string): ChatProvider | null {
  return PROVIDER_IDS.find((id) => PROVIDERS[id].pill === pill) ?? null;
}

/** Where a local server is, as it was connected in the settings window; empty until then. */
export function serverUrl(settings: Settings, provider: ChatProvider): string {
  return provider === "ollama" ? settings.ollamaServerUrl : provider === "lmstudio" ? settings.lmstudioServerUrl : "";
}

/** The model chosen for a provider — for the one the chat talks to, unless said otherwise. */
export function chatModel(settings: Settings, provider: ChatProvider = settings.chatProvider): string {
  switch (provider) {
    case "anthropic": return settings.model;
    case "google": return settings.googleChatModel;
    case "openai": return settings.openaiChatModel;
    case "ollama": return settings.ollamaChatModel;
    case "lmstudio": return settings.lmstudioChatModel;
  }
}

export function setChatModel(settings: Settings, provider: ChatProvider, model: string) {
  switch (provider) {
    case "anthropic": settings.model = model; break;
    case "google": settings.googleChatModel = model; break;
    case "openai": settings.openaiChatModel = model; break;
    case "ollama": settings.ollamaChatModel = model; break;
    case "lmstudio": settings.lmstudioChatModel = model; break;
  }
}

/**
 * The model a provider falls back on when the one chosen is not in its list:
 * the family each is best started on, else the first it offers.
 */
const PREFERRED: Partial<Record<ChatProvider, string>> = { anthropic: "sonnet", google: "flash", openai: "mini" };

export function fallbackModel(provider: ChatProvider, models: { id: string }[]): string | null {
  const family = PREFERRED[provider];
  return (family ? models.find((m) => m.id.includes(family)) : null)?.id ?? models[0]?.id ?? null;
}
