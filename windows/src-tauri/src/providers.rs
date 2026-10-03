// Who the chat talks to — the ChatProvider of IslandTypes.swift, and the
// OpenAI-compatible half of ClaudeService.swift: Google, OpenAI, and the local
// servers (Ollama, LM Studio). Anthropic's own API is in claude.rs.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::claude::{self, Chat, ChatContext, ChatReply};
use crate::island::WINDOW_LABEL;
use crate::local_chat::{self, LocalError};
use crate::secrets;
use crate::settings::Settings;

/// How long a list of models may take, and an answer that does not stream.
const MODELS_TIMEOUT: Duration = Duration::from_secs(10);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest answer asked for.
const MAX_TOKENS: u32 = 4096;
/// How much of a dropped text file a local model is given.
const MAX_LOCAL_FILE_CHARS: usize = 24_000;
/// Files that are not text: a local model is only told their name.
const BINARY_EXTENSIONS: &[&str] = &["pdf", "jpg", "jpeg", "png", "gif", "webp"];
/// The island hears what an answer says so far on this event while it streams.
pub const STREAM_EVENT: &str = "chat-stream";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Anthropic,
    Google,
    Openai,
    Ollama,
    Lmstudio,
}

/// A model a provider offers: what it is asked for by, and what it is shown as.
#[derive(Debug, Clone, Serialize)]
pub struct Model {
    pub id: String,
    pub label: String,
}

impl Provider {
    pub fn display_name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Google => "Google",
            Provider::Openai => "OpenAI",
            Provider::Ollama => "Ollama",
            Provider::Lmstudio => "LM Studio",
        }
    }

    pub fn is_local(self) -> bool {
        matches!(self, Provider::Ollama | Provider::Lmstudio)
    }

    /// The key it needs, by its name in the keychain; a local server needs none.
    pub fn secret(self) -> Option<&'static str> {
        match self {
            Provider::Anthropic => Some(claude::KEY),
            Provider::Google => Some("google-api-key"),
            Provider::Openai => Some("openai-api-key"),
            Provider::Ollama | Provider::Lmstudio => None,
        }
    }

    /// Where a local server is, as the user connected it; empty when they have not.
    fn server(self, settings: &Settings) -> String {
        match self {
            Provider::Ollama => local_chat::normalise_url(&settings.ollama_server_url),
            Provider::Lmstudio => local_chat::normalise_url(&settings.lmstudio_server_url),
            _ => String::new(),
        }
    }

    /// The model chosen for it.
    pub fn model(self, settings: &Settings) -> String {
        match self {
            Provider::Anthropic => settings.model.clone(),
            Provider::Google => settings.google_chat_model.clone(),
            Provider::Openai => settings.openai_chat_model.clone(),
            Provider::Ollama => settings.ollama_chat_model.clone(),
            Provider::Lmstudio => settings.lmstudio_chat_model.clone(),
        }
    }
}

const GOOGLE_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE: &str = "https://api.openai.com/v1";
/// Model families that are not for chatting.
const GOOGLE_NOT_CHAT: &[&str] = &["embed", "imagen", "veo", "aqa", "tts", "audio", "live"];
const OPENAI_NOT_CHAT: &[&str] = &[
    "embed", "tts", "whisper", "dall-e", "audio", "realtime", "moderat", "codex", "computer-use",
    "transcribe", "image", "sora", "babbage", "davinci", "instruct",
];

// ── Model lists ───────────────────────────────────────────────────────────────

