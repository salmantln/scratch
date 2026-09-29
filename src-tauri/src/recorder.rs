//! Audio capture (macOS and Windows): the microphone and the system output (the other people on the
//! call) are recorded as two 16 kHz mono WAV tracks. System audio comes from a Core Audio process
//! tap on macOS (the "System Audio Recording" permission) and WASAPI loopback on Windows. Nothing
//! joins the call; this only hears what the Mac or PC plays.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// How often to retry a missing device and check whether the default device changed.
const POLL: Duration = Duration::from_secs(2);

struct Chunk { rate: u32, channels: u16, samples: Vec<f32> }

/// What the UI and tray show about each track while recording.
pub struct Health {
    epoch: Instant,
    heard: [AtomicBool; 2],
    restart: [AtomicBool; 2],
    /// Milliseconds after `epoch` when each track last delivered audio.
    last_chunk: [AtomicU64; 2],
    /// An ongoing problem per track ("Microphone disconnected"), shown as a warning.
    problems: Mutex<[Option<String>; 2]>,
    /// The latest device change ("Microphone changed to AirPods Pro."), shown as information.
    note: Mutex<Option<String>>,
    devices: Mutex<[Option<String>; 2]>,
}
impl Default for Health {
    fn default() -> Self {
        Health { epoch: Instant::now(), heard: Default::default(), restart: Default::default(), last_chunk: Default::default(), problems: Default::default(), note: Default::default(), devices: Default::default() }
    }
}
impl Health {
    /// Whether any non-zero sample arrived on the mic and system tracks.
    pub fn heard(&self) -> [bool; 2] { [self.heard[MIC].load(Ordering::Relaxed), self.heard[SYSTEM].load(Ordering::Relaxed)] }
    /// The mic's problem first, then system audio's.
    pub fn problem(&self) -> Option<String> {
        let problems = self.problems.lock().ok()?;
        problems.iter().flatten().cloned().reduce(|a, b| format!("{a} {b}"))
    }
    pub fn note(&self) -> Option<String> { self.note.lock().ok().and_then(|n| n.clone()) }
    /// The names of the devices in use: the microphone, and the call audio source.
    pub fn devices(&self) -> [Option<String>; 2] { self.devices.lock().map(|d| d.clone()).unwrap_or_default() }
    fn set_problem(&self, track: usize, problem: Option<String>) { if let Ok(mut p) = self.problems.lock() { p[track] = problem; } }
    fn set_note(&self, note: String) { if let Ok(mut n) = self.note.lock() { *n = Some(note); } }
    fn now(&self) -> u64 { self.epoch.elapsed().as_millis() as u64 }
    fn delivered(&self, track: usize) { self.last_chunk[track].store(self.now(), Ordering::Relaxed); }
    fn silent_for(&self, track: usize) -> u64 { self.now().saturating_sub(self.last_chunk[track].load(Ordering::Relaxed)) }
}

pub struct Recording { stop: Sender<()>, thread: Option<JoinHandle<Result<(), String>>>, pub health: Arc<Health> }
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

