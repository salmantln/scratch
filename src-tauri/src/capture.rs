//! Recording and transcription lifecycle. Rust owns capture so it keeps going while the window is
//! hidden, and the tray can stop it. A meeting moves idle → recording → processing → ready, or to
//! error with its audio kept for a retry. Nothing starts recording except an explicit start.
use crate::meetings::{self, Metadata, Resume};
use crate::sealed::{self, TRACKS};
use crate::transcript::{self, Transcript};
use crate::tray;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::Arc;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

pub const AUDIO: &str = "audio";
/// Written in the audio folder while Whisper runs, with the attempt count, so a transcription that
/// crashes QuietNote is retried once and then left for the user rather than crashing every launch.
const MARKER: &str = ".transcribing";
const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));
/// The live transcript runs on macOS (`live`). Windows transcribes on the CPU at about real time,
/// which a second pass during the call can't keep up with.
const FOLLOWS: bool = cfg!(target_os = "macos");
/// The others' voices are told apart on macOS (`speakers`).
const SEPARATES: bool = cfg!(target_os = "macos");
const UNSUPPORTED: &str = "Recording isn’t available on this platform yet.";
const BUSY: &str = "Another meeting is already recording. Stop it first.";
/// A track with no sound at all after this long is reported as silent (permission off, muted mic).
const SILENT_AFTER: Duration = Duration::from_secs(20);
/// Recording needs this much free space to start, and warns below it (two tracks use about 230 MB an hour).
const LOW_DISK: u64 = 1 << 30;
/// Below this, recording stops cleanly so the audio so far stays valid.
const FULL_DISK: u64 = 150 << 20;
/// After the call app lets go of the microphone, the recording stops this much later (unless kept)…
const CALL_ENDED_STOP: Duration = Duration::from_secs(60);
/// …and only once nobody has been heard for this long, so talking on after the call keeps recording.
const QUIET_BEFORE_STOP_MS: u64 = 10_000;
/// Nothing heard on either track for this long (a recording left running) starts a countdown…
const SILENT_MS: u64 = 15 * 60 * 1000;
/// …of this long, which any sound cancels.
const SILENT_STOP: Duration = Duration::from_secs(120);

struct Session {
    meeting_id: String,
    title: String,
    started_at: String,
    /// When recording last started or resumed (wall clock), and what was recorded before that. Pauses
    /// don't count, and the window and the tray both show the recorded time from these.
    wall: SystemTime,
    resumed_at: String,
    recorded: Duration,
    started: Instant,
    /// Paused: the streams are closed and the microphone is released until it resumes.
    paused: bool,
    live_text: LiveText,
    disk: Option<String>,
    /// The recording is about to stop on its own: why, and when.
    ending: Option<Ending>,
    /// Outlives each run of the recorder, so the chosen microphone and what was heard carry over a pause.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    health: Arc<crate::recorder::Health>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    recording: Option<crate::recorder::Recording>,
}
impl Session {
    fn elapsed(&self) -> Duration {
        if self.paused { self.recorded } else { self.recorded + SystemTime::now().duration_since(self.wall).unwrap_or_default() }
    }
}
#[derive(Default)]
struct Jobs { queue: VecDeque<String>, current: Option<Progress>, worker: bool }

/// Why a recording is about to stop by itself. Either way the user can keep recording, and it stops
/// only after a countdown, so it never ends unseen.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Reason { CallEnded(&'static str), Silent }
#[derive(Clone, Copy, Debug, PartialEq)]
struct Ending { reason: Reason, at: SystemTime }
impl Reason {
    fn text(self) -> String {
        match self { Reason::CallEnded(app) => format!("The {app} call ended."), Reason::Silent => "Nothing has been heard for 15 minutes.".into() }
    }
}
#[derive(Debug, PartialEq)]
enum Step { Wait, Start(Reason), Cancel, Stop }
/// What a running recording's countdown does next: a long silence starts one, sound cancels a silence
/// countdown, and a countdown that has run out stops the recording once it's quiet.
fn step(ending: Option<Ending>, quiet_ms: u64, now: SystemTime) -> Step {
    match ending {
        None if quiet_ms >= SILENT_MS => Step::Start(Reason::Silent),
        None => Step::Wait,
        Some(Ending { reason: Reason::Silent, .. }) if quiet_ms < 3_000 => Step::Cancel,
        Some(e) if now >= e.at && quiet_ms >= QUIET_BEFORE_STOP_MS => Step::Stop,
        Some(_) => Step::Wait,
    }
}

