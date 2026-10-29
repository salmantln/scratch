//! Menu bar / system tray: a thin control surface over the main window and the meeting archive.
//! Recent meetings and projects are read from disk, so the tray works while the window is hidden.
//! While recording it shows the meeting, the elapsed time and Stop. It starts a recording only when its Start recording is clicked.
use crate::{app_state::Shared, capture, meetings};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY: &str = "quietnote";
/// The "Transcribing…" line, updated in place so the menu isn't rebuilt on every percent.
static PROGRESS: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);
/// The `Mood` the icon shows.
static STATE: AtomicU8 = AtomicU8::new(Mood::Resting as u8);
/// Hush in that mood (Settings → Appearance → Show Hush), or the logo.
static HUSH: AtomicBool = AtomicBool::new(true);
/// Until when Hush shows a transcript was just saved.
static DONE: Mutex<Option<Instant>> = Mutex::new(None);
const DONE_FOR: Duration = Duration::from_secs(4);

/// What Hush's face in the menu bar says QuietNote is doing, as the window's Hush does.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Mood { Resting, Listening, Paused, Winding, Attention, Transcribing, Done }
const MOODS: [Mood; 7] = [Mood::Resting, Mood::Listening, Mood::Paused, Mood::Winding, Mood::Attention, Mood::Transcribing, Mood::Done];
/// The recording first (about to stop by itself, then a problem, then paused), then transcription.
fn mood(state: &capture::State, done: bool) -> Mood {
    match &state.recording {
        Some(live) if live.ending.is_some() => Mood::Winding,
        Some(live) if live.problem.is_some() => Mood::Attention,
        Some(live) if live.resumed_at.is_none() => Mood::Paused,
        Some(_) => Mood::Listening,
        None if state.transcribing.is_some() || !state.queued.is_empty() => Mood::Transcribing,
        None if done => Mood::Done,
        None => Mood::Resting,
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// In the Dock and ⌘-Tab only while one of QuietNote's windows is open (macOS); otherwise it's a
/// menu bar app, still running, so call detection and recording carry on. `closing` is a window
/// on its way out, which may still report itself visible. The call panel never counts.
pub fn sync_dock(app: &AppHandle, closing: Option<&str>) {
    #[cfg(target_os = "macos")]
    {
        let open = app.webview_windows().iter().any(|(label, window)| {
            Some(label.as_str()) != closing && label != crate::calls::PANEL && window.is_visible().unwrap_or(false)
        });
        let _ = app.set_activation_policy(if open { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, closing);
}

/// Asks the main window to finish saving, then exits. Exits anyway after a short grace period
/// so a busy or navigated-away webview can't block Quit; recovery drafts cover anything unsaved.
pub fn request_quit(app: &AppHandle) {
    // Finalize the recording here, before the webview round trip and its grace period.
    capture::shutdown(app);
    if app.state::<Shared>().begin_quit()
        && app.get_webview_window("main").is_some()
        && app.emit_to("main", "quietnote://quit-requested", ()).is_ok()
    {
        let app = app.clone();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(3)); app.exit(0); });
    } else {
        app.exit(0);
    }
}

fn label(text: &str) -> String {
    let text = text.trim();
    let text = if text.is_empty() { "Untitled meeting".to_string() }
        else if text.chars().count() > 48 { format!("{}…", text.chars().take(47).collect::<String>().trim_end()) }
        else { text.to_string() };
    // Windows menus treat `&` as a mnemonic marker.
    if cfg!(windows) { text.replace('&', "&&") } else { text }
}

/// One line of the tray menu. The menu is built from capture state in `entries`, which the tests
/// check, so the tray says exactly what the window says.
#[derive(Debug, PartialEq)]
enum Entry { Item(String, String, bool), Separator, Projects(Option<String>, Vec<String>) }
fn item(id: impl Into<String>, text: impl Into<String>, enabled: bool) -> Entry { Entry::Item(id.into(), text.into(), enabled) }

/// `next` is the calendar's current or next meeting (`calendar::next`): its occurrence id and its line.
fn entries(state: &capture::State, listing: Option<&meetings::Listing>, project: Option<String>, next: Option<(String, String)>) -> Vec<Entry> {
    let mut out = Vec::new();
    let quit = if state.recording.is_some() { item("quit", "Stop recording and quit", true) } else { item("quit", "Quit QuietNote", true) };
    let Some((projects, recent)) = listing else {
        out.extend([item("attention", "QuietNote needs attention.", false), Entry::Separator, item("open", "Open QuietNote", true), quit]);
        return out;
    };
    if let Some(live) = &state.recording {
        let started = chrono::DateTime::parse_from_rfc3339(&live.started_at).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
        let paused = live.resumed_at.is_none();
        out.push(item("recording", format!("{} {}", if paused { "❙❙ Paused:" } else { "● Recording:" }, label(&live.title)), false));
        out.push(item("started", format!("Started {started}"), false));
        // The first sentence of a problem ("Microphone disconnected.") fits a menu line.
        if let Some(problem) = &live.problem { out.push(item("problem", format!("⚠ {}", label(problem.split_inclusive(". ").next().unwrap_or(problem))), false)); }
        if let Some(ending) = &live.ending {
            let at = chrono::DateTime::parse_from_rfc3339(&ending.stops_at).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
            out.push(item("ending", format!("⏱ {} Stops at {at}", label(&ending.reason)), false));
            out.push(item("keep", "Keep recording", true));
        }
        out.push(if paused { item("resume", "Resume recording", true) } else { item("pause", "Pause recording", true) });
        out.push(item("stop", "Stop recording", true));
        out.push(item(format!("meeting:{}", live.meeting_id), "Open meeting", true));
    } else if state.available {
        // Records at once into a new meeting (or one prepared for the event happening now); the window names it.
        out.push(item("record", "Start recording", true));
        // Opens New meeting filled in from the event; it doesn't start recording.
        if let Some((event, text)) = next { out.push(item(format!("event:{event}"), label(&text), true)); }
    } else {
        out.push(item("new", "New meeting…", true));
    }
    if let Some(job) = &state.transcribing { out.push(item("progress", format!("Transcribing {}… {}%", label(&job.title), job.percent), false)); }
    // While recording, the menu is a control surface: recent meetings and projects wait until it stops.
    if state.recording.is_none() {
        out.push(Entry::Separator);
        out.push(item("recent", "Recent", false));
        if recent.is_empty() { out.push(item("none", "No meetings yet", false)); }
        out.extend(recent.iter().map(|(id, title)| item(format!("meeting:{id}"), label(title), true)));
        if !projects.is_empty() {
            out.push(Entry::Separator);
            out.push(Entry::Projects(project.filter(|p| projects.contains(p)), projects.clone()));
        }
    }
    out.extend([Entry::Separator, item("open", "Open QuietNote", true), item("settings", "Settings…", true), quit]);
    out
}

fn build_menu(app: &AppHandle, state: &capture::State) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let listing = meetings::tray_listing(app, 3).ok();
    let mut progress = None;
    for entry in entries(state, listing.as_ref(), app.state::<Shared>().project(), crate::calendar::next()) {
        match entry {
            Entry::Item(id, text, enabled) => {
                let item = MenuItem::with_id(app, &id, &text, enabled, None::<&str>)?;
                menu.append(&item)?;
                if id == "progress" { progress = Some(item); }
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Projects(current, projects) => {
                let submenu = Submenu::new(app, current.as_deref().map_or("Projects".into(), |p| format!("Project: {}", label(p))), true)?;
                for p in &projects {
                    submenu.append(&CheckMenuItem::with_id(app, format!("project:{p}"), label(p), true, current.as_ref() == Some(p), None::<&str>)?)?;
                }
                menu.append(&submenu)?;
            }
        }
    }
    if let Ok(mut slot) = PROGRESS.lock() { *slot = progress; }
    Ok(menu)
}

/// ⌘Q (macOS): QuietNote's windows go and it keeps running in the menu bar, as Granola does, so a
/// call is still noticed and a recording carries on. Quit QuietNote, below it, quits.
pub fn app_menu(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItemKind;
        // Without the menu bar icon there's nothing to close to (and nothing handling these items).
        if app.tray_by_id(TRAY).is_none() { return Ok(()); }
        let menu = Menu::default(app)?;
        if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
            // Tauri's default app menu ends with the predefined Quit, which exits at once.
            let items = first.items()?;
            if let Some(MenuItemKind::Predefined(_)) = items.last() { first.remove_at(items.len() - 1)?; }
            first.append(&MenuItem::with_id(app, "close", "Close to Menu Bar", true, Some("CmdOrCtrl+Q"))?)?;
            first.append(&MenuItem::with_id(app, "quit", "Quit QuietNote", true, None::<&str>)?)?;
        }
        app.set_menu(menu)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

fn close_to_menu_bar(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label == "main" { let _ = window.hide(); } else if label != crate::calls::PANEL { let _ = window.close(); }
    }
    sync_dock(app, Some("main"));
}

