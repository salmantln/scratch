//! Recording and transcription lifecycle. Rust owns capture so it keeps going while the window is
//! hidden, and the tray can stop it. A meeting moves idle → recording → processing → ready, or to
//! error with its audio kept for a retry. Nothing starts recording except an explicit start.
use crate::meetings::{self, Metadata};
use crate::transcript::{self, Transcript};
use crate::tray;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

pub const AUDIO: &str = "audio";
const TRACKS: [&str; 2] = ["mic.wav", "system.wav"];
/// Written in the audio folder while Whisper runs, with the attempt count, so a transcription that
/// crashes QuietNote is retried once and then left for the user rather than crashing every launch.
const MARKER: &str = ".transcribing";
const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));
const UNSUPPORTED: &str = "Recording isn’t available on this platform yet.";
const BUSY: &str = "Another meeting is already recording. Stop it first.";
/// A track with no sound at all after this long is reported as silent (permission off, muted mic).
const SILENT_AFTER: Duration = Duration::from_secs(20);
/// Recording needs this much free space to start, and warns below it (two tracks use about 230 MB an hour).
const LOW_DISK: u64 = 1 << 30;
/// Below this, recording stops cleanly so the audio so far stays valid.
const FULL_DISK: u64 = 150 << 20;

struct Session {
    meeting_id: String,
    title: String,
    started_at: String,
    /// Wall-clock start: the window and the tray both count elapsed time from it.
    wall: SystemTime,
    started: Instant,
    disk: Option<String>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    recording: crate::recorder::Recording,
}
impl Session {
    fn elapsed(&self) -> Duration { SystemTime::now().duration_since(self.wall).unwrap_or_default() }
}
#[derive(Default)]
struct Jobs { queue: VecDeque<String>, current: Option<Progress>, worker: bool }

#[derive(Default)]
pub struct Capture { session: Mutex<Option<Session>>, starting: AtomicBool, jobs: Mutex<Jobs>, wake: Condvar, model: OnceLock<&'static str> }
/// Held while a recording starts; a second start is refused until it's released.
struct Claim<'a>(&'a AtomicBool);
impl Drop for Claim<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
impl Capture {
    /// Whether Rust is recording or transcribing this meeting, so its status mustn't be overwritten.
    pub fn owns(&self, id: &str) -> bool {
        self.session.lock().is_ok_and(|s| s.as_ref().is_some_and(|s| s.meeting_id == id))
            || self.jobs.lock().is_ok_and(|j| j.queue.iter().any(|q| q == id) || j.current.as_ref().is_some_and(|c| c.meeting_id == id))
    }
    /// One recording at a time: refused while one runs or is starting.
    fn claim(&self) -> Result<Claim<'_>, String> {
        if self.session.lock().map_err(|e| e.to_string())?.is_some() || self.starting.swap(true, Ordering::SeqCst) { return Err(BUSY.into()); }
        Ok(Claim(&self.starting))
    }
}

