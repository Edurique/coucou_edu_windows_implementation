// Two pills that need no key and no account: what Spotify is playing, and how
// many WhatsApp messages are unread. Both are read from window titles, which
// is local, instant and asks nothing of anybody:
//
//   * the Spotify desktop app titles its main window "Artist - Title" while
//     something plays, and "Spotify" (or "Spotify Premium"…) when nothing does.
//     Its window has the class every Chromium window has, so it is known by
//     the program it belongs to;
//   * WhatsApp Web titles its tab "(3) WhatsApp" with the unread count, and a
//     browser window carries the title of the tab it shows.
//
// That is also where they stop. Spotify in a browser is not seen. WhatsApp is
// counted only while its tab is the one a browser window shows, and the
// desktop app says "WhatsApp" with no count: the pill then knows it is open,
// not what is unread. Nothing is read but titles — never a message, never a
// contact — and nothing here touches the network.
//
// The idea is corefusiion's (Louis-CFM/coucou#80); this is written for this
// tree and its rules.

use serde::Serialize;
use windows::core::BOOL;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK,
    VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};

/// The Spotify desktop app's program, as the end of its path.
const SPOTIFY_EXE: &str = r"\spotify.exe";
/// What a WhatsApp window's title is, after its count if it has one.
const WHATSAPP: &str = "WhatsApp";
/// Longest window title and program path read, in UTF-16 units.
const TITLE_UNITS: usize = 512;
const PATH_UNITS: usize = 1024;

/// A visible top-level window: the process it belongs to, and what it says.
struct Window {
    pid: u32,
    title: String,
}

unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
    // SAFETY: `out` is the Vec `windows()` passed, alive for the whole call.
    let windows = unsafe { &mut *(out.0 as *mut Vec<Window>) };
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        let mut title = [0u16; TITLE_UNITS];
        let len = unsafe { GetWindowTextW(hwnd, &mut title) };
        if len > 0 {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            windows.push(Window { pid, title: String::from_utf16_lossy(&title[..len as usize]) });
        }
    }
    true.into()
}

/// Every visible window that has a title.
fn windows() -> Vec<Window> {
    let mut found: Vec<Window> = Vec::new();
    // SAFETY: the callback only runs during this call, on this thread.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut found as *mut Vec<Window> as isize)) };
    found
}

/// The path of the program a process runs, lowercased. None when it cannot be
/// asked — a process of another user, or one that is gone.
fn program_of(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed before returning; the buffer is ours.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = [0u16; PATH_UNITS];
        let mut len = path.len() as u32;
        let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        named.ok()?;
        Some(String::from_utf16_lossy(&path[..len as usize]).to_lowercase())
    }
}

/// What Spotify is playing. `open` is false when the app is not running.
#[derive(Serialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub open: bool,
    pub playing: bool,
    pub artist: String,
    pub title: String,
}

/// "Artist - Title" while something plays. The app's own name — "Spotify",
/// "Spotify Premium", "Spotify Free" — is what it says when nothing does, and
/// "Advertisement" is not a song.
fn track_of(title: &str) -> Option<(String, String)> {
    // A hyphen, or the en dash some versions use.
    let (artist, track) = [" - ", " \u{2013} "].iter().find_map(|sep| title.split_once(sep))?;
    let (artist, track) = (artist.trim(), track.trim());
    let named = !artist.is_empty() && !track.is_empty() && !artist.starts_with("Spotify") && track != "Advertisement";
    named.then(|| (artist.to_string(), track.to_string()))
}

pub fn now_playing() -> NowPlaying {
    let spotify = |w: &Window| program_of(w.pid).is_some_and(|path| path.ends_with(SPOTIFY_EXE));
    let Some(window) = windows().into_iter().find(spotify) else {
        return NowPlaying::default();
    };
    match track_of(&window.title) {
        Some((artist, title)) => NowPlaying { open: true, playing: true, artist, title },
        None => NowPlaying { open: true, ..NowPlaying::default() },
    }
}