fn on_menu(app: &AppHandle, id: &str) {
    if id == "quit" { return request_quit(app); }
    if id == "close" { return close_to_menu_bar(app); }
    if id == "keep" { return capture::keep(app); }
    if matches!(id, "stop" | "pause" | "resume") {
        let (app, id) = (app.clone(), id.to_string());
        std::thread::spawn(move || {
            let failed = match id.as_str() { "stop" => capture::stop(&app, None).err(), "pause" => capture::pause(&app).err(), _ => capture::resume(&app).err().map(|f| f.message) };
            // Resuming can fail (the microphone was turned off meanwhile); the window says why.
            if let Some(problem) = failed { show_main(&app); let _ = app.emit_to("main", "quietnote://capture-problem", problem); }
        });
        return;
    }
    show_main(app);
    let _ = match id {
        "new" => app.emit_to("main", "quietnote://new-meeting", ()),
        // The user's click starts the recording; the window makes the meeting and starts it.
        "record" => app.emit_to("main", "quietnote://record-now", ()),
        "settings" => app.emit_to("main", "quietnote://open-settings", ()),
        _ => match (id.strip_prefix("meeting:"), id.strip_prefix("project:"), id.strip_prefix("event:")) {
            (Some(meeting), _, _) => app.emit_to("main", "quietnote://open-meeting", meeting),
            (_, Some(project), _) => app.emit_to("main", "quietnote://open-project", project),
            (_, _, Some(event)) => app.emit_to("main", "quietnote://new-meeting", serde_json::json!({ "eventId": event })),
            _ => Ok(()),
        },
    };
}

