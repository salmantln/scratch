//! Open at login (macOS): QuietNote is the user's login item (`SMAppService`, listed in System
//! Settings → General → Login Items, as Granola is), so call detection (`calls`) is running when a
//! meeting starts. A login launch keeps the window hidden; nothing records until the user presses
//! Start recording. On by default, turned off in Settings (`openAtLogin`) or in System Settings.
use tauri::AppHandle;

/// The argument the LaunchAgent of earlier builds passed, so the app starts without its window.
const BACKGROUND: &str = "--background";
/// That LaunchAgent, removed so QuietNote doesn't open twice at login.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const LEGACY: &str = "Library/LaunchAgents/app.quietnote.desktop.plist";
/// In the app data folder once QuietNote has registered itself, so a login item the user removed
/// in System Settings isn't added back.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const REGISTERED: &str = "login-item";

/// Whether this launch came from the login item: macOS marks the open-application event of a login
/// launch (`keyAELaunchedAsLogInItem`). Read during setup, while that event is being handled.
pub fn background(args: &[String]) -> bool { args.iter().any(|a| a == BACKGROUND) || at_login() }

#[cfg(target_os = "macos")]
fn at_login() -> bool {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};
    const PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
    const LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
    let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else { return false };
    let data: Option<Retained<NSAppleEventDescriptor>> = unsafe { msg_send![&*event, paramDescriptorForKeyword: PROP_DATA] };
    data.is_some_and(|d| d.enumCodeValue() == LOGIN_ITEM)
}
#[cfg(not(target_os = "macos"))]
fn at_login() -> bool { false }

/// What to do about the login item, from the preference, the system's status and whether
/// QuietNote registered it before.
#[derive(Debug, PartialEq)]
enum Step { Register, Unregister, TurnedOff, Keep }

fn step(wanted: bool, on: bool, registered: bool) -> Step {
    match (wanted, on, registered) {
        (true, true, _) | (false, false, _) => Step::Keep,
        // Registered once and gone now: removed in System Settings, so the preference follows.
        (true, false, true) => Step::TurnedOff,
        (true, false, false) => Step::Register,
        (false, true, _) => Step::Unregister,
    }
}

/// Matches the login item to the preference. Only for a release build inside an app bundle, so
/// development builds never register themselves.
pub fn sync(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        use tauri::{Emitter, Manager};
        if cfg!(debug_assertions) { return; }
        let Ok(exe) = std::env::current_exe() else { return };
        if !exe.ancestors().any(|dir| dir.extension().is_some_and(|e| e == "app")) { return; }
        let (Ok(root), Ok(data)) = (crate::meetings::root(app), app.path().app_data_dir()) else { return };
        if let Ok(home) = app.path().home_dir() { let _ = std::fs::remove_file(home.join(LEGACY)); }
        let marker = data.join(REGISTERED);
        let service = unsafe { SMAppService::mainAppService() };
        let status = unsafe { service.status() };
        // Waiting for approval in System Settings counts as on: it's the user's to allow.
        let on = status == SMAppServiceStatus::Enabled || status == SMAppServiceStatus::RequiresApproval;
        match step(crate::meetings::preference(&root, "openAtLogin", true), on, marker.exists()) {
            Step::Register => if unsafe { service.registerAndReturnError() }.is_ok() { let _ = std::fs::write(&marker, ""); },
            Step::Unregister => { let _ = unsafe { service.unregisterAndReturnError() }; let _ = std::fs::remove_file(&marker); }
            Step::TurnedOff => {
                let _ = crate::meetings::set_preference(&root, "openAtLogin", false.into());
                let _ = std::fs::remove_file(&marker);
                // So the window shows it off, and doesn't write it back on with its other settings.
                let _ = app.emit_to("main", "quietnote://preferences-changed", ());
            }
            Step::Keep => if on { let _ = std::fs::write(&marker, ""); } else { let _ = std::fs::remove_file(&marker); },
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_preference_without_fighting_system_settings() {
        assert_eq!(step(true, false, false), Step::Register, "first launch adds it");
        assert_eq!(step(true, true, true), Step::Keep);
        assert_eq!(step(true, false, true), Step::TurnedOff, "removed in System Settings stays removed");
        assert_eq!(step(false, true, true), Step::Unregister);
        assert_eq!(step(false, false, false), Step::Keep);
    }

    #[test]
    fn knows_a_login_launch_from_earlier_builds() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(background(&args(&["quietnote", "--background"])));
    }
}