/// A command error the UI can act on: `mic-denied` offers System Settings, `disk` explains space.
#[derive(Debug, Serialize)]
pub struct Failure { code: &'static str, message: String }
impl From<String> for Failure { fn from(message: String) -> Self { Failure { code: "failed", message } } }

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level { Waiting, Heard, Silent }
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pub meeting_id: String,
    pub title: String,
    pub started_at: String,
    pub mic: Level,
    pub system: Level,
    pub mic_device: Option<String>,
    pub system_device: Option<String>,
    /// Something is wrong right now (a device is gone, the disk is low).
    pub problem: Option<String>,
    /// The latest device change, for information.
    pub note: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress { pub meeting_id: String, pub title: String, pub percent: u8 }
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub available: bool,
    /// The microphone permission: granted, denied, undetermined (never asked) or unknown.
    pub microphone: &'static str,
    /// The bundled speech model: ready, missing or damaged.
    pub model: &'static str,
    pub recording: Option<Live>,
    pub transcribing: Option<Progress>,
    pub queued: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed { metadata: Metadata, transcript: Option<String>, problem: Option<String> }

fn microphone() -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return crate::recorder::microphone_permission();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    "unknown"
}
fn model(app: &AppHandle) -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return match crate::transcribe::status(app) {
        crate::transcribe::ModelStatus::Ready => "ready",
        crate::transcribe::ModelStatus::Missing => "missing",
        crate::transcribe::ModelStatus::Damaged => "damaged",
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = app; "missing" }
}
pub fn snapshot(app: &AppHandle) -> State {
    let capture = app.state::<Capture>();
    let recording = capture.session.lock().ok().and_then(|s| s.as_ref().map(|s| {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let (heard, problem, note, devices) = { let h = &s.recording.health; (h.heard(), h.problem(), h.note(), h.devices()) };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let (heard, problem, note, devices): ([bool; 2], Option<String>, Option<String>, [Option<String>; 2]) = Default::default();
        let level = |heard: bool| if heard { Level::Heard } else if s.started.elapsed() >= SILENT_AFTER { Level::Silent } else { Level::Waiting };
        let problem = [problem, s.disk.clone()].into_iter().flatten().reduce(|a, b| format!("{a} {b}"));
        let [mic_device, system_device] = devices;
        Live { meeting_id: s.meeting_id.clone(), title: s.title.clone(), started_at: s.started_at.clone(), mic: level(heard[0]), system: level(heard[1]), mic_device, system_device, problem, note }
    }));
    let jobs = capture.jobs.lock();
    let (transcribing, queued) = jobs.map(|j| (j.current.clone(), j.queue.iter().cloned().collect())).unwrap_or_default();
    let model = *capture.model.get_or_init(|| model(app));
    State { available: SUPPORTED, microphone: microphone(), model, recording, transcribing, queued }
}
/// Tells the window and the tray that capture state changed.
fn publish(app: &AppHandle) {
    let _ = app.emit("quietnote://capture-state", snapshot(app));
    let _ = tray::refresh(app);
}
fn changed(app: &AppHandle, metadata: &Metadata, transcript: Option<String>, problem: Option<String>) {
    let _ = app.emit("quietnote://meeting-changed", Changed { metadata: metadata.clone(), transcript, problem });
}
fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }

#[derive(Debug, PartialEq)]
enum Disk { Fine, Low, Full }
fn disk(free: u64) -> Disk { if free < FULL_DISK { Disk::Full } else if free < LOW_DISK { Disk::Low } else { Disk::Fine } }
fn free_space(path: &Path) -> Option<u64> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return fs4::available_space(path).ok();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = path; None }
}
fn megabytes(bytes: u64) -> u64 { bytes >> 20 }