/// Rebuilds the menu and sets Hush's mood from the capture state.
pub fn refresh(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY) else { return Ok(()) };
    let state = capture::snapshot(app);
    tray.set_menu(Some(build_menu(app, &state)?))?;
    show(&tray, &state);
    Ok(())
}
fn show(tray: &TrayIcon, state: &capture::State) {
    let done = DONE.lock().ok().and_then(|d| *d).is_some_and(|until| Instant::now() < until);
    let mood = mood(state, done) as u8;
    if STATE.swap(mood, Ordering::Relaxed) != mood { draw(tray); }
}
/// A transcript was just saved: Hush looks pleased for a moment, then rests.
pub fn transcribed(app: &AppHandle) {
    if let Ok(mut done) = DONE.lock() { *done = Some(Instant::now() + DONE_FOR); }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DONE_FOR);
        if let Some(tray) = app.tray_by_id(TRAY) { show(&tray, &capture::snapshot(&app)); }
    });
}

fn icon(mood: Mood, hush: bool) -> tauri::Result<Image<'static>> {
    let busy = matches!(mood, Mood::Listening | Mood::Paused | Mood::Winding | Mood::Attention);
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = match (hush, mood) {
        (true, Mood::Resting) => include_bytes!("../icons/tray-template.png"),
        (true, Mood::Listening) => include_bytes!("../icons/tray-recording-template.png"),
        (true, Mood::Paused) => include_bytes!("../icons/tray-paused-template.png"),
        (true, Mood::Winding) => include_bytes!("../icons/tray-winding-template.png"),
        (true, Mood::Attention) => include_bytes!("../icons/tray-attention-template.png"),
        (true, Mood::Transcribing) => include_bytes!("../icons/tray-transcribing-template.png"),
        (true, Mood::Done) => include_bytes!("../icons/tray-done-template.png"),
        (false, _) if busy => include_bytes!("../icons/tray-logo-recording-template.png"),
        (false, _) => include_bytes!("../icons/tray-logo-template.png"),
    };
    #[cfg(not(target_os = "macos"))]
    let bytes: &[u8] = { let _ = hush; if busy { include_bytes!("../icons/tray-recording.png") } else { include_bytes!("../icons/32x32.png") } };
    Image::from_bytes(bytes)
}
fn draw(tray: &TrayIcon) {
    if let Ok(image) = icon(MOODS[STATE.load(Ordering::Relaxed) as usize], HUSH.load(Ordering::Relaxed)) { let _ = tray.set_icon(Some(image)); }
    #[cfg(target_os = "macos")]
    let _ = tray.set_icon_as_template(true);
}
fn shows_hush(app: &AppHandle) -> bool { meetings::root(app).map_or(true, |root| meetings::preference(&root, "showHush", true)) }
/// Redraws the icon when Show Hush changed (after the preferences are saved).
pub fn restyle(app: &AppHandle) {
    let hush = shows_hush(app);
    if HUSH.swap(hush, Ordering::Relaxed) != hush { if let Some(tray) = app.tray_by_id(TRAY) { draw(&tray); } }
}
/// Shows the recorded time (next to the menu bar icon on macOS, in the tooltip elsewhere) and whether
/// it's paused; `None` clears it. Hush's face follows `refresh`.
pub fn recording_tick(app: &AppHandle, clock: Option<(Duration, bool)>) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let time = |e: Duration| { let s = e.as_secs(); if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{:02}:{:02}", s / 60, s % 60) } };
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(clock.map(|(e, paused)| if paused { format!("❙❙ {}", time(e)) } else { time(e) }).as_deref());
    let _ = tray.set_tooltip(Some(clock.map_or("QuietNote".to_string(), |(e, paused)| format!("QuietNote: {} {}", if paused { "Paused" } else { "Recording" }, time(e)))));
}
/// Updates the "Transcribing…" line in place, or rebuilds the menu when transcription ends.
pub fn progress(app: &AppHandle, text: Option<&str>) {
    let item = PROGRESS.lock().ok().and_then(|p| p.clone());
    match (item, text) {
        (Some(item), Some(text)) => { let _ = item.set_text(text); }
        _ => { let _ = refresh(app); }
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let builder = TrayIconBuilder::with_id(TRAY)
        .tooltip("QuietNote")
        .menu(&build_menu(app, &capture::snapshot(app))?)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    #[cfg(target_os = "macos")]
    let builder = { HUSH.store(shows_hush(app), Ordering::Relaxed); builder.icon(icon(Mood::Resting, HUSH.load(Ordering::Relaxed))?).icon_as_template(true) };
    // Windows convention: left click restores the app, right click opens the menu.
    #[cfg(not(target_os = "macos"))]
    let builder = {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        let builder = builder.show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event { show_main(tray.app_handle()); }
        });
        match app.default_window_icon() { Some(icon) => builder.icon(icon.clone()), None => builder }
    };
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
pub async fn tray_sync(app: AppHandle, project: Option<String>) -> Result<(), String> {
    app.state::<Shared>().set_project(project);
    refresh(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quietnote_quit(app: AppHandle) { app.exit(0); }

#[cfg(test)]
mod tests {
    use super::*;
    fn state(recording: bool, transcribing: bool, problem: Option<&str>) -> capture::State {
        capture::State {
            available: true, microphone: "granted", model: "ready", queued: vec![], detects_calls: true, live_transcript: true,
            recording: recording.then(|| capture::Live {
                meeting_id: "m1".into(), title: "Acme onboarding".into(), started_at: "2026-09-29T10:05:00.000Z".into(), recorded_ms: 0, resumed_at: Some("2026-09-29T10:05:00.000Z".into()),
                mic: capture::Level::Heard, system: capture::Level::Waiting, mic_device: None, system_device: None, problem: problem.map(Into::into), note: None, live_text: capture::LiveText::Off, ending: None,
            }),
            transcribing: transcribing.then(|| capture::Progress { meeting_id: "m0".into(), title: "Standup".into(), percent: 42 }),
        }
    }
    fn texts(entries: &[Entry]) -> Vec<&str> { entries.iter().filter_map(|e| match e { Entry::Item(_, text, _) => Some(text.as_str()), _ => None }).collect() }
    #[test]
    fn menu_says_what_the_window_says() {
        let listing: meetings::Listing = (vec!["Acme".into()], vec![("m1".into(), "Acme onboarding".into())]);
        let idle = entries(&state(false, false, None), Some(&listing), Some("Acme".into()), None);
        assert_eq!(texts(&idle), ["Start recording", "Recent", "Acme onboarding", "Open QuietNote", "Settings…", "Quit QuietNote"]);
        // The calendar's next meeting sits under Start recording, and opens New meeting for that event.
        let next = entries(&state(false, false, None), Some(&listing), None, Some(("ev1@0".into(), "Next: Weekly sync · 14:00".into())));
        assert_eq!(&texts(&next)[..2], ["Start recording", "Next: Weekly sync · 14:00"]);
        assert!(next.contains(&Entry::Item("event:ev1@0".into(), "Next: Weekly sync · 14:00".into(), true)));
        // Not while recording: the menu is the recording's controls.
        assert!(!texts(&entries(&state(true, false, None), Some(&listing), None, Some(("e".into(), "Now: Sync".into())))).contains(&"Now: Sync"));
        assert!(idle.contains(&Entry::Projects(Some("Acme".into()), vec!["Acme".into()])));
        let mut unavailable = state(false, false, None);
        unavailable.available = false;
        assert_eq!(texts(&entries(&unavailable, Some(&listing), None, None))[0], "New meeting…");
        let recording = entries(&state(true, true, Some("Microphone disconnected. Reconnecting…")), Some(&listing), Some("Acme".into()), None);
        let lines = texts(&recording);
        assert_eq!(lines[0], "● Recording: Acme onboarding");
        assert!(lines[1].starts_with("Started ") && !lines[1].contains("bot"));
        assert_eq!(lines[2], "⚠ Microphone disconnected.");
        // Only what matters while recording: no Start, no recent meetings, no projects.
        assert_eq!(&lines[3..], ["Pause recording", "Stop recording", "Open meeting", "Transcribing Standup… 42%", "Open QuietNote", "Settings…", "Stop recording and quit"]);
        assert!(!recording.iter().any(|e| matches!(e, Entry::Projects(..))));
        let mut paused = state(true, false, None);
        if let Some(live) = paused.recording.as_mut() { live.resumed_at = None; }
        let lines = entries(&paused, Some(&listing), None, None);
        let lines = texts(&lines);
        assert_eq!(lines[0], "❙❙ Paused: Acme onboarding");
        assert_eq!(&lines[2..4], ["Resume recording", "Stop recording"]);
        let broken = entries(&state(true, false, None), None, None, None);
        assert_eq!(texts(&broken), ["QuietNote needs attention.", "Open QuietNote", "Stop recording and quit"]);
    }
    #[test]
    fn hush_shows_what_is_happening() {
        assert_eq!(mood(&state(false, false, None), false), Mood::Resting);
        assert_eq!(mood(&state(false, false, None), true), Mood::Done);
        assert_eq!(mood(&state(true, true, None), true), Mood::Listening);
        assert_eq!(mood(&state(true, false, Some("Microphone disconnected.")), false), Mood::Attention);
        let mut paused = state(true, false, None);
        if let Some(live) = paused.recording.as_mut() { live.resumed_at = None; }
        assert_eq!(mood(&paused, false), Mood::Paused);
        let mut ending = state(true, false, Some("Disk space is low."));
        if let Some(live) = ending.recording.as_mut() { live.ending = Some(capture::EndingView { reason: "The call ended.".into(), stops_at: "2026-09-29T11:00:00.000Z".into() }); }
        assert_eq!(mood(&ending, false), Mood::Winding);
        // From Stop until the transcript is saved, queued before the worker picks it up too.
        assert_eq!(mood(&state(false, true, None), true), Mood::Transcribing);
        let mut queued = state(false, false, None);
        queued.queued = vec!["m1".into()];
        assert_eq!(mood(&queued, false), Mood::Transcribing);
        assert!(MOODS.iter().enumerate().all(|(i, m)| *m as usize == i));
    }
}
