//! QuietNote meeting bundles. Existing Scratch Markdown commands remain available.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) date: String,
    pub(crate) duration: u64,
    pub(crate) project: String,
    pub(crate) participants: Vec<String>,
    pub(crate) status: String,
    pub(crate) capture_started_at: Option<String>,
    pub(crate) capture_ended_at: Option<String>,
    pub(crate) audio_path: Option<String>,
    pub(crate) transcript_path: String,
    pub(crate) meeting_path: String,
    pub(crate) tags: Vec<String>,
    /// Recovered after QuietNote closed mid-recording (a crash or force quit), until dismissed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) interrupted: bool,
    /// Why the last transcription failed; the audio is kept for a retry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meeting {
    metadata: Metadata,
    markdown: String,
    transcript: String,
}
#[derive(Serialize)]
pub struct Archive { root: String, projects: Vec<String>, meetings: Vec<Meeting> }

pub(crate) fn root(app: &AppHandle) -> Result<PathBuf, String> {
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
        || metadata.transcript_path != format!("{}/{}/transcript.md", metadata.project, metadata.id)
        || metadata.audio_path.as_ref().is_some_and(|p| *p != format!("{}/{}/audio", metadata.project, metadata.id)) {
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
pub(crate) fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
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
fn list_projects(root: &Path) -> Result<Vec<String>, String> {
    let mut projects = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() && safe_component(&name) { projects.push(name); }
    }
    projects.sort_by_key(|name| name.to_lowercase());
    Ok(projects)
}
pub(crate) fn read_metadata(root: &Path) -> Result<Vec<(Metadata, PathBuf)>, String> {
    let mut found = Vec::new();
    for entry in walkdir::WalkDir::new(root).min_depth(3).max_depth(3).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() != "metadata.json" || !entry.file_type().is_file() { continue; }
        let metadata: Metadata = serde_json::from_slice(&std::fs::read(entry.path()).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid metadata at {}: {}", entry.path().display(), e))?;
        let dir = bundle(root, &metadata)?;
        if dir.join("metadata.json") != entry.path() { return Err("Meeting metadata does not match its directory".into()); }
        for name in ["meeting.md", "transcript.md"] {
            if !dir.join(name).canonicalize().map_err(|e| e.to_string())?.starts_with(root) {
                return Err("Meeting file leaves the archive".into());
            }
        }
        found.push((metadata, dir));
    }
    Ok(found)
}
/// A meeting's metadata and folder.
pub(crate) fn find(root: &Path, id: &str) -> Result<(Metadata, PathBuf), String> {
    read_metadata(root)?.into_iter().find(|(m, _)| m.id == id).ok_or_else(|| "This meeting no longer exists".into())
}
pub(crate) fn write_metadata(dir: &Path, metadata: &Metadata) -> Result<(), String> {
    atomic_write(&dir.join("metadata.json"), &serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?)
}
/// A boolean privacy preference from `.privacy.json`, or `fallback` when unset.
pub(crate) fn preference(root: &Path, key: &str, fallback: bool) -> bool {
    std::fs::read(root.join(".privacy.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get(key).and_then(|v| v.as_bool()))
        .unwrap_or(fallback)
}
fn read_archive(root: &Path) -> Result<Archive, String> {
    let mut meetings = Vec::new();
    for (metadata, dir) in read_metadata(root)? {
        meetings.push(Meeting {
            markdown: std::fs::read_to_string(dir.join("meeting.md")).map_err(|e| e.to_string())?,
            transcript: std::fs::read_to_string(dir.join("transcript.md")).map_err(|e| e.to_string())?,
            metadata,
        });
    }
    Ok(Archive { root: root.to_string_lossy().into(), projects: list_projects(root)?, meetings })
}
/// Projects, and the newest meetings as `(id, title)`.
pub(crate) type Listing = (Vec<String>, Vec<(String, String)>);
/// Reads metadata only and sorts like the library.
fn listing(root: &Path, limit: usize) -> Result<Listing, String> {
    let mut all: Vec<Metadata> = read_metadata(root)?.into_iter().map(|(m, _)| m).collect();
    all.sort_by(|a, b| b.date.cmp(&a.date));
    Ok((list_projects(root)?, all.into_iter().take(limit).map(|m| (m.id, m.title)).collect()))
}
pub(crate) fn tray_listing(app: &AppHandle, limit: usize) -> Result<Listing, String> {
    listing(&root(app)?, limit)
}
fn make_project(root: &Path, name: &str) -> Result<(), String> {
    if !safe_component(name) { return Err("Use letters, numbers, spaces, hyphens or underscores".into()); }
    if list_projects(root)?.iter().any(|p| p.eq_ignore_ascii_case(name)) { return Err("A project with this name already exists".into()); }
    let path = root.join(name);
    if path.exists() { return Err("A file with this name already exists in the archive".into()); }
    std::fs::create_dir(&path).map_err(|e| e.to_string())?;
    if !path.canonicalize().map_err(|e| e.to_string())?.starts_with(root) { return Err("Project path leaves the archive".into()); }
    Ok(())
}
#[tauri::command]
pub async fn load_meeting_archive(app: AppHandle) -> Result<Archive, String> {
    tauri::async_runtime::spawn_blocking(move || read_archive(&root(&app)?))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn create_project(app: AppHandle, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || make_project(&root(&app)?, name.trim()))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn create_meeting_bundle(app: AppHandle, meeting: Meeting) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_bundle(&root(&app)?, &meeting, true))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_meeting_metadata(app: AppHandle, metadata: Metadata) -> Result<(), String> {
    // While recording or transcribing, the Rust side owns the meeting's status.
    if app.state::<crate::capture::Capture>().owns(&metadata.id) { return Err("This meeting is recording or being transcribed".into()); }
    let root = root(&app)?;
    let dir = bundle(&root, &metadata)?;
    if !dir.join("metadata.json").exists() { return Err("Meeting does not exist".into()); }
    write_metadata(&dir, &metadata)
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
        // The recovery fields are optional on disk and left out when unset.
        assert!(!restored.interrupted && restored.error.is_none());
        assert!(!std::fs::read_to_string(dir.join("metadata.json")).unwrap().contains("interrupted"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn projects_are_directories_and_names_are_validated() {
        let root = std::env::temp_dir().join(format!("quietnote-projects-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".scratch")).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join(".privacy.json"), "{}").unwrap();
        make_project(&root, "Northstar").unwrap();
        make_project(&root, "acme").unwrap();
        assert!(make_project(&root, "ACME").is_err());
        assert!(make_project(&root, "../Escape").is_err());
        assert!(make_project(&root, "").is_err());
        let archive = read_archive(&root).unwrap();
        assert_eq!(archive.projects, vec!["acme".to_string(), "Northstar".to_string()]);
        assert!(archive.meetings.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn listing_returns_newest_meetings_and_projects() {
        let root = std::env::temp_dir().join(format!("quietnote-listing-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        make_project(&root, "Empty").unwrap();
        for (id, date, project) in [("m1", "2026-09-01T10:00:00Z", "Acme"), ("m2", "2026-09-03T10:00:00Z", "Northstar"), ("m3", "2026-09-02T10:00:00Z", "Acme"), ("m4", "2026-09-04T10:00:00Z", "Acme")] {
            let meeting: Meeting = serde_json::from_value(serde_json::json!({"metadata":{"id":id,"title":format!("Meeting {id}"),"date":date,"duration":0,"project":project,"participants":[],"status":"idle","captureStartedAt":null,"captureEndedAt":null,"audioPath":null,"transcriptPath":format!("{project}/{id}/transcript.md"),"meetingPath":format!("{project}/{id}/meeting.md"),"tags":[]},"markdown":"","transcript":""})).unwrap();
            write_bundle(&root, &meeting, true).unwrap();
        }
        let (projects, recent) = listing(&root, 3).unwrap();
        assert_eq!(projects, vec!["Acme", "Empty", "Northstar"]);
        assert_eq!(recent.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), vec!["m4", "m2", "m3"]);
        assert_eq!(recent[0].1, "Meeting m4");
        std::fs::remove_dir_all(root).unwrap();
    }
}
