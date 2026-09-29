//! Local speech recognition with whisper.cpp. The bundled model and voice activity detector run on
//! this computer (Metal on Apple silicon, the CPU on Windows); audio never leaves it.
use crate::recorder::{RATE, TRACKS};
use crate::transcript::Piece;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

pub const MODEL: &str = "ggml-large-v3-turbo-q5_0.bin";
const VAD: &str = "ggml-silero-v6.2.0.bin";
/// Name, size and SHA-256 of each bundled model; the same pins as `scripts/fetch-models.mjs`.
const MODELS: [(&str, u64, &str); 2] = [
    (MODEL, 574_041_195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
    (VAD, 885_098, "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"),
];
/// Models whose full checksum already passed in this session.
static VERIFIED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelStatus { Ready, Missing, Damaged }

fn locate(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let bundled = app.path().resolve(format!("models/{name}"), BaseDirectory::Resource).ok().filter(|p| p.exists());
    // `tauri dev` runs from the build directory; use the fetched copy directly.
    let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models").join(name);
    bundled.or_else(|| (cfg!(debug_assertions) && local.exists()).then_some(local))
}
/// A quick check for the UI: both models are present at their expected size.
pub fn status(app: &AppHandle) -> ModelStatus {
    let mut status = ModelStatus::Ready;
    for (name, size, _) in MODELS {
        match locate(app, name).and_then(|p| std::fs::metadata(p).ok()) {
            None => return ModelStatus::Missing,
            Some(meta) if meta.len() != size => status = ModelStatus::Damaged,
            _ => {}
        }
    }
    status
}
fn sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
/// The model's path after a full checksum (once per session), so a damaged file fails clearly
/// instead of producing a wrong transcript.
fn verified(path: Option<PathBuf>, name: &str, size: u64, hash: &str) -> Result<PathBuf, String> {
    let path = path.ok_or_else(|| format!("The speech model {name} is missing from this installation of QuietNote. Reinstall QuietNote to transcribe."))?;
    if VERIFIED.lock().is_ok_and(|v| v.contains(&path)) { return Ok(path); }
    let damaged = || format!("The speech model {name} in this installation is damaged. Reinstall QuietNote to transcribe.");
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() != size { return Err(damaged()); }
    if sha256(&path).map_err(|e| format!("Couldn’t read the speech model: {e}"))? != hash { return Err(damaged()); }
    if let Ok(mut v) = VERIFIED.lock() { v.push(path.clone()); }
    Ok(path)
}
fn samples(path: &Path) -> Result<Vec<f32>, String> {
    let reader = hound::WavReader::open(path).map_err(|e| format!("Couldn’t read {}: {e}", path.display()))?;
    if reader.spec().sample_rate != RATE || reader.spec().channels != 1 { return Err(format!("{} isn’t 16 kHz mono audio", path.display())); }
    // A truncated final sample (from an abrupt exit) ends the track rather than failing it.
    Ok(reader.into_samples::<i16>().map_while(Result::ok).map(|s| s as f32 / 32768.0).collect())
}
/// Whisper's annotations for non-speech ("[BLANK_AUDIO]", "(music)") aren't words anyone said.
fn is_annotation(text: &str) -> bool {
    let t = text.trim();
    t.is_empty() || (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) || (t.starts_with('*') && t.ends_with('*'))
}

/// Transcribes the mic and system tracks in `audio`. `progress` gets 0–100.
///
/// No initial prompt is given: in testing, Whisper repeated prompt text (a meeting's name) as if
/// someone had said it, which would put words in the transcript that nobody spoke.
pub fn run(app: &AppHandle, audio: &Path, progress: Arc<dyn Fn(u8) + Send + Sync>) -> Result<[Vec<Piece>; 2], String> {
    let [(model, model_size, model_hash), (vad, vad_size, vad_hash)] = MODELS;
    let model = verified(locate(app, model), model, model_size, model_hash)?;
    let vad = verified(locate(app, vad), vad, vad_size, vad_hash)?;
    recognize(&model, &vad, audio, progress)
}
fn load(model: &Path) -> Result<WhisperContext, String> {
    let failed = |e: String| format!("Couldn’t load the speech model: {e}");
    // whisper.cpp opens files with narrow paths, which fail on Windows under a non-ASCII user folder;
    // reading the bytes in Rust avoids that.
    if cfg!(windows) {
        let bytes = std::fs::read(model).map_err(|e| failed(e.to_string()))?;
        return WhisperContext::new_from_buffer_with_params(&bytes, WhisperContextParameters::default()).map_err(|e| failed(e.to_string()));
    }
    WhisperContext::new_with_params(model, WhisperContextParameters::default()).map_err(|e| failed(e.to_string()))
}
/// Groups detected speech into chunks of at most `max_ms` (Whisper hears 30 seconds at a time),
/// padded slightly so words at the edges aren't clipped. Transcribing each chunk on its own gives
/// exact timestamps and keeps one misheard stretch from derailing the rest of the recording.
/// A chunk only ends at a real pause, so a word is never cut in two ("the 14" | "th of October"),
/// stretching up to Whisper's full 30-second window if it has to.
fn chunks(speech: &[(u64, u64)], max_ms: u64) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = Vec::new();
    for &(start, end) in speech {
        match out.last_mut() {
            Some(last) if end.saturating_sub(last.0) <= max_ms || (start < last.1 + 300 && end.saturating_sub(last.0) <= 30_000) => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out.into_iter().map(|(start, end)| (start.saturating_sub(200), end + 200)).collect()
}
fn normalized(word: &str) -> String { word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect() }
/// Where a phrase of 2–8 words repeats at least three times in a row, as `(start word, phrase length)`.
/// People don't do that; it's Whisper's decoder stuck in a loop.
fn find_loop(words: &[&str]) -> Option<(usize, usize)> {
    let norm: Vec<String> = words.iter().map(|w| normalized(w)).collect();
    for i in 0..norm.len() {
        for n in 2..=8 {
            if i + 3 * n > norm.len() { break; }
            if norm[i..i + n].iter().all(|w| !w.is_empty()) && norm[i..i + n] == norm[i + n..i + 2 * n] && norm[i..i + n] == norm[i + 2 * n..i + 3 * n] { return Some((i, n)); }
        }
    }
    None
}
/// Removes the repeats of each loop, keeping the first occurrence: deletion only.
fn collapse_loops(text: &str) -> String {
    let mut words: Vec<&str> = text.split_whitespace().collect();
    while let Some((i, n)) = find_loop(&words) {
        let mut end = i + n;
        while end + n <= words.len() && (0..n).all(|k| normalized(words[i + k]) == normalized(words[end + k])) { end += n; }
        words.drain(i + n..end);
    }
    words.join(" ")
}
/// A sentence repeated three or more times in a row is a decoder loop too; the first one stays.
fn drop_repeats(sentences: Vec<(u64, u64, String)>) -> Vec<(u64, u64, String)> {
    let key = |t: &str| t.split_whitespace().map(normalized).collect::<Vec<_>>();
    let mut out: Vec<(u64, u64, String)> = Vec::new();
    let mut run = 0;
    for (i, sentence) in sentences.iter().enumerate() {
        run = if i > 0 && key(&sentence.2) == key(&sentences[i - 1].2) { run + 1 } else { 1 };
        let runs_on = sentences[i..].iter().take_while(|s| key(&s.2) == key(&sentence.2)).count() + run - 1;
        if run == 1 || runs_on < 3 { out.push(sentence.clone()); } else if let Some(last) = out.last_mut() { last.1 = sentence.1; }
    }
    out
}
/// Whisper can time the first word after a silence at the end of that silence. Each piece starts at the
/// first detected speech it overlaps by more than a moment, so it lands where the talking began.
fn align(pieces: &mut [Piece], speech: &[(u64, u64)]) {
    for piece in pieces {
        let overlap = |(start, end): &(u64, u64)| end.min(&piece.end_ms).saturating_sub(*start.max(&piece.start_ms));
        if let Some(&(start, _)) = speech.iter().find(|r| overlap(r) >= 300) {
            piece.start_ms = piece.start_ms.max(start).min(piece.end_ms);
        }
    }
}
/// Marks pieces that begin a speech region following at least half a second of silence.
fn mark_pauses(pieces: &mut [Piece], speech: &[(u64, u64)]) {
    for piece in pieces {
        piece.pause_before = speech.windows(2).any(|w| w[1].0 >= w[0].1 + 500 && piece.start_ms.abs_diff(w[1].0) <= 300);
    }
}
fn params(strategy: SamplingStrategy, language: &str, threads: i32) -> FullParams<'_, '_> {
    let mut params = FullParams::new(strategy);
    params.set_n_threads(threads);
    params.set_language(Some(language));
    params.set_translate(false);
    params.set_temperature(0.0);
    // Each chunk starts fresh, so a mistake in one can't carry into the next.
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params
}
/// One chunk's sentences as `(start ms, end ms, text)` relative to the chunk, timed from Whisper's
/// word timestamps (a segment can hold several sentences, and the echo check needs each one's time).
/// A sentence also ends where the words stop for a second or more.
fn transcribe_chunk(state: &mut WhisperState, audio: &[f32], strategy: SamplingStrategy, language: &str, threads: i32) -> Result<Vec<(u64, u64, String)>, String> {
    let mut params = params(strategy, language, threads);
    params.set_token_timestamps(true);
    state.full(params, audio).map_err(|e| format!("Transcription failed: {e}"))?;
    let mut out = Vec::new();
    for segment in state.as_iter() {
        let (mut text, mut start, mut end) = (Vec::<u8>::new(), None::<i64>, 0i64);
        let mut flush = |text: &mut Vec<u8>, start: &mut Option<i64>, end: i64| {
            let sentence = String::from_utf8_lossy(text).trim().to_string();
            if let (false, Some(t0)) = (is_annotation(&sentence), *start) { out.push((t0.max(0) as u64 * 10, end.max(t0).max(0) as u64 * 10, sentence)); }
            text.clear();
            *start = None;
        };
        for i in 0..segment.n_tokens() {
            let Some(token) = segment.get_token(i) else { continue };
            let Ok(bytes) = token.to_bytes() else { continue };
            // Special tokens ("[_BEG_]", "<|endoftext|>") aren't words.
            if bytes.starts_with(b"[_") || bytes.starts_with(b"<|") { continue; }
            let data = token.token_data();
            // A second or more between words is two utterances Whisper ran together.
            if start.is_some() && data.t0 - end >= 100 { flush(&mut text, &mut start, end); }
            if start.is_none() && bytes.iter().any(|b| !b.is_ascii_whitespace()) { start = Some(data.t0); }
            text.extend_from_slice(bytes);
            end = data.t1;
            if matches!(String::from_utf8_lossy(bytes).trim_end().chars().last(), Some('.' | '?' | '!')) { flush(&mut text, &mut start, end); }
        }
        flush(&mut text, &mut start, end);
    }
    Ok(out)
}
fn recognize(model: &Path, vad: &Path, audio: &Path, progress: Arc<dyn Fn(u8) + Send + Sync>) -> Result<[Vec<Piece>; 2], String> {
    whisper_rs::install_logging_hooks();
    let context = load(model)?;
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8) as i32;
    let mut tracks: [Vec<Piece>; 2] = Default::default();
    for (index, name) in TRACKS.iter().enumerate() {
        let path = audio.join(name);
        if !path.exists() { continue; }
        let audio = samples(&path)?;
        // Nothing to hear: a denied permission or an empty call leaves only digital silence.
        if audio.len() < RATE as usize / 2 || audio.iter().all(|s| *s == 0.0) { progress(((index + 1) * 50) as u8); continue; }
        let mut detector = WhisperVadContext::new(&vad.to_string_lossy(), WhisperVadContextParams::default()).map_err(|e| e.to_string())?;
        let speech: Vec<(u64, u64)> = detector.segments_from_samples(WhisperVadParams::new(), &audio).map_err(|e| e.to_string())?
            .map(|s| ((s.start.max(0.0) * 10.0) as u64, (s.end.max(0.0) * 10.0) as u64)).collect();
        let slice = |(start, end): (u64, u64)| &audio[(start as usize * 16).min(audio.len())..(end as usize * 16).min(audio.len())];
        let chunks = chunks(&speech, 25_000);
        let mut state = context.create_state().map_err(|e| e.to_string())?;
        // The language is detected once, from the longest stretch of speech: a short chunk ("Okay.")
        // could be mistaken for another language.
        let language = chunks.iter().max_by_key(|(s, e)| e - s)
            .and_then(|&chunk| { state.pcm_to_mel(slice(chunk), threads as usize).ok()?; state.lang_detect(0, threads as usize).ok() })
            .and_then(|(id, _)| whisper_rs::get_lang_str(id)).unwrap_or("auto");
        for (done, &chunk) in chunks.iter().enumerate() {
            let looped = |sentences: &[(u64, u64, String)]| find_loop(&sentences.iter().flat_map(|(_, _, t)| t.split_whitespace()).collect::<Vec<_>>()).is_some();
            let mut sentences = transcribe_chunk(&mut state, slice(chunk), SamplingStrategy::Greedy { best_of: 1 }, language, threads)?;
            // A loop gets one more try with beam search; if it persists, only the repeats are removed.
            if looped(&sentences) {
                sentences = transcribe_chunk(&mut state, slice(chunk), SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 }, language, threads)?;
            }
            tracks[index].extend(drop_repeats(sentences).into_iter().map(|(start, end, text)| Piece {
                start_ms: chunk.0 + start, end_ms: (chunk.0 + end).min(chunk.1), text: collapse_loops(&text), pause_before: false,
            }));
            progress((index * 50 + (done + 1) * 50 / chunks.len()) as u8);
        }
        align(&mut tracks[index], &speech);
        mark_pauses(&mut tracks[index], &speech);
    }
    progress(100);
    Ok(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_is_chunked_and_pauses_are_marked() {
        assert_eq!(chunks(&[(1000, 3000), (4000, 6000), (30_000, 31_000), (31_500, 60_000)], 25_000), vec![(800, 6200), (29_800, 31_200), (31_300, 60_200)]);
        // No cut at a 100 ms dip inside a word; the chunk runs on toward 30 s instead.
        assert_eq!(chunks(&[(0, 24_000), (24_100, 27_000), (28_000, 29_000)], 25_000), vec![(0, 27_200), (27_800, 29_200)]);
        let piece = |start, end| Piece { start_ms: start, end_ms: end, text: "Sounds good".into(), pause_before: false };
        let speech = [(12100, 12700), (12900, 14000), (14800, 17400)];
        let mut pieces = vec![piece(12100, 12700), piece(12950, 14000), piece(14700, 17400)];
        mark_pauses(&mut pieces, &speech);
        let mut early = vec![piece(6_600, 22_500), piece(6_400, 22_500)];
        align(&mut early, &[(400, 6_500), (17_500, 22_500)]);
        assert_eq!(early.iter().map(|p| p.start_ms).collect::<Vec<_>>(), vec![17_500, 17_500]);
        assert_eq!(pieces.iter().map(|p| p.pause_before).collect::<Vec<_>>(), vec![false, false, true]);
    }
    #[test]
    fn decoder_loops_are_cut_to_one_occurrence() {
        assert_eq!(collapse_loops("I will send the link to the link to the link to the link to the"), "I will send the link to the");
        assert_eq!(collapse_loops("Yes, I will send the data set. Yes, I will send the data set. Yes, I will send the data set."), "Yes, I will send the data set.");
        // What people really repeat stays.
        for text in ["No no no, that's fine.", "We said it twice: ship it, ship it.", "Bye, bye, bye then."] { assert_eq!(collapse_loops(text), text); }
        let s = |t: &str| (0, 1000, t.to_string());
        let kept = drop_repeats(vec![s("Hello."), s("Yes, I will send it."), s("Yes, I will send it."), s("Yes, I will send it."), s("Bye.")]);
        assert_eq!(kept.iter().map(|k| k.2.as_str()).collect::<Vec<_>>(), vec!["Hello.", "Yes, I will send it.", "Bye."]);
        let twice = drop_repeats(vec![s("Okay."), s("Okay."), s("Next.")]);
        assert_eq!(twice.len(), 3);
    }
    #[test]
    fn a_damaged_or_missing_model_fails_clearly() {
        let path = std::env::temp_dir().join(format!("quietnote-model-{}.bin", std::process::id()));
        std::fs::write(&path, b"not a model").unwrap();
        assert!(verified(None, "m.bin", 11, "x").unwrap_err().contains("missing"));
        assert!(verified(Some(path.clone()), "m.bin", 99, "x").unwrap_err().contains("damaged"));
        assert!(verified(Some(path.clone()), "m.bin", 11, "0000").unwrap_err().contains("damaged"));
        let hash = sha256(&path).unwrap();
        assert_eq!(verified(Some(path.clone()), "m.bin", 11, &hash).unwrap(), path);
        std::fs::remove_file(path).unwrap();
    }
    /// Runs the bundled model on a real recording folder (with mic.wav and/or system.wav):
    /// `QUIETNOTE_TEST_AUDIO=/path/to/audio cargo test transcribes -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn transcribes_a_recording() {
        let audio = PathBuf::from(std::env::var("QUIETNOTE_TEST_AUDIO").expect("QUIETNOTE_TEST_AUDIO"));
        let models = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
        let started = std::time::Instant::now();
        let [mic, system] = recognize(&models.join(MODEL), &models.join(VAD), &audio, Arc::new(|_| {})).unwrap();
        if std::env::var("QUIETNOTE_TEST_PIECES").is_ok() {
            for (name, pieces) in [("mic", &mic), ("system", &system)] { for p in pieces { println!("{name} {:>6}-{:>6} {}", p.start_ms, p.end_ms, p.text); } }
        }
        let (turns, echo) = crate::transcript::merge(mic, system);
        println!("dropped as echo: {echo:?}");
        let transcript = crate::transcript::Transcript { version: 1, model: MODEL.into(), turns, echo };
        println!("{:?}\n--- verbatim ---\n{}--- clean ---\n{}", started.elapsed(), crate::transcript::markdown(&transcript, false), crate::transcript::markdown(&transcript, true));
        assert!(!transcript.turns.is_empty());
    }
}
