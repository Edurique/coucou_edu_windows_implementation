// Mochi on the desktop — the window side of DesktopMochi.swift: a small
// transparent window of his own that flies out of the island, is dragged about,
// lets the mouse through everywhere but on his body, and flies back.
//
// What he does there — when he leaves, when a request calls him back — is the
// island's to decide (src/island/desktop.ts); what he looks like is his own
// page's (src/desktop/main.ts). This only moves the window and says where the
// mouse is. Nothing here runs while he is in the island.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WebviewWindowBuilder};

use crate::{island, platform, settings};

pub const LABEL: &str = "mochi";
/// Side of his window, in logical pixels: DesktopMochiLogic.panelSize.
const PANEL: f64 = 120.0;
/// How far from a screen's edges he is kept.
const MARGIN: f64 = 24.0;
/// His body in the window: a disc of this share of its side.
const BODY_RADIUS: f64 = 0.24;
/// A flight between the island and his place.
const FLIGHT: Duration = Duration::from_millis(450);
/// The mouse and the window are looked at this often while he is out.
const TICK: Duration = Duration::from_millis(16);
/// A press that moves less than this is a click, not a drag (logical pixels).
const DRAG_SLOP: f64 = 3.0;

/// What the island is told (event `mochi`): he landed, he is home, his wardrobe is asked for.
const TO_ISLAND: &str = "mochi";
/// What his page may ask of the island.
const ASKS: [&str; 2] = ["wardrobe", "askHome"];

struct Drag {
    /// Where the cursor and the window were when it began.
    cursor: (f64, f64),
    origin: (i32, i32),
    moved: bool,
}

#[derive(Default)]
struct Live {
    /// He is out and the mouse is being watched.
    out: bool,
    /// A flight is under way: nothing else starts until it lands.
    flying: bool,
    drag: Option<Drag>,
}

static LIVE: Mutex<Live> = Mutex::new(Live { out: false, flying: false, drag: None });

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Created hidden at launch like the settings window (see create_settings_window):
/// a WebView2 window made later comes up blank in this app. Its page draws
/// nothing until it is shown.
pub fn create(app: &AppHandle) {
    if !platform::CURSOR_POLL {
        return;
    }
    let built = WebviewWindowBuilder::new(app, LABEL, crate::page_url(app, "mochi.html"))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Mochi")
        .inner_size(PANEL, PANEL)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(win) => {
            platform::make_non_activating(&win);
            let _ = win.set_ignore_cursor_events(true);
        }
        Err(err) => crate::log::line(format!("mochi window failed: {err}")),
    }
}

// ── Where things are ──────────────────────────────────────────────────────────

fn side(win: &WebviewWindow) -> f64 {
    PANEL * win.scale_factor().unwrap_or(1.0)
}

/// The island's top centre: where he leaves from and comes back to.
fn notch(app: &AppHandle, win: &WebviewWindow) -> (i32, i32) {
    let side = side(win);
    let Some(island) = island::window(app) else { return (0, 0) };
    let at = island.outer_position().unwrap_or_default();
    let size = island.outer_size().unwrap_or_default();
    (at.x + (size.width as f64 / 2.0 - side / 2.0).round() as i32, at.y)
}

/// A screen's work area in physical pixels, and its scale: (x, y, width, height, scale).
type Area = (f64, f64, f64, f64, f64);

/// The screens' work areas, the main one first.
fn work_areas(app: &AppHandle) -> Vec<Area> {
    let main = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let mut areas: Vec<(bool, Area)> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            let rect = (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64, m.scale_factor());
            (Some(*m.position()) == main, rect)
        })
        .collect();
    areas.sort_by_key(|(is_main, _)| !is_main);
    areas.into_iter().map(|(_, area)| area).collect()
}