/// The models a provider offers, for the picker in the chat. An error is what
/// the picker says in the list's place.
pub async fn models(provider: Provider, settings: &Settings) -> Result<Vec<Model>, String> {
    if provider.is_local() {
        let name = provider.display_name();
        let base = provider.server(settings);
        if base.is_empty() {
            return Err(format!("Connect {name} in Settings → Chat first."));
        }
        return match local_chat::fetch_models(&base).await {
            Ok(models) if models.is_empty() => Err(format!("No models yet. Download one in {name} first.")),
            Ok(models) => Ok(models),
            Err(_) => Err(format!("Cannot reach {base}. Is the server running?")),
        };
    }
    let key = provider
        .secret()
        .and_then(secrets::get)
        .ok_or_else(|| "No API key — add it in Settings.".to_string())?;
    let models = match provider {
        Provider::Anthropic => claude::fetch_models(&key).await,
        Provider::Google => fetch_google_models(&key).await,
        Provider::Openai => fetch_openai_models(&key).await,
        Provider::Ollama | Provider::Lmstudio => Vec::new(),
    };
    if models.is_empty() {
        return Err("Failed to load models. Check your API key.".to_string());
    }
    Ok(models)
}

/// The `data` array of a models endpoint that takes a bearer key; empty on any error.
async fn bearer_models(url: &str, key: &str) -> Vec<Value> {
    let Ok(client) = reqwest::Client::builder().timeout(MODELS_TIMEOUT).build() else { return Vec::new() };
    let Ok(response) = client.get(url).header("Authorization", format!("Bearer {key}")).send().await else {
        return Vec::new();
    };
    if response.status().as_u16() != 200 {
        return Vec::new();
    }
    let Ok(json) = response.json::<Value>().await else { return Vec::new() };
    json.get("data").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn is_chat_model(id: &str, excluded: &[&str]) -> bool {
    let lower = id.to_lowercase();
    !excluded.iter().any(|word| lower.contains(word))
}

/// Gemini's models, through the OpenAI-compatible endpoint, without the
/// "models/" the API sometimes puts in front of their names.
async fn fetch_google_models(key: &str) -> Vec<Model> {
    bearer_models(&format!("{GOOGLE_BASE}/models"), key)
        .await
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(|raw| raw.strip_prefix("models/").unwrap_or(raw))
        .filter(|id| is_chat_model(id, GOOGLE_NOT_CHAT))
        .map(|id| Model { id: id.to_string(), label: id.to_string() })
        .collect()
}

/// OpenAI's chat models, the newest first.
async fn fetch_openai_models(key: &str) -> Vec<Model> {
    let mut found: Vec<(String, i64)> = bearer_models(&format!("{OPENAI_BASE}/models"), key)
        .await
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?;
            is_chat_model(id, OPENAI_NOT_CHAT)
                .then(|| (id.to_string(), item.get("created").and_then(Value::as_i64).unwrap_or(0)))
        })
        .collect();
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.into_iter().map(|(id, _)| Model { label: id.clone(), id }).collect()
}

// ── Connecting a local server ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LocalServer {
    /// The address as it is kept: without a trailing slash or a doc path.
    pub url: String,
    /// How many chat models it has.
    pub models: usize,
}

/// Settings → Chat → Connect: checks the server answers and has a model before
/// its address is kept. An empty address is the server's usual one.
pub async fn connect_local(provider: Provider, raw: &str) -> Result<LocalServer, String> {
    let name = provider.display_name();
    let candidate = if raw.trim().is_empty() { default_server(provider) } else { raw };
    let url = local_chat::normalise_url(candidate);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http:// and https:// URLs are supported.".to_string());
    }
    match local_chat::fetch_models(&url).await {
        Ok(models) if models.is_empty() => Err(format!("No models yet — download one in {name} first.")),
        Ok(models) => Ok(LocalServer { url, models: models.len() }),
        Err(_) => Err(format!("Couldn't reach {name} at {url}. Is it running?")),
    }
}

/// Where each local server listens when nothing was changed.
pub fn default_server(provider: Provider) -> &'static str {
    match provider {
        Provider::Lmstudio => "http://127.0.0.1:1234",
        _ => "http://127.0.0.1:11434",
    }
}

// ── A chat turn ───────────────────────────────────────────────────────────────