/// Starts recording a meeting that hasn't been captured yet.
pub fn start(app: &AppHandle, id: &str) -> Result<Metadata, Failure> {
    if !SUPPORTED { return Err(UNSUPPORTED.to_string().into()); }
    let capture = app.state::<Capture>();
    // The first start can wait on the microphone permission prompt, so no lock is held meanwhile.
    let claim = capture.claim()?;
    let metadata = begin(app, id)?;
    drop(claim);
    spawn_ticker(app.clone(), metadata.id.clone());
    publish(app);
    changed(app, &metadata, None, None);
    Ok(metadata)
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn begin(app: &AppHandle, id: &str) -> Result<Metadata, Failure> {
    let capture = app.state::<Capture>();
    if capture.owns(id) { return Err("This meeting is being transcribed.".to_string().into()); }
    let root = meetings::root(app)?;
    let (mut metadata, dir) = meetings::find(&root, id)?;
    if metadata.status != "idle" { return Err("This meeting has already been recorded.".to_string().into()); }
    if let Some(free) = free_space(&root).filter(|f| disk(*f) != Disk::Fine) {
        return Err(Failure { code: "disk", message: format!("Not enough disk space to record: {} MB free. Free up at least 1 GB and try again.", megabytes(free)) });
    }
    let audio = dir.join(AUDIO);
    // Left over from a start that failed before the meeting was marked as recording.
    if audio.exists() { std::fs::remove_dir_all(&audio).map_err(|e| e.to_string())?; }
    std::fs::create_dir_all(&audio).map_err(|e| e.to_string())?;
    let recording = match crate::recorder::start(&audio) {
        Ok(recording) => recording,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&audio);
            return Err(Failure { code: if e == crate::recorder::MIC_DENIED { "mic-denied" } else { "failed" }, message: e });
        }
    };
    let (wall, started_at) = (SystemTime::now(), now());
    metadata.status = "recording".into();
    metadata.capture_started_at = Some(started_at.clone());
    metadata.audio_path = Some(format!("{}/{}/{AUDIO}", metadata.project, metadata.id));
    if let Err(e) = meetings::write_metadata(&dir, &metadata) {
        drop(recording);
        let _ = std::fs::remove_dir_all(&audio);
        return Err(e.into());
    }
    *capture.session.lock().map_err(|e| e.to_string())? = Some(Session { meeting_id: metadata.id.clone(), title: metadata.title.clone(), started_at, wall, started: Instant::now(), disk: None, recording });
    Ok(metadata)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn begin(_: &AppHandle, _: &str) -> Result<Metadata, Failure> { Err(UNSUPPORTED.to_string().into()) }

/// Stops the current recording, finalizes the audio and queues transcription. `reason` explains a
/// stop the user didn't ask for (the disk filled up).
pub fn stop(app: &AppHandle, reason: Option<String>) -> Result<Metadata, String> {
    let session = app.state::<Capture>().session.lock().map_err(|e| e.to_string())?.take().ok_or("Nothing is recording.")?;
    let duration = session.elapsed().as_secs();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let finished = session.recording.stop();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let finished: Result<(), String> = Ok(());
    tray::recording_tick(app, None);
    let root = meetings::root(app)?;
    let (mut metadata, dir) = meetings::find(&root, &session.meeting_id)?;
    metadata.status = "processing".into();
    metadata.capture_ended_at = Some(now());
    metadata.duration = duration;
    meetings::write_metadata(&dir, &metadata)?;
    enqueue(app, &metadata.id);
    let problem = [reason, finished.err().map(|e| format!("The end of the recording may be incomplete. {e}"))].into_iter().flatten().reduce(|a, b| format!("{a} {b}"));
    changed(app, &metadata, None, problem);
    publish(app);
    Ok(metadata)
}

/// While recording: the tray's elapsed time every second, a state update when a track's health
/// changes, and a disk check every 30 seconds.
fn spawn_ticker(app: AppHandle, id: String) {
    std::thread::spawn(move || {
        let mut last = None;
        let mut checked = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let capture = app.state::<Capture>();
            let Some(elapsed) = capture.session.lock().ok().and_then(|s| s.as_ref().filter(|s| s.meeting_id == id).map(Session::elapsed)) else { break };
            tray::recording_tick(&app, Some(elapsed));
            if checked.elapsed() >= Duration::from_secs(30) {
                checked = Instant::now();
                let free = meetings::root(&app).ok().and_then(|root| free_space(&root));
                match free.map(disk) {
                    Some(Disk::Full) => {
                        let _ = stop(&app, Some("Recording stopped: the disk is almost full. The audio up to now was saved and will be transcribed.".into()));
                        break;
                    }
                    level => {
                        let warning = (level == Some(Disk::Low)).then(|| format!("Disk space is low ({} MB free). Recording continues.", megabytes(free.unwrap_or(0))));
                        if let Ok(mut session) = capture.session.lock() { if let Some(s) = session.as_mut() { s.disk = warning; } }
                    }
                }
            }
            let Some(live) = snapshot(&app).recording.filter(|l| l.meeting_id == id) else { break };
            let health = (live.mic, live.system, live.problem, live.note, live.mic_device, live.system_device);
            if last.as_ref() != Some(&health) {
                if last.is_some() { publish(&app); }
                last = Some(health);
            }
        }
    });
}