/// Keeps his window inside the nearest work area, the margin from its edges.
/// On each screen he has that screen's size: its scale decides both.
fn clamp(origin: (f64, f64), side: f64, areas: &[Area]) -> (f64, f64) {
    let centre = (origin.0 + side / 2.0, origin.1 + side / 2.0);
    let nearest = areas.iter().min_by(|a, b| {
        let far = |r: &&Area| (centre.0 - (r.0 + r.2 / 2.0)).hypot(centre.1 - (r.1 + r.3 / 2.0));
        far(a).total_cmp(&far(b))
    });
    let Some(&(x, y, w, h, scale)) = nearest else { return origin };
    let (side, margin) = (PANEL * scale, MARGIN * scale);
    (
        origin.0.max(x + margin).min((x + w - side - margin).max(x + margin)),
        origin.1.max(y + margin).min((y + h - side - margin).max(y + margin)),
    )
}

/// Bottom right of the main screen, until he has a place of his own.
fn default_place(areas: &[Area]) -> (f64, f64) {
    match areas.first() {
        Some(&(x, y, w, h, scale)) => (x + w - (PANEL + MARGIN) * scale, y + h - (PANEL + MARGIN) * scale),
        None => (0.0, 0.0),
    }
}

fn saved_place(app: &AppHandle) -> Option<(f64, f64)> {
    let shared = app.try_state::<crate::Shared>()?;
    let at = shared.settings.lock().unwrap().desktop_mochi_at?;
    Some((at[0] as f64, at[1] as f64))
}

/// Remembers whether he lives on the desktop, and where when he does.
fn remember(app: &AppHandle, out: bool, at: Option<(i32, i32)>) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.mochi_on_desktop = out;
        if let Some((x, y)) = at {
            current.desktop_mochi_at = Some([x, y]);
        }
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
}

fn over_island(app: &AppHandle, cursor: (f64, f64)) -> bool {
    let Some(island) = island::window(app) else { return false };
    let at = island.outer_position().unwrap_or_default();
    let size = island.outer_size().unwrap_or_default();
    cursor.0 >= at.x as f64 && cursor.0 < at.x as f64 + size.width as f64 && cursor.1 >= at.y as f64 && cursor.1 < at.y as f64 + size.height as f64
}

fn tell_island(app: &AppHandle, what: &str) {
    let _ = app.emit_to(island::WINDOW_LABEL, TO_ISLAND, what);
}

// ── Flights ───────────────────────────────────────────────────────────────────

/// Slow at both ends, like the Mac's easeInEaseOut.
fn ease(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// Moves the window from where it is to `to`, then calls `landed`.
fn fly(win: WebviewWindow, to: (i32, i32), landed: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        let from = win.outer_position().unwrap_or_default();
        let started = Instant::now();
        loop {
            let t = (started.elapsed().as_secs_f64() / FLIGHT.as_secs_f64()).min(1.0);
            let k = ease(t);
            let x = from.x as f64 + (to.0 - from.x) as f64 * k;
            let y = from.y as f64 + (to.1 - from.y) as f64 * k;
            let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(TICK / 2);
        }
        landed();
    });
}

/// He is out: the mouse is watched until he goes home.
fn settle(app: &AppHandle, win: &WebviewWindow) {
    {
        let mut live = LIVE.lock().unwrap();
        live.flying = false;
        live.out = true;
    }
    let at = win.outer_position().unwrap_or_default();
    remember(app, true, Some((at.x, at.y)));
    watch(app.clone(), win.clone());
    tell_island(app, "landed");
}

/// Out of the island, to his place. False when he is already out, or cannot be here.
#[tauri::command]
pub fn mochi_fly_out(app: AppHandle) -> bool {
    let Some(win) = window(&app) else { return false };
    {
        let mut live = LIVE.lock().unwrap();
        if live.out || live.flying {
            return false;
        }
        live.flying = true;
    }
    let side = side(&win);
    let areas = work_areas(&app);
    let place = clamp(saved_place(&app).unwrap_or_else(|| default_place(&areas)), side, &areas);
    let from = notch(&app, &win);
    let size = side.round() as u32;
    let _ = win.set_size(PhysicalSize::new(size, size));
    let _ = win.set_position(PhysicalPosition::new(from.0, from.1));
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.emit_to(LABEL, "mochi-shown", json!({ "fade": true }));
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    let landing = app.clone();
    let landed = win.clone();
    fly(win, (place.0.round() as i32, place.1.round() as i32), move || settle(&landing, &landed));
    true
}

