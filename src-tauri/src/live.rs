//! The live transcript (macOS): while a meeting records, its speech is transcribed on this Mac a few
//! seconds after it's said and shown as a draft. Whisper starts it and settles the language; an
//! English meeting then switches to Parakeet (`parakeet`), which is fast enough to follow every second
//! and to show the sentence still being spoken. The full pass after Stop (`capture::process`) makes
//! the transcript that's kept; nothing here is written to disk.
use crate::capture::{self, LiveText};
use crate::parakeet::Parakeet;
use crate::recorder::{Health, RATE};
use crate::transcribe::{Detector, Engine};
use crate::transcript::{self, Piece};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

/// How often new audio is looked at: Whisper needs a few seconds per step, Parakeet a fraction of one.
const TICK: Duration = Duration::from_secs(3);
const PARAKEET_TICK: Duration = Duration::from_secs(1);
/// Speech counts as finished after this much silence, so a sentence isn't cut mid-word.
const HOLD_MS: u64 = 600;
/// Chunks stay short, so text follows speech closely even when nobody pauses for long.
const CHUNK_MS: u64 = 8_000;
/// Speech that has gone on this long without a pause is transcribed anyway.
const LONGEST_MS: u64 = 25_000;
const MS: usize = RATE as usize / 1000;

/// Which chunks of a buffer holding `buffered` ms of audio are ready to transcribe, and the ms from
/// which the buffer must be kept. Speech still going on at the end waits for a pause, unless `all`
/// (the recording paused) or it has gone on too long. Without speech, only the last second is kept,
/// in case a word is just starting.
fn ready(speech: &[(u64, u64)], buffered: u64, all: bool) -> (Vec<(u64, u64)>, u64) {
    let mut done = crate::transcribe::chunks(speech, CHUNK_MS);
    let open = !all && done.last().is_some_and(|&(start, _)| speech.last().is_some_and(|&(_, end)| buffered.saturating_sub(end) < HOLD_MS && end - start < LONGEST_MS));
    let kept = if open { done.pop().map(|(start, _)| start) } else { None };
    let keep = kept.unwrap_or_else(|| done.last().map_or(0, |&(_, end)| end).max(buffered.saturating_sub(1000)).min(buffered));
    (done, keep)
}

