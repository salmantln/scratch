//! How this Mac protects the archive. QuietNote doesn't encrypt files itself: `disk_encryption`
//! reports whether FileVault encrypts the disk (Settings → Privacy says so, or how to turn it on),
//! and recordings are kept out of Time Machine unless `backupAudio` is on, so a backup drive never
//! holds the audio. Transcripts and notes are backed up as before.
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;

/// FileVault's state from `fdesetup status`: on, off, encrypting, decrypting or unknown.
fn filevault(status: &str) -> &'static str {
    // A conversion in progress also says "FileVault is On.", so it's checked first.
    if status.contains("Encryption in progress") { "encrypting" }
    else if status.contains("Decryption in progress") { "decrypting" }
    else if status.contains("FileVault is On") { "on" }
    else if status.contains("FileVault is Off") { "off" }
    else { "unknown" }
}

/// Whether FileVault encrypts this Mac's disk; "unavailable" elsewhere.
#[tauri::command]
pub async fn disk_encryption() -> String {
    if !cfg!(target_os = "macos") { return "unavailable".into(); }
    tauri::async_runtime::spawn_blocking(|| std::process::Command::new("/usr/bin/fdesetup").arg("status").output())
        .await.ok().and_then(Result::ok)
        .map_or("unknown", |out| filevault(&String::from_utf8_lossy(&out.stdout))).into()
}

/// Whether recordings are kept out of backups, from `backupAudio` (default off).
fn excluded(root: &Path) -> bool { !crate::meetings::preference(root, "backupAudio", false) }

/// Marks a meeting's audio folder to be left out of Time Machine, or backed up again. The mark
/// stays with the folder, so the files written into it later are covered.
#[cfg(target_os = "macos")]
fn mark(dir: &Path, excluded: bool) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&dir.to_string_lossy()));
    let value = NSNumber::new_bool(excluded);
    let value: &AnyObject = &value;
    unsafe { url.setResourceValue_forKey_error(Some(value), NSURLIsExcludedFromBackupKey) }
        .map_err(|e| e.localizedDescription().to_string())
}
#[cfg(not(target_os = "macos"))]
fn mark(_: &Path, _: bool) -> Result<(), String> { Ok(()) }

/// A recording's audio folder, as it's made or continued.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub fn recording(root: &Path, audio: &Path) {
    if let Err(e) = mark(audio, excluded(root)) { eprintln!("Couldn't set Time Machine for {}: {}", audio.display(), e); }
}

/// What the audio folders were last marked as, so a preference write that doesn't change it costs nothing.
static APPLIED: Mutex<Option<bool>> = Mutex::new(None);

/// Matches every meeting's audio folder to `backupAudio` (at setup and after the preferences are written).
pub fn sync(app: &AppHandle) {
    if !cfg!(target_os = "macos") { return; }
    let Ok(root) = crate::meetings::root(app) else { return };
    let excluded = excluded(&root);
    {
        let mut applied = APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        if *applied == Some(excluded) { return; }
        *applied = Some(excluded);
    }
    std::thread::spawn(move || {
        let Ok(meetings) = crate::meetings::read_metadata(&root) else { return };
        for (_, dir) in meetings {
            let audio = dir.join(crate::capture::AUDIO);
            if audio.is_dir() { if let Err(e) = mark(&audio, excluded) { eprintln!("Couldn't set Time Machine for {}: {}", audio.display(), e); } }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_filevault_status() {
        assert_eq!(filevault("FileVault is On.\n"), "on");
        assert_eq!(filevault("FileVault is Off.\n"), "off");
        assert_eq!(filevault("FileVault is On.\nEncryption in progress: Percent completed = 34.5\n"), "encrypting");
        assert_eq!(filevault("FileVault is On.\nDecryption in progress: Percent completed = 80.1\n"), "decrypting");
        assert_eq!(filevault(""), "unknown");
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn marks_a_folder_out_of_backups_and_back() {
        let dir = std::env::temp_dir().join(format!("quietnote-protect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The temporary folder is left out of Time Machine as a whole, so the folder's own mark is read.
        let marked = |dir: &Path| String::from_utf8_lossy(&std::process::Command::new("/usr/bin/xattr").arg(dir).output().unwrap().stdout).contains("com_apple_backup_excludeItem");
        mark(&dir, true).unwrap();
        assert!(marked(&dir));
        mark(&dir, false).unwrap();
        assert!(!marked(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
