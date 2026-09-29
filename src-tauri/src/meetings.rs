//! QuietNote meeting bundles. Existing Scratch Markdown commands remain available.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    id: String,
    title: String,
    date: String,
    duration: u64,
    project: String,
    participants: Vec<String>,
    status: String,
    capture_started_at: Option<String>,
    capture_ended_at: Option<String>,
    audio_path: Option<String>,
    transcript_path: String,
    meeting_path: String,
    tags: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meeting {
    metadata: Metadata,
    markdown: String,
    transcript: String,
}
#[derive(Serialize)]
pub struct Archive { root: String, meetings: Vec<Meeting> }

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("meetings");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.canonicalize().map_err(|e| e.to_string())
}
fn safe_component(value: &str) -> bool {
    !value.is_empty() && value.len() < 200 && value != "." && value != ".."
        && value.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '))
}
fn bundle(root: &Path, metadata: &Metadata) -> Result<PathBuf, String> {
    if !safe_component(&metadata.id) || !safe_component(&metadata.project) {
        return Err("Invalid meeting or project name".into());
    }
    if metadata.meeting_path != format!("{}/{}/meeting.md", metadata.project, metadata.id)
        || metadata.transcript_path != format!("{}/{}/transcript.md", metadata.project, metadata.id) {
        return Err("Meeting paths do not match the bundle".into());
    }
    let project = root.join(&metadata.project);
    let directory = project.join(&metadata.id);
    for path in [&project, &directory] {
        if path.exists() && !path.canonicalize().map_err(|e| e.to_string())?.starts_with(root) {
            return Err("Meeting path leaves the archive".into());
        }
    }
    Ok(directory)
}
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    if path.is_symlink() { return Err("Refusing to write through a symbolic link".into()); }
    let temp = path.with_extension("quietnote-tmp");
    if temp.is_symlink() { return Err("Invalid temporary file".into()); }
    std::fs::write(&temp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}
fn write_bundle(root: &Path, meeting: &Meeting, create: bool) -> Result<(), String> {
    let dir = bundle(root, &meeting.metadata)?;
    if create && dir.join("metadata.json").exists() { return Err("Meeting already exists".into()); }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("meeting.md"), meeting.markdown.as_bytes())?;
    atomic_write(&dir.join("transcript.md"), meeting.transcript.as_bytes())?;
    atomic_write(&dir.join("metadata.json"), &serde_json::to_vec_pretty(&meeting.metadata).map_err(|e| e.to_string())?)
}
#[tauri::command]
pub async fn load_meeting_archive(app: AppHandle, seeds: Vec<Meeting>) -> Result<Archive, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&app)?;
        let marker = root.join(".initialized");
        if !marker.exists() {
            // Resume interrupted initialization without replacing user files.
            for meeting in &seeds {
                let dir = bundle(&root, &meeting.metadata)?;
                if !dir.exists() { write_bundle(&root, meeting, true)?; }
            }
            atomic_write(&marker, b"QuietNote demo archive v1")?;
        }
        let mut meetings = Vec::new();
        for entry in walkdir::WalkDir::new(&root).min_depth(3).max_depth(3).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() != "metadata.json" || !entry.file_type().is_file() { continue; }
            let metadata: Metadata = serde_json::from_slice(&std::fs::read(entry.path()).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid metadata at {}: {}", entry.path().display(), e))?;
            let dir = bundle(&root, &metadata)?;
            if dir.join("metadata.json") != entry.path() { return Err("Meeting metadata does not match its directory".into()); }
            for name in ["meeting.md", "transcript.md"] {
                if !dir.join(name).canonicalize().map_err(|e| e.to_string())?.starts_with(&root) {
                    return Err("Meeting file leaves the archive".into());
                }
            }
            meetings.push(Meeting {
                markdown: std::fs::read_to_string(dir.join("meeting.md")).map_err(|e| e.to_string())?,
                transcript: std::fs::read_to_string(dir.join("transcript.md")).map_err(|e| e.to_string())?,
                metadata,
            });
        }
        Ok(Archive { root: root.to_string_lossy().into(), meetings })
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn create_meeting_bundle(app: AppHandle, meeting: Meeting) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_bundle(&root(&app)?, &meeting, true))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_meeting_metadata(app: AppHandle, metadata: Metadata) -> Result<(), String> {
    let root = root(&app)?;
    let dir = bundle(&root, &metadata)?;
    if !dir.join("metadata.json").exists() { return Err("Meeting does not exist".into()); }
    atomic_write(&dir.join("metadata.json"), &serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?)
}
#[tauri::command]
pub async fn quietnote_preferences(app: AppHandle, value: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let path = root(&app)?.join(".privacy.json");
    if let Some(value) = value {
        atomic_write(&path, &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)?;
        return Ok(value);
    }
    if !path.exists() { return Ok(serde_json::json!({})); }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_accepts_projects() {
        for invalid in ["", ".", "..", "../Acme", "/tmp", "Acme/client", "A\\B"] { assert!(!safe_component(invalid)); }
        assert!(safe_component("Northstar"));
        assert!(safe_component("2026-09-28-acme-onboarding"));
    }
    #[test]
    fn round_trip_and_no_overwrite() {
        let root = std::env::temp_dir().join(format!("quietnote-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let meeting: Meeting = serde_json::from_str(r##"{"metadata":{"id":"meeting-1","title":"Call","date":"2026-09-28","duration":42,"project":"Acme","participants":[],"status":"ready","captureStartedAt":null,"captureEndedAt":null,"audioPath":null,"transcriptPath":"Acme/meeting-1/transcript.md","meetingPath":"Acme/meeting-1/meeting.md","tags":[]},"markdown":"# Call\n\n## Notes\nLocal notes","transcript":"Separate transcript"}"##).unwrap();
        write_bundle(&root, &meeting, true).unwrap();
        assert!(write_bundle(&root, &meeting, true).is_err());
        let dir = bundle(&root, &meeting.metadata).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("meeting.md")).unwrap(), meeting.markdown);
        assert_eq!(std::fs::read_to_string(dir.join("transcript.md")).unwrap(), meeting.transcript);
        let restored: Metadata = serde_json::from_slice(&std::fs::read(dir.join("metadata.json")).unwrap()).unwrap();
        assert_eq!(restored.id, meeting.metadata.id);
        std::fs::remove_dir_all(root).unwrap();
    }
}
