//! Start recording from any app (Settings → Shortcuts, `globalRecord`; unset is ⌃⌥R, empty is off). A system-wide
//! shortcut, so it works while QuietNote is hidden or another app is in front: it shows the main window and emits
//! `quietnote://record-now`, as the tray's Start recording does. It records only when pressed.
//! macOS and Windows only, where recording is real.
use tauri::AppHandle;

pub const DEFAULT: &str = "Control+Alt+R";

/// The shortcut wanted from the preference: unset is the default, empty is off.
fn wanted(value: Option<String>) -> Option<String> {
    match value {
        None => Some(DEFAULT.into()),
        Some(v) if v.is_empty() => None,
        Some(v) => Some(v),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod system {
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    /// The accelerator registered now.
    static CURRENT: Mutex<Option<String>> = Mutex::new(None);

    /// Registers `accelerator` (None: none), then lets go of the previous one, so a refused key keeps the old one working.
    pub fn register(app: &AppHandle, accelerator: Option<&str>) -> Result<(), String> {
        let mut current = CURRENT.lock().map_err(|e| e.to_string())?;
        if current.as_deref() == accelerator { return Ok(()); }
        let global = app.global_shortcut();
        if let Some(accelerator) = accelerator {
            let shortcut: Shortcut = accelerator.parse().map_err(|_| format!("“{accelerator}” isn’t a shortcut QuietNote can use."))?;
            global.on_shortcut(shortcut, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    crate::tray::show_main(app);
                    let _ = app.emit_to("main", "quietnote://record-now", ());
                }
            }).map_err(|_| "Another app already uses this shortcut. Choose another.".to_string())?;
        }
        if let Some(old) = current.as_deref().and_then(|a| a.parse::<Shortcut>().ok()) { let _ = global.unregister(old); }
        *current = accelerator.map(String::from);
        Ok(())
    }
}

/// At setup: adds the plugin, then registers the shortcut.
pub fn init(app: &AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Err(e) = app.plugin(tauri_plugin_global_shortcut::Builder::new().build()) {
        eprintln!("Couldn't start global shortcuts: {e}");
        return;
    }
    sync(app);
}

/// Matches the registration to the preference: at setup and after the preferences are saved.
pub fn sync(app: &AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let Ok(root) = crate::meetings::root(app) else { return };
        if let Err(e) = system::register(app, wanted(crate::meetings::preference_str(&root, "globalRecord")).as_deref()) {
            eprintln!("Couldn't register the Start recording shortcut: {e}");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (app, wanted);
}

/// Settings tries a new shortcut ('' turns it off) before saving it, so a key another app holds is refused with a reason.
#[tauri::command]
pub fn hotkey_set(app: AppHandle, accelerator: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    { system::register(&app, wanted(Some(accelerator)).as_deref()) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (app, accelerator); Err("Shortcuts that work from any app need macOS or Windows.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unset_is_the_default_and_empty_is_off() {
        assert_eq!(wanted(None).as_deref(), Some(DEFAULT));
        assert_eq!(wanted(Some(String::new())), None);
        assert_eq!(wanted(Some("Control+Alt+M".into())).as_deref(), Some("Control+Alt+M"));
    }
}
