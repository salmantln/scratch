//! Call detection: notices when a call app or a browser starts using the microphone and offers to
//! record in a small panel. It asks Core Audio which apps are using the microphone, on this Mac, and
//! (if the user allows Accessibility) whether a browser using it shows a meeting (`ax`); it never
//! joins or listens to the call, and nothing records until the user presses Start recording.
use crate::{meetings, tray};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const PANEL: &str = "call";
/// How long an app must hold the microphone before QuietNote offers to record, so a blip isn't a call.
const HOLD: Duration = Duration::from_secs(3);

/// Apps that make calls, by bundle id; helper processes (`com.google.Chrome.helper`) count as their app.
const APPS: &[(&str, &str)] = &[
    ("us.zoom", "Zoom"),
    ("com.microsoft.teams", "Microsoft Teams"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.apple.avconferenced", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("Cisco-Systems.Spark", "Webex"),
    ("com.cisco.webexmeetingsapp", "Webex"),
    ("com.webex.meetingmanager", "Webex"),
    ("com.hnc.Discord", "Discord"),
    ("net.whatsapp.WhatsApp", "WhatsApp"),
    ("com.google.Chrome", "Chrome"),
    ("com.apple.Safari", "Safari"),
    ("com.apple.WebKit.GPU", "Safari"),
    ("company.thebrowser.Browser", "Arc"),
    ("org.mozilla.firefox", "Firefox"),
    ("org.mozilla.plugincontainer", "Firefox"),
    ("com.microsoft.edgemac", "Microsoft Edge"),
    ("com.brave.Browser", "Brave"),
];

/// Browsers, by name, and the bundle id whose windows show their tabs.
const BROWSERS: &[(&str, &str)] = &[
    ("Chrome", "com.google.Chrome"),
    ("Safari", "com.apple.Safari"),
    ("Arc", "company.thebrowser.Browser"),
    ("Firefox", "org.mozilla.firefox"),
    ("Microsoft Edge", "com.microsoft.edgemac"),
    ("Brave", "com.brave.Browser"),
];
/// Meeting services, by what their pages put in a window or tab title or address.
const SERVICES: &[(&str, &[&str])] = &[
    ("Google Meet", &["meet.google.com", "google meet", "meet - ", "meet – "]),
    ("Microsoft Teams", &["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "microsoft teams"]),
    ("Zoom", &["zoom.us/wc", "app.zoom.us", "zoom meeting"]),
    ("Webex", &["webex.com", "webex"]),
    ("Whereby", &["whereby.com", "whereby"]),
    ("Jitsi Meet", &["meet.jit.si", "jitsi meet"]),
];
/// The meeting service a browser shows in any window or tab, if any.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn service(titles: &[String]) -> Option<&'static str> {
    let titles: Vec<String> = titles.iter().map(|t| t.to_lowercase()).collect();
    SERVICES.iter().find(|(_, marks)| titles.iter().any(|t| marks.iter().any(|m| if m.ends_with(' ') { t.starts_with(m) } else { t.contains(m) }))).map(|(name, _)| *name)
}

/// The call app a process belongs to, or `None` for anything else (dictation tools, voice memos).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn app_name(bundle_id: &str) -> Option<&'static str> {
    let id = bundle_id.to_ascii_lowercase();
    APPS.iter().find(|(prefix, _)| {
        let prefix = prefix.to_ascii_lowercase();
        id == prefix || id.strip_prefix(&prefix).is_some_and(|rest| rest.starts_with('.'))
    }).map(|(_, name)| *name)
}

#[derive(Debug, PartialEq)]
pub enum Action { Show(&'static str), Hide }

/// Decides when the panel shows. Each app is offered once per stretch of microphone use: dismissing
/// it, or recording, keeps it quiet until that app lets go of the microphone.
#[derive(Default)]
pub struct Detector { since: HashMap<&'static str, Instant>, offered: HashSet<&'static str>, showing: Option<&'static str> }
impl Detector {
    /// `apps` are the call apps using the microphone now; `quiet` is set while recording or with detection off.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn step(&mut self, apps: &[&'static str], quiet: bool, now: Instant) -> Option<Action> {
        self.since.retain(|app, _| apps.contains(app));
        self.offered.retain(|app| apps.contains(app));
        for &app in apps { self.since.entry(app).or_insert(now); }
        if quiet { self.offered.extend(apps); }
        if let Some(app) = self.showing {
            if quiet || !apps.contains(&app) { self.showing = None; return Some(Action::Hide); }
            return None;
        }
        let app = *apps.iter().find(|app| !self.offered.contains(*app) && now.duration_since(self.since[*app]) >= HOLD)?;
        self.offered.insert(app);
        self.showing = Some(app);
        Some(Action::Show(app))
    }
    /// The app the panel was showing; it stays offered until its microphone use ends.
    pub fn take(&mut self) -> Option<&'static str> { self.showing.take() }
}

/// Notices that the call being recorded ended: the call app that was using the microphone during the
/// recording has let go of it for a few seconds (a blip while devices switch isn't an end).
#[derive(Default)]
pub struct Ender { call: Option<&'static str>, gone: Option<Instant> }
/// How long the call app must be off the microphone before the call counts as ended.
const GONE: Duration = Duration::from_secs(6);
impl Ender {
    /// `apps` are the call apps using the microphone now; returns the call that just ended.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn step(&mut self, apps: &[&'static str], recording: bool, now: Instant) -> Option<&'static str> {
        if !recording { *self = Ender::default(); return None; }
        if let Some(&app) = apps.first() {
            if self.call.is_none_or(|c| !apps.contains(&c)) { self.call = Some(app); }
            self.gone = None;
            return None;
        }
        let call = self.call?;
        if now.duration_since(*self.gone.get_or_insert(now)) < GONE { return None; }
        *self = Ender::default();
        Some(call)
    }
}

#[derive(Default)]
pub struct Calls { detector: Mutex<Detector>, ender: Mutex<Ender> }

/// Watches microphone use every two seconds (macOS only; elsewhere nothing is detected).
pub fn spawn(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let root = meetings::root(&app).ok();
            let enabled = root.as_deref().is_some_and(|r| meetings::preference(r, "detectCalls", true));
            let muted = root.as_deref().map(|r| meetings::preference_list(r, "mutedCallApps")).unwrap_or_default();
            let recording = crate::capture::recording(&app);
            // Read while recording too, so a call that's already been recorded isn't offered again.
            let mut apps: Vec<&'static str> = if enabled { mac::apps_using_input().iter().filter_map(|id| app_name(id)).collect() } else { Vec::new() };
            // With Accessibility allowed, a browser counts only while it shows a meeting, named after its service.
            if enabled && root.as_deref().is_some_and(|r| meetings::preference(r, "confirmMeetings", false)) && crate::ax::trusted() {
                apps = apps.into_iter().filter_map(|app| match BROWSERS.iter().find(|(name, _)| *name == app) {
                    Some((_, bundle)) => service(&crate::ax::titles(bundle)),
                    None => Some(app),
                }).collect();
            }
            apps.sort_unstable();
            apps.dedup();
            // A call being recorded that ends is noticed even for apps that aren't offered.
            let ended = app.state::<Calls>().ender.lock().ok().and_then(|mut e| e.step(&apps, recording && enabled, Instant::now()));
            if let Some(call) = ended { crate::capture::call_ended(&app, call); }
            apps.retain(|app| !muted.iter().any(|m| m == app));
            let action = app.state::<Calls>().detector.lock().ok().and_then(|mut d| d.step(&apps, recording || !enabled, Instant::now()));
            let handle = app.clone();
            match action {
                Some(Action::Show(name)) => { let _ = app.run_on_main_thread(move || show(&handle, Some(name))); }
                Some(Action::Hide) => { let _ = app.run_on_main_thread(move || hide(&handle)); }
                None => {}
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn available() -> bool { cfg!(target_os = "macos") }

/// The same panel shows the countdown when a recording is about to stop by itself (it reads the
/// countdown from the capture state), so it's seen over the call even with QuietNote's window hidden.
pub fn ending_panel(app: &AppHandle, show_it: bool) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || if show_it { show(&handle, None) } else { hide(&handle) });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, show_it);
}

/// Shows the panel, offering to record `call` (or, without one, for a countdown).
#[cfg(target_os = "macos")]
fn show(app: &AppHandle, call: Option<&'static str>) {
    use tauri::{PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
    // Wide enough for the countdown's two buttons too.
    const SIZE: (f64, f64) = (440.0, 72.0);
    let window = match app.get_webview_window(PANEL) {
        Some(window) => { if let Some(name) = call { let _ = window.emit_to(PANEL, "quietnote://call", name); } window }
        None => {
            let url = format!("index.html?panel=call&app={}", urlencoding::encode(call.unwrap_or_default()));
            let built = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(url.into()))
                .title("Meeting detected")
                .inner_size(SIZE.0, SIZE.1)
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .accept_first_mouse(true)
                .focused(false)
                .visible(false)
                .shadow(true)
                .build();
            match built { Ok(window) => { mac::round(&window); window } Err(_) => return }
        }
    };
    // The top right of the screen the pointer is on, just under the menu bar.
    let monitor = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let (area, scale) = (monitor.work_area(), monitor.scale_factor());
        let x = area.position.x + area.size.width as i32 - ((SIZE.0 + 12.0) * scale) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, area.position.y + (10.0 * scale) as i32));
    }
    let _ = window.show();
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL) { let _ = window.hide(); }
}
fn close(app: &AppHandle) -> Option<&'static str> {
    hide(app);
    app.state::<Calls>().detector.lock().ok().and_then(|mut d| d.take())
}