fn enqueue(app: &AppHandle, id: &str) {
    let capture = app.state::<Capture>();
    let Ok(mut jobs) = capture.jobs.lock() else { return };
    if !jobs.queue.iter().any(|q| q == id) { jobs.queue.push_back(id.into()); }
    if !jobs.worker {
        jobs.worker = true;
        let app = app.clone();
        std::thread::Builder::new().name("quietnote-transcribe".into()).spawn(move || work(app)).ok();
    }
    capture.wake.notify_one();
}
fn work(app: AppHandle) {
    let capture = app.state::<Capture>();
    loop {
        let id = {
            let Ok(mut jobs) = capture.jobs.lock() else { return };
            loop {
                if let Some(id) = jobs.queue.pop_front() {
                    jobs.current = Some(Progress { meeting_id: id.clone(), title: String::new(), percent: 0 });
                    break id;
                }
                let Ok(next) = capture.wake.wait(jobs) else { return };
                jobs = next;
            }
        };
        publish(&app);
        let outcome = process(&app, &id);
        if let Ok(mut jobs) = capture.jobs.lock() { jobs.current = None; }
        tray::progress(&app, None);
        match outcome {
            Ok(Some((metadata, markdown))) => changed(&app, &metadata, Some(markdown), None),
            Ok(None) => {}
            Err(e) => if let Ok(metadata) = meetings::root(&app).and_then(|root| record_failure(&root, &id, &e)) {
                // The reason is kept in `metadata.error` and shown under Details on the meeting.
                changed(&app, &metadata, None, Some(format!("Transcription of “{}” couldn’t finish. Your recording is still saved; open the meeting to retry.", metadata.title)));
            },
        }
        publish(&app);
    }
}
fn set_progress(app: &AppHandle, id: &str, title: Option<&str>, percent: u8) {
    let capture = app.state::<Capture>();
    let Ok(mut jobs) = capture.jobs.lock() else { return };
    let Some(current) = jobs.current.as_mut().filter(|c| c.meeting_id == id) else { return };
    if let Some(title) = title { current.title = title.into(); }
    if current.percent == percent && title.is_none() { return; }
    current.percent = percent;
    let label = format!("Transcribing {}… {percent}%", current.title);
    drop(jobs);
    tray::progress(app, Some(&label));
    let _ = app.emit("quietnote://capture-state", snapshot(app));
}
fn attempts(audio: &Path) -> u32 { std::fs::read_to_string(audio.join(MARKER)).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0) }
/// Transcribes a `processing` meeting. `None` when there was nothing to do.
fn process(app: &AppHandle, id: &str) -> Result<Option<(Metadata, String)>, String> {
    let root = meetings::root(app)?;
    let (metadata, dir) = meetings::find(&root, id)?;
    if metadata.status != "processing" { return Ok(None); }
    set_progress(app, id, Some(&metadata.title), 0);
    let audio = dir.join(AUDIO);
    if !audio.is_dir() { return Err("The audio for this meeting is missing.".into()); }
    for track in TRACKS { let _ = repair_wav(&audio.join(track)); }
    std::fs::write(audio.join(MARKER), (attempts(&audio) + 1).to_string()).map_err(|e| e.to_string())?;
    let [mic, system] = recognize(app, &audio, id)?;
    let (turns, echo) = transcript::merge(mic, system);
    save_transcript(&root, id, &Transcript { version: 1, model: model_name().into(), turns, echo }).map(Some)
}
/// Saves a finished transcription in an order that never loses audio: the transcript, then `ready`,
/// and only then, if the user chose it, the audio is deleted.
fn save_transcript(root: &Path, id: &str, transcript: &Transcript) -> Result<(Metadata, String), String> {
    let (mut metadata, dir) = meetings::find(root, id)?;
    let markdown = transcript::markdown(transcript, meetings::preference(root, "cleanTranscript", true));
    meetings::atomic_write(&dir.join("transcript.json"), &serde_json::to_vec_pretty(transcript).map_err(|e| e.to_string())?)?;
    meetings::atomic_write(&dir.join("transcript.md"), markdown.as_bytes())?;
    metadata.status = "ready".into();
    metadata.error = None;
    meetings::write_metadata(&dir, &metadata)?;
    let audio = dir.join(AUDIO);
    let _ = std::fs::remove_file(audio.join(MARKER));
    if meetings::preference(root, "deleteAudio", false) && std::fs::remove_dir_all(&audio).is_ok() {
        metadata.audio_path = None;
        // The meeting is already ready; a stale audio path only means Show audio finds nothing.
        let _ = meetings::write_metadata(&dir, &metadata);
    }
    Ok((metadata, markdown))
}
/// A failed transcription: the meeting needs attention, the reason is kept, and the audio stays.
fn record_failure(root: &Path, id: &str, error: &str) -> Result<Metadata, String> {
    let (mut metadata, dir) = meetings::find(root, id)?;
    metadata.status = "error".into();
    metadata.error = Some(error.into());
    meetings::write_metadata(&dir, &metadata)?;
    let _ = std::fs::remove_file(dir.join(AUDIO).join(MARKER));
    Ok(metadata)
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn recognize(app: &AppHandle, audio: &Path, id: &str) -> Result<[Vec<transcript::Piece>; 2], String> {
    let (handle, id) = (app.clone(), id.to_string());
    crate::transcribe::run(app, audio, std::sync::Arc::new(move |percent| set_progress(&handle, &id, None, percent)))
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn recognize(_: &AppHandle, _: &Path, _: &str) -> Result<[Vec<transcript::Piece>; 2], String> { Err(UNSUPPORTED.into()) }
fn model_name() -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return crate::transcribe::MODEL.trim_end_matches(".bin");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    ""
}

/// Fixes the size fields of a WAV file that wasn't finalized (QuietNote was force-quit or crashed),
/// so everything written up to the last flush plays and transcribes. Returns the audio duration.
pub(crate) fn repair_wav(path: &Path) -> std::io::Result<Duration> {
    use std::io::{Error, ErrorKind, Read, Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let len = file.metadata()?.len();
    let mut header = vec![0u8; len.min(4096) as usize];
    file.read_exact(&mut header)?;
    let invalid = || Error::new(ErrorKind::InvalidData, "Not a WAV file");
    if header.len() < 12 || &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" { return Err(invalid()); }
    let (mut at, mut block, mut rate) = (12usize, 2u64, 16_000u64);
    while at + 8 <= header.len() {
        let size = u32::from_le_bytes(header[at + 4..at + 8].try_into().map_err(|_| invalid())?) as usize;
        if &header[at..at + 4] == b"fmt " && at + 22 <= header.len() {
            rate = u32::from_le_bytes(header[at + 12..at + 16].try_into().map_err(|_| invalid())?).max(1) as u64;
            block = u16::from_le_bytes([header[at + 20], header[at + 21]]).max(1) as u64;
        }
        if &header[at..at + 4] == b"data" {
            let start = at as u64 + 8;
            let data = (len.saturating_sub(start) / block * block).min(u32::MAX as u64 - start);
            file.seek(SeekFrom::Start(4))?;
            file.write_all(&((start + data - 8) as u32).to_le_bytes())?;
            file.seek(SeekFrom::Start(at as u64 + 4))?;
            file.write_all(&(data as u32).to_le_bytes())?;
            return Ok(Duration::from_secs_f64(data as f64 / block as f64 / rate as f64));
        }
        at += 8 + size + (size & 1);
    }
    Err(invalid())
}

/// At launch: a recording cut short by a crash or force quit is recovered from its audio, flagged
/// `interrupted` so the UI says so, and transcribed; one with no audio needs attention. A stopped
/// recording waiting for transcription is queued. A transcription that was running when QuietNote
/// closed is retried once; if that closes QuietNote again, it waits for the user.
pub fn recover(app: &AppHandle) {
    let Ok(root) = meetings::root(app) else { return };
    let _ = recover_archive(&root, |id| enqueue(app, id));
}
fn recover_archive(root: &Path, mut queue: impl FnMut(&str)) -> Result<(), String> {
    for (mut metadata, dir) in meetings::read_metadata(root)? {
        if metadata.status != "recording" && metadata.status != "processing" { continue; }
        let audio = dir.join(AUDIO);
        let recovered = TRACKS.iter().filter_map(|t| repair_wav(&audio.join(t)).ok()).max().filter(|d| !d.is_zero());
        let Some(duration) = recovered.filter(|_| SUPPORTED && metadata.audio_path.is_some()) else {
            if metadata.status == "processing" { metadata.error = Some("The audio for this meeting is missing, so it can’t be transcribed.".into()); }
            metadata.status = "error".into();
            meetings::write_metadata(&dir, &metadata)?;
            continue;
        };
        if metadata.status == "recording" {
            metadata.interrupted = true;
            metadata.duration = duration.as_secs();
            metadata.capture_ended_at = metadata.capture_started_at.as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|s| (s + duration).to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            metadata.status = "processing".into();
        } else if attempts(&audio) >= 2 {
            metadata.status = "error".into();
            metadata.error = Some("QuietNote closed while transcribing this meeting. The audio is kept, so you can try again.".into());
            meetings::write_metadata(&dir, &metadata)?;
            continue;
        }
        meetings::write_metadata(&dir, &metadata)?;
        queue(&metadata.id);
    }
    Ok(())
}
/// On quit, a running recording is finalized so it's transcribed on the next launch.
pub fn shutdown(app: &AppHandle) {
    let recording = app.state::<Capture>().session.lock().is_ok_and(|s| s.is_some());
    if recording { let _ = stop(app, None); }
}

#[tauri::command]
pub fn capture_status(app: AppHandle) -> State { snapshot(&app) }
#[tauri::command]
pub async fn capture_start(app: AppHandle, meeting_id: String) -> Result<Metadata, Failure> {
    tauri::async_runtime::spawn_blocking(move || start(&app, &meeting_id)).await.map_err(|e| Failure::from(e.to_string()))?
}
#[tauri::command]
pub async fn capture_stop(app: AppHandle) -> Result<Metadata, String> {
    tauri::async_runtime::spawn_blocking(move || stop(&app, None)).await.map_err(|e| e.to_string())?
}
/// Transcribes a meeting again from its kept audio, after a failure.
#[tauri::command]
pub async fn transcribe_meeting(app: AppHandle, meeting_id: String) -> Result<Metadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !SUPPORTED { return Err(UNSUPPORTED.to_string()); }
        if app.state::<Capture>().owns(&meeting_id) { return Err("This meeting is already being transcribed.".into()); }
        let root = meetings::root(&app)?;
        let (mut metadata, dir) = meetings::find(&root, &meeting_id)?;
        if metadata.audio_path.is_none() || !dir.join(AUDIO).is_dir() { return Err("This meeting has no audio to transcribe.".into()); }
        // A retry the user asked for starts the crash-loop count again.
        let _ = std::fs::remove_file(dir.join(AUDIO).join(MARKER));
        metadata.status = "processing".into();
        metadata.error = None;
        meetings::write_metadata(&dir, &metadata)?;
        enqueue(&app, &meeting_id);
        changed(&app, &metadata, None, None);
        publish(&app);
        Ok(metadata)
    }).await.map_err(|e| e.to_string())?
}
/// A recorded transcript turn: the words as recognized, and the clean view of them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnView { start_ms: u64, speaker: String, text: String, clean: String }
/// Both views of a recorded transcript, for the Clean / Verbatim toggle. Reading it changes nothing.
/// `None` for typed or example transcripts.
#[tauri::command]
pub async fn transcript_data(app: AppHandle, meeting_id: String) -> Result<Option<Vec<TurnView>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, dir) = meetings::find(&meetings::root(&app)?, &meeting_id)?;
        let path = dir.join("transcript.json");
        if !path.exists() { return Ok(None); }
        let transcript: Transcript = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(Some(transcript.turns.iter().map(|t| TurnView { start_ms: t.start_ms, speaker: t.speaker.clone(), text: t.text.clone(), clean: t.clean() }).collect()))
    }).await.map_err(|e| e.to_string())?
}
/// Rewrites every recorded `transcript.md` after the filler-word preference changes.
#[tauri::command]
pub async fn render_transcripts(app: AppHandle, clean: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for (metadata, dir) in meetings::read_metadata(&meetings::root(&app)?)? {
            let Ok(bytes) = std::fs::read(dir.join("transcript.json")) else { continue };
            let transcript: Transcript = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let markdown = transcript::markdown(&transcript, clean);
            meetings::atomic_write(&dir.join("transcript.md"), markdown.as_bytes())?;
            changed(&app, &metadata, Some(markdown), None);
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
/// Opens the system privacy pane where the user can allow the microphone or system audio.
#[tauri::command]
pub fn open_privacy_settings(kind: String) -> Result<(), String> {
    let url = match (kind.as_str(), cfg!(target_os = "macos")) {
        ("microphone", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        ("systemAudio", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        ("microphone", false) if cfg!(windows) => "ms-settings:privacy-microphone",
        _ => return Err("There’s no system setting for this on this computer.".into()),
    };
    open::that_detached(url).map_err(|e| e.to_string())
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;
    fn archive(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("quietnote-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }
    fn meeting(root: &Path, id: &str, status: &str, audio: bool) -> std::path::PathBuf {
        let dir = root.join("Acme").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        for file in ["meeting.md", "transcript.md"] { std::fs::write(dir.join(file), "").unwrap(); }
        let metadata = serde_json::json!({"id":id,"title":id,"date":"2026-09-29","duration":0,"project":"Acme","participants":[],"status":status,"captureStartedAt":"2026-09-29T10:00:00.000Z","captureEndedAt":null,"audioPath":audio.then(|| format!("Acme/{id}/audio")),"transcriptPath":format!("Acme/{id}/transcript.md"),"meetingPath":format!("Acme/{id}/meeting.md"),"tags":[]});
        std::fs::write(dir.join("metadata.json"), metadata.to_string()).unwrap();
        if audio {
            std::fs::create_dir_all(dir.join(AUDIO)).unwrap();
            let spec = hound::WavSpec { channels: 1, sample_rate: 16_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let mut writer = hound::WavWriter::create(dir.join(AUDIO).join("mic.wav"), spec).unwrap();
            for _ in 0..32_000 { writer.write_sample(1i16).unwrap(); }
            writer.flush().unwrap();
            std::mem::forget(writer);
        }
        dir
    }
    #[test]
    fn repairs_an_unfinalized_wav() {
        let path = std::env::temp_dir().join(format!("quietnote-wav-{}.wav", std::process::id()));
        let spec = hound::WavSpec { channels: 1, sample_rate: 16_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..16_000 { writer.write_sample((i % 100) as i16).unwrap(); }
        writer.finalize().unwrap();
        // Simulate a crash: stale size fields, plus samples and half a sample written after the last flush.
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[4..8].copy_from_slice(&0u32.to_le_bytes());
        bytes[40..44].copy_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 0, 2, 0, 3]);
        std::fs::write(&path, &bytes).unwrap();
        let duration = repair_wav(&path).unwrap();
        assert_eq!(hound::WavReader::open(&path).unwrap().len(), 16_002);
        assert!((duration.as_secs_f64() - 1.000125).abs() < 1e-6);
        std::fs::write(&path, b"not audio").unwrap();
        assert!(repair_wav(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn recovers_interrupted_recordings_and_stops_crash_loops() {
        let root = archive("recover");
        meeting(&root, "crashed", "recording", true);
        meeting(&root, "no-audio", "recording", false);
        meeting(&root, "stopped-by-quit", "processing", true);
        std::fs::write(meeting(&root, "crashed-once", "processing", true).join(AUDIO).join(MARKER), "1").unwrap();
        std::fs::write(meeting(&root, "crashed-twice", "processing", true).join(AUDIO).join(MARKER), "2").unwrap();
        meeting(&root, "lost-audio", "processing", false);
        meeting(&root, "done", "ready", false);
        let mut queued = Vec::new();
        recover_archive(&root, |id| queued.push(id.to_string())).unwrap();
        queued.sort();
        assert_eq!(queued, vec!["crashed", "crashed-once", "stopped-by-quit"]);
        let find = |id| meetings::find(&root, id).unwrap().0;
        let crashed = find("crashed");
        assert_eq!((crashed.status.as_str(), crashed.duration, crashed.interrupted), ("processing", 2, true));
        assert_eq!(crashed.capture_ended_at.as_deref(), Some("2026-09-29T10:00:02.000Z"));
        // A recording stopped on quit is finished, not recovered.
        assert!(!find("stopped-by-quit").interrupted);
        let twice = find("crashed-twice");
        assert_eq!(twice.status, "error");
        assert!(twice.error.unwrap().contains("closed while transcribing"));
        assert!(root.join("Acme/crashed-twice/audio/mic.wav").exists());
        assert_eq!(find("no-audio").status, "error");
        assert!(find("lost-audio").error.unwrap().contains("missing"));
        assert_eq!(find("done").status, "ready");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn audio_is_kept_until_a_transcript_is_saved() {
        let root = archive("retention");
        let transcript = Transcript { version: 1, model: "test".into(), turns: vec![], echo: vec![] };
        // Failure: never ready, the reason is kept, and so is the audio.
        meeting(&root, "failed", "processing", true);
        let failed = record_failure(&root, "failed", "The speech model is missing.").unwrap();
        assert_eq!((failed.status.as_str(), failed.error.as_deref()), ("error", Some("The speech model is missing.")));
        assert!(root.join("Acme/failed/audio/mic.wav").exists());
        // Success without "Delete audio after transcribing": ready, audio kept.
        meeting(&root, "kept", "processing", true);
        let (kept, markdown) = save_transcript(&root, "kept", &transcript).unwrap();
        assert_eq!((kept.status.as_str(), kept.audio_path.is_some()), ("ready", true));
        assert!(markdown.contains("No speech was recognized"));
        assert!(root.join("Acme/kept/audio/mic.wav").exists());
        // Success with it: ready first, then the audio goes.
        std::fs::write(root.join(".privacy.json"), r#"{"deleteAudio":true}"#).unwrap();
        meeting(&root, "deleted", "processing", true);
        let (deleted, _) = save_transcript(&root, "deleted", &transcript).unwrap();
        assert_eq!((deleted.status.as_str(), deleted.audio_path.is_none()), ("ready", true));
        assert!(!root.join("Acme/deleted/audio").exists());
        assert!(root.join("Acme/deleted/transcript.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn only_one_recording_can_start() {
        let capture = Capture::default();
        let claim = capture.claim().unwrap();
        assert_eq!(capture.claim().err().as_deref(), Some(BUSY));
        drop(claim);
        assert!(capture.claim().is_ok());
    }
    #[test]
    fn disk_thresholds() {
        assert_eq!(disk(20 << 30), Disk::Fine);
        assert_eq!(disk(900 << 20), Disk::Low);
        assert_eq!(disk(100 << 20), Disk::Full);
    }
}