#[derive(Default)]
pub struct Capture {
    session: Mutex<Option<Session>>, starting: AtomicBool, jobs: Mutex<Jobs>, wake: Condvar, model: OnceLock<&'static str>,
    /// The latest live transcript, kept after the recording stops until its full transcript replaces it.
    draft: Mutex<Option<Draft>>,
}
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
pub struct Failure { code: &'static str, pub message: String }
impl From<String> for Failure { fn from(message: String) -> Self { Failure { code: "failed", message } } }

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level { Waiting, Heard, Silent }
/// Whether the recording has a live transcript: off (turned off, or not on this platform), loading
/// the model, on, or failed (the full transcript is still made after Stop).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum LiveText { Off, Loading, On, Failed }
/// The live transcript so far: the same turns as a finished transcript, but a draft that's never saved.
#[derive(Clone, Serialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct Draft { meeting_id: String, turns: Vec<TurnView> }
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pub meeting_id: String,
    pub title: String,
    pub started_at: String,
    /// Recorded time before `resumed_at`; the clock is `recorded_ms + (now − resumed_at)`.
    pub recorded_ms: u64,
    /// When recording last started or resumed; `None` while paused.
    pub resumed_at: Option<String>,
    pub mic: Level,
    pub system: Level,
    pub mic_device: Option<String>,
    pub system_device: Option<String>,
    /// Something is wrong right now (a device is gone, the disk is low).
    pub problem: Option<String>,
    /// The latest device change, for information.
    pub note: Option<String>,
    pub live_text: LiveText,
    /// About to stop by itself (the call ended, or a long silence) unless kept.
    pub ending: Option<EndingView>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndingView { pub reason: String, pub stops_at: String }
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
    /// Whether QuietNote can notice calls on this platform (see `calls`).
    pub detects_calls: bool,
    /// Whether recordings can have a live transcript on this platform.
    pub live_transcript: bool,
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
        let (heard, problem, note, devices) = { let h = &s.health; (h.heard(), h.problem(), h.note(), h.devices()) };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let (heard, problem, note, devices): ([bool; 2], Option<String>, Option<String>, [Option<String>; 2]) = Default::default();
        let level = |heard: bool| if heard { Level::Heard } else if !s.paused && s.started.elapsed() >= SILENT_AFTER { Level::Silent } else { Level::Waiting };
        let problem = [problem, s.disk.clone()].into_iter().flatten().reduce(|a, b| format!("{a} {b}"));
        let [mic_device, system_device] = devices;
        Live {
            meeting_id: s.meeting_id.clone(), title: s.title.clone(), started_at: s.started_at.clone(), recorded_ms: s.recorded.as_millis() as u64,
            resumed_at: (!s.paused).then(|| s.resumed_at.clone()), mic: level(heard[0]), system: level(heard[1]), mic_device, system_device, problem, note, live_text: s.live_text,
            ending: s.ending.map(|e| EndingView { reason: e.reason.text(), stops_at: chrono::DateTime::<chrono::Utc>::from(e.at).to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }),
        }
    }));
    let jobs = capture.jobs.lock();
    let (transcribing, queued) = jobs.map(|j| (j.current.clone(), j.queue.iter().cloned().collect())).unwrap_or_default();
    let model = *capture.model.get_or_init(|| model(app));
    State { available: SUPPORTED, microphone: microphone(), model, recording, transcribing, queued, detects_calls: crate::calls::available(), live_transcript: FOLLOWS }
}
/// Whether a recording is running or starting.
pub fn recording(app: &AppHandle) -> bool {
    let capture = app.state::<Capture>();
    capture.starting.load(Ordering::SeqCst) || capture.session.lock().is_ok_and(|s| s.is_some())
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

/// Starts recording a meeting that hasn't been captured yet, or records more of one that has: the new
/// part is transcribed and added to its transcript.
pub fn start(app: &AppHandle, id: &str) -> Result<Metadata, Failure> {
    if !SUPPORTED { return Err(UNSUPPORTED.to_string().into()); }
    let capture = app.state::<Capture>();
    // The first start can wait on the microphone permission prompt, so no lock is held meanwhile.
    let claim = capture.claim()?;
    let metadata = begin(app, id)?;
    drop(claim);
    spawn_ticker(app.clone(), metadata.id.clone());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    spawn_meter(app.clone(), metadata.id.clone());
    pause_media(app);
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
    let resuming = match metadata.status.as_str() {
        "idle" => false,
        "ready" => true,
        "error" => return Err("Retry this meeting’s transcription before recording more of it.".to_string().into()),
        _ => return Err("This meeting is already being recorded or transcribed.".to_string().into()),
    };
    // Only a transcript QuietNote made can be continued; a written one would be replaced.
    if resuming && !dir.join("transcript.json").exists() && !std::fs::read_to_string(dir.join("transcript.md")).unwrap_or_default().trim().is_empty() {
        return Err("This meeting’s transcript wasn’t recorded in QuietNote, so recording more would replace it.".to_string().into());
    }
    if let Some(free) = free_space(&root).filter(|f| disk(*f) != Disk::Fine) {
        return Err(Failure { code: "disk", message: format!("Not enough disk space to record: {} MB free. Free up at least 1 GB and try again.", megabytes(free)) });
    }
    let audio = dir.join(AUDIO);
    // Audio kept from the earlier recording is continued; it's never deleted here.
    let kept = resuming && TRACKS.iter().any(|t| sealed::path(&audio, t).is_some());
    if !kept {
        // Left over from a start that failed before the meeting was marked as recording.
        if audio.exists() { std::fs::remove_dir_all(&audio).map_err(|e| e.to_string())?; }
        std::fs::create_dir_all(&audio).map_err(|e| e.to_string())?;
    }
    crate::protect::recording(&root, &audio);
    let resume = resuming.then(|| resume_point(&dir, metadata.duration, kept));
    let discard = |audio: &Path| if !kept { let _ = std::fs::remove_dir_all(audio); };
    let health = Arc::new(crate::recorder::Health::with_mic(meetings::preference_str(&root, "inputDevice")));
    let recording = match audio_key(&root, &audio, &health).and_then(|key| crate::recorder::start(&audio, health.clone(), kept, meetings::preference(&root, "echoCancellation", true), key)) {
        Ok(recording) => recording,
        Err(e) => {
            discard(&audio);
            return Err(recorder_failure(e));
        }
    };
    let (wall, started_at) = (SystemTime::now(), now());
    let live_text = if FOLLOWS && model(app) == "ready" && meetings::preference(&root, "liveTranscript", true) { LiveText::Loading } else { LiveText::Off };
    metadata.status = "recording".into();
    // A resumed meeting keeps when it was first recorded.
    if !resuming { metadata.capture_started_at = Some(started_at.clone()); }
    metadata.audio_path = Some(format!("{}/{}/{AUDIO}", metadata.project, metadata.id));
    metadata.resume = resume;
    if let Err(e) = meetings::write_metadata(&dir, &metadata) {
        drop(recording);
        discard(&audio);
        return Err(e.into());
    }
    // The clock carries on from the earlier recording.
    let at = resume.map_or(0, |r| r.at_ms);
    *capture.session.lock().map_err(|e| e.to_string())? = Some(Session {
        meeting_id: metadata.id.clone(), title: metadata.title.clone(), started_at: started_at.clone(), wall, resumed_at: started_at,
        recorded: Duration::from_millis(at), started: Instant::now(), paused: false, live_text, disk: None, ending: None, health: health.clone(), recording: Some(recording),
    });
    if let Ok(mut draft) = capture.draft.lock() { *draft = None; }
    #[cfg(target_os = "macos")]
    if live_text == LiveText::Loading { crate::live::spawn(app.clone(), metadata.id.clone(), health, at); }
    Ok(metadata)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn begin(_: &AppHandle, _: &str) -> Result<Metadata, Failure> { Err(UNSUPPORTED.to_string().into()) }
/// Where recording more of a finished meeting begins: in the audio files (after what's kept there), and
/// in the meeting, after both the earlier recording and its last words.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn resume_point(dir: &Path, duration: u64, kept: bool) -> Resume {
    let audio = dir.join(AUDIO);
    let sample = if !kept { 0 } else {
        TRACKS.iter().filter_map(|t| {
            let path = sealed::path(&audio, t)?;
            if sealed::encrypted(&path) { return sealed::length(&path).ok(); }
            repair_wav(&path).ok()?;
            hound::WavReader::open(&path).ok().map(|r| r.duration() as u64)
        }).max().unwrap_or(0)
    };
    let spoken = std::fs::read(dir.join("transcript.json")).ok().and_then(|b| serde_json::from_slice::<Transcript>(&b).ok())
        .and_then(|t| t.turns.iter().map(|t| t.end_ms).max()).unwrap_or(0);
    Resume { at_ms: (duration * 1000).max(sample * 1000 / crate::recorder::RATE as u64).max(spoken), sample }
}
/// The key a recording's audio is encrypted with: always for tracks already encrypted, which can't be
/// continued without it, and for new ones while `encryptAudio` is on (macOS). If the Keychain can't
/// give one, new audio is recorded unencrypted and the recorder says so.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn audio_key(root: &Path, audio: &Path, health: &crate::recorder::Health) -> Result<Option<Arc<sealed::Key>>, String> {
    if TRACKS.iter().any(|t| sealed::path(audio, t).is_some_and(|p| sealed::encrypted(&p))) {
        return sealed::key(false)?.ok_or_else(|| sealed::MISSING_KEY.to_string()).map(Some);
    }
    if !sealed::AVAILABLE || !meetings::preference(root, "encryptAudio", true) { return Ok(None); }
    sealed::key(true).or_else(|e| { health.set_note(format!("{e} This recording isn’t encrypted.")); Ok(None) })
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn recorder_failure(message: String) -> Failure {
    Failure { code: if message == crate::recorder::MIC_DENIED { "mic-denied" } else { "failed" }, message }
}

/// Pauses the recording: the streams close, so the microphone is released, and the audio so far is
/// finalized. The meeting stays `recording` until it's stopped, and a crash while paused is
/// recovered like any other recording.
pub fn pause(app: &AppHandle) -> Result<(), String> {
    let capture = app.state::<Capture>();
    let mut guard = capture.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("Nothing is recording.")?;
    if session.paused { return Ok(()); }
    session.recorded = session.elapsed();
    session.paused = true;
    let ending = session.ending.take().is_some();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let finished = { let finished = session.recording.take().map_or(Ok(()), |r| r.stop()); session.health.clear(); finished };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let finished: Result<(), String> = Ok(());
    drop(guard);
    if ending { crate::calls::ending_panel(app, false); }
    publish(app);
    finished.map_err(|e| format!("The audio before the pause may be incomplete. {e}"))
}
/// Resumes a paused recording, continuing the same audio files.
pub fn resume(app: &AppHandle) -> Result<(), Failure> {
    let capture = app.state::<Capture>();
    // Held while the streams open, so the recording can't be stopped halfway through resuming.
    let mut guard = capture.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("Nothing is recording.".to_string())?;
    if !session.paused { return Ok(()); }
    let root = meetings::root(app)?;
    if let Some(free) = free_space(&root).filter(|f| disk(*f) == Disk::Full) {
        return Err(Failure { code: "disk", message: format!("Not enough disk space to keep recording: {} MB free. Free up space and try again.", megabytes(free)) });
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (_, dir) = meetings::find(&root, &session.meeting_id)?;
        let audio = dir.join(AUDIO);
        // Why it paused no longer applies.
        session.health.clear();
        let key = audio_key(&root, &audio, &session.health)?;
        session.recording = Some(crate::recorder::start(&audio, session.health.clone(), true, meetings::preference(&root, "echoCancellation", true), key).map_err(recorder_failure)?);
    }
    (session.wall, session.resumed_at, session.started, session.paused) = (SystemTime::now(), now(), Instant::now(), false);
    drop(guard);
    pause_media(app);
    publish(app);
    Ok(())
}
/// Music playing when a recording starts or resumes would be recorded too, so it's paused (macOS).
fn pause_media(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if meetings::root(app).is_ok_and(|root| meetings::preference(&root, "pauseMedia", true)) { std::thread::spawn(mac::pause_media); }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// When the Mac goes to sleep mid-recording, the recording pauses: the audio so far is finalized and
/// the microphone released. It waits for Resume after waking, since the meeting may be over by then.
pub fn pause_on_sleep(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::on_sleep(app.clone());
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn slept(app: &AppHandle) {
    let capture = app.state::<Capture>();
    if !capture.session.lock().is_ok_and(|s| s.as_ref().is_some_and(|s| !s.paused)) { return; }
    let _ = pause(app);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(session) = capture.session.lock().ok().as_ref().and_then(|s| s.as_ref()) {
        session.health.set_note("Paused because the Mac went to sleep. Resume when you’re back in the meeting.".into());
    }
    publish(app);
}

/// Stops the current recording, finalizes the audio and queues transcription. `reason` explains a
/// stop the user didn't ask for (the disk filled up).
pub fn stop(app: &AppHandle, reason: Option<String>) -> Result<Metadata, String> {
    let session = app.state::<Capture>().session.lock().map_err(|e| e.to_string())?.take().ok_or("Nothing is recording.")?;
    if session.ending.is_some() { crate::calls::ending_panel(app, false); }
    let duration = session.elapsed().as_secs();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let finished = session.recording.map_or(Ok(()), |r| r.stop());
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

/// The call app let go of the microphone (`calls`): the recording stops after a countdown unless kept.
pub fn call_ended(app: &AppHandle, call: &'static str) {
    let started = app.state::<Capture>().session.lock().ok().and_then(|mut s| {
        let s = s.as_mut().filter(|s| !s.paused && s.ending.is_none())?;
        s.ending = Some(Ending { reason: Reason::CallEnded(call), at: SystemTime::now() + CALL_ENDED_STOP });
        Some(())
    });
    if started.is_some() { crate::calls::ending_panel(app, true); publish(app); }
}
/// Keeps recording after a countdown started; a silence is counted again from now.
pub fn keep(app: &AppHandle) {
    let kept = app.state::<Capture>().session.lock().ok().and_then(|mut s| {
        let s = s.as_mut()?;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        s.health.heard_now();
        s.ending.take()
    });
    if kept.is_some() { crate::calls::ending_panel(app, false); publish(app); }
}
/// Runs the countdown of meeting `id`'s recording one step (`step`).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn count_down(app: &AppHandle, id: &str) {
    let capture = app.state::<Capture>();
    let Ok(mut guard) = capture.session.lock() else { return };
    let Some(session) = guard.as_mut().filter(|s| s.meeting_id == id && !s.paused) else { return };
    match step(session.ending, session.health.quiet_for(), SystemTime::now()) {
        Step::Wait => {}
        Step::Start(reason) => {
            session.ending = Some(Ending { reason, at: SystemTime::now() + SILENT_STOP });
            drop(guard);
            crate::calls::ending_panel(app, true);
            publish(app);
        }
        Step::Cancel => {
            session.ending = None;
            drop(guard);
            crate::calls::ending_panel(app, false);
            publish(app);
        }
        Step::Stop => {
            let reason = session.ending.map(|e| e.reason.text()).unwrap_or_default();
            drop(guard);
            let _ = stop(app, Some(format!("Recording stopped by itself: {reason} The audio up to then was saved and will be transcribed.")));
        }
    }
}

/// While recording: live input levels for the window's meters, about ten times a second, so it's
/// visible at once that both tracks are being captured.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn spawn_meter(app: AppHandle, id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let levels = app.state::<Capture>().session.lock().ok().and_then(|s| s.as_ref().filter(|s| s.meeting_id == id).map(|s| s.health.take_levels()));
        let Some(levels) = levels else { break };
        let _ = app.emit_to("main", "quietnote://levels", levels);
    });
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
            let Some(clock) = capture.session.lock().ok().and_then(|s| s.as_ref().filter(|s| s.meeting_id == id).map(|s| (s.elapsed(), s.paused))) else { break };
            tray::recording_tick(&app, Some(clock));
            // Stopped while this tick was drawn: Stop has already cleared the time, so this tick's mustn't stay.
            if !recording(&app) { tray::recording_tick(&app, None); break; }
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            count_down(&app, &id);
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
        // The full transcript (or the failure notice) replaces the live draft.
        if let Ok(mut draft) = capture.draft.lock() { if draft.as_ref().is_some_and(|d| d.meeting_id == id) { *draft = None; } }
        if matches!(outcome, Ok(Some(_))) { tray::transcribed(&app); }
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
    for path in TRACKS.iter().filter_map(|t| sealed::path(&audio, t)) { let _ = repair(&path); }
    std::fs::write(audio.join(MARKER), (attempts(&audio) + 1).to_string()).map_err(|e| e.to_string())?;
    // Recording resumed: the new part goes after the transcript that's already there, which must be readable.
    let earlier = dir.join("transcript.json");
    let before = match (metadata.resume, earlier.exists()) {
        (Some(_), true) => Some(serde_json::from_slice::<Transcript>(&std::fs::read(&earlier).map_err(|e| e.to_string())?)
            .map_err(|e| format!("The earlier transcript of this meeting couldn’t be read, so the new part wasn’t added: {e}"))?),
        _ => None,
    };
    let separating = SEPARATES && meetings::preference(&root, "separateSpeakers", true);
    // Telling voices apart comes after transcribing, so transcription shows as 90% of the progress.
    let [mic, system] = recognize(app, &audio, id, metadata.resume, if separating { 90 } else { 100 })?;
    #[cfg(target_os = "macos")]
    let system = if separating && !system.is_empty() {
        set_progress(app, id, None, 95);
        let earlier = before.as_ref().map_or(0, |t| crate::speakers::numbered(t.turns.iter().map(|t| t.speaker.clone())));
        separate(app, &audio, metadata.resume, system, earlier + 1)
    } else { system };
    let (turns, echo) = transcript::merge(mic, system);
    let mut transcript = Transcript { version: 1, model: model_name().into(), turns, echo };
    if let (Some(resume), Some(before)) = (metadata.resume, before) { transcript = transcript::append(before, transcript, resume.at_ms); }
    save_transcript(&root, id, &transcript).map(Some)
}
/// Labels the others' sentences by voice (`speakers`). It only improves the transcript: if the voices
/// can't be told apart, the others stay "Others" and the transcript is saved as it is.
#[cfg(target_os = "macos")]
fn separate(app: &AppHandle, audio: &Path, resume: Option<Resume>, mut system: Vec<transcript::Piece>, first: usize) -> Vec<transcript::Piece> {
    let (from, at) = resume.map_or((0, 0), |r| (r.sample as usize, r.at_ms));
    let voices = sealed::path(audio, TRACKS[1]).ok_or_else(|| "There’s no call audio.".to_string()).and_then(|path| crate::transcribe::samples(&path)).and_then(|mut call| {
        call.drain(..from.min(call.len()));
        crate::speakers::voices(app, &call)
    });
    match voices {
        Ok(voices) => { crate::speakers::label(&mut system, &voices.into_iter().map(|(s, e, v)| (s + at, e + at, v)).collect(), first); }
        Err(e) => eprintln!("QuietNote: the others’ voices couldn’t be told apart: {e}"),
    }
    system
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
    metadata.resume = None;
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
/// Transcribes the audio, or only its resumed part. Its progress fills `share` percent of the meeting's.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn recognize(app: &AppHandle, audio: &Path, id: &str, resume: Option<Resume>, share: u8) -> Result<[Vec<transcript::Piece>; 2], String> {
    let (handle, id) = (app.clone(), id.to_string());
    let (from, at) = resume.map_or((0, 0), |r| (r.sample, r.at_ms));
    crate::transcribe::run(app, audio, from, at, std::sync::Arc::new(move |percent| set_progress(&handle, &id, None, (percent as u16 * share as u16 / 100) as u8)))
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn recognize(_: &AppHandle, _: &Path, _: &str, _: Option<Resume>, _: u8) -> Result<[Vec<transcript::Piece>; 2], String> { Err(UNSUPPORTED.into()) }
fn model_name() -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return crate::transcribe::MODEL.trim_end_matches(".bin");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    ""
}