/// Back into the island. With `keep` he still lives on the desktop — a request
/// called him back, and he returns once it is answered.
#[tauri::command]
pub fn mochi_fly_home(app: AppHandle, keep: bool) -> bool {
    let Some(win) = window(&app) else { return false };
    {
        let mut live = LIVE.lock().unwrap();
        if !live.out || live.flying {
            return false;
        }
        live.out = false;
        live.flying = true;
        live.drag = None;
    }
    let _ = win.set_ignore_cursor_events(true);
    let to = notch(&app, &win);
    let home = app.clone();
    let hidden = win.clone();
    fly(win, to, move || go_home(&home, &hidden, keep));
    true
}

fn go_home(app: &AppHandle, win: &WebviewWindow, keep: bool) {
    let _ = win.hide();
    let _ = win.emit_to(LABEL, "mochi-hidden", ());
    {
        let mut live = LIVE.lock().unwrap();
        live.flying = false;
        live.out = false;
        live.drag = None;
    }
    remember(app, keep, None);
    tell_island(app, "home");
}

// ── Dragging ──────────────────────────────────────────────────────────────────

fn begin_drag(win: &WebviewWindow, moved: bool) -> Option<Drag> {
    let cursor = platform::cursor_physical()?;
    let at = win.outer_position().ok()?;
    Some(Drag { cursor, origin: (at.x, at.y), moved })
}

/// The mouse went down on his body: he follows it until it is let go.
#[tauri::command]
pub fn mochi_grab(app: AppHandle) {
    let Some(win) = window(&app) else { return };
    let mut live = LIVE.lock().unwrap();
    if live.out && !live.flying && live.drag.is_none() {
        live.drag = begin_drag(&win, false);
    }
}

/// He was dragged out of the island: his window appears under the mouse,
/// already held. False when he is out already, or cannot be here.
#[tauri::command]
pub fn mochi_take_out(app: AppHandle) -> bool {
    let Some(win) = window(&app) else { return false };
    let Some(cursor) = platform::cursor_physical() else { return false };
    {
        let live = LIVE.lock().unwrap();
        if live.out || live.flying {
            return false;
        }
    }
    let side = side(&win);
    let size = side.round() as u32;
    let _ = win.set_size(PhysicalSize::new(size, size));
    let _ = win.set_position(PhysicalPosition::new((cursor.0 - side / 2.0).round() as i32, (cursor.1 - side / 2.0).round() as i32));
    let _ = win.emit_to(LABEL, "mochi-shown", json!({ "fade": false }));
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    {
        let mut live = LIVE.lock().unwrap();
        live.out = true;
        live.drag = begin_drag(&win, true);
    }
    watch(app.clone(), win);
    true
}

/// The mouse was let go after a drag: on the island he goes home, anywhere
/// else that is his place from now on.
fn drop_at(app: &AppHandle, win: &WebviewWindow, cursor: (f64, f64)) {
    if over_island(app, cursor) {
        LIVE.lock().unwrap().out = false;
        go_home(app, win, false);
        return;
    }
    let at = win.outer_position().unwrap_or_default();
    remember(app, true, Some((at.x, at.y)));
    tell_island(app, "landed");
}

// ── The mouse, while he is out ────────────────────────────────────────────────