/// Starts recording into `dir`. Fails if the microphone can't be used; a missing system audio
/// stream is reported through `Health` and leaves a silent system track while it's retried.
pub fn start(dir: &Path) -> Result<Recording, String> {
    #[cfg(target_os = "macos")]
    mac::ensure_mic_access()?;
    let health = Arc::new(Health::default());
    let mic = writer(dir.join(TRACKS[MIC]), health.clone(), MIC)?;
    let system = writer(dir.join(TRACKS[SYSTEM]), health.clone(), SYSTEM)?;
    let (stop, stopped) = mpsc::channel();
    let (ready_tx, ready) = mpsc::channel();
    let shared = health.clone();
    // cpal streams aren't `Send` on every platform, so they live on one thread for the session.
    let thread = thread::Builder::new().name("quietnote-capture".into()).spawn(move || {
        let senders = [mic.0, system.0];
        let mut sources: [Option<Source>; 2] = [None, None];
        match Source::open(MIC, &senders[MIC], &shared) {
            Ok(source) => sources[MIC] = Some(source),
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
        Ok(Ok(())) => Ok(Recording { stop, thread: Some(thread), health }),
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
        None => poll.then_some(Reopen::Missing),
        Some(s) if WATCH_STALL[track] && s.opened.elapsed().as_millis() as u64 > STALL_MS && health.silent_for(track) > STALL_MS => Some(Reopen::Stalled),
        Some(s) if poll && s.follows_default && Source::default_id(track).is_some_and(|id| Some(id) != s.id) => Some(Reopen::Changed),
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
}
impl Source {
    fn default_id(track: usize) -> Option<String> {
        let host = cpal::default_host();
        let device = if track == MIC { host.default_input_device() } else { host.default_output_device() };
        device.and_then(|d| d.id().ok()).map(|id| id.to_string())
    }
    fn open(track: usize, tx: &Sender<Chunk>, health: &Arc<Health>) -> Result<Source, String> {
        let host = cpal::default_host();
        #[cfg(target_os = "macos")]
        let tap = if track == SYSTEM { Some(mac::SystemTap::new()?) } else { None };
        let device = match track {
            MIC => host.default_input_device().ok_or("No microphone was found")?,
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
        let follows_default = track == MIC || cfg!(not(target_os = "macos"));
        let name = if track == SYSTEM && cfg!(target_os = "macos") { "this Mac’s sound output".to_string() }
            else { device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "the default device".into()) };
        if let Ok(mut devices) = health.devices.lock() { devices[track] = Some(name.clone()); }
        health.delivered(track);
        Ok(Source { _stream: stream, #[cfg(target_os = "macos")] _tap: tap, id: device.id().ok().map(|id| id.to_string()), name, opened: Instant::now(), follows_default })
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

/// A track's sample channel and the thread writing it to disk.
type Writer = (Sender<Chunk>, JoinHandle<Result<(), String>>);
fn writer(path: PathBuf, health: Arc<Health>, track: usize) -> Result<Writer, String> {
    let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let wav = hound::WavWriter::create(&path, spec).map_err(|e| format!("Couldn’t create {}: {e}", path.display()))?;
    let (tx, rx) = mpsc::channel::<Chunk>();
    let handle = thread::Builder::new().name(format!("quietnote-{}", TRACKS[track])).spawn(move || {
        write(wav, rx, &health, track).inspect_err(|e| health.set_problem(track, Some(format!("Recording stopped saving audio: {e}"))))
    }).map_err(|e| e.to_string())?;
    Ok((tx, handle))
}
fn write(mut wav: hound::WavWriter<std::io::BufWriter<std::fs::File>>, rx: Receiver<Chunk>, health: &Health, track: usize) -> Result<(), String> {
    let started = Instant::now();
    let mut converter = Converter { rate: 0, resampler: None, pending: Vec::new() };
    let mut written: u64 = 0;
    let mut out = Vec::new();
    let mut flushed = Instant::now();
    let put = |wav: &mut hound::WavWriter<_>, samples: &[f32], written: &mut u64| -> Result<(), String> {
        for s in samples { wav.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| e.to_string())?; }
        *written += samples.len() as u64;
        Ok(())
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => {
                let channels = chunk.channels.max(1) as usize;
                let mono: Vec<f32> = chunk.samples.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect();
                if !health.heard[track].load(Ordering::Relaxed) && mono.iter().any(|s| *s != 0.0) { health.heard[track].store(true, Ordering::Relaxed); }
                converter.push(chunk.rate, &mono, &mut out)?;
                put(&mut wav, &out, &mut written)?;
                out.clear();
            }
            // Loopback delivers nothing while no audio plays, and a reconnecting device leaves a gap.
            // Silence keeps both tracks on the same clock as the meeting.
            Err(RecvTimeoutError::Timeout) => {
                let behind = (started.elapsed().as_secs_f64() - 0.25).max(0.0) * RATE as f64;
                if (behind as u64) > written { put(&mut wav, &vec![0.0; behind as usize - written as usize], &mut written)?; }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Rewrites the header, so the file stays readable if QuietNote is closed abruptly.
        if flushed.elapsed() >= Duration::from_secs(1) { wav.flush().map_err(|e| e.to_string())?; flushed = Instant::now(); }
    }
    converter.flush(&mut out)?;
    put(&mut wav, &out, &mut written)?;
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
        let (tx, handle) = writer(path.clone(), Arc::new(Health::default()), SYSTEM).unwrap();
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
        let recording = start(&dir).unwrap();
        let mut peak = 0;
        while started.elapsed() < Duration::from_secs(seconds) {
            thread::sleep(Duration::from_secs(10).min(Duration::from_secs(seconds).saturating_sub(started.elapsed())));
            let health = &recording.health;
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
                description.setName(&NSString::from_str("QuietNote system audio"));
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
            let (name, uid_value) = (NSString::from_str("QuietNote system audio"), NSString::from_str(&uid));
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
