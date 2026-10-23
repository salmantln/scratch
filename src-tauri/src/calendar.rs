//! The user's calendar (macOS), through EventKit: every calendar added to the Mac (Google, Outlook or
//! Exchange, iCloud), read on this Mac with the Calendar permission. It names meetings and says who's
//! invited; it never changes the calendar, and it never starts a recording. Only while the user turns it
//! on (the `calendar` preference).
use crate::meetings::{self, Attendee};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

/// An event happening now, or starting within this long, is the "current" one (joining a few minutes early).
const EARLY_MS: i64 = 10 * 60 * 1000;
/// The tray's next meeting looks this far ahead.
const AHEAD_MS: i64 = 12 * 60 * 60 * 1000;

/// One occurrence of a calendar event.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// This occurrence: the event's id with its start, as a recurring event's occurrences share an id.
    pub id: String,
    /// The event across its occurrences and devices, so a weekly meeting's notes can follow each other.
    pub series: Option<String>,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub attendees: Vec<Attendee>,
    /// The call's link (Zoom, Meet, Teams, Webex, Whereby) from the event's URL, location or notes.
    pub link: Option<String>,
}

/// The first video call link in any of `texts`.
pub fn meeting_link(texts: &[&str]) -> Option<String> {
    static LINK: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let link = LINK.get_or_init(|| regex::Regex::new(r#"(?i)https://[^\s<>"')]*(zoom\.us/(j|my|w)/|meet\.google\.com/[a-z]+-|teams\.microsoft\.com/l/meetup-join|teams\.live\.com/meet|webex\.com/(meet|join|[a-z0-9.-]+/j\.php)|whereby\.com/)[^\s<>"')]*"#).expect("link pattern"));
    texts.iter().find_map(|t| link.find(t)).map(|m| m.as_str().trim_end_matches(['.', ',']).to_string())
}
/// An attendee from what EventKit gives: a display name (maybe missing) and a `mailto:` URL.
pub fn attendee(name: Option<&str>, url: &str, me: bool) -> Attendee {
    let email = url.get(..7).filter(|s| s.eq_ignore_ascii_case("mailto:")).map(|_| urlencoding::decode(&url[7..]).map(|e| e.into_owned()).unwrap_or_else(|_| url[7..].to_string())).unwrap_or_default().to_lowercase();
    let name = name.map(str::trim).filter(|n| !n.is_empty() && !n.contains('@')).map(String::from)
        .unwrap_or_else(|| email.split('@').next().unwrap_or_default().split(['.', '_']).filter(|w| !w.is_empty()).map(|w| { let mut c = w.chars(); c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default() }).collect::<Vec<_>>().join(" "));
    Attendee { name, email, me }
}
/// The event the user is in, or about to join: happening now or starting within 10 minutes. With
/// several, the one with a call link, then the one that started last.
pub fn current(events: &[Event], now_ms: i64) -> Option<&Event> {
    events.iter().filter(|e| e.start_ms - EARLY_MS <= now_ms && now_ms < e.end_ms).max_by_key(|e| (e.link.is_some(), e.start_ms))
}
/// The tray's line: the current event, or the next one within 12 hours.
fn next_line(events: &[Event], now_ms: i64) -> Option<(String, String)> {
    if let Some(e) = current(events, now_ms) { return Some((e.id.clone(), format!("Now: {}", e.title))); }
    let e = events.iter().filter(|e| e.start_ms > now_ms && e.start_ms - now_ms <= AHEAD_MS).min_by_key(|e| e.start_ms)?;
    let at = chrono::DateTime::from_timestamp_millis(e.start_ms).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
    Some((e.id.clone(), format!("Next: {} · {at}", e.title)))
}

fn enabled(app: &AppHandle) -> bool { meetings::root(app).is_ok_and(|root| meetings::preference(&root, "calendar", false)) }
fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }
/// Events from now (including those still going on) to `days` ahead, when the calendar is on and allowed.
pub fn upcoming(app: &AppHandle, days: u32) -> Vec<Event> {
    if !enabled(app) { return Vec::new(); }
    let from = now_ms() - 6 * 60 * 60 * 1000;
    #[cfg(target_os = "macos")]
    return mac::events(from, now_ms() + days.min(7) as i64 * 24 * 60 * 60 * 1000).into_iter().filter(|e| e.end_ms > now_ms()).collect();
    #[cfg(not(target_os = "macos"))]
    { let _ = (from, days); Vec::new() }
}

/// The tray's calendar line, recomputed every minute while the calendar is on; the menu is rebuilt only when it changes.
static NEXT: Mutex<Option<(String, String)>> = Mutex::new(None);
pub fn next() -> Option<(String, String)> { NEXT.lock().ok().and_then(|n| n.clone()) }
pub fn spawn(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            let line = next_line(&upcoming(&app, 1), now_ms());
            let changed = NEXT.lock().map(|mut n| if *n != line { *n = line; true } else { false }).unwrap_or(false);
            if changed { let _ = crate::tray::refresh(&app); }
            std::thread::sleep(Duration::from_secs(60));
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The Calendar permission: "granted", "denied", "restricted", "undetermined", or "unavailable" off macOS.
/// With `ask`, macOS asks the user first (once).
#[tauri::command]
pub async fn calendar_access(ask: bool) -> String {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || { if ask { mac::request(); } mac::access().to_string() }).await.unwrap_or_else(|_| "unavailable".into());
    #[cfg(not(target_os = "macos"))]
    { let _ = ask; "unavailable".into() }
}
/// Today's and the coming `days`' events (at most a week), soonest first.
#[tauri::command]
pub async fn calendar_events(app: AppHandle, days: u32) -> Vec<Event> {
    tauri::async_runtime::spawn_blocking(move || upcoming(&app, days)).await.unwrap_or_default()
}
/// The event the user is in or about to join, if any.
#[tauri::command]
pub async fn calendar_now(app: AppHandle) -> Option<Event> {
    tauri::async_runtime::spawn_blocking(move || current(&upcoming(&app, 1), now_ms()).cloned()).await.ok().flatten()
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{attendee, meeting_link, Event};
    use objc2::runtime::Bool;
    use objc2::AnyThread;
    use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore, EKParticipantStatus};
    use objc2_foundation::{NSDate, NSError};
    use std::time::Duration;

    pub fn access() -> &'static str {
        match unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) } {
            EKAuthorizationStatus::FullAccess => "granted",
            EKAuthorizationStatus::NotDetermined => "undetermined",
            EKAuthorizationStatus::Restricted => "restricted",
            _ => "denied",
        }
    }
    /// Asks for full access to events the first time; macOS shows its own prompt.
    pub fn request() {
        if access() != "undetermined" { return; }
        let store = unsafe { EKEventStore::init(EKEventStore::alloc()) };
        let (tx, rx) = std::sync::mpsc::channel();
        let block = block2::RcBlock::new(move |granted: Bool, _: *mut NSError| { let _ = tx.send(granted.as_bool()); });
        unsafe { store.requestFullAccessToEventsWithCompletion(block2::RcBlock::as_ptr(&block)) };
        let _ = rx.recv_timeout(Duration::from_secs(120));
    }
    pub fn events(from_ms: i64, to_ms: i64) -> Vec<Event> {
        if access() != "granted" { return Vec::new(); }
        let store = unsafe { EKEventStore::init(EKEventStore::alloc()) };
        let date = |ms: i64| NSDate::dateWithTimeIntervalSince1970(ms as f64 / 1000.0);
        let predicate = unsafe { store.predicateForEventsWithStartDate_endDate_calendars(&date(from_ms), &date(to_ms), None) };
        let mut out: Vec<Event> = unsafe { store.eventsMatchingPredicate(&predicate) }.iter().filter_map(|e| unsafe {
            let title = e.title().to_string();
            if e.isAllDay() || title.trim().is_empty() { return None; }
            let participants = e.attendees().map(|a| a.to_vec()).unwrap_or_default();
            // Declined by the user: not a meeting they're in.
            if participants.iter().any(|p| p.isCurrentUser() && p.participantStatus() == EKParticipantStatus::Declined) { return None; }
            let attendees = participants.iter().map(|p| attendee(p.name().map(|n| n.to_string()).as_deref(), &p.URL().absoluteString().map(|u| u.to_string()).unwrap_or_default(), p.isCurrentUser())).collect();
            let (url, location, notes) = (e.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()), e.location().map(|s| s.to_string()), e.notes().map(|s| s.to_string()));
            let start_ms = (e.startDate().timeIntervalSince1970() * 1000.0) as i64;
            Some(Event {
                id: format!("{}@{start_ms}", e.eventIdentifier().map(|s| s.to_string()).unwrap_or_default()),
                series: e.calendarItemExternalIdentifier().map(|s| s.to_string()).filter(|s| !s.is_empty()),
                title: title.trim().to_string(), start_ms, end_ms: (e.endDate().timeIntervalSince1970() * 1000.0) as i64, attendees,
                link: meeting_link(&[url.as_deref().unwrap_or_default(), location.as_deref().unwrap_or_default(), notes.as_deref().unwrap_or_default()]),
            })
        }).collect();
        out.sort_by_key(|e| e.start_ms);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(id: &str, start_ms: i64, end_ms: i64, link: bool) -> Event {
        Event { id: id.into(), series: None, title: id.into(), start_ms, end_ms, attendees: vec![], link: link.then(|| "https://meet.google.com/abc-defg-hij".into()) }
    }
    #[test]
    fn finds_the_call_link_in_an_invite() {
        assert_eq!(meeting_link(&["", "Room 4", "Join: https://acme.zoom.us/j/123456789?pwd=abc. Dial in…"]).as_deref(), Some("https://acme.zoom.us/j/123456789?pwd=abc"));
        assert_eq!(meeting_link(&["https://meet.google.com/abc-defg-hij"]).as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        assert!(meeting_link(&["<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y>"]).unwrap().starts_with("https://teams.microsoft.com/l/meetup-join/"));
        assert_eq!(meeting_link(&["https://example.com/agenda", "Lunch at Rosa's"]), None);
    }
    #[test]
    fn names_attendees_by_their_name_or_their_email() {
        assert_eq!(attendee(Some("Maria Lopez"), "mailto:Maria.Lopez@Acme.com", false), Attendee { name: "Maria Lopez".into(), email: "maria.lopez@acme.com".into(), me: false });
        assert_eq!(attendee(None, "mailto:tom_baker%2Bwork@acme.com", true), Attendee { name: "Tom Baker+work".into(), email: "tom_baker+work@acme.com".into(), me: true });
        assert_eq!(attendee(Some("sam@acme.com"), "mailto:sam@acme.com", false).name, "Sam");
        assert_eq!(attendee(Some("Room 4"), "urn:x-room", false), Attendee { name: "Room 4".into(), email: String::new(), me: false });
    }
    #[test]
    fn the_current_event_is_the_one_being_joined() {
        let m = 60_000;
        let events = [event("standup", 0, 15 * m, false), event("sync", 25 * m, 55 * m, true), event("review", 30 * m, 60 * m, false)];
        assert_eq!(current(&events, 5 * m).map(|e| e.id.as_str()), Some("standup"));
        // Ten minutes early counts; with two candidates, the one with a call link.
        assert_eq!(current(&events, 20 * m).map(|e| e.id.as_str()), Some("sync"));
        assert_eq!(current(&events, 58 * m).map(|e| e.id.as_str()), Some("review"));
        assert_eq!(current(&events, 61 * m), None);
        assert_eq!(next_line(&events, 5 * m).map(|l| l.1), Some("Now: standup".into()));
        assert!(next_line(&events, -60 * m).unwrap().1.starts_with("Next: standup · "));
        assert_eq!(next_line(&events, 13 * 60 * m), None);
    }
    /// Reports this Mac's Calendar access and how many events the coming week has, with how many have
    /// attendees and a call link. Counts only, as titles and names are private:
    /// `cargo test calendar_live -- --ignored --nocapture` (it never asks for access itself).
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn calendar_live() {
        println!("access: {}", mac::access());
        let events = mac::events(now_ms(), now_ms() + 7 * 24 * 60 * 60 * 1000);
        println!("{} events in the next 7 days; {} with attendees, {} with a call link, {} recurring; current: {}",
            events.len(), events.iter().filter(|e| e.attendees.len() > 1).count(), events.iter().filter(|e| e.link.is_some()).count(),
            events.iter().filter(|e| e.series.is_some()).count(), current(&events, now_ms()).is_some());
    }
}
