// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::providers::Provider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// GitHub projects ("owner/name") whose news the pill keeps to itself: a
    /// project not listed here speaks up, so a new one does by default.
    #[serde(default)]
    pub github_muted: Vec<String>,
    /// The island unfolds for a moment on each new song Spotify plays. On until
    /// switched off, and absent from a settings.json written before it existed.
    #[serde(default = "yes")]
    pub announce_songs: bool,
    /// The island stays away while an app has the whole display, and only a
    /// request waiting for an answer brings it out. On until switched off.
    #[serde(default = "yes")]
    pub hide_in_fullscreen: bool,
    /// Who the chat talks to, picked in the chat itself, and the model chosen
    /// for each provider (Anthropic's is `model`). All absent from a
    /// settings.json written before the chat had more than one.
    #[serde(default)]
    pub chat_provider: Provider,
    #[serde(default = "default_google_model")]
    pub google_chat_model: String,
    #[serde(default = "default_openai_model")]
    pub openai_chat_model: String,
    #[serde(default = "default_ollama_model")]
    pub ollama_chat_model: String,
    #[serde(default = "default_lmstudio_model")]
    pub lmstudio_chat_model: String,
    /// Where the local model servers are, once connected in the settings
    /// window; empty until then. Addresses, not secrets.
    #[serde(default)]
    pub ollama_server_url: String,
    #[serde(default)]
    pub lmstudio_server_url: String,
}

// The models a provider starts on, as on macOS (ChatProvider.defaultModel).
fn default_google_model() -> String {
    "gemini-2.0-flash".to_string()
}

fn default_openai_model() -> String {
    "gpt-4o".to_string()
}

fn default_ollama_model() -> String {
    "llama3.2".to_string()
}

fn default_lmstudio_model() -> String {
    "local-model".to_string()
}

fn yes() -> bool {
    true
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            github_muted: Vec::new(),
            announce_songs: true,
            hide_in_fullscreen: true,
            chat_provider: Provider::default(),
            google_chat_model: default_google_model(),
            openai_chat_model: default_openai_model(),
            ollama_chat_model: default_ollama_model(),
            lmstudio_chat_model: default_lmstudio_model(),
            ollama_server_url: String::new(),
            lmstudio_server_url: String::new(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
