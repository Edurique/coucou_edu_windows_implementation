// Claude plan usage — the 5-hour and weekly limits Claude Code reports to its
// status line, as ClaudePlanGauge.swift reads them.
//
// Claude Code runs the status line command after each reply and hands it a JSON
// with `rate_limits`. Coucou's relay (`coucou-hook --statusline`) forwards those
// here, then runs the status line the user had before, so theirs still shows.
// Nothing is asked of Anthropic: this only reads what Claude Code already has.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::settings;

/// What marks a relay payload as a status line's, not a hook event's.
pub const KIND: &str = "statusline";
/// The island hears of new figures on this event.
const EVENT: &str = "plan-usage";
/// A percentage past this is not a percentage.
const MAX_RAW_PCT: f64 = 200.0;
/// A reset further away than this is a time in milliseconds, not seconds.
const MAX_RESET_AHEAD_SECS: f64 = 400.0 * 86_400.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    /// 0–100.
    pub used_pct: f64,
    /// Unix seconds.
    pub resets_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub five_hour: Option<PlanWindow>,
    pub seven_day: Option<PlanWindow>,
    /// Unix milliseconds: when Claude Code last said so.
    pub updated_at: u64,
}

/// The last figures heard, kept so an island that just loaded has them.
static LAST: Mutex<Option<PlanUsage>> = Mutex::new(None);

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// `rate_limits` of a status line payload. None when absent or malformed.
pub fn parse(payload: &Value, now: f64) -> Option<PlanUsage> {
    let limits = payload.get("rate_limits")?.as_object()?;
    let five_hour = parse_window(limits.get("five_hour"), now);
    let seven_day = parse_window(limits.get("seven_day"), now);
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(PlanUsage { five_hour, seven_day, updated_at: (now * 1000.0) as u64 })
}

fn parse_window(raw: Option<&Value>, now: f64) -> Option<PlanWindow> {
    let window = raw?.as_object()?;
    let raw_pct = window.get("used_percentage")?.as_f64()?;
    if !(0.0..=MAX_RAW_PCT).contains(&raw_pct) {
        return None;
    }
    let resets_at = window.get("resets_at")?.as_f64()?;
    if resets_at <= 0.0 || resets_at > now + MAX_RESET_AHEAD_SECS {
        return None;
    }
    // Over the limit is still the limit.
    Some(PlanWindow { used_pct: raw_pct.min(100.0), resets_at })
}

/// Where the last figures are kept between two runs of the app.
fn store_path() -> PathBuf {
    settings::local_dir().join("plan-usage.json")
}

/// A status line payload from the relay: no session, no reveal, no sound —
/// the island's gauge takes the new figures, and that is all.
pub fn receive(app: &AppHandle, payload: &Value) {
    let Some(usage) = parse(payload, now_secs()) else { return };
    if let Ok(json) = serde_json::to_vec(&usage) {
        let _ = std::fs::write(store_path(), json);
    }
    *LAST.lock().unwrap() = Some(usage.clone());
    let _ = app.emit_to(WINDOW_LABEL, EVENT, usage);
}

/// The last figures heard — in this run, or the one before.
pub fn last() -> Option<PlanUsage> {
    let mut last = LAST.lock().unwrap();
    if last.is_none() {
        *last = std::fs::read(store_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    }
    last.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: f64 = 1_800_000_000.0;

    #[test]
    fn both_windows_are_read() {
        let payload = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 42.5, "resets_at": NOW + 3600.0 },
            "seven_day": { "used_percentage": 7, "resets_at": NOW + 86_400.0 },
        }});
        let usage = parse(&payload, NOW).unwrap();
        assert_eq!(usage.five_hour, Some(PlanWindow { used_pct: 42.5, resets_at: NOW + 3600.0 }));
        assert_eq!(usage.seven_day, Some(PlanWindow { used_pct: 7.0, resets_at: NOW + 86_400.0 }));
        assert_eq!(usage.updated_at, (NOW * 1000.0) as u64);
    }

    #[test]
    fn one_window_is_enough_and_none_is_nothing() {
        let one = json!({ "rate_limits": { "five_hour": { "used_percentage": 10, "resets_at": NOW + 60.0 } } });
        let usage = parse(&one, NOW).unwrap();
        assert!(usage.five_hour.is_some() && usage.seven_day.is_none());
        assert_eq!(parse(&json!({ "rate_limits": {} }), NOW), None);
        assert_eq!(parse(&json!({}), NOW), None);
        assert_eq!(parse(&json!({ "rate_limits": "soon" }), NOW), None);
    }

    #[test]
    fn over_the_limit_is_the_limit_and_nonsense_is_refused() {
        let window = |pct: f64| json!({ "rate_limits": { "five_hour": { "used_percentage": pct, "resets_at": NOW + 60.0 } } });
        assert_eq!(parse(&window(150.0), NOW).unwrap().five_hour.unwrap().used_pct, 100.0);
        assert_eq!(parse(&window(200.0), NOW).unwrap().five_hour.unwrap().used_pct, 100.0);
        assert_eq!(parse(&window(201.0), NOW), None);
        assert_eq!(parse(&window(-1.0), NOW), None);
    }

    #[test]
    fn a_reset_in_milliseconds_or_missing_is_refused() {
        let at = |resets: Value| json!({ "rate_limits": { "seven_day": { "used_percentage": 10, "resets_at": resets } } });
        assert_eq!(parse(&at(json!(NOW * 1000.0)), NOW), None);
        assert_eq!(parse(&at(json!(0)), NOW), None);
        assert_eq!(parse(&at(json!("tomorrow")), NOW), None);
        assert!(parse(&at(json!(NOW + 399.0 * 86_400.0)), NOW).is_some());
    }
}
