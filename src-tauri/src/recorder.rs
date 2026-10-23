//! Audio capture (macOS and Windows): the microphone and the system output (the other people on the
//! call) are recorded as two 16 kHz mono WAV tracks. System audio comes from a Core Audio process
//! tap on macOS (the "System Audio Recording" permission) and WASAPI loopback on Windows. Nothing
//! joins the call; this only hears what the Mac or PC plays. On speakers the microphone hears the
//! call too, so the call audio is cancelled out of the mic track before it's written (`Canceller`).
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use sonora_aec3::block::Block;
use sonora_aec3::block_processor::BlockProcessor;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;
pub const TRACKS: [&str; 2] = ["mic.wav", "system.wav"];
const MIC: usize = 0;
const SYSTEM: usize = 1;
/// Frames per resampler call at the device rate.
const CHUNK: usize = 1024;
#[cfg(target_os = "macos")]
pub const MIC_DENIED: &str = "QuietNote can’t use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.";
#[cfg(not(target_os = "macos"))]
pub const MIC_DENIED: &str = "Microphone access is off. Turn on “Let desktop apps access your microphone” in Settings → Privacy & security → Microphone, then try again.";
/// A stream that should deliver audio continuously but hasn't for this long is treated as dead.
const STALL_MS: u64 = 3000;
/// Streams that deliver audio even in silence, so a gap means the device stopped: always the mic,
/// and the macOS tap. Windows loopback legitimately goes quiet while nothing plays.
const WATCH_STALL: [bool; 2] = [true, cfg!(target_os = "macos")];
/// The name of QuietNote's private system audio device (macOS).
const SYSTEM_DEVICE: &str = "QuietNote system audio";
/// How often to retry a missing device and check whether the default device changed.
const POLL: Duration = Duration::from_secs(2);
/// The echo canceller works on 4 ms blocks.
const FRAME: usize = sonora_aec3::common::BLOCK_SIZE;
/// How long the mic waits for the call audio of the same moment before it's written without it (200 ms).
const ECHO_WAIT: usize = RATE as usize / 5;
/// Call audio kept for the canceller at most, in case the mic falls behind (2 s).
const ECHO_KEPT: usize = RATE as usize * 2;
/// A peak this loud counts as someone talking (about −34 dB), as the live transcript's dots do.
const LOUD: f32 = 0.02;

struct Chunk { rate: u32, channels: u16, samples: Vec<f32> }

/// What the UI and tray show about each track while recording.
pub struct Health {
    epoch: Instant,
    heard: [AtomicBool; 2],
    /// The loudest sample per track since the meter last read it (f32 bits; non-negative floats order like integers).
    peak: [AtomicU32; 2],
    restart: [AtomicBool; 2],
    /// Milliseconds after `epoch` when each track last delivered audio, and last sounded like someone talking.
    last_chunk: [AtomicU64; 2],
    loud: [AtomicU64; 2],
    /// An ongoing problem per track ("Microphone disconnected"), shown as a warning.
    problems: Mutex<[Option<String>; 2]>,
    /// The latest device change ("Microphone changed to AirPods Pro."), shown as information.
    note: Mutex<Option<String>>,
    devices: Mutex<[Option<String>; 2]>,
    /// The microphone the user chose, by name (`None`: the system default), and whether it just changed.
    mic: Mutex<Option<String>>,
    chosen: AtomicBool,
    /// While the live transcript follows the recording: the 16 kHz samples written since it last took
    /// them, per track, including silence padding, so their count is the position in the audio file.
    feed: [Mutex<Vec<f32>>; 2],
    live: AtomicBool,
}
impl Default for Health {
    fn default() -> Self {
        Health {
            epoch: Instant::now(), heard: Default::default(), peak: Default::default(), restart: Default::default(), last_chunk: Default::default(), loud: Default::default(), problems: Default::default(),
            note: Default::default(), devices: Default::default(), mic: Default::default(), chosen: Default::default(), feed: Default::default(), live: Default::default(),
        }
    }
}
impl Health {
    pub fn with_mic(mic: Option<String>) -> Self { Health { mic: Mutex::new(mic), ..Default::default() } }
    /// Switches the microphone (`None`: the system default); a running recording reopens it at once.
    pub fn choose_mic(&self, mic: Option<String>) {
        if let Ok(mut m) = self.mic.lock() { *m = mic; }
        self.chosen.store(true, Ordering::Relaxed);
    }
    fn chosen_mic(&self) -> Option<String> { self.mic.lock().ok().and_then(|m| m.clone()) }
    /// Starts or stops keeping written samples for the live transcript (macOS); stopping drops what's kept.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn follow(&self, on: bool) {
        self.live.store(on, Ordering::Relaxed);
        if !on { for feed in &self.feed { if let Ok(mut f) = feed.lock() { *f = Vec::new(); } } }
    }
    /// The samples written to each track since the last call.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn take_feed(&self) -> [Vec<f32>; 2] { [MIC, SYSTEM].map(|t| self.feed[t].lock().map(|mut f| std::mem::take(&mut *f)).unwrap_or_default()) }
    fn feed(&self, track: usize, samples: &[f32]) {
        if self.live.load(Ordering::Relaxed) { if let Ok(mut f) = self.feed[track].lock() { f.extend_from_slice(samples); } }
    }
    /// Forgets device trouble when the streams close for a pause; they're checked again on resume.
    /// Quiet is counted again from now, so a pause doesn't count as silence.
    pub fn clear(&self) {
        if let Ok(mut p) = self.problems.lock() { *p = Default::default(); }
        if let Ok(mut n) = self.note.lock() { *n = None; }
        self.heard_now();
    }
    /// Counts quiet from now, as if someone had just spoken.
    pub fn heard_now(&self) { for loud in &self.loud { loud.store(self.now(), Ordering::Relaxed); } }
    /// How long neither track has sounded like someone talking, in ms.
    pub fn quiet_for(&self) -> u64 { self.now().saturating_sub(self.loud.iter().map(|l| l.load(Ordering::Relaxed)).max().unwrap_or(0)) }
    /// Whether any non-zero sample arrived on the mic and system tracks.
    pub fn heard(&self) -> [bool; 2] { [self.heard[MIC].load(Ordering::Relaxed), self.heard[SYSTEM].load(Ordering::Relaxed)] }
    /// The loudest sample (0–1) on the mic and system tracks since the last call, for a live meter.
    pub fn take_levels(&self) -> [f32; 2] { [MIC, SYSTEM].map(|t| f32::from_bits(self.peak[t].swap(0, Ordering::Relaxed))) }
    /// The mic's problem first, then system audio's.
    pub fn problem(&self) -> Option<String> {
        let problems = self.problems.lock().ok()?;
        problems.iter().flatten().cloned().reduce(|a, b| format!("{a} {b}"))
    }
    pub fn note(&self) -> Option<String> { self.note.lock().ok().and_then(|n| n.clone()) }
    /// The names of the devices in use: the microphone, and the call audio source.
    pub fn devices(&self) -> [Option<String>; 2] { self.devices.lock().map(|d| d.clone()).unwrap_or_default() }
    fn set_problem(&self, track: usize, problem: Option<String>) { if let Ok(mut p) = self.problems.lock() { p[track] = problem; } }
    /// Shows information about the recording (a device change, why it paused).
    pub fn set_note(&self, note: String) { if let Ok(mut n) = self.note.lock() { *n = Some(note); } }
    fn now(&self) -> u64 { self.epoch.elapsed().as_millis() as u64 }
    fn delivered(&self, track: usize) { self.last_chunk[track].store(self.now(), Ordering::Relaxed); }
    fn silent_for(&self, track: usize) -> u64 { self.now().saturating_sub(self.last_chunk[track].load(Ordering::Relaxed)) }
}