/// Follows the mouse for as long as he is out: his window takes it only on his
/// body, his page is told where it is for his eyes, and a drag moves him.
fn watch(app: AppHandle, win: WebviewWindow) {
    std::thread::spawn(move || {
        let mut taking: Option<bool> = None;
        let mut last: Option<(i32, i32)> = None;
        loop {
            std::thread::sleep(TICK);
            let Some(cursor) = platform::cursor_physical() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let side = PANEL * scale;
            let held = platform::left_button_down();

            // The lock is never kept across a call to the window: those wait for
            // the main thread, which may itself be waiting for the lock.
            let drag = {
                let mut live = LIVE.lock().unwrap();
                if !live.out {
                    break;
                }
                let step = live.drag.as_mut().map(|drag| {
                    let (dx, dy) = (cursor.0 - drag.cursor.0, cursor.1 - drag.cursor.1);
                    drag.moved |= held && dx.hypot(dy) > DRAG_SLOP * scale;
                    (drag.moved, (drag.origin.0 as f64 + dx, drag.origin.1 as f64 + dy))
                });
                if !held {
                    live.drag = None;
                }
                step
            };
            if let Some((moved, to)) = drag {
                if held {
                    if moved {
                        let to = clamp(to, side, &work_areas(&app));
                        let _ = win.set_position(PhysicalPosition::new(to.0.round() as i32, to.1.round() as i32));
                    }
                    continue;
                }
                let _ = win.emit_to(LABEL, "mochi-released", json!({ "moved": moved }));
                if moved {
                    drop_at(&app, &win, cursor);
                }
                continue;
            }

            let Ok(at) = win.outer_position() else { continue };
            let from_centre = (cursor.0 - (at.x as f64 + side / 2.0), cursor.1 - (at.y as f64 + side / 2.0));
            let on_body = from_centre.0.hypot(from_centre.1) <= side * BODY_RADIUS;
            if taking != Some(on_body) {
                taking = Some(on_body);
                let _ = win.set_ignore_cursor_events(!on_body);
            }
            // His eyes follow the mouse: his page is told when it moved.
            let seen = ((from_centre.0 / scale).round() as i32, (from_centre.1 / scale).round() as i32);
            if last != Some(seen) {
                last = Some(seen);
                let _ = win.emit_to(LABEL, "mochi-cursor", json!({ "x": seen.0, "y": seen.1 }));
            }
        }
    });
}

// ── Between the island and his page ───────────────────────────────────────────

/// What the island knows and his page draws: his state, his outfit, the music.
#[tauri::command]
pub fn mochi_tell(app: AppHandle, what: Value) {
    let _ = app.emit_to(LABEL, "mochi-state", what);
}

/// What his page asks of the island: his wardrobe (a right click), or to go home (a double click).
#[tauri::command]
pub fn mochi_ask(app: AppHandle, what: String) {
    if ASKS.contains(&what.as_str()) {
        tell_island(&app, &what);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn he_stays_inside_the_nearest_screen() {
        let areas = [(0.0, 0.0, 1920.0, 1040.0, 1.0), (1920.0, 0.0, 2560.0, 1400.0, 2.0)];
        // Inside: left where he is.
        assert_eq!(clamp((500.0, 300.0), 120.0, &areas), (500.0, 300.0));
        // Past the corner of the first screen: brought back by the margin.
        assert_eq!(clamp((-50.0, -50.0), 120.0, &areas), (24.0, 24.0));
        assert_eq!(clamp((1900.0, 1000.0), 120.0, &areas[..1]), (1920.0 - 120.0 - 24.0, 1040.0 - 120.0 - 24.0));
        // On the second screen the margin is in its own pixels.
        assert_eq!(clamp((4400.0, 1390.0), 240.0, &areas), (1920.0 + 2560.0 - 240.0 - 48.0, 1400.0 - 240.0 - 48.0));
        // Dragged there from a screen of another scale: held to the size he will have on it.
        assert_eq!(clamp((4400.0, 1390.0), 120.0, &areas), (1920.0 + 2560.0 - 240.0 - 48.0, 1400.0 - 240.0 - 48.0));
        // No screen known: nothing to hold him to.
        assert_eq!(clamp((7.0, 9.0), 120.0, &[]), (7.0, 9.0));
        assert_eq!(default_place(&areas), (1920.0 - 120.0 - 24.0, 1040.0 - 120.0 - 24.0));
    }

    #[test]
    fn a_flight_starts_and_ends_slowly() {
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        assert_eq!(ease(0.5), 0.5);
        assert!(ease(0.1) < 0.1 && ease(0.9) > 0.9);
    }
}