/// WhatsApp, as far as a window title tells: whether it is open, and how many
/// messages are unread when the title says so.
#[derive(Serialize, Clone, Copy, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhatsApp {
    pub open: bool,
    pub unread: u32,
}

/// The unread count a WhatsApp window's title carries: "(3) WhatsApp" is 3,
/// "WhatsApp" is 0 — and anything else is not WhatsApp. What follows the name
/// is the browser's ("… - Google Chrome").
fn unread_of(title: &str) -> Option<u32> {
    let title = title.trim_start();
    let (count, rest) = match title.strip_prefix('(').and_then(|rest| rest.split_once(')')) {
        Some((count, rest)) => (count.trim().parse::<u32>().ok()?, rest.trim_start()),
        None => (0, title),
    };
    let after = rest.strip_prefix(WHATSAPP)?;
    // "WhatsApp" itself, not a word that starts with it.
    after.chars().next().is_none_or(|c| !c.is_alphanumeric()).then_some(count)
}

pub fn whatsapp() -> WhatsApp {
    let counts: Vec<u32> = windows().iter().filter_map(|w| unread_of(&w.title)).collect();
    // The highest: two windows on the same account must not count twice.
    WhatsApp { open: !counts.is_empty(), unread: counts.into_iter().max().unwrap_or(0) }
}

/// Presses one of the keyboard's media keys. It goes to whatever is playing —
/// the Spotify app, a browser tab — exactly as the key on a keyboard would.
pub fn press(action: &str) -> Result<(), String> {
    let key = match action {
        "toggle" => VK_MEDIA_PLAY_PAUSE,
        "next" => VK_MEDIA_NEXT_TRACK,
        "previous" => VK_MEDIA_PREV_TRACK,
        _ => return Err("unknown media key".into()),
    };
    let stroke = |up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key.0),
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let strokes = [stroke(false), stroke(true)];
    // SAFETY: a plain array of INPUT, with its real size.
    let sent = unsafe { SendInput(&strokes, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == strokes.len() { Ok(()) } else { Err("the media key was not delivered".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spotify_title_is_a_song_only_while_one_plays() {
        assert_eq!(track_of("Daft Punk - Around the World"), Some(("Daft Punk".into(), "Around the World".into())));
        assert_eq!(track_of("Sigur R\u{f3}s \u{2013} Hopp\u{ed}polla"), Some(("Sigur R\u{f3}s".into(), "Hopp\u{ed}polla".into())));
        // A title with a dash of its own keeps it.
        assert_eq!(track_of("AC/DC - Back in Black - Remastered"), Some(("AC/DC".into(), "Back in Black - Remastered".into())));
        // Idle, paused, or an ad: nothing is playing.
        assert_eq!(track_of("Spotify Premium"), None);
        assert_eq!(track_of("Spotify"), None);
        assert_eq!(track_of("Spotify - Advertisement"), None);
        assert_eq!(track_of("Some Brand - Advertisement"), None);
    }

    #[test]
    fn a_whatsapp_title_says_how_many_are_unread() {
        assert_eq!(unread_of("(3) WhatsApp"), Some(3));
        assert_eq!(unread_of("(12) WhatsApp - Google Chrome"), Some(12));
        assert_eq!(unread_of("WhatsApp"), Some(0));
        assert_eq!(unread_of("WhatsApp \u{2014} Mozilla Firefox"), Some(0));
        // Not WhatsApp: another window, a word that only starts like it, a count that is not one.
        assert_eq!(unread_of("(3) Inbox - Mail"), None);
        assert_eq!(unread_of("WhatsApps export.txt - Notepad"), None);
        assert_eq!(unread_of("Notes about WhatsApp"), None);
        assert_eq!(unread_of("(draft) WhatsApp"), None);
    }
}
