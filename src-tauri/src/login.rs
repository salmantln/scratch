//! Open at login (macOS): a user LaunchAgent starts QuietNote in the menu bar when the user logs in,
//! so call detection (`calls`) is running when a meeting starts. It only opens the app, with its
//! window hidden; nothing records until the user presses Start recording. On by default, turned off
//! in Settings (`openAtLogin`).
use std::path::Path;
use tauri::AppHandle;

const LABEL: &str = "app.quietnote.desktop";
/// The argument a login launch passes, so the app starts without its window.
const BACKGROUND: &str = "--background";

/// Whether this launch came from the login item.
pub fn background(args: &[String]) -> bool { args.iter().any(|a| a == BACKGROUND) }

/// The LaunchAgent that opens `exe` at login. No `KeepAlive`: quitting QuietNote keeps it quit.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn plist(exe: &Path) -> String {
    let exe = exe.to_string_lossy().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>{BACKGROUND}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>AssociatedBundleIdentifiers</key>
  <string>{LABEL}</string>
</dict>
</plist>
"#)
}

/// Adds or removes the login item to match the preference. Only for a release build inside an app
/// bundle, so development builds never register `target/` as a login item. It takes effect at the
/// next login.
pub fn sync(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if cfg!(debug_assertions) { return; }
        let Ok(exe) = std::env::current_exe() else { return };
        if !exe.ancestors().any(|dir| dir.extension().is_some_and(|e| e == "app")) { return; }
        let (Ok(root), Ok(home)) = (crate::meetings::root(app), app.path().home_dir()) else { return };
        let agents = home.join("Library/LaunchAgents");
        let path = agents.join(format!("{LABEL}.plist"));
        if crate::meetings::preference(&root, "openAtLogin", true) {
            if std::fs::read_to_string(&path).is_ok_and(|current| current == plist(&exe)) { return; }
            let _ = std::fs::create_dir_all(&agents).map_err(|e| e.to_string()).and_then(|_| crate::meetings::atomic_write(&path, plist(&exe).as_bytes()));
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_the_app_in_the_background_at_login() {
        let agent = plist(Path::new("/Applications/Q&A <Note>.app/Contents/MacOS/quietnote"));
        assert!(agent.contains("<string>app.quietnote.desktop</string>"));
        assert!(agent.contains("<string>/Applications/Q&amp;A &lt;Note&gt;.app/Contents/MacOS/quietnote</string>\n    <string>--background</string>"));
        assert!(agent.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(!agent.contains("KeepAlive"), "quitting keeps it quit");
    }

    #[test]
    fn knows_a_login_launch() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(background(&args(&["quietnote", "--background"])));
        assert!(!background(&args(&["quietnote"])));
        assert!(!background(&args(&["quietnote", "notes.md"])));
    }
}
