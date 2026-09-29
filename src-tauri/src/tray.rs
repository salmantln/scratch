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

fn entries(state: &capture::State, listing: Option<&meetings::Listing>, project: Option<String>) -> Vec<Entry> {
    let mut out = Vec::new();
    let quit = if state.recording.is_some() { item("quit", "Stop recording and quit", true) } else { item("quit", "Quit QuietNote", true) };
    let Some((projects, recent)) = listing else {
        out.extend([item("attention", "QuietNote needs attention.", false), Entry::Separator, item("open", "Open QuietNote", true), quit]);
        return out;
    };
    if let Some(live) = &state.recording {
        let started = chrono::DateTime::parse_from_rfc3339(&live.started_at).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
        out.push(item("recording", format!("● Recording: {}", label(&live.title)), false));
        out.push(item("started", format!("Started {started} by you · No bot joined"), false));
        // The first sentence of a problem ("Microphone disconnected.") fits a menu line.
        if let Some(problem) = &live.problem { out.push(item("problem", format!("⚠ {}", label(problem.split_inclusive(". ").next().unwrap_or(problem))), false)); }
        out.push(item("stop", "Stop recording", true));
        out.push(item(format!("meeting:{}", live.meeting_id), "Open meeting", true));
    } else {
        out.push(item("new", "New meeting…", true));
        if state.available { out.push(item("record", "Start recording…", true)); }
    }
    if let Some(job) = &state.transcribing { out.push(item("progress", format!("Transcribing {}… {}%", label(&job.title), job.percent), false)); }
    out.push(Entry::Separator);
    out.push(item("recent", "Recent", false));
    if recent.is_empty() { out.push(item("none", "No meetings yet", false)); }
    out.extend(recent.iter().map(|(id, title)| item(format!("meeting:{id}"), label(title), true)));
    if !projects.is_empty() {
        out.push(Entry::Separator);
        out.push(Entry::Projects(project.filter(|p| projects.contains(p)), projects.clone()));
    }
    out.extend([Entry::Separator, item("open", "Open QuietNote", true), item("settings", "Settings…", true), quit]);
    out
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let listing = meetings::tray_listing(app, 3).ok();
    let mut progress = None;
    for entry in entries(&capture::snapshot(app), listing.as_ref(), app.state::<Shared>().project()) {
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
    if id == "stop" {
        let app = app.clone();
        std::thread::spawn(move || { let _ = capture::stop(&app, None); });
        return;
    }
    show_main(app);
    let _ = match id {
        "new" => app.emit_to("main", "quietnote://new-meeting", serde_json::json!({ "record": false })),
        // Opens New meeting with "Start recording" as its action; recording starts only from there.
        "record" => app.emit_to("main", "quietnote://new-meeting", serde_json::json!({ "record": true })),
        "settings" => app.emit_to("main", "quietnote://open-settings", ()),
        _ => match (id.strip_prefix("meeting:"), id.strip_prefix("project:")) {
            (Some(meeting), _) => app.emit_to("main", "quietnote://open-meeting", meeting),
            (_, Some(project)) => app.emit_to("main", "quietnote://open-project", project),
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
/// Shows the elapsed recording time (next to the menu bar icon on macOS, in the tooltip elsewhere)
/// and the recording icon; `None` restores the idle tray.
pub fn recording_tick(app: &AppHandle, elapsed: Option<Duration>) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let recording = elapsed.is_some();
    if RECORDING_ICON.swap(recording, Ordering::Relaxed) != recording {
        if let Ok(image) = icon(recording) { let _ = tray.set_icon(Some(image)); }
        #[cfg(target_os = "macos")]
        let _ = tray.set_icon_as_template(true);
    }
    let clock = elapsed.map(|e| { let s = e.as_secs(); if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{:02}:{:02}", s / 60, s % 60) } });
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(clock.as_deref());
    let _ = tray.set_tooltip(Some(clock.map_or("QuietNote".to_string(), |c| format!("QuietNote: Recording {c}"))));
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
            available: true, microphone: "granted", model: "ready", queued: vec![],
            recording: recording.then(|| capture::Live {
                meeting_id: "m1".into(), title: "Acme onboarding".into(), started_at: "2026-09-29T10:05:00.000Z".into(),
                mic: capture::Level::Heard, system: capture::Level::Waiting, mic_device: None, system_device: None, problem: problem.map(Into::into), note: None,
            }),
            transcribing: transcribing.then(|| capture::Progress { meeting_id: "m0".into(), title: "Standup".into(), percent: 42 }),
        }
    }
    fn texts(entries: &[Entry]) -> Vec<&str> { entries.iter().filter_map(|e| match e { Entry::Item(_, text, _) => Some(text.as_str()), _ => None }).collect() }
    #[test]
    fn menu_says_what_the_window_says() {
        let listing: meetings::Listing = (vec!["Acme".into()], vec![("m1".into(), "Acme onboarding".into())]);
        let idle = entries(&state(false, false, None), Some(&listing), None);
        assert_eq!(texts(&idle)[..2], ["New meeting…", "Start recording…"]);
        assert_eq!(texts(&idle).last(), Some(&"Quit QuietNote"));
        let recording = entries(&state(true, true, Some("Microphone disconnected. Reconnecting…")), Some(&listing), Some("Acme".into()));
        let lines = texts(&recording);
        assert_eq!(lines[0], "● Recording: Acme onboarding");
        assert!(lines[1].starts_with("Started ") && lines[1].ends_with(" by you · No bot joined"));
        assert_eq!(lines[2], "⚠ Microphone disconnected.");
        assert_eq!(&lines[3..6], ["Stop recording", "Open meeting", "Transcribing Standup… 42%"]);
        assert!(!lines.contains(&"Start recording…") && !lines.contains(&"New meeting…"));
        assert_eq!(lines.last(), Some(&"Stop recording and quit"));
        assert!(recording.contains(&Entry::Projects(Some("Acme".into()), vec!["Acme".into()])));
        let broken = entries(&state(true, false, None), None, None);
        assert_eq!(texts(&broken), ["QuietNote needs attention.", "Open QuietNote", "Stop recording and quit"]);
    }
}
