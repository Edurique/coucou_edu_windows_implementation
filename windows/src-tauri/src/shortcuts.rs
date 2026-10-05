// The shortcuts that work from any app — port of ShortcutLogic.swift and
// HotKeyCenter.swift. The table of actions and their default keys lives here;
// the keys the user changed live in settings.json; the system side is the
// platform's (RegisterHotKey on Windows).
//
// A key is a Windows virtual-key code and the modifiers Win32's MOD_* bits,
// which is what the settings window records and what the system is asked for.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::platform;

pub const ALT: u32 = 1;
pub const CTRL: u32 = 2;
pub const SHIFT: u32 = 4;
pub const WIN: u32 = 8;
const MODIFIERS: u32 = ALT | CTRL | SHIFT | WIN;
/// The Mac's ⌃⌥, which most of its shortcuts are on.
const CTRL_ALT: u32 = CTRL | ALT;

/// The event the island receives when one is pressed, with the action's name.
const EVENT: &str = "shortcut";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    /// Windows virtual-key code.
    pub vk: u32,
    /// ALT | CTRL | SHIFT | WIN.
    pub mods: u32,
    pub enabled: bool,
}

struct Action {
    /// The Mac's own name for it (ShortcutAction's raw value).
    id: &'static str,
    default: Shortcut,
}

const fn action(id: &'static str, vk: u32, enabled: bool) -> Action {
    Action { id, default: Shortcut { vk, mods: CTRL_ALT, enabled } }
}

const VK_SPACE: u32 = 0x20;
const VK_LEFT: u32 = 0x25;
const VK_RIGHT: u32 = 0x27;

/// The Mac's table, on Ctrl+Alt for its ⌃⌥, with three differences. Opening
/// the island is on Ctrl+Alt+N — ⌘⇧N would be Ctrl+Shift+N here, which every
/// browser and the Explorer already use — and stays off until switched on, as
/// on the Mac. The pills are on the arrows rather than on [ and ]: those two
/// are typed with AltGr on many keyboards, and AltGr is Ctrl+Alt, so taking
/// them would take the characters away. And attaching the front window is not
/// here: this version does not attach windows.
const ACTIONS: [Action; 9] = [
    action("toggleIsland", b'N' as u32, false),
    action("openChat", VK_SPACE, true),
    action("goToAlert", b'A' as u32, true),
    action("jumpToTerminal", b'T' as u32, true),
    action("nextPill", VK_RIGHT, true),
    action("prevPill", VK_LEFT, true),
    action("muteToggle", b'M' as u32, true),
    action("desktopToggle", b'D' as u32, true),
    action("wardrobeToggle", b'G' as u32, true),
];

/// Each action with the keys it is on: the user's when they changed them.
fn resolved(overrides: &BTreeMap<String, Shortcut>) -> Vec<(&'static str, Shortcut)> {
    ACTIONS.iter().map(|a| (a.id, overrides.get(a.id).copied().unwrap_or(a.default))).collect()
}