pub struct Recording { stop: Sender<()>, thread: Option<JoinHandle<Result<(), String>>> }
impl Recording {
    /// Stops both streams and finalizes the WAV files.
    pub fn stop(mut self) -> Result<(), String> { self.finish() }
    fn finish(&mut self) -> Result<(), String> {
        let _ = self.stop.send(());
        self.thread.take().map_or(Ok(()), |t| t.join().map_err(|_| "The recorder stopped unexpectedly".to_string())?)
    }
}
impl Drop for Recording { fn drop(&mut self) { let _ = self.finish(); } }

/// The microphone permission as the OS reports it: "granted", "denied", "undetermined" (never asked),
/// or "unknown" where it can't be read. System audio permission can't be read without private API.
pub fn microphone_permission() -> &'static str {
    #[cfg(target_os = "macos")]
    return mac::microphone_permission();
    #[cfg(not(target_os = "macos"))]
    "unknown"
}
/// Asks for microphone access without recording anything (macOS shows its prompt the first time),
/// then returns the permission as `microphone_permission` reports it.
pub fn ask_microphone() -> &'static str {
    #[cfg(target_os = "macos")]
    let _ = mac::ensure_mic_access();
    microphone_permission()
}

/// The microphones this computer has, by name, for choosing one.
pub fn input_devices() -> Vec<String> {
    let mut names: Vec<String> = cpal::default_host().input_devices().map(|d| d.filter_map(|d| name(&d)).collect()).unwrap_or_default();
    // QuietNote's own system audio device is an input too while recording.
    names.retain(|n| n != SYSTEM_DEVICE);
    names.dedup();
    names
}
fn name(device: &cpal::Device) -> Option<String> { device.description().ok().map(|d| d.name().to_string()) }
fn fallback_note(health: &Health, name: &str) -> String {
    format!("{} isn’t available, so the microphone is {name}.", health.chosen_mic().unwrap_or_default())
}

/// Starts recording into `dir`. Fails if the microphone can't be used; a missing system audio
/// stream is reported through `Health` and leaves a silent system track while it's retried.
/// `append` continues the tracks already there (after a pause), from the same moment on both.
/// `cancel_echo` removes the call audio the microphone picks up from speakers.
pub fn start(dir: &Path, health: Arc<Health>, append: bool, cancel_echo: bool) -> Result<Recording, String> {
    #[cfg(target_os = "macos")]
    mac::ensure_mic_access()?;
    if append { even_tracks(dir, &health)?; }
    let played = Arc::new(Played::default());
    let (mic_echo, system_echo) = if cancel_echo { (Echo::Cancel(played.clone()), Echo::Share(played)) } else { (Echo::Off, Echo::Off) };
    let mic = writer(dir.join(TRACKS[MIC]), health.clone(), MIC, append, mic_echo)?;
    let system = writer(dir.join(TRACKS[SYSTEM]), health.clone(), SYSTEM, append, system_echo)?;
    let (stop, stopped) = mpsc::channel();
    let (ready_tx, ready) = mpsc::channel();
    let shared = health;
    // cpal streams aren't `Send` on every platform, so they live on one thread for the session.
    let thread = thread::Builder::new().name("quietnote-capture".into()).spawn(move || {
        let senders = [mic.0, system.0];
        let mut sources: [Option<Source>; 2] = [None, None];
        match Source::open(MIC, &senders[MIC], &shared) {
            Ok(source) => {
                if source.fallback { shared.set_note(fallback_note(&shared, &source.name)); }
                sources[MIC] = Some(source);
            }
            Err(e) => { let _ = ready_tx.send(Err(e)); return Ok(()); }
        }
        match Source::open(SYSTEM, &senders[SYSTEM], &shared) {
            Ok(source) => sources[SYSTEM] = Some(source),
            Err(e) => shared.set_problem(SYSTEM, Some(format!("Call audio isn’t being recorded: {e}. QuietNote keeps trying."))),
        }
        let _ = ready_tx.send(Ok(()));
        let mut polled = Instant::now();
        while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(Duration::from_millis(500)) {
            let poll = polled.elapsed() >= POLL;
            if poll { polled = Instant::now(); }
            for track in [MIC, SYSTEM] { watch(track, &mut sources[track], &senders[track], &shared, poll); }
        }
        drop(sources);
        drop(senders);
        [mic.1.join(), system.1.join()].into_iter().try_for_each(|r| r.map_err(|_| "A recording track stopped unexpectedly".to_string())?)
    }).map_err(|e| e.to_string())?;
    match ready.recv() {
        Ok(Ok(())) => Ok(Recording { stop, thread: Some(thread) }),
        Ok(Err(e)) => { let _ = thread.join(); Err(e) }
        Err(_) => Err("The recorder couldn’t start".into()),
    }
}