/// Start recording: the main window creates a meeting named after the app and starts recording it.
#[tauri::command]
pub fn call_record(app: AppHandle) {
    let Some(name) = close(&app) else { return };
    tray::show_main(&app);
    let _ = app.emit_to("main", "quietnote://record-call", name);
}
#[tauri::command]
pub fn call_dismiss(app: AppHandle) { close(&app); }
/// Opens QuietNote, or its Privacy settings where call detection is turned off.
#[tauri::command]
pub fn call_open(app: AppHandle, settings: bool) {
    close(&app);
    tray::show_main(&app);
    if settings { let _ = app.emit_to("main", "quietnote://open-settings", ()); }
}
/// Whether QuietNote may read what browsers show (Accessibility); with `ask`, macOS asks the user first.
#[tauri::command]
pub fn call_accessibility(ask: bool) -> bool {
    #[cfg(target_os = "macos")]
    return if ask { crate::ax::ask() } else { crate::ax::trusted() };
    #[cfg(not(target_os = "macos"))]
    { let _ = ask; false }
}
/// Don't notify for this app again (until it's allowed in Settings).
#[tauri::command]
pub fn call_mute(app: AppHandle) -> Result<(), String> {
    let Some(name) = close(&app) else { return Ok(()) };
    let path = meetings::root(&app)?.join(".privacy.json");
    let mut value: serde_json::Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
        Err(_) => serde_json::json!({}),
    };
    let object = value.as_object_mut().ok_or("The privacy preferences are unreadable")?;
    let list = object.entry("mutedCallApps").or_insert_with(|| serde_json::json!([]));
    if !list.is_array() { *list = serde_json::json!([]); }
    if let Some(list) = list.as_array_mut() { if !list.iter().any(|v| v == name) { list.push(name.into()); } }
    meetings::atomic_write(&path, &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)?;
    let _ = app.emit_to("main", "quietnote://preferences-changed", ());
    Ok(())
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_core_audio::{
        kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        kAudioProcessPropertyBundleID, kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyPID, AudioObjectGetPropertyData,
        AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertySelector,
    };
    use objc2_foundation::NSString;
    use std::ffi::c_void;
    use std::ptr::NonNull;

    fn address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress { mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain }
    }
    fn read<T: Copy>(object: AudioObjectID, selector: AudioObjectPropertySelector, value: &mut T) -> bool {
        let mut size = std::mem::size_of::<T>() as u32;
        let status = unsafe { AudioObjectGetPropertyData(object, NonNull::from(&address(selector)), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::from(value).cast()) };
        status == 0
    }

    /// Bundle ids of the other processes using an input device right now (macOS 14.2+ process objects).
    pub fn apps_using_input() -> Vec<String> { processes().into_iter().filter(|(_, input)| *input).map(|(id, _)| id).collect() }
    /// Every other process Core Audio knows, with whether it's using an input device.
    pub fn processes() -> Vec<(String, bool)> {
        let system = kAudioObjectSystemObject as AudioObjectID;
        let list = address(kAudioHardwarePropertyProcessObjectList);
        let mut size = 0u32;
        if unsafe { AudioObjectGetPropertyDataSize(system, NonNull::from(&list), 0, std::ptr::null(), NonNull::from(&mut size)) } != 0 { return Vec::new(); }
        let mut processes = vec![0 as AudioObjectID; size as usize / std::mem::size_of::<AudioObjectID>()];
        if processes.is_empty() { return Vec::new(); }
        let status = unsafe { AudioObjectGetPropertyData(system, NonNull::from(&list), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::new_unchecked(processes.as_mut_ptr()).cast()) };
        if status != 0 { return Vec::new(); }
        processes.truncate(size as usize / std::mem::size_of::<AudioObjectID>());
        let own = std::process::id() as i32;
        processes.into_iter().filter_map(|process| {
            let (mut running, mut pid) = (0u32, 0i32);
            if read(process, kAudioProcessPropertyPID, &mut pid) && pid == own { return None; }
            let mut id: *mut c_void = std::ptr::null_mut();
            if !read(process, kAudioProcessPropertyBundleID, &mut id) || id.is_null() { return None; }
            // A CFString the caller owns; CFString is toll-free bridged to NSString.
            let id = unsafe { Retained::from_raw(id.cast::<NSString>()) }?;
            Some((id.to_string(), read(process, kAudioProcessPropertyIsRunningInput, &mut running) && running != 0))
        }).collect()
    }

    /// Rounded corners for the undecorated panel, and a place over full-screen apps (a call in full screen).
    pub fn round(window: &tauri::WebviewWindow) {
        let Ok(ns_window) = window.ns_window() else { return };
        let ns_window = ns_window.cast::<AnyObject>();
        unsafe {
            // NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary
            let _: () = msg_send![ns_window, setCollectionBehavior: (1usize << 0) | (1usize << 8)];
            let view: *mut AnyObject = msg_send![ns_window, contentView];
            if view.is_null() { return; }
            let _: () = msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![view, layer];
            if layer.is_null() { return; }
            let _: () = msg_send![layer, setCornerRadius: 14.0f64];
            let _: () = msg_send![layer, setMasksToBounds: true];
            let _: () = msg_send![ns_window, setOpaque: false];
            let clear: *mut AnyObject = msg_send![objc2::class!(NSColor), clearColor];
            let _: () = msg_send![ns_window, setBackgroundColor: clear];
            let _: () = msg_send![ns_window, invalidateShadow];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_call_apps_and_their_helpers() {
        assert_eq!(app_name("us.zoom.xos"), Some("Zoom"));
        assert_eq!(app_name("com.google.Chrome.helper"), Some("Chrome"));
        assert_eq!(app_name("company.thebrowser.browser.helper"), Some("Arc"));
        assert_eq!(app_name("com.microsoft.teams2"), Some("Microsoft Teams"));
        assert_eq!(app_name("com.microsoft.teams2.helper"), Some("Microsoft Teams"));
        assert_eq!(app_name("com.apple.WebKit.GPU"), Some("Safari"));
        assert_eq!(app_name("com.google.Chromebook"), None);
        assert_eq!(app_name("com.apple.VoiceMemos"), None);
        assert_eq!(app_name(""), None);
    }

    #[test]
    fn offers_once_after_the_microphone_is_held() {
        let (mut d, t) = (Detector::default(), Instant::now());
        assert_eq!(d.step(&["Zoom"], false, t), None);
        assert_eq!(d.step(&["Zoom"], false, t + Duration::from_secs(2)), None);
        assert_eq!(d.step(&["Zoom"], false, t + HOLD), Some(Action::Show("Zoom")));
        assert_eq!(d.step(&["Zoom"], false, t + Duration::from_secs(10)), None);
        assert_eq!(d.take(), Some("Zoom"));
        assert_eq!(d.step(&["Zoom"], false, t + Duration::from_secs(20)), None, "dismissed stays quiet during the call");
        assert_eq!(d.step(&[], false, t + Duration::from_secs(30)), None);
        assert_eq!(d.step(&["Zoom"], false, t + Duration::from_secs(40)), None);
        assert_eq!(d.step(&["Zoom"], false, t + Duration::from_secs(43)), Some(Action::Show("Zoom")), "a new call is offered again");
    }

    #[test]
    fn hides_when_the_call_ends_or_recording_starts() {
        let (mut d, t) = (Detector::default(), Instant::now());
        d.step(&["Chrome"], false, t);
        assert_eq!(d.step(&["Chrome"], false, t + HOLD), Some(Action::Show("Chrome")));
        assert_eq!(d.step(&[], false, t + Duration::from_secs(5)), Some(Action::Hide));
        d.step(&["Chrome"], false, t + Duration::from_secs(6));
        assert_eq!(d.step(&["Chrome"], false, t + Duration::from_secs(9)), Some(Action::Show("Chrome")));
        assert_eq!(d.step(&["Chrome"], true, t + Duration::from_secs(10)), Some(Action::Hide));
        assert_eq!(d.step(&["Chrome"], false, t + Duration::from_secs(20)), None, "stopping a recording mid-call doesn't offer again");
    }

    /// Lists what's using the microphone on this Mac right now: `cargo test calls_live -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn calls_live() {
        println!("Audio processes: {:?}", mac::processes());
        let apps = mac::apps_using_input();
        println!("Using the microphone: {apps:?}");
        println!("Offered as: {:?}", apps.iter().filter_map(|id| app_name(id)).collect::<Vec<_>>());
    }

    #[test]
    fn browsers_count_when_they_show_a_meeting() {
        let titles = |t: &[&str]| t.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(service(&titles(&["Inbox (3) - Gmail", "Meet - abc-defg-hij"])), Some("Google Meet"));
        assert_eq!(service(&titles(&["https://meet.google.com/abc-defg-hij"])), Some("Google Meet"));
        assert_eq!(service(&titles(&["Weekly sync | Microsoft Teams"])), Some("Microsoft Teams"));
        assert_eq!(service(&titles(&["Zoom Meeting"])), Some("Zoom"));
        assert_eq!(service(&titles(&["Standup – Whereby"])), Some("Whereby"));
        // A page that only mentions a meeting isn't one, and neither is dictating into a document.
        assert_eq!(service(&titles(&["How to meet - deadlines", "Untitled document - Google Docs"])), None);
        assert_eq!(service(&titles(&["Meeting notes - Notion"])), None);
        assert_eq!(service(&[]), None);
    }

    /// Reports what Accessibility shows of a running app: how many window and tab titles, whether one
    /// is a meeting, and with QUIETNOTE_AX_DEPTH set, its element tree with every name in it (only
    /// during a test call, to see how the app shows who is speaking):
    /// `QUIETNOTE_AX_APP=com.google.Chrome cargo test call_window_live -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn call_window_live() {
        let bundle = std::env::var("QUIETNOTE_AX_APP").unwrap_or_else(|_| "com.google.Chrome".into());
        println!("Accessibility allowed: {}", crate::ax::trusted());
        // Counts only: titles are the user's private browsing.
        let started = std::time::Instant::now();
        let titles = crate::ax::titles(&bundle);
        println!("{bundle}: {} titles and tabs read in {:?}; meeting: {:?}", titles.len(), started.elapsed(), service(&titles));
        if let Some(depth) = std::env::var("QUIETNOTE_AX_DEPTH").ok().and_then(|d| d.parse().ok()) { print!("{}", crate::ax::dump(&bundle, depth)); }
    }

    #[test]
    fn notices_when_the_recorded_call_ends() {
        let (mut e, t) = (Ender::default(), Instant::now());
        let at = |s| t + Duration::from_secs(s);
        // Recording without a call (an in-person meeting): nothing ever ends.
        assert_eq!(e.step(&[], true, at(0)), None);
        assert_eq!(e.step(&[], true, at(30)), None);
        // Zoom holds the microphone, then lets go: a short gap is a device switching, a longer one the end.
        e.step(&["Zoom"], true, at(40));
        assert_eq!(e.step(&[], true, at(42)), None);
        assert_eq!(e.step(&["Zoom"], true, at(44)), None);
        assert_eq!(e.step(&[], true, at(46)), None);
        assert_eq!(e.step(&[], true, at(52)), Some("Zoom"));
        // Once only.
        assert_eq!(e.step(&[], true, at(60)), None);
        // A call joined by another app takes over; stopping the recording forgets it.
        e.step(&["Slack"], true, at(70));
        e.step(&["Slack", "Chrome"], true, at(72));
        e.step(&["Chrome"], true, at(74));
        assert_eq!(e.step(&[], true, at(76)), None);
        assert_eq!(e.step(&[], true, at(82)), Some("Chrome"));
        e.step(&["Zoom"], true, at(90));
        assert_eq!(e.step(&[], false, at(91)), None);
        assert_eq!(e.step(&[], true, at(100)), None);
    }

    #[test]
    fn stays_quiet_while_recording() {
        let (mut d, t) = (Detector::default(), Instant::now());
        d.step(&["Zoom"], true, t);
        assert_eq!(d.step(&["Zoom"], true, t + Duration::from_secs(10)), None);
        assert_eq!(d.step(&["Zoom", "Slack"], false, t + Duration::from_secs(11)), None);
        assert_eq!(d.step(&["Zoom", "Slack"], false, t + Duration::from_secs(14)), Some(Action::Show("Slack")));
    }
}