/// How long a track is, after repairing one cut short by a crash: a WAV's header is fixed, and an
/// encrypted track simply ends at its last whole frame.
fn repair(path: &Path) -> std::io::Result<Duration> { if sealed::encrypted(path) { sealed::duration(path) } else { repair_wav(path) } }
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
        let recovered = TRACKS.iter().filter_map(|t| repair(&sealed::path(&audio, t)?).ok()).max().filter(|d| !d.is_zero());
        let Some(duration) = recovered.filter(|_| SUPPORTED && metadata.audio_path.is_some()) else {
            if metadata.status == "processing" { metadata.error = Some("The audio for this meeting is missing, so it can’t be transcribed.".into()); }
            metadata.status = "error".into();
            meetings::write_metadata(&dir, &metadata)?;
            continue;
        };
        if metadata.status == "recording" {
            metadata.interrupted = true;
            match metadata.resume {
                // A resumed recording: the earlier part, plus what the files hold after it.
                Some(r) => metadata.duration = (r.at_ms + (duration.as_millis() as u64).saturating_sub(r.sample * 1000 / 16_000)) / 1000,
                None => {
                    metadata.duration = duration.as_secs();
                    metadata.capture_ended_at = metadata.capture_started_at.as_deref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|s| (s + duration).to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                }
            }
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
/// The first-run screens explain the microphone, then ask for it here, before any recording. Nothing is recorded.
#[tauri::command]
pub async fn capture_allow_microphone(app: AppHandle) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        crate::recorder::ask_microphone();
        publish(&app);
        snapshot(&app)
    }).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn capture_start(app: AppHandle, meeting_id: String) -> Result<Metadata, Failure> {
    tauri::async_runtime::spawn_blocking(move || start(&app, &meeting_id)).await.map_err(|e| Failure::from(e.to_string()))?
}
#[tauri::command]
pub async fn capture_stop(app: AppHandle) -> Result<Metadata, String> {
    tauri::async_runtime::spawn_blocking(move || stop(&app, None)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn capture_pause(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pause(&app)).await.map_err(|e| e.to_string())?
}
/// Keep recording: cancels the countdown to stopping by itself.
#[tauri::command]
pub fn capture_keep(app: AppHandle) { keep(&app); }
#[tauri::command]
pub async fn capture_resume(app: AppHandle) -> Result<(), Failure> {
    tauri::async_runtime::spawn_blocking(move || resume(&app)).await.map_err(|e| Failure::from(e.to_string()))?
}
#[derive(Serialize)]
pub struct Devices { devices: Vec<String>, selected: Option<String> }
/// The microphones to record from, and the chosen one (`None`: the system default).
#[tauri::command]
pub async fn capture_devices(app: AppHandle) -> Result<Devices, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = meetings::preference_str(&meetings::root(&app)?, "inputDevice");
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let devices = crate::recorder::input_devices();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let devices = Vec::new();
        Ok(Devices { devices, selected })
    }).await.map_err(|e| e.to_string())?
}
/// Chooses the microphone (`None`: the system default). A recording in progress switches to it at once.
#[tauri::command]
pub async fn capture_set_device(app: AppHandle, name: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        meetings::set_preference(&meetings::root(&app)?, "inputDevice", name.clone().map_or(serde_json::Value::Null, Into::into))?;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(session) = app.state::<Capture>().session.lock().map_err(|e| e.to_string())?.as_ref() { session.health.choose_mic(name); }
        let _ = app.emit_to("main", "quietnote://preferences-changed", ());
        Ok(())
    }).await.map_err(|e| e.to_string())?
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
/// Writes a playable copy of a meeting's audio, a WAV file per track, into the folder the user chose.
/// Nothing in the archive changes, and no file there is replaced. Returns the files written.
#[tauri::command]
pub async fn audio_export(app: AppHandle, meeting_id: String, folder: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if app.state::<Capture>().owns(&meeting_id) { return Err("Export the audio once this meeting has finished recording and transcribing.".to_string()); }
        let (_, dir) = meetings::find(&meetings::root(&app)?, &meeting_id)?;
        let audio = dir.join(AUDIO);
        let key = if TRACKS.iter().any(|t| sealed::path(&audio, t).is_some_and(|p| sealed::encrypted(&p))) { Some(sealed::key(false)?.ok_or(sealed::MISSING_KEY)?) } else { None };
        export_audio(&audio, &meeting_id, Path::new(&folder), key.as_deref())
    }).await.map_err(|e| e.to_string())?
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn export_audio(audio: &Path, name: &str, folder: &Path, key: Option<&sealed::Key>) -> Result<Vec<String>, String> {
    if !folder.is_dir() { return Err("That folder isn’t available.".into()); }
    let mut written = Vec::new();
    for track in TRACKS {
        let Some(path) = sealed::path(audio, track) else { continue };
        let out = (1..).map(|n| folder.join(if n == 1 { format!("{name} {track}.wav") } else { format!("{name} {track} {n}.wav") })).find(|p| !p.exists()).ok_or("No free file name.")?;
        let fail = |e: &dyn std::fmt::Display| format!("Couldn’t write {}: {e}", out.display());
        match key.filter(|_| sealed::encrypted(&path)) {
            Some(key) => {
                let (rate, samples) = sealed::read(&path, key)?;
                let mut wav = hound::WavWriter::create(&out, hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int }).map_err(|e| fail(&e))?;
                for s in samples { wav.write_sample(s).map_err(|e| fail(&e))?; }
                wav.finalize().map_err(|e| fail(&e))?;
            }
            None if sealed::encrypted(&path) => return Err(sealed::MISSING_KEY.into()),
            None => { std::fs::copy(&path, &out).map_err(|e| fail(&e))?; }
        }
        written.push(out.display().to_string());
    }
    if written.is_empty() { return Err("This meeting has no audio to export.".into()); }
    Ok(written)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn export_audio(_: &Path, _: &str, _: &Path, _: Option<&sealed::Key>) -> Result<Vec<String>, String> { Err(UNSUPPORTED.into()) }