/// Why a track's stream is being reopened.
#[derive(Clone, Copy, PartialEq)]
enum Reopen { Lost, Stalled, Changed, Missing }
/// Keeps one track on a live device: reopens it when it was lost, stopped delivering audio, or the
/// system default changed, and says so. Audio already written is never touched; the writer pads the
/// gap with silence so both tracks stay on the meeting's clock.
fn watch(track: usize, source: &mut Option<Source>, tx: &Sender<Chunk>, health: &Arc<Health>, poll: bool) {
    let reason = match source {
        _ if health.restart[track].swap(false, Ordering::Relaxed) => Some(Reopen::Lost),
        _ if track == MIC && health.chosen.swap(false, Ordering::Relaxed) => Some(Reopen::Changed),
        None => poll.then_some(Reopen::Missing),
        Some(s) if WATCH_STALL[track] && s.opened.elapsed().as_millis() as u64 > STALL_MS && health.silent_for(track) > STALL_MS => Some(Reopen::Stalled),
        Some(s) if poll && s.follows_default && Source::default_id(track).is_some_and(|id| Some(id) != s.id) => Some(Reopen::Changed),
        // The chosen microphone was missing and has been connected since.
        Some(s) if poll && s.fallback && health.chosen_mic().is_some_and(|m| Source::input(&m).is_some()) => Some(Reopen::Changed),
        _ => None,
    };
    let Some(reason) = reason else { return };
    *source = None;
    let label = if track == MIC { "Microphone" } else { "Call audio" };
    match Source::open(track, tx, health) {
        Ok(opened) => {
            let name = opened.name.clone();
            health.set_problem(track, None);
            health.set_note(match (track, reason) {
                (MIC, _) if opened.fallback => fallback_note(health, &name),
                (MIC, Reopen::Changed) => format!("Microphone changed to {name}."),
                (_, Reopen::Changed) => format!("Call audio now comes from {name}."),
                (_, Reopen::Stalled) => format!("{label} stopped responding and was reconnected ({name})."),
                _ => format!("{label} reconnected ({name})."),
            });
            *source = Some(opened);
        }
        Err(e) => health.set_problem(track, Some(if track == MIC {
            "Microphone disconnected. No other microphone is available; call audio is still being recorded. Connect a microphone or stop recording.".into()
        } else {
            format!("Call audio isn’t being recorded: {e}. QuietNote keeps trying.")
        })),
    }
}

/// One open input stream. On macOS the system track also owns its process tap, which must outlive
/// the stream (fields drop in order).
struct Source {
    _stream: cpal::Stream,
    #[cfg(target_os = "macos")]
    _tap: Option<mac::SystemTap>,
    id: Option<String>,
    name: String,
    opened: Instant,
    /// Opened on the system default device, so a new default means reopening. The macOS tap hears
    /// every output device, so it never needs to follow.
    follows_default: bool,
    /// The chosen microphone wasn't connected, so this is the default instead.
    fallback: bool,
}
impl Source {
    fn input(name: &str) -> Option<cpal::Device> {
        cpal::default_host().input_devices().ok()?.find(|d| self::name(d).as_deref() == Some(name))
    }
    fn default_id(track: usize) -> Option<String> {
        let host = cpal::default_host();
        let device = if track == MIC { host.default_input_device() } else { host.default_output_device() };
        device.and_then(|d| d.id().ok()).map(|id| id.to_string())
    }
    fn open(track: usize, tx: &Sender<Chunk>, health: &Arc<Health>) -> Result<Source, String> {
        let host = cpal::default_host();
        #[cfg(target_os = "macos")]
        let tap = if track == SYSTEM { Some(mac::SystemTap::new()?) } else { None };
        let chosen = if track == MIC { health.chosen_mic() } else { None };
        let named = chosen.as_deref().and_then(Source::input);
        let fallback = chosen.is_some() && named.is_none();
        let follows_default = if track == MIC { named.is_none() } else { cfg!(not(target_os = "macos")) };
        let device = match track {
            MIC => match named { Some(device) => device, None => host.default_input_device().ok_or("No microphone was found")? },
            #[cfg(target_os = "macos")]
            _ => tap.as_ref().map(|t| t.device(&host)).ok_or("System audio is unavailable")??,
            // WASAPI records an output device's mix when an input stream is built on it (loopback).
            #[cfg(not(target_os = "macos"))]
            _ => host.default_output_device().ok_or("No audio output device was found")?,
        };
        let config = if track == SYSTEM && !device.supports_input() { device.default_output_config() } else { device.default_input_config() }.map_err(describe)?;
        let stream = match config.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, config.into(), tx, health, track),
            SampleFormat::F64 => build::<f64>(&device, config.into(), tx, health, track),
            SampleFormat::I16 => build::<i16>(&device, config.into(), tx, health, track),
            SampleFormat::I32 => build::<i32>(&device, config.into(), tx, health, track),
            SampleFormat::U16 => build::<u16>(&device, config.into(), tx, health, track),
            SampleFormat::U8 => build::<u8>(&device, config.into(), tx, health, track),
            SampleFormat::I8 => build::<i8>(&device, config.into(), tx, health, track),
            format => return Err(format!("Unsupported audio format {format}")),
        }?;
        stream.play().map_err(describe)?;
        let name = if track == SYSTEM && cfg!(target_os = "macos") { "this Mac’s sound output".to_string() }
            else { self::name(&device).unwrap_or_else(|| "the default device".into()) };
        if let Ok(mut devices) = health.devices.lock() { devices[track] = Some(name.clone()); }
        health.delivered(track);
        Ok(Source { _stream: stream, #[cfg(target_os = "macos")] _tap: tap, id: device.id().ok().map(|id| id.to_string()), name, opened: Instant::now(), follows_default, fallback })
    }
}
fn build<T: SizedSample + Send + 'static>(device: &cpal::Device, config: cpal::StreamConfig, tx: &Sender<Chunk>, health: &Arc<Health>, track: usize) -> Result<cpal::Stream, String>
where f32: FromSample<T> {
    let (tx, health, errors) = (tx.clone(), health.clone(), health.clone());
    let (rate, channels) = (config.sample_rate, config.channels);
    device.build_input_stream::<T, _, _>(config, move |data: &[T], _: &_| {
        health.delivered(track);
        let _ = tx.send(Chunk { rate, channels, samples: data.iter().map(|s| s.to_sample::<f32>()).collect() });
    }, move |error: cpal::Error| {
        use cpal::ErrorKind::*;
        match error.kind() {
            Xrun | RealtimeDenied | DeviceChanged => {}
            _ => {
                errors.set_problem(track, Some(if track == MIC { "Microphone disconnected. Reconnecting…".into() } else { "System audio source changed. Reconnecting…".into() }));
                errors.restart[track].store(true, Ordering::Relaxed);
            }
        }
    }, None).map_err(describe)
}
fn describe(error: cpal::Error) -> String {
    if error.kind() == cpal::ErrorKind::PermissionDenied { MIC_DENIED.into() } else { error.to_string() }
}