/// The actions that share their keys with another one.
fn duplicates(keys: &[(&'static str, Shortcut)]) -> HashSet<&'static str> {
    let mut seen: HashMap<(u32, u32), &'static str> = HashMap::new();
    let mut twice = HashSet::new();
    for (id, key) in keys {
        if let Some(other) = seen.insert((key.vk, key.mods), id) {
            twice.insert(*id);
            twice.insert(other);
        }
    }
    twice
}

/// A shortcut with no modifier would take the key itself away from every app.
fn usable(key: &Shortcut) -> bool {
    key.enabled && key.mods & MODIFIERS != 0 && key.vk != 0
}

/// The actions the system refused at the last registration: their keys are
/// another app's.
static REFUSED: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Registers what is switched on, and remembers what the system refused.
pub fn apply(app: &AppHandle, overrides: &BTreeMap<String, Shortcut>) {
    let keys = resolved(overrides);
    let twice = duplicates(&keys);
    // Two actions on the same keys: neither is registered, the settings say why.
    let wanted: Vec<(i32, u32, u32)> = keys
        .iter()
        .enumerate()
        .filter(|(_, (id, key))| usable(key) && !twice.contains(id))
        .map(|(i, (_, key))| (i as i32, key.vk, key.mods))
        .collect();
    let app = app.clone();
    let refused = platform::set_hotkeys(wanted, move |index| {
        if let Some(action) = ACTIONS.get(index as usize) {
            let _ = app.emit(EVENT, action.id);
        }
    });
    *REFUSED.lock().unwrap() = refused.iter().filter_map(|i| ACTIONS.get(*i as usize)).map(|a| a.id).collect();
}

/// One line of the settings' list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutState {
    pub action: &'static str,
    pub vk: u32,
    pub mods: u32,
    pub enabled: bool,
    pub is_default: bool,
    /// "duplicate": another action of Coucou's is on the same keys. "taken":
    /// another app has them. None when it works.
    pub conflict: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    /// False where the system gives no shortcuts to register (Linux).
    pub supported: bool,
    pub items: Vec<ShortcutState>,
}

pub fn list(overrides: &BTreeMap<String, Shortcut>) -> Shortcuts {
    let keys = resolved(overrides);
    let twice = duplicates(&keys);
    let refused = REFUSED.lock().unwrap().clone();
    let items = ACTIONS
        .iter()
        .zip(&keys)
        .map(|(action, (id, key))| ShortcutState {
            action: id,
            vk: key.vk,
            mods: key.mods,
            enabled: key.enabled,
            is_default: *key == action.default,
            conflict: if twice.contains(id) {
                Some("duplicate")
            } else if usable(key) && refused.contains(id) {
                Some("taken")
            } else {
                None
            },
        })
        .collect();
    Shortcuts { supported: platform::GLOBAL_HOTKEYS, items }
}

/// Puts an action on new keys, or back on its own (`key` None). False for a
/// name that is no action.
pub fn set(overrides: &mut BTreeMap<String, Shortcut>, action: &str, key: Option<Shortcut>) -> bool {
    let Some(known) = ACTIONS.iter().find(|a| a.id == action) else { return false };
    match key {
        // Back on its default: nothing to keep in settings.json.
        Some(key) if key != known.default => {
            overrides.insert(known.id.to_string(), key);
        }
        _ => {
            overrides.remove(known.id);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_stand_until_changed() {
        let mut overrides = BTreeMap::new();
        let keys = resolved(&overrides);
        assert_eq!(keys.len(), ACTIONS.len());
        assert!(duplicates(&keys).is_empty());
        // The island's own shortcut is off until asked for, as on the Mac.
        assert_eq!(keys[0], ("toggleIsland", Shortcut { vk: b'N' as u32, mods: CTRL_ALT, enabled: false }));
        assert!(keys[1..].iter().all(|(_, key)| key.enabled));

        let other = Shortcut { vk: b'J' as u32, mods: CTRL | SHIFT, enabled: true };
        assert!(set(&mut overrides, "openChat", Some(other)));
        assert_eq!(resolved(&overrides)[1], ("openChat", other));
        // Back on its own keys: nothing is kept.
        assert!(set(&mut overrides, "openChat", Some(ACTIONS[1].default)));
        assert!(overrides.is_empty());
        assert!(set(&mut overrides, "openChat", Some(other)) && set(&mut overrides, "openChat", None));
        assert!(overrides.is_empty());
        assert!(!set(&mut overrides, "attachFrontWindow", Some(other)));
    }

    #[test]
    fn the_same_keys_twice_are_a_conflict() {
        let mut overrides = BTreeMap::new();
        set(&mut overrides, "muteToggle", Some(Shortcut { vk: b'G' as u32, mods: CTRL_ALT, enabled: true }));
        let twice = duplicates(&resolved(&overrides));
        assert_eq!(twice, HashSet::from(["muteToggle", "wardrobeToggle"]));
        let listed = list(&overrides);
        let conflict = |id: &str| listed.items.iter().find(|s| s.action == id).unwrap().conflict;
        assert_eq!(conflict("muteToggle"), Some("duplicate"));
        assert_eq!(conflict("wardrobeToggle"), Some("duplicate"));
        assert_eq!(conflict("openChat"), None);
        assert!(!listed.items.iter().find(|s| s.action == "muteToggle").unwrap().is_default);
    }

    #[test]
    fn a_key_alone_is_never_taken() {
        assert!(!usable(&Shortcut { vk: b'A' as u32, mods: 0, enabled: true }));
        assert!(!usable(&Shortcut { vk: b'A' as u32, mods: CTRL, enabled: false }));
        assert!(usable(&Shortcut { vk: b'A' as u32, mods: WIN, enabled: true }));
    }
}