/// A recorded transcript turn: the words as recognized, and the clean view of them.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnView { start_ms: u64, speaker: String, text: String, clean: String }
impl From<&transcript::Turn> for TurnView {
    fn from(t: &transcript::Turn) -> Self { TurnView { start_ms: t.start_ms, speaker: t.speaker.clone(), text: t.text.clone(), clean: t.clean() } }
}
/// Both views of a recorded transcript, for the Clean / Verbatim toggle. Reading it changes nothing.
/// `None` for typed or example transcripts.
#[tauri::command]
pub async fn transcript_data(app: AppHandle, meeting_id: String) -> Result<Option<Vec<TurnView>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, dir) = meetings::find(&meetings::root(&app)?, &meeting_id)?;
        let path = dir.join("transcript.json");
        if !path.exists() { return Ok(None); }
        let transcript: Transcript = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(Some(transcript.turns.iter().map(TurnView::from).collect()))
    }).await.map_err(|e| e.to_string())?
}
/// The live transcript of the recording in progress, or of one still being transcribed, so a window
/// opened meanwhile shows it too.
#[tauri::command]
pub fn capture_live_transcript(app: AppHandle) -> Option<Draft> { app.state::<Capture>().draft.lock().ok().and_then(|d| d.clone()) }
/// For the live transcript: whether meeting `id` is still recording, and if so whether it's paused.
#[cfg(target_os = "macos")]
pub(crate) fn following(app: &AppHandle, id: &str) -> Option<bool> {
    app.state::<Capture>().session.lock().ok()?.as_ref().filter(|s| s.meeting_id == id).map(|s| s.paused)
}
#[cfg(target_os = "macos")]
pub(crate) fn set_live_text(app: &AppHandle, id: &str, state: LiveText) {
    let capture = app.state::<Capture>();
    let Ok(mut session) = capture.session.lock() else { return };
    let Some(s) = session.as_mut().filter(|s| s.meeting_id == id) else { return };
    s.live_text = state;
    drop(session);
    publish(app);
}
#[cfg(target_os = "macos")]
pub(crate) fn set_draft(app: &AppHandle, id: &str, turns: &[transcript::Turn]) {
    let draft = Draft { meeting_id: id.into(), turns: turns.iter().map(TurnView::from).collect() };
    if let Ok(mut d) = app.state::<Capture>().draft.lock() { *d = Some(draft.clone()); }
    let _ = app.emit_to("main", "quietnote://live-transcript", draft);
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
/// Gives a voice in a recorded transcript a name ("Speaker 2" → "Maria"), or merges it into another voice by
/// giving it that voice's name. Only the speaker labels change; every word stays as recognized.
fn rename_speaker(dir: &Path, from: &str, to: &str, clean: bool) -> Result<String, String> {
    let to = to.trim();
    if to.is_empty() || to.chars().count() > 60 || to.contains(['\n', '#']) { return Err("A speaker’s name needs 1 to 60 characters, without “#”.".into()); }
    let path = dir.join("transcript.json");
    let mut transcript: Transcript = serde_json::from_slice(&std::fs::read(&path).map_err(|_| "This meeting has no recorded transcript.".to_string())?).map_err(|e| e.to_string())?;
    if !transcript.turns.iter().any(|t| t.speaker == from) { return Err(format!("Nobody is called “{from}” in this transcript.")); }
    for turn in transcript.turns.iter_mut().filter(|t| t.speaker == from) { turn.speaker = to.to_string(); }
    let markdown = transcript::markdown(&transcript, clean);
    meetings::atomic_write(&path, &serde_json::to_vec_pretty(&transcript).map_err(|e| e.to_string())?)?;
    meetings::atomic_write(&dir.join("transcript.md"), markdown.as_bytes())?;
    Ok(markdown)
}
#[tauri::command]
pub async fn transcript_rename_speaker(app: AppHandle, meeting_id: String, from: String, to: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if app.state::<Capture>().owns(&meeting_id) { return Err("This meeting is still being recorded or transcribed.".to_string()); }
        let root = meetings::root(&app)?;
        let (metadata, dir) = meetings::find(&root, &meeting_id)?;
        let markdown = rename_speaker(&dir, &from, &to, meetings::preference(&root, "cleanTranscript", true))?;
        changed(&app, &metadata, Some(markdown.clone()), None);
        Ok(markdown)
    }).await.map_err(|e| e.to_string())?
}
/// Opens the system privacy pane where the user can allow the microphone or system audio.
#[tauri::command]
pub fn open_privacy_settings(kind: String) -> Result<(), String> {
    let url = match (kind.as_str(), cfg!(target_os = "macos")) {
        ("microphone", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        ("systemAudio", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        ("accessibility", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ("calendars", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        ("fileVault", true) => "x-apple.systempreferences:com.apple.preference.security?FileVault",
        ("microphone", false) if cfg!(windows) => "ms-settings:privacy-microphone",
        _ => return Err("There’s no system setting for this on this computer.".into()),
    };
    open::that_detached(url).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSWorkspace, NSWorkspaceWillSleepNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    use tauri::AppHandle;

    /// Pauses whatever is playing (music, a podcast) through MediaRemote, the private framework behind
    /// the media keys. Pause never starts anything, so it's harmless when nothing plays or the call fails.
    pub fn pause_media() {
        use objc2_core_foundation::{CFBundle, CFString, CFURLPathStyle, CFURL};
        let path = CFString::from_static_str("/System/Library/PrivateFrameworks/MediaRemote.framework");
        let Some(url) = CFURL::with_file_system_path(None, Some(&path), CFURLPathStyle::CFURLPOSIXPathStyle, true) else { return };
        let Some(bundle) = CFBundle::new(None, Some(&url)) else { return };
        let send = bundle.function_pointer_for_name(Some(&CFString::from_static_str("MRMediaRemoteSendCommand")));
        if send.is_null() { return; }
        // Boolean MRMediaRemoteSendCommand(MRMediaRemoteCommand command, CFDictionaryRef options); kMRPause is 1.
        let send: extern "C" fn(u32, *const std::ffi::c_void) -> u8 = unsafe { std::mem::transmute(send) };
        send(1, std::ptr::null());
    }

    /// macOS waits for this observer (up to 30 seconds) before sleeping, so the audio is finalized first.
    pub fn on_sleep(app: AppHandle) {
        let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| super::slept(&app));
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillSleepNotification), None, None, &block) };
        // Observes for as long as QuietNote runs.
        std::mem::forget(observer);
    }
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
    fn a_pause_stops_the_clock_and_a_resume_continues_it() {
        let session = |recorded: u64, running: u64, paused: bool| Session {
            meeting_id: "m".into(), title: "m".into(), started_at: String::new(), resumed_at: String::new(), started: Instant::now(), disk: None, ending: None,
            wall: SystemTime::now() - Duration::from_secs(running), recorded: Duration::from_secs(recorded), paused,
            live_text: LiveText::Off, health: Arc::new(crate::recorder::Health::default()), recording: None,
        };
        assert_eq!(session(65, 30, true).elapsed().as_secs(), 65);
        assert_eq!(session(65, 30, false).elapsed().as_secs(), 95);
        assert_eq!(session(0, 12, false).elapsed().as_secs(), 12);
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
        // Resumed after a minute of earlier recording: the files hold one second of it, then one more.
        let resumed = meeting(&root, "crashed-resumed", "recording", true);
        let mut metadata: serde_json::Value = serde_json::from_slice(&std::fs::read(resumed.join("metadata.json")).unwrap()).unwrap();
        metadata["resume"] = serde_json::json!({ "atMs": 60_000, "sample": 16_000 });
        std::fs::write(resumed.join("metadata.json"), metadata.to_string()).unwrap();
        let mut queued = Vec::new();
        recover_archive(&root, |id| queued.push(id.to_string())).unwrap();
        queued.sort();
        assert_eq!(queued, vec!["crashed", "crashed-once", "crashed-resumed", "stopped-by-quit"]);
        let resumed = meetings::find(&root, "crashed-resumed").unwrap().0;
        assert_eq!((resumed.duration, resumed.resume.map(|r| r.at_ms)), (61, Some(60_000)));
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
    /// A meeting recorded with encryption: two seconds of `mic.qna`, plus half a frame from the crash.
    fn encrypted_meeting(root: &Path, id: &str, status: &str, key: &Arc<sealed::Key>) -> std::path::PathBuf {
        let dir = meeting(root, id, status, true);
        std::fs::remove_file(dir.join(AUDIO).join("mic.wav")).unwrap();
        let path = dir.join(AUDIO).join("mic.qna");
        let mut writer = sealed::Writer::create(&path, key.clone(), 16_000).unwrap();
        for i in 0..32_000 { writer.write_sample((i % 300) as i16).unwrap(); if i % 16_000 == 15_999 { writer.flush().unwrap(); } }
        writer.finalize().unwrap();
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut file, &[0xff, 0, 0, 0, 1, 2, 3]).unwrap();
        dir
    }
    #[test]
    fn recovers_an_encrypted_recording_without_its_key() {
        let root = archive("recover-sealed");
        encrypted_meeting(&root, "crashed", "recording", &Arc::new(sealed::Key::new(&[8; 32])));
        let mut queued = Vec::new();
        recover_archive(&root, |id| queued.push(id.to_string())).unwrap();
        assert_eq!(queued, vec!["crashed"]);
        let crashed = meetings::find(&root, "crashed").unwrap().0;
        assert_eq!((crashed.status.as_str(), crashed.duration, crashed.interrupted), ("processing", 2, true));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exports_playable_audio_without_replacing_anything() {
        let root = archive("export");
        let key = Arc::new(sealed::Key::new(&[9; 32]));
        let sealed_audio = encrypted_meeting(&root, "sealed", "ready", &key).join(AUDIO);
        let plain = meeting(&root, "plain", "ready", true).join(AUDIO);
        let folder = root.join("Exported");
        std::fs::create_dir_all(&folder).unwrap();
        let written = export_audio(&sealed_audio, "sealed", &folder, Some(&key)).unwrap();
        assert_eq!(written, vec![folder.join("sealed mic.wav").display().to_string()]);
        let samples: Vec<i16> = hound::WavReader::open(folder.join("sealed mic.wav")).unwrap().into_samples().map(Result::unwrap).collect();
        assert_eq!(samples.len(), 32_000);
        assert!(samples.iter().enumerate().all(|(i, s)| *s == (i % 300) as i16));
        // Again: a second copy beside the first. A WAV from before encryption is copied as it is.
        assert_eq!(export_audio(&sealed_audio, "sealed", &folder, Some(&key)).unwrap(), vec![folder.join("sealed mic 2.wav").display().to_string()]);
        export_audio(&plain, "plain", &folder, None).unwrap();
        assert_eq!(std::fs::read(folder.join("plain mic.wav")).unwrap(), std::fs::read(plain.join("mic.wav")).unwrap());
        assert_eq!(export_audio(&sealed_audio, "sealed", &folder, None).unwrap_err(), sealed::MISSING_KEY);
        assert_eq!(export_audio(&root.join("none"), "none", &folder, None).unwrap_err(), "This meeting has no audio to export.");
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
    fn a_recording_stops_by_itself_only_after_a_countdown_and_once_it_is_quiet() {
        let now = SystemTime::now();
        let call = |at| Some(Ending { reason: Reason::CallEnded("Zoom"), at });
        let silent = |at| Some(Ending { reason: Reason::Silent, at });
        // A long silence starts a countdown; anything shorter doesn't.
        assert_eq!(step(None, SILENT_MS - 1, now), Step::Wait);
        assert_eq!(step(None, SILENT_MS, now), Step::Start(Reason::Silent));
        // Any sound cancels a silence countdown, but not one for an ended call.
        assert_eq!(step(silent(now + Duration::from_secs(60)), 500, now), Step::Cancel);
        assert_eq!(step(call(now + Duration::from_secs(60)), 500, now), Step::Wait);
        // When the countdown runs out it stops, once nobody has been heard for a while.
        assert_eq!(step(call(now - Duration::from_secs(1)), QUIET_BEFORE_STOP_MS - 1, now), Step::Wait);
        assert_eq!(step(call(now - Duration::from_secs(1)), QUIET_BEFORE_STOP_MS, now), Step::Stop);
        assert_eq!(step(silent(now - Duration::from_secs(1)), SILENT_MS + 120_000, now), Step::Stop);
        assert_eq!(Reason::CallEnded("Zoom").text(), "The Zoom call ended.");
    }
    #[test]
    fn naming_a_speaker_changes_only_the_labels() {
        let root = archive("rename");
        let dir = meeting(&root, "named", "ready", false);
        let turn = |start_ms: u64, speaker: &str, text: &str| transcript::Turn { start_ms, end_ms: start_ms + 1000, speaker: speaker.into(), text: text.into(), removed: vec![], breaks: vec![] };
        let recorded = Transcript { version: 1, model: "test".into(), turns: vec![turn(0, "You", "Hi Maria."), turn(2000, "Speaker 1", "Um, hi."), turn(4000, "Speaker 2", "Hello.")], echo: vec![] };
        std::fs::write(dir.join("transcript.json"), serde_json::to_vec(&recorded).unwrap()).unwrap();
        let markdown = rename_speaker(&dir, "Speaker 1", " Maria Lopez ", false).unwrap();
        assert_eq!(markdown, "# Transcript\n\n### 00:00 You\nHi Maria.\n\n### 00:02 Maria Lopez\nUm, hi.\n\n### 00:04 Speaker 2\nHello.\n");
        assert_eq!(std::fs::read_to_string(dir.join("transcript.md")).unwrap(), markdown);
        let saved: Transcript = serde_json::from_slice(&std::fs::read(dir.join("transcript.json")).unwrap()).unwrap();
        assert_eq!(saved.turns.iter().map(|t| (t.speaker.as_str(), t.text.as_str())).collect::<Vec<_>>(), [("You", "Hi Maria."), ("Maria Lopez", "Um, hi."), ("Speaker 2", "Hello.")]);
        // Merging a voice into another, by its name.
        rename_speaker(&dir, "Speaker 2", "Maria Lopez", true).unwrap();
        assert!(rename_speaker(&dir, "Speaker 9", "Sam", true).unwrap_err().contains("Nobody is called"));
        assert!(rename_speaker(&dir, "Maria Lopez", "## Sam", true).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disk_thresholds() {
        assert_eq!(disk(20 << 30), Disk::Fine);
        assert_eq!(disk(900 << 20), Disk::Low);
        assert_eq!(disk(100 << 20), Disk::Full);
    }
}