/// Mono 16 kHz resampler that accepts any device rate.
struct Converter { rate: u32, resampler: Option<Fft<f32>>, pending: Vec<f32> }
impl Converter {
    fn push(&mut self, rate: u32, mono: &[f32], out: &mut Vec<f32>) -> Result<(), String> {
        if rate != self.rate { self.flush(out)?; *self = Converter { rate, resampler: None, pending: Vec::new() }; }
        if rate == RATE { out.extend_from_slice(mono); return Ok(()); }
        if self.resampler.is_none() {
            self.resampler = Some(Fft::new(rate as usize, RATE as usize, CHUNK, 1, FixedSync::Input).map_err(|e| e.to_string())?);
        }
        self.pending.extend_from_slice(mono);
        let resampler = self.resampler.as_mut().expect("resampler");
        while self.pending.len() >= CHUNK {
            let input = InterleavedSlice::new(&self.pending[..CHUNK], 1, CHUNK).map_err(|e| e.to_string())?;
            out.extend(resampler.process(&input, None).map_err(|e| e.to_string())?.take_data());
            self.pending.drain(..CHUNK);
        }
        Ok(())
    }
    /// Resamples what's left, padded to a full chunk, and keeps only the real part.
    fn flush(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let (Some(resampler), false) = (self.resampler.as_mut(), self.pending.is_empty()) else { return Ok(()); };
        let real = (self.pending.len() as u64 * RATE as u64 / self.rate as u64) as usize;
        self.pending.resize(CHUNK, 0.0);
        let input = InterleavedSlice::new(&self.pending[..], 1, CHUNK).map_err(|e| e.to_string())?;
        out.extend(resampler.process(&input, None).map_err(|e| e.to_string())?.take_data().into_iter().take(real));
        self.pending.clear();
        Ok(())
    }
}

