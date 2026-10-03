// Local models (Ollama, LM Studio) through their OpenAI-compatible server —
// the same helpers as LocalChat.swift. No key: the server is on the user's
// own machine, at an address they typed.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::providers::Model;

/// What these servers want in place of a key.
pub const AUTHORIZATION: &str = "Bearer ollama";
/// How long a list of models may take, and a whole answer.
const MODELS_TIMEOUT: Duration = Duration::from_secs(5);
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);
/// The island is told of new text at most this often while an answer streams.
const MIN_UPDATE: Duration = Duration::from_millis(1000 / 15);
/// How much of an error's body is read to find its message.
const MAX_ERROR_BODY: usize = 4096;
/// Models a chat cannot be had with: embeddings, rerankers, image encoders.
const NOT_CHAT: &[&str] = &["embed", "bge-", "all-minilm", "clip", "rerank"];

pub enum LocalError {
    /// The server is not reachable (wrong URL, not running, network error).
    Unreachable,
    /// The model was asked for but is not installed on the server.
    ModelNotFound(String),
    /// The server replied with an error message.
    Server(String),
}

/// Removes trailing slashes and the sub-paths the docs show (`/api`, `/v1`).
pub fn normalise_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    for suffix in ["/api", "/v1"] {
        if let Some(cut) = s.strip_suffix(suffix) {
            s = cut.to_string();
        }
    }
    s
}

/// `delta.content` of one OpenAI-SSE line. None for a line that is not data,
/// for `[DONE]`, and for content that is missing or null.
pub fn parse_sse_delta(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data: ")?;
    if payload == "[DONE]" {
        return None;
    }
    let json: Value = serde_json::from_str(payload).ok()?;
    json.get("choices")?.get(0)?.get("delta")?.get("content")?.as_str().map(str::to_string)
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

/// Removes completed `<think>…</think>` blocks (reasoning models like DeepSeek-R1).
pub fn filter_thinking_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(THINK_OPEN) {
        let Some(len) = rest[start..].find(THINK_CLOSE) else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start + len + THINK_CLOSE.len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// For an answer still coming: closed think blocks removed, and what is inside
/// one that has not been closed yet kept out of sight.
pub fn progressive_filter(text: &str) -> String {
    let cleaned = filter_thinking_blocks(text);
    match cleaned.find(THINK_OPEN) {
        Some(open) => cleaned[..open].trim().to_string(),
        None => cleaned,
    }
}

/// The server's chat models (`GET /v1/models`). An empty list means the server
/// answered and has none; `Unreachable`, that it did not answer as one should.
pub async fn fetch_models(base_url: &str) -> Result<Vec<Model>, LocalError> {
    let client = reqwest::Client::builder().timeout(MODELS_TIMEOUT).build().map_err(|_| LocalError::Unreachable)?;
    let response = client
        .get(format!("{base_url}/v1/models"))
        .header("Authorization", AUTHORIZATION)
        .send()
        .await
        .map_err(|_| LocalError::Unreachable)?;
    if response.status().as_u16() != 200 {
        return Err(LocalError::Unreachable);
    }
    let json: Value = response.json().await.map_err(|_| LocalError::Unreachable)?;
    let items = json.get("data").and_then(Value::as_array).ok_or(LocalError::Unreachable)?;
    Ok(items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .filter(|id| {
            let lower = id.to_lowercase();
            !NOT_CHAT.iter().any(|word| lower.contains(word))
        })
        .map(|id| Model { id: id.to_string(), label: id.to_string() })
        .collect())
}

/// Sends a conversation and streams the reply. `on_text` gets what can be shown
/// so far each time there is more, a few times a second at most; what comes
/// back is the whole answer, thinking removed.
pub async fn stream_chat(
    base_url: &str,
    body: &Value,
    model: &str,
    mut on_text: impl FnMut(&str),
) -> Result<String, LocalError> {
    let client = reqwest::Client::builder().timeout(STREAM_TIMEOUT).build().map_err(|_| LocalError::Unreachable)?;
    let mut response = client
        .post(format!("{base_url}/v1/chat/completions"))
        .header("Authorization", AUTHORIZATION)
        .json(body)
        .send()
        .await
        .map_err(|_| LocalError::Unreachable)?;

    let status = response.status().as_u16();
    if status == 404 {
        return Err(LocalError::ModelNotFound(model.to_string()));
    }
    if status != 200 {
        let mut raw: Vec<u8> = Vec::new();
        while raw.len() <= MAX_ERROR_BODY {
            match response.chunk().await {
                Ok(Some(bytes)) => raw.extend_from_slice(&bytes),
                _ => break,
            }
        }
        let message = serde_json::from_slice::<Value>(&raw)
            .ok()
            .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string));
        return Err(LocalError::Server(message.unwrap_or_else(|| format!("HTTP {status}"))));
    }

    let mut accumulated = String::new();
    // Bytes, not text: a chunk may end in the middle of a character.
    let mut pending: Vec<u8> = Vec::new();
    let mut last_update: Option<Instant> = None;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(_) => return Err(LocalError::Unreachable),
        };
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(delta) = parse_sse_delta(line.trim_end_matches(['\r', '\n'])) else { continue };
            accumulated.push_str(&delta);
            if last_update.is_none_or(|at| at.elapsed() >= MIN_UPDATE) {
                last_update = Some(Instant::now());
                on_text(&progressive_filter(&accumulated));
            }
        }
    }
    // Always the last state, whatever the pace was.
    on_text(&progressive_filter(&accumulated));
    Ok(filter_thinking_blocks(&accumulated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_lose_their_trailing_slashes_and_doc_paths() {
        assert_eq!(normalise_url(" http://127.0.0.1:11434/ "), "http://127.0.0.1:11434");
        assert_eq!(normalise_url("http://localhost:1234/v1"), "http://localhost:1234");
        assert_eq!(normalise_url("http://localhost:11434/api/"), "http://localhost:11434");
        assert_eq!(normalise_url(""), "");
    }

    #[test]
    fn a_data_line_gives_its_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(parse_sse_delta(line).as_deref(), Some("Hel"));
    }

    #[test]
    fn other_lines_give_nothing() {
        assert_eq!(parse_sse_delta("data: [DONE]"), None);
        assert_eq!(parse_sse_delta(": keep-alive"), None);
        assert_eq!(parse_sse_delta(""), None);
        assert_eq!(parse_sse_delta(r#"data: {"choices":[{"delta":{"content":null}}]}"#), None);
        assert_eq!(parse_sse_delta(r#"data: {"choices":[{"delta":{}}]}"#), None);
        assert_eq!(parse_sse_delta("data: not json"), None);
    }

    #[test]
    fn closed_think_blocks_are_removed() {
        assert_eq!(filter_thinking_blocks("<think>hmm\nwell</think>\n\nHello"), "Hello");
        assert_eq!(filter_thinking_blocks("A<think>x</think>B<think>y</think>C"), "ABC");
        assert_eq!(filter_thinking_blocks("No thinking here"), "No thinking here");
    }

    #[test]
    fn an_open_think_block_stays_out_of_sight_while_streaming() {
        assert_eq!(progressive_filter("<think>still going"), "");
        assert_eq!(progressive_filter("Hi <think>wait"), "Hi");
        assert_eq!(progressive_filter("<think>done</think>Answer"), "Answer");
    }
}