/// One chat turn with anything but Anthropic. A local server streams its
/// answer: the island hears it grow on `STREAM_EVENT`, then gets the whole.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    provider: Provider,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let name = provider.display_name();
    let (base, authorization) = if provider.is_local() {
        let base = provider.server(settings);
        if base.is_empty() {
            return Err(format!("Connect {name} in Settings → Chat first."));
        }
        (format!("{base}/v1"), local_chat::AUTHORIZATION.to_string())
    } else {
        let key = provider
            .secret()
            .and_then(secrets::get)
            .ok_or_else(|| format!("{name} API key missing. Configure it in Settings."))?;
        let base = if provider == Provider::Google { GOOGLE_BASE } else { OPENAI_BASE };
        (base.to_string(), format!("Bearer {key}"))
    };

    // What was said so far, as plain text: these APIs take a string per message.
    let mut messages = vec![json!({ "role": "system", "content": claude::system_prompt() })];
    for message in chat.snapshot() {
        let mut simplified = message.clone();
        if let Some(text) = message
            .get("content")
            .and_then(Value::as_array)
            .and_then(|blocks| blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("text")))
            .and_then(|block| block.get("text").and_then(Value::as_str))
        {
            simplified["content"] = json!(text);
        }
        messages.push(simplified);
    }

    // File and window context rides along with the first message only.
    let mut text = query.clone();
    if chat.is_empty() {
        match &context {
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut prefix = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    prefix.push_str(&format!(", URL: {url}"));
                }
                text = format!("{prefix}\n\n{query}");
            }
            Some(ChatContext::File { name, path }) => {
                text = match provider.is_local().then(|| local_file_text(path)).flatten() {
                    Some(contents) => format!("File: {name}\n\n{contents}\n\n{query}"),
                    None => format!("File: {name}\n\n{query}"),
                };
            }
            None => {}
        }
    }
    let turn = json!({ "role": "user", "content": text });
    messages.push(turn.clone());
    chat.push(turn);

    let model = provider.model(settings);
    let result = if provider.is_local() {
        let body = json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_TOKENS });
        let base = provider.server(settings);
        local_chat::stream_chat(&base, &body, &model, |visible| {
            let _ = app.emit_to(WINDOW_LABEL, STREAM_EVENT, visible);
        })
        .await
        .map_err(|err| match err {
            LocalError::Unreachable if provider == Provider::Ollama => {
                "Ollama isn't running. Open it, then ask again.".to_string()
            }
            LocalError::Unreachable => "Start the local server in LM Studio, then ask again.".to_string(),
            LocalError::ModelNotFound(m) => format!("{m} isn't installed. Pick another model above the chat box."),
            LocalError::Server(message) => message,
        })
    } else {
        let body = json!({ "model": model, "max_tokens": MAX_TOKENS, "messages": messages });
        complete(&format!("{base}/chat/completions"), &authorization, &body).await
    };

    match result {
        Ok(answer) => {
            chat.push(json!({ "role": "assistant", "content": answer }));
            Ok(ChatReply { text: answer })
        }
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            Err(err)
        }
    }
}

/// A dropped text file's words, for a model that cannot be handed the file itself.
fn local_file_text(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path).extension()?.to_str()?.to_lowercase();
    if BINARY_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let text = std::fs::read_to_string(path).ok().filter(|t| !t.is_empty())?;
    Some(match text.char_indices().nth(MAX_LOCAL_FILE_CHARS) {
        Some((cut, _)) => format!("{}\n[truncated]", &text[..cut]),
        None => text,
    })
}

/// An answer that comes whole (Google, OpenAI).
async fn complete(url: &str, authorization: &str, body: &Value) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(ANSWER_TIMEOUT).build().map_err(|e| e.to_string())?;
    let response = client
        .post(url)
        .header("Authorization", authorization)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status().as_u16();
    let json: Value = response.json().await.unwrap_or(Value::Null);
    if status != 200 {
        return Err(json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {status}")));
    }
    json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .map(|content| content.trim().to_string())
        .ok_or_else(|| "Unexpected response format".to_string())
}