/// One track's audio that hasn't been transcribed yet, where it starts, what it said so far, and
/// (with Parakeet) the sentence still being spoken, which is redone each step until it's finished.
#[derive(Default)]
struct Track { audio: Vec<f32>, start_ms: u64, pieces: Vec<Piece>, speaking: Vec<Piece> }
/// What transcribes the draft.
enum Words { Whisper(Engine), Parakeet(Parakeet) }
struct Follower { detector: Detector, words: Words, tracks: [Track; 2], language: Option<&'static str> }
impl Follower {
    /// Transcribes what's ready on each track; `true` when there's new text.
    fn step(&mut self, feed: [Vec<f32>; 2], all: bool) -> Result<bool, String> {
        let mut changed = false;
        for (track, samples) in self.tracks.iter_mut().zip(feed) {
            track.audio.extend(samples);
            let buffered = (track.audio.len() / MS) as u64;
            if buffered < 1000 && !all { continue; }
            // Digital silence (nobody on the call has spoken yet) needs no detector.
            let speech = if track.audio.iter().all(|s| *s == 0.0) { Vec::new() } else { self.detector.speech(&track.audio)? };
            let (chunks, keep) = ready(&speech, buffered, all);
            let timed = |pieces: Vec<Piece>, start: u64| pieces.into_iter().map(|p| Piece { start_ms: p.start_ms + start, end_ms: p.end_ms + start, ..p }).collect::<Vec<_>>();
            for chunk in chunks {
                let pieces = match &mut self.words {
                    Words::Whisper(engine) => {
                        // Short chunks ("Okay.") are a poor guide to the language, so it's settled on a longer one.
                        if self.language.is_none() && chunk.1 - chunk.0 >= 4_000 { self.language = engine.language(&track.audio, chunk); }
                        engine.pieces(&track.audio, chunk, &speech, self.language.unwrap_or("auto"))?
                    }
                    Words::Parakeet(parakeet) => parakeet.pieces(&track.audio, chunk, &speech),
                };
                changed |= !pieces.is_empty();
                track.pieces.extend(timed(pieces, track.start_ms));
            }
            let keep = (keep as usize * MS).min(track.audio.len());
            // Speech after what's finished is still being said: Parakeet shows it as it grows.
            let speaking = match (&self.words, speech.last()) {
                (Words::Parakeet(parakeet), Some(&(_, end))) if !all && end > keep as u64 / MS as u64 => {
                    timed(parakeet.pieces(&track.audio, ((keep / MS) as u64, (end + 200).min(buffered)), &speech), track.start_ms)
                }
                _ => Vec::new(),
            };
            changed |= speaking != track.speaking;
            track.speaking = speaking;
            track.audio.drain(..keep);
            track.start_ms += (keep / MS) as u64;
        }
        Ok(changed)
    }
    /// An English meeting switches to Parakeet once Whisper has settled the language, freeing Whisper's memory.
    fn wants_parakeet(&self) -> bool { self.language == Some("en") && matches!(self.words, Words::Whisper(_)) }
    fn tick(&self) -> Duration { if matches!(self.words, Words::Parakeet(_)) { PARAKEET_TICK } else { TICK } }
    /// What's been said on each track, finished and still being said.
    fn said(&self) -> [Vec<Piece>; 2] { self.tracks.each_ref().map(|t| t.pieces.iter().chain(&t.speaking).cloned().collect()) }
}

/// Stops keeping samples when the live transcript ends for any reason, so they can't pile up.
struct Following(Arc<Health>);
impl Drop for Following { fn drop(&mut self) { self.0.follow(false); } }

/// Follows the recording of meeting `id` until it stops. `start_ms` is where its audio begins in the
/// meeting (after earlier recordings of it).
pub fn spawn(app: AppHandle, id: String, health: Arc<Health>, start_ms: u64) {
    health.follow(true);
    let following = Following(health);
    let (handle, meeting) = (app.clone(), id.clone());
    let spawned = std::thread::Builder::new().name("quietnote-live".into()).spawn(move || {
        if let Err(e) = follow(&app, &id, &following.0, start_ms) {
            eprintln!("QuietNote: the live transcript stopped: {e}");
            capture::set_live_text(&app, &id, LiveText::Failed);
        }
    });
    if spawned.is_err() { capture::set_live_text(&handle, &meeting, LiveText::Failed); }
}
fn follow(app: &AppHandle, id: &str, health: &Health, start_ms: u64) -> Result<(), String> {
    // Loading checks the model file and takes a few seconds; the recording has already started.
    let (detector, engine) = (Detector::load(app)?, Engine::load(app)?);
    if capture::following(app, id).is_none() { return Ok(()); }
    capture::set_live_text(app, id, LiveText::On);
    let track = || Track { start_ms, ..Default::default() };
    let mut follower = Follower { detector, words: Words::Whisper(engine), tracks: [track(), track()], language: None };
    let (mut flushed, mut tried) = (false, false);
    loop {
        std::thread::sleep(follower.tick());
        // Ends with the recording; the full pass takes over from here.
        let Some(paused) = capture::following(app, id) else { return Ok(()) };
        // While paused nothing new arrives, so what was said up to the pause is finished once.
        if paused && flushed { continue; }
        flushed = paused;
        if follower.step(health.take_feed(), paused)? {
            let [mic, system] = follower.said();
            capture::set_draft(app, id, &transcript::merge(mic, system).0);
        }
        // Once only: without the Parakeet model (or if it fails to load), Whisper carries on.
        if follower.wants_parakeet() && !tried {
            tried = true;
            match Parakeet::load(app) { Ok(parakeet) => follower.words = Words::Parakeet(parakeet), Err(e) => eprintln!("QuietNote: the live transcript stays with Whisper: {e}") }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_is_transcribed_once_its_speaker_pauses() {
        // Still talking at the end of the buffer: wait, and keep the speech from where it began.
        assert_eq!(ready(&[(1000, 3000)], 3300, false), (vec![], 800));
        // A pause after it: transcribe it, and keep only the silence after it.
        assert_eq!(ready(&[(1000, 3000)], 4500, false), (vec![(800, 3200)], 3500));
        // Two stretches with a long pause between: the first is done, the second waits.
        assert_eq!(ready(&[(1000, 3000), (12_000, 14_000)], 14_100, false), (vec![(800, 3200)], 11_800));
        // Paused: everything so far is transcribed.
        assert_eq!(ready(&[(1000, 3000), (12_000, 14_000)], 14_100, true), (vec![(800, 3200), (11_800, 14_200)], 14_100));
        // Talking for a long time without a pause doesn't hold the text back.
        assert_eq!(ready(&[(0, 26_000)], 26_000, false).0, vec![(0, 26_200)]);
        // Nothing said: only the last second is kept.
        assert_eq!(ready(&[], 5000, false), (vec![], 4000));
        assert_eq!(ready(&[], 400, true), (vec![], 0));
    }
    /// Plays a recording folder (mic.wav and system.wav) through the live transcript a step at a time, as
    /// while recording, and reports how long each step takes and how much text it made. With
    /// QUIETNOTE_TEST_PARAKEET=1 an English recording switches to Parakeet as the app does:
    /// `QUIETNOTE_TEST_AUDIO=/path/to/audio cargo test --release follows_a_recording -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn follows_a_recording() {
        use crate::transcribe::{samples, MODEL, VAD};
        let audio = std::path::PathBuf::from(std::env::var("QUIETNOTE_TEST_AUDIO").expect("QUIETNOTE_TEST_AUDIO"));
        let models = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
        let loading = std::time::Instant::now();
        let (detector, engine) = (Detector::open(&models.join(VAD)).unwrap(), Engine::open(&models.join(MODEL)).unwrap());
        println!("model loaded in {:?}", loading.elapsed());
        let tracks = crate::recorder::TRACKS.map(|t| samples(&audio.join(t)).unwrap_or_default());
        let length = tracks.iter().map(Vec::len).max().unwrap_or(0);
        let mut follower = Follower { detector, words: Words::Whisper(engine), tracks: Default::default(), language: None };
        let parakeet = std::env::var("QUIETNOTE_TEST_PARAKEET").is_ok();
        let (mut at, mut times, mut switched) = (0, Vec::new(), None);
        while at < length {
            let step = follower.tick().as_millis() as usize * MS;
            let feed = tracks.each_ref().map(|t| t[at.min(t.len())..(at + step).min(t.len())].to_vec());
            let started = std::time::Instant::now();
            follower.step(feed, false).unwrap();
            times.push((started.elapsed(), follower.tick()));
            at += step;
            if parakeet && follower.wants_parakeet() { follower.words = Words::Parakeet(crate::parakeet::fetched()); switched = Some(at / MS); }
        }
        follower.step(Default::default(), true).unwrap();
        if let Some(ms) = switched { println!("switched to Parakeet at {:.1}s", ms as f64 / 1000.0); }
        let late: Vec<_> = times.iter().filter(|(took, tick)| took > tick).collect();
        println!("steps slower than their tick: {}", late.len());
        let times: Vec<Duration> = times.iter().map(|(took, _)| *took).collect();
        let (turns, _) = transcript::merge(follower.tracks[0].pieces.clone(), follower.tracks[1].pieces.clone());
        if std::env::var("QUIETNOTE_TEST_PIECES").is_ok() { print!("{}", transcript::markdown(&transcript::Transcript { version: 1, model: String::new(), turns: turns.clone(), echo: vec![] }, false)); }
        let words: usize = turns.iter().map(|t| t.text.split_whitespace().count()).sum();
        let slowest = times.iter().max().copied().unwrap_or_default();
        let mean = times.iter().sum::<Duration>() / times.len().max(1) as u32;
        let rss = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok()
            .and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0) / 1024;
        println!("{:.0}s of audio in {} steps: mean {mean:?}, slowest {slowest:?} per step; {} turns, {words} words, language {:?}; rss {rss} MB",
            length as f64 / RATE as f64, times.len(), turns.len(), follower.language);
        assert!(!turns.is_empty());
    }
}
