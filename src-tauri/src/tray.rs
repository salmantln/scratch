//! Menu bar / system tray: a thin control surface over the main window and the meeting archive.
//! Recent meetings and projects are read from disk, so the tray works while the window is hidden.
//! While recording it shows the meeting, the elapsed time and Stop; it never starts a recording itself.
use crate::{app_state::Shared, capture, meetings};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY: &str = "quietnote";
/// The "Transcribing…" line, updated in place so the menu isn't rebuilt on every percent.
static PROGRESS: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);
static RECORDING_ICON: AtomicBool = AtomicBool::new(false);

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
        out.push(item("started", format!("Started {started} by you · No bot joined"), false));
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
        // New meeting's primary action is Start recording, so one entry opens it.
        out.push(item("record", "Start recording…", true));
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

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let listing = meetings::tray_listing(app, 3).ok();
    let mut progress = None;
    for entry in entries(&capture::snapshot(app), listing.as_ref(), app.state::<Shared>().project(), crate::calendar::next()) {
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

fn on_menu(app: &AppHandle, id: &str) {
    if id == "quit" { return request_quit(app); }
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
        // Opens New meeting; recording starts only from its Start recording button.
        "new" | "record" => app.emit_to("main", "quietnote://new-meeting", ()),
        "settings" => app.emit_to("main", "quietnote://open-settings", ()),
        _ => match (id.strip_prefix("meeting:"), id.strip_prefix("project:"), id.strip_prefix("event:")) {
            (Some(meeting), _, _) => app.emit_to("main", "quietnote://open-meeting", meeting),
            (_, Some(project), _) => app.emit_to("main", "quietnote://open-project", project),
            (_, _, Some(event)) => app.emit_to("main", "quietnote://new-meeting", serde_json::json!({ "eventId": event })),
            _ => Ok(()),
        },
    };
}

pub fn refresh(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY) { tray.set_menu(Some(build_menu(app)?))?; }
    Ok(())
}

fn icon(recording: bool) -> tauri::Result<Image<'static>> {
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = if recording { include_bytes!("../icons/tray-recording-template.png") } else { include_bytes!("../icons/tray-template.png") };
    #[cfg(not(target_os = "macos"))]
    let bytes: &[u8] = if recording { include_bytes!("../icons/tray-recording.png") } else { include_bytes!("../icons/32x32.png") };
    Image::from_bytes(bytes)
}
/// Shows the recorded time (next to the menu bar icon on macOS, in the tooltip elsewhere), whether
/// it's paused, and the recording icon; `None` restores the idle tray.
pub fn recording_tick(app: &AppHandle, clock: Option<(Duration, bool)>) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let recording = clock.is_some();
    if RECORDING_ICON.swap(recording, Ordering::Relaxed) != recording {
        if let Ok(image) = icon(recording) { let _ = tray.set_icon(Some(image)); }
        #[cfg(target_os = "macos")]
        let _ = tray.set_icon_as_template(true);
    }
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
        .menu(&build_menu(app)?)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    #[cfg(target_os = "macos")]
    let builder = builder.icon(icon(false)?).icon_as_template(true);
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
        assert_eq!(texts(&idle), ["Start recording…", "Recent", "Acme onboarding", "Open QuietNote", "Settings…", "Quit QuietNote"]);
        // The calendar's next meeting sits under Start recording, and opens New meeting for that event.
        let next = entries(&state(false, false, None), Some(&listing), None, Some(("ev1@0".into(), "Next: Weekly sync · 14:00".into())));
        assert_eq!(&texts(&next)[..2], ["Start recording…", "Next: Weekly sync · 14:00"]);
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
        assert!(lines[1].starts_with("Started ") && lines[1].ends_with(" by you · No bot joined"));
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
}