const SPEC: hound::WavSpec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
type Wav = hound::WavWriter<std::io::BufWriter<std::fs::File>>;
fn open_wav(path: &Path, append: bool) -> Result<Wav, String> {
    if append && path.exists() { hound::WavWriter::append(path) } else { hound::WavWriter::create(path, SPEC) }.map_err(|e| format!("Couldn’t write {}: {e}", path.display()))
}
/// Pads the shorter track with silence, so a resumed recording continues both tracks from the same moment.
fn even_tracks(dir: &Path, health: &Health) -> Result<(), String> {
    let paths = TRACKS.map(|t| dir.join(t));
    let lengths = paths.each_ref().map(|p| hound::WavReader::open(p).map(|r| r.duration()).unwrap_or(0));
    let longest = lengths.iter().copied().max().unwrap_or(0);
    for (track, (path, length)) in paths.iter().zip(lengths).enumerate().filter(|(_, (_, l))| *l < longest) {
        let mut wav = open_wav(path, true)?;
        for _ in length..longest { wav.write_sample(0i16).map_err(|e| e.to_string())?; }
        wav.finalize().map_err(|e| e.to_string())?;
        health.feed(track, &vec![0.0; (longest - length) as usize]);
    }
    Ok(())
}
/// The call audio as the system track wrote it, for the mic track's echo canceller: the samples not
/// used yet, and the track position just after the last one.
#[derive(Default)]
struct Played(Mutex<(u64, VecDeque<f32>)>);
impl Played {
    fn push(&self, samples: &[f32]) {
        let Ok(mut played) = self.0.lock() else { return };
        let (end, kept) = &mut *played;
        *end += samples.len() as u64;
        kept.extend(samples);
        let over = kept.len().saturating_sub(ECHO_KEPT);
        kept.drain(..over);
    }
    fn end(&self) -> u64 { self.0.lock().map_or(0, |p| p.0) }
    /// The call audio at track positions `at..at + frame.len()`: silence where none was written (yet),
    /// and anything older is dropped, since the mic has gone on without it.
    fn take(&self, at: u64, frame: &mut [f32]) {
        frame.fill(0.0);
        let Ok(mut played) = self.0.lock() else { return };
        let (end, kept) = &mut *played;
        let stale = at.saturating_sub(*end - kept.len() as u64).min(kept.len() as u64) as usize;
        kept.drain(..stale);
        // Dropped while the mic was far behind.
        let skip = ((*end - kept.len() as u64).saturating_sub(at) as usize).min(frame.len());
        let available = (frame.len() - skip).min(kept.len());
        for (slot, sample) in frame[skip..].iter_mut().zip(kept.drain(..available)) { *slot = sample; }
    }
}
/// Removes the call audio from the mic track with WebRTC's echo canceller (AEC3, in Rust). On speakers
/// the microphone hears the others too; the system track is exactly what played, so the canceller
/// learns how it reaches the microphone (delay and room) and subtracts it. Each 4 ms block of mic
/// audio waits until the call audio of the same moment is written, briefly, so the two line up.
///
/// Only the linear filter's output is kept: it subtracts the modelled echo and nothing else. AEC3's
/// suppressor after it would also mute the user while the call plays (talking over music or a
/// shared video lost whole words in testing); what little echo remains, the transcript's echo check catches.
struct Canceller { aec: BlockProcessor, filter: sonora::high_pass_filter::HighPassFilter, played: Arc<Played>, pending: Vec<f32>, at: u64, render: Block, capture: Block, linear: Block, block: Vec<Vec<f32>> }
impl Canceller {
    fn new(played: Arc<Played>) -> Self {
        let aec = BlockProcessor::new(&sonora_aec3::config::EchoCanceller3Config::default(), RATE as usize, 1, 1);
        // As in WebRTC, the mic's rumble and DC offset go first, so the filter models only what played.
        let filter = sonora::high_pass_filter::HighPassFilter::new(RATE as i32, 1);
        Canceller { aec, filter, played, pending: Vec::new(), at: 0, render: Block::new(1, 1), capture: Block::new(1, 1), linear: Block::new(1, 1), block: vec![vec![0.0; FRAME]] }
    }
    /// Cancels the echo in `samples` (mic audio continuing the track) into `out`. With `all` (the end),
    /// nothing waits and a final part block is written as it is.
    fn push(&mut self, samples: &[f32], out: &mut Vec<f32>, all: bool) {
        // AEC3 works in 16-bit sample units.
        const SCALE: f32 = 32768.0;
        self.pending.extend_from_slice(samples);
        let mut done = 0;
        while self.pending.len() - done >= FRAME {
            let waiting = self.pending.len() - done < ECHO_WAIT && self.played.end() < self.at + FRAME as u64;
            if waiting && !all { break; }
            let render = self.render.view_mut(0, 0);
            self.played.take(self.at, render);
            render.iter_mut().for_each(|s| *s *= SCALE);
            self.aec.buffer_render(&self.render);
            for (slot, s) in self.block[0].iter_mut().zip(&self.pending[done..done + FRAME]) { *slot = s * SCALE; }
            self.filter.process_channels(&mut self.block);
            self.capture.view_mut(0, 0).copy_from_slice(&self.block[0]);
            let saturated = self.block[0].iter().any(|s| s.abs() >= SCALE - 1.0);
            self.aec.process_capture(false, saturated, Some(&mut self.linear), &mut self.capture);
            // Removing echo never makes a block louder. Right after the call gets loud, before the filter
            // has learned the room, its estimate can be wrong and subtracting it would add a burst instead.
            let power = |s: &[f32]| s.iter().map(|x| x * x).sum::<f32>();
            let cleaned = if power(self.linear.view(0, 0)) <= power(&self.block[0]) { self.linear.view(0, 0) } else { &self.block[0][..] };
            out.extend(cleaned.iter().map(|s| s / SCALE));
            done += FRAME;
            self.at += FRAME as u64;
        }
        self.pending.drain(..done);
        if all {
            self.at += self.pending.len() as u64;
            out.append(&mut self.pending);
        }
    }
}
/// A track's part in echo cancellation: the system track shares what it writes, the mic track cancels it.
enum Echo { Share(Arc<Played>), Cancel(Arc<Played>), Off }

/// A track's sample channel and the thread writing it to disk.
type Writer = (Sender<Chunk>, JoinHandle<Result<(), String>>);
fn writer(path: PathBuf, health: Arc<Health>, track: usize, append: bool, echo: Echo) -> Result<Writer, String> {
    let wav = open_wav(&path, append)?;
    let (tx, rx) = mpsc::channel::<Chunk>();
    let handle = thread::Builder::new().name(format!("quietnote-{}", TRACKS[track])).spawn(move || {
        write(wav, rx, &health, track, echo).inspect_err(|e| health.set_problem(track, Some(format!("Recording stopped saving audio: {e}"))))
    }).map_err(|e| e.to_string())?;
    Ok((tx, handle))
}
fn write(mut wav: Wav, rx: Receiver<Chunk>, health: &Health, track: usize, echo: Echo) -> Result<(), String> {
    let started = Instant::now();
    let mut converter = Converter { rate: 0, resampler: None, pending: Vec::new() };
    // The track's position: everything handed on, including mic audio the canceller still holds.
    let mut written: u64 = 0;
    let mut out = Vec::new();
    let mut flushed = Instant::now();
    let (shared, mut canceller) = match echo {
        Echo::Share(played) => (Some(played), None),
        Echo::Cancel(played) => (None, Some(Canceller::new(played))),
        Echo::Off => (None, None),
    };
    let mut cleaned = Vec::new();
    let mut put = |wav: &mut hound::WavWriter<_>, samples: &[f32], written: &mut u64, all: bool| -> Result<(), String> {
        *written += samples.len() as u64;
        if let Some(played) = &shared { played.push(samples); }
        let samples = match canceller.as_mut() {
            Some(canceller) => { cleaned.clear(); canceller.push(samples, &mut cleaned, all); &cleaned[..] }
            None => samples,
        };
        for s in samples { wav.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| e.to_string())?; }
        health.feed(track, samples);
        Ok(())
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => {
                let channels = chunk.channels.max(1) as usize;
                let mono: Vec<f32> = chunk.samples.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect();
                if !health.heard[track].load(Ordering::Relaxed) && mono.iter().any(|s| *s != 0.0) { health.heard[track].store(true, Ordering::Relaxed); }
                let peak = mono.iter().fold(0f32, |m, s| m.max(s.abs())).min(1.0);
                health.peak[track].fetch_max(peak.to_bits(), Ordering::Relaxed);
                if peak >= LOUD { health.loud[track].store(health.now(), Ordering::Relaxed); }
                converter.push(chunk.rate, &mono, &mut out)?;
                put(&mut wav, &out, &mut written, false)?;
                out.clear();
            }
            // Loopback delivers nothing while no audio plays, and a reconnecting device leaves a gap.
            // Silence keeps both tracks on the same clock as the meeting.
            Err(RecvTimeoutError::Timeout) => {
                let behind = (started.elapsed().as_secs_f64() - 0.25).max(0.0) * RATE as f64;
                if (behind as u64) > written { put(&mut wav, &vec![0.0; behind as usize - written as usize], &mut written, false)?; }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Rewrites the header, so the file stays readable if QuietNote is closed abruptly.
        if flushed.elapsed() >= Duration::from_secs(1) { wav.flush().map_err(|e| e.to_string())?; flushed = Instant::now(); }
    }
    converter.flush(&mut out)?;
    put(&mut wav, &out, &mut written, true)?;
    wav.finalize().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resamples_any_device_rate_to_16k() {
        for rate in [48_000u32, 44_100, 16_000] {
            let mut converter = Converter { rate: 0, resampler: None, pending: Vec::new() };
            let mut out = Vec::new();
            // Ten seconds: the resampler's fixed delay (a few ms) mustn't grow into drift.
            let tone: Vec<f32> = (0..rate * 10).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5).collect();
            for chunk in tone.chunks(480) { converter.push(rate, chunk, &mut out).unwrap(); }
            converter.flush(&mut out).unwrap();
            assert!(out.len().abs_diff(RATE as usize * 10) < 400, "{rate} Hz gave {} samples", out.len());
            let peak = out[2000..14000].iter().fold(0f32, |m, s| m.max(s.abs()));
            assert!((peak - 0.5).abs() < 0.05, "{rate} Hz peak {peak}");
        }
    }
    #[test]
    fn pads_silence_while_a_track_is_quiet() {
        let path = std::env::temp_dir().join(format!("quietnote-pad-{}.wav", std::process::id()));
        let (tx, handle) = writer(path.clone(), Arc::new(Health::default()), SYSTEM, false, Echo::Off).unwrap();
        tx.send(Chunk { rate: RATE, channels: 2, samples: vec![0.25; 3200] }).unwrap();
        thread::sleep(Duration::from_millis(1300));
        drop(tx);
        handle.join().unwrap().unwrap();
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!((reader.spec().channels, reader.spec().sample_rate), (1, RATE));
        let samples: Vec<i16> = reader.into_samples().map(Result::unwrap).collect();
        assert!(samples[..1600].iter().all(|s| (*s - 8191).abs() <= 1));
        assert!((8_000..20_000).contains(&samples.len()), "{} samples", samples.len());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn a_resumed_recording_continues_both_tracks_from_the_same_moment() {
        let dir = std::env::temp_dir().join(format!("quietnote-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (track, length) in TRACKS.iter().zip([16_000, 12_000]) {
            let mut wav = open_wav(&dir.join(track), false).unwrap();
            for _ in 0..length { wav.write_sample(100i16).unwrap(); }
            wav.finalize().unwrap();
        }
        let health = Health::default();
        health.follow(true);
        even_tracks(&dir, &health).unwrap();
        // The live transcript hears the padding too, so it stays on the file's clock.
        assert_eq!(health.take_feed().map(|f| f.len()), [0, 4_000]);
        let (tx, handle) = writer(dir.join(TRACKS[SYSTEM]), Arc::new(Health::default()), SYSTEM, true, Echo::Off).unwrap();
        tx.send(Chunk { rate: RATE, channels: 1, samples: vec![0.25; 1600] }).unwrap();
        drop(tx);
        handle.join().unwrap().unwrap();
        let samples = |track: &str| hound::WavReader::open(dir.join(track)).unwrap().into_samples::<i16>().map(Result::unwrap).collect::<Vec<_>>();
        assert_eq!(samples(TRACKS[MIC]).len(), 16_000);
        let system = samples(TRACKS[SYSTEM]);
        // The earlier audio, silence up to where the mic track ended, then the resumed audio.
        assert_eq!(system.len(), 17_600);
        assert!(system[..12_000].iter().all(|s| *s == 100) && system[12_000..16_000].iter().all(|s| *s == 0));
        assert!(system[16_000..].iter().all(|s| (*s - 8191).abs() <= 1));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn health_reports_problems_per_track() {
        let health = Health::default();
        assert_eq!(health.problem(), None);
        health.set_problem(SYSTEM, Some("Call audio lost.".into()));
        health.set_problem(MIC, Some("Microphone disconnected.".into()));
        assert_eq!(health.problem().as_deref(), Some("Microphone disconnected. Call audio lost."));
        health.set_problem(MIC, None);
        assert_eq!(health.problem().as_deref(), Some("Call audio lost."));
        health.delivered(MIC);
        assert!(health.silent_for(MIC) < STALL_MS);
    }
    /// Speech-like noise: bursts of about a syllable, with short pauses.
    fn voice(seconds: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..seconds * RATE as usize).map(|i| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (state >> 8) as f32 / (1 << 24) as f32 * 2.0 - 1.0;
            let syllable = ((i as f32 / RATE as f32 * 4.0 + seed as f32) * std::f32::consts::PI).sin().max(0.0);
            noise * syllable * 0.3
        }).collect()
    }
    fn energy(samples: &[f32]) -> f32 { samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32 }
    /// Runs mic and call audio through the canceller in the chunk sizes the writers use, with the call
    /// audio arriving a little ahead or behind.
    fn cancel(mic: &[f32], call: &[f32], call_lead: isize) -> Vec<f32> {
        let played = Arc::new(Played::default());
        let mut canceller = Canceller::new(played.clone());
        let mut out = Vec::new();
        let step = 341;
        for at in (0..mic.len()).step_by(step) {
            let ahead = (at as isize + call_lead).clamp(0, call.len() as isize) as usize;
            let given = played.end() as usize;
            if ahead > given { played.push(&call[given..ahead]); }
            canceller.push(&mic[at..(at + step).min(mic.len())], &mut out, false);
        }
        played.push(&call[played.end() as usize..]);
        canceller.push(&[], &mut out, true);
        out
    }
    #[test]
    fn cancels_the_call_heard_through_speakers_but_keeps_the_users_voice() {
        let rate = RATE as usize;
        // Twelve seconds of the others talking; the mic hears them 60 ms later through the room, quieter.
        let call = voice(12, 7);
        let delay = rate * 60 / 1000;
        let echo: Vec<f32> = (0..call.len()).map(|i| if i >= delay { call[i - delay] * 0.5 + call[i.saturating_sub(delay + 40)] * 0.15 } else { 0.0 }).collect();
        // The user speaks over the last four seconds.
        let user = voice(4, 3);
        let mic: Vec<f32> = echo.iter().enumerate().map(|(i, e)| e + if i >= 8 * rate { user[i - 8 * rate] } else { 0.0 }).collect();
        for lead in [100 * rate as isize / 1000, 0, -(80 * rate as isize / 1000)] {
            let out = cancel(&mic, &call, lead);
            assert_eq!(out.len(), mic.len(), "every sample is written, in place");
            // Once it has learned the echo (a few seconds), what's left is far quieter: at least 15 dB.
            let removed = 10.0 * (energy(&mic[5 * rate..8 * rate]) / energy(&out[5 * rate..8 * rate])).log10();
            assert!(removed > 15.0, "echo reduced by only {removed:.1} dB (call audio lead {lead})");
            // The user's own voice, talking over the call, stays within 3 dB of what was said.
            let kept = 10.0 * (energy(&out[9 * rate..12 * rate]) / energy(&user[rate..])).log10();
            assert!(kept.abs() < 3.0, "the user's voice changed by {kept:.1} dB (call audio lead {lead})");
        }
        // Without call audio (headphones, or nobody else talking), the mic passes through unchanged in level.
        let alone = voice(6, 11);
        let out = cancel(&alone, &vec![0.0; alone.len()], 0);
        let change = 10.0 * (energy(&out[rate..]) / energy(&alone[rate..])).log10();
        assert!(change.abs() < 1.0, "the mic alone changed by {change:.1} dB");
    }
    #[test]
    fn call_audio_for_the_canceller_lines_up_by_track_position() {
        let played = Played::default();
        played.push(&[1.0; 100]);
        played.push(&[2.0; 100]);
        let mut frame = [9.0; 160];
        // Positions 50..210: what's there, then silence for what hasn't arrived.
        played.take(50, &mut frame);
        assert!(frame[..50].iter().all(|s| *s == 1.0) && frame[50..150].iter().all(|s| *s == 2.0) && frame[150..].iter().all(|s| *s == 0.0));
        // The late part of that frame arrives after it was used, so it's dropped as stale.
        played.push(&[3.0; 100]);
        played.take(210, &mut frame);
        assert!(frame[..90].iter().all(|s| *s == 3.0) && frame[90..].iter().all(|s| *s == 0.0));
        assert_eq!(played.end(), 300);
    }
    /// Cancels the echo in a recording made without it, as the recorder would have, and writes the
    /// folder again (system.wav as it was, mic.wav cancelled) for listening or `transcribes_a_recording`:
    /// `QUIETNOTE_TEST_AUDIO=/path/to/audio QUIETNOTE_TEST_OUT=/new/folder cargo test --release cancels_echo_in -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cancels_echo_in_a_recording() {
        let audio = PathBuf::from(std::env::var("QUIETNOTE_TEST_AUDIO").expect("QUIETNOTE_TEST_AUDIO"));
        let out = PathBuf::from(std::env::var("QUIETNOTE_TEST_OUT").expect("QUIETNOTE_TEST_OUT"));
        let [mic, call] = TRACKS.map(|t| crate::transcribe::samples(&audio.join(t)).unwrap());
        let started = Instant::now();
        let cancelled = cancel(&mic, &call, 0);
        println!("{:.0}s of audio in {:?}", mic.len() as f64 / RATE as f64, started.elapsed());
        // Seconds where the call was loud and the mic heard something: mostly echo on speakers.
        let rate = RATE as usize;
        let (mut before, mut after) = (0f32, 0f32);
        for second in 0..mic.len() / rate {
            let range = second * rate..(second + 1) * rate;
            if energy(&call[range.clone()]) > 1e-4 { before += energy(&mic[range.clone()]); after += energy(&cancelled[range]); }
        }
        println!("mic level while the call played: {:.1} dB lower", 10.0 * (before / after.max(1e-12)).log10());
        std::fs::create_dir_all(&out).unwrap();
        std::fs::copy(audio.join(TRACKS[SYSTEM]), out.join(TRACKS[SYSTEM])).unwrap();
        let mut wav = open_wav(&out.join(TRACKS[MIC]), false).unwrap();
        for s in cancelled { wav.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).unwrap(); }
        wav.finalize().unwrap();
    }
    /// Records from this computer's real devices (it asks for permissions the first time), then checks
    /// both tracks are valid, as long as the wall clock, and aligned:
    /// `QUIETNOTE_LIVE_SECONDS=300 cargo test --release records_live -- --ignored --nocapture`
    /// Set QUIETNOTE_LIVE_KEEP=1 to keep the audio (the folder is printed).
    #[test]
    #[ignore]
    fn records_live() {
        let seconds: u64 = std::env::var("QUIETNOTE_LIVE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        let dir = std::env::temp_dir().join(format!("quietnote-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ps = |field: &str| std::process::Command::new("ps").args(["-o", field, "-p", &std::process::id().to_string()]).output().ok()
            .and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(0.0);
        let rss = || ps("rss=") as u64 / 1024;
        let before = rss();
        let started = Instant::now();
        let health = Arc::new(Health::default());
        let recording = start(&dir, health.clone(), false, true).unwrap();
        let mut peak = 0;
        while started.elapsed() < Duration::from_secs(seconds) {
            thread::sleep(Duration::from_secs(10).min(Duration::from_secs(seconds).saturating_sub(started.elapsed())));
            peak = peak.max(rss());
            println!("{:>5}s  rss {:>4} MB  cpu {:>4.1}%  heard {:?}  silent for {:?} ms  devices {:?}  problem {:?}  note {:?}",
                started.elapsed().as_secs(), rss(), ps("%cpu="), health.heard(), [health.silent_for(MIC), health.silent_for(SYSTEM)], health.devices(), health.problem(), health.note());
        }
        let wall = started.elapsed().as_secs_f64();
        recording.stop().unwrap();
        let lengths: Vec<f64> = TRACKS.iter().map(|t| {
            let reader = hound::WavReader::open(dir.join(t)).unwrap();
            reader.len() as f64 / RATE as f64
        }).collect();
        println!("wall {wall:.1}s  tracks {lengths:?}s  rss before {before} MB, peak {peak} MB  folder {}", dir.display());
        // Opening devices costs a fixed fraction of a second at the start; beyond that, no drift.
        for length in &lengths { assert!((length - wall).abs() < 0.5 + wall * 0.002, "track {length:.2}s vs wall {wall:.2}s"); }
        assert!((lengths[0] - lengths[1]).abs() < 0.5);
        if std::env::var("QUIETNOTE_LIVE_KEEP").is_err() { std::fs::remove_dir_all(dir).unwrap(); }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use cpal::traits::{DeviceTrait, HostTrait};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::AnyThread;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use objc2_core_audio::{
        kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
        kAudioAggregateDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, AudioHardwareCreateAggregateDevice,
        AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap, AudioObjectID, CATapDescription, CATapMuteBehavior,
    };
    use objc2_core_foundation::CFDictionary;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    use std::ffi::CStr;
    use std::ptr::NonNull;
    use std::time::Duration;

    use super::MIC_DENIED;

    pub fn microphone_permission() -> &'static str {
        let Some(media) = (unsafe { AVMediaTypeAudio }) else { return "unknown" };
        match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) } {
            AVAuthorizationStatus::Authorized => "granted",
            AVAuthorizationStatus::NotDetermined => "undetermined",
            _ => "denied",
        }
    }
    /// Asks for microphone access the first time, and fails with a clear message if it's off.
    pub fn ensure_mic_access() -> Result<(), String> {
        let media = unsafe { AVMediaTypeAudio }.ok_or("The microphone is unavailable")?;
        match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) } {
            AVAuthorizationStatus::Authorized => Ok(()),
            AVAuthorizationStatus::NotDetermined => {
                let (tx, rx) = std::sync::mpsc::channel();
                let block = block2::RcBlock::new(move |granted: Bool| { let _ = tx.send(granted.as_bool()); });
                unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &block) };
                match rx.recv_timeout(Duration::from_secs(120)) { Ok(true) => Ok(()), _ => Err(MIC_DENIED.into()) }
            }
            _ => Err(MIC_DENIED.into()),
        }
    }

    /// A private aggregate device over a global tap of everything the Mac plays. It works whatever
    /// the output device is, including headsets that also have a microphone.
    pub struct SystemTap { tap: AudioObjectID, device: AudioObjectID, uid: String }
    impl SystemTap {
        pub fn new() -> Result<Self, String> {
            let failed = |what: &str, status: i32| format!("Couldn’t {what} (Core Audio error {status})");
            let description = unsafe { CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &NSArray::new()) };
            unsafe {
                description.setMuteBehavior(CATapMuteBehavior::Unmuted);
                description.setPrivate(true);
                description.setName(&NSString::from_str(super::SYSTEM_DEVICE));
            }
            let mut tap: AudioObjectID = 0;
            let status = unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap) };
            if status != 0 { return Err(failed("start the system audio tap", status)); }
            let tap_uid = unsafe { description.UUID().UUIDString() };
            // A fresh id per attempt, so a device still being torn down can't collide with the new one.
            static ATTEMPT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let uid = format!("app.quietnote.system-audio.{}.{}", std::process::id(), ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            let key = |k: &CStr| NSString::from_str(k.to_str().unwrap_or_default());
            let yes = NSNumber::new_bool(true);
            let sub_tap = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key(kAudioSubTapUIDKey), &*key(kAudioSubTapDriftCompensationKey)], &[&tap_uid, &yes]);
            let taps = NSArray::from_retained_slice(&[sub_tap]);
            let (name, uid_value) = (NSString::from_str(super::SYSTEM_DEVICE), NSString::from_str(&uid));
            let properties = NSDictionary::<NSString, AnyObject>::from_slices(
                &[&*key(kAudioAggregateDeviceNameKey), &*key(kAudioAggregateDeviceUIDKey), &*key(kAudioAggregateDeviceTapListKey), &*key(kAudioAggregateDeviceTapAutoStartKey), &*key(kAudioAggregateDeviceIsPrivateKey)],
                &[&name, &uid_value, &taps, &yes, &yes],
            );
            // NSDictionary is toll-free bridged to CFDictionary.
            let properties: &CFDictionary = unsafe { &*(Retained::as_ptr(&properties) as *const CFDictionary) };
            let mut device: AudioObjectID = 0;
            let status = unsafe { AudioHardwareCreateAggregateDevice(properties, NonNull::from(&mut device)) };
            if status != 0 {
                unsafe { AudioHardwareDestroyProcessTap(tap) };
                return Err(failed("create the system audio device", status));
            }
            Ok(SystemTap { tap, device, uid })
        }
        /// The aggregate device as cpal sees it. Core Audio publishes a new device a little after
        /// creating it (live runs showed anywhere from immediately to seconds), so this waits for it.
        pub fn device(&self, host: &cpal::Host) -> Result<cpal::Device, String> {
            for _ in 0..60 {
                let found = host.input_devices().map_err(|e| e.to_string())?.find(|d| d.id().is_ok_and(|id| id.to_string().ends_with(&self.uid)));
                if let Some(device) = found { return Ok(device); }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err("The system audio device didn’t appear".into())
        }
    }
    impl Drop for SystemTap {
        fn drop(&mut self) { unsafe { AudioHardwareDestroyAggregateDevice(self.device); AudioHardwareDestroyProcessTap(self.tap); } }
    }
}
