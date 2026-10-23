//! Parakeet (NVIDIA's TDT transducer, 110M parameters, English) for the live transcript on macOS,
//! through sherpa-onnx on the CPU. It transcribes a few seconds of speech in tens of milliseconds and
//! uses a fraction of Whisper's memory, so English meetings get their words while they're spoken.
use crate::transcribe::{locate, verified};
use crate::transcript::Piece;
use sherpa_onnx::{OfflineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const DIR: &str = "parakeet-tdt-110m-en-int8";
/// The model's files, sizes and SHA-256: the same pins as `scripts/fetch-models.mjs`.
const FILES: [(&str, u64, &str); 4] = [
    ("encoder.int8.onnx", 131_113_202, "0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657"),
    ("decoder.int8.onnx", 3_955_863, "f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19"),
    ("joiner.int8.onnx", 1_411_403, "bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6"),
    ("tokens.txt", 9_953, "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10"),
];
/// It shares the computer with the call.
const THREADS: i32 = 2;
/// Shorter audio holds no word, and audio too short for one feature frame makes onnxruntime throw a
/// C++ exception, which Rust can't catch: the app aborts. 100 ms (1,600 samples) is well clear of it.
const SHORTEST: usize = 1_600;

pub struct Parakeet(OfflineRecognizer);
impl Parakeet {
    /// The bundled model, checked once per session; `None` without an error when it isn't installed.
    pub fn load(app: &AppHandle) -> Result<Parakeet, String> {
        let paths: Vec<PathBuf> = FILES.iter().map(|(name, size, hash)| {
            let name = format!("{DIR}/{name}");
            verified(locate(app, &name), &name, *size, hash)
        }).collect::<Result<_, _>>()?;
        Parakeet::open(&paths[0], &paths[1], &paths[2], &paths[3])
    }
    pub(crate) fn open(encoder: &Path, decoder: &Path, joiner: &Path, tokens: &Path) -> Result<Parakeet, String> {
        let path = |p: &Path| Some(p.to_string_lossy().into_owned());
        let config = OfflineRecognizerConfig {
            model_config: OfflineModelConfig {
                transducer: OfflineTransducerModelConfig { encoder: path(encoder), decoder: path(decoder), joiner: path(joiner) },
                tokens: path(tokens), model_type: Some("nemo_transducer".into()), num_threads: THREADS, ..Default::default()
            },
            decoding_method: Some("greedy_search".into()),
            ..Default::default()
        };
        OfflineRecognizer::create(&config).map(Parakeet).ok_or_else(|| "Couldn’t load the Parakeet model".into())
    }
    /// One stretch of audio as tokens with when each starts and how long it lasts (seconds).
    fn recognize(&self, audio: &[f32]) -> Option<Vec<(String, f32, f32)>> {
        if audio.len() < SHORTEST { return None; }
        let stream = self.0.create_stream();
        stream.accept_waveform(16_000, audio);
        self.0.decode(&stream);
        let result = stream.get_result()?;
        let (times, durations) = (result.timestamps.unwrap_or_default(), result.durations.unwrap_or_default());
        Some(result.tokens.into_iter().enumerate().map(|(i, token)| (token, times.get(i).copied().unwrap_or(0.0), durations.get(i).copied().unwrap_or(0.0))).collect())
    }
    /// One chunk of `audio` as pieces timed in ms from the start of `audio`, like Whisper's
    /// (`transcribe::Engine::pieces`), so the live transcript merges and checks echo the same way.
    pub fn pieces(&self, audio: &[f32], chunk: (u64, u64), speech: &[(u64, u64)]) -> Vec<Piece> {
        let tokens = self.recognize(crate::transcribe::span(audio, chunk)).unwrap_or_default();
        let mut pieces: Vec<Piece> = sentences(&tokens).into_iter().map(|(start, end, text)| Piece {
            start_ms: chunk.0 + start, end_ms: (chunk.0 + end).min(chunk.1), text, ..Default::default()
        }).collect();
        crate::transcribe::align(&mut pieces, speech);
        crate::transcribe::mark_pauses(&mut pieces, speech);
        pieces
    }
}
/// Tokens as timed sentences `(start ms, end ms, text)`: a sentence ends at its full stop, question or
/// exclamation mark, or where the words stop for a second or more (as with Whisper's).
fn sentences(tokens: &[(String, f32, f32)]) -> Vec<(u64, u64, String)> {
    let ms = |seconds: f32| (seconds.max(0.0) * 1000.0).round() as u64;
    let mut out = Vec::new();
    let (mut text, mut start, mut end) = (String::new(), 0u64, 0u64);
    let mut flush = |text: &mut String, start: u64, end: u64| {
        let sentence = text.trim();
        if !sentence.is_empty() { out.push((start, end.max(start), sentence.to_string())); }
        text.clear();
    };
    for (token, at, length) in tokens {
        // Punctuation can come as a token of its own, after a space, and even after a pause.
        let punctuation = token.trim().chars().all(|c| matches!(c, '.' | ',' | '?' | '!' | ';' | ':'));
        if !text.trim().is_empty() && ms(*at) >= end + 1000 && !punctuation { flush(&mut text, start, end); }
        if text.trim().is_empty() {
            if punctuation { continue; }
            start = ms(*at);
        }
        if punctuation { text.truncate(text.trim_end().len()); text.push_str(token.trim()); } else { text.push_str(token); }
        end = ms(at + length.max(0.08));
        if matches!(token.trim_end().chars().last(), Some('.' | '?' | '!')) { flush(&mut text, start, end); }
    }
    flush(&mut text, start, end);
    out
}

/// The model fetched into `resources/models`, for tests that run it.
#[cfg(test)]
pub(crate) fn fetched() -> Parakeet {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models").join(DIR);
    Parakeet::open(&dir.join(FILES[0].0), &dir.join(FILES[1].0), &dir.join(FILES[2].0), &dir.join(FILES[3].0)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens_become_timed_sentences() {
        let t = |token: &str, at: f32| (token.to_string(), at, 0.16);
        let tokens = [t(" Okay", 0.24), t(",", 0.72), t(" let", 0.88), t("'", 1.04), t("s", 1.12), t(" go", 1.28), t(" .", 1.6), t(" S", 2.0), t("ure", 2.1), t(" then", 4.0), t(" .", 5.5), t("?", 6.0)];
        // A full stop that comes late still ends its sentence; one with no sentence is dropped.
        assert_eq!(sentences(&tokens), [(240, 1760, "Okay, let's go.".to_string()), (2000, 2260, "Sure".to_string()), (4000, 5660, "then.".to_string())]);
        assert!(sentences(&[]).is_empty());
    }
    /// Transcribes the first 20 seconds of a WAV file with the bundled model:
    /// `QUIETNOTE_TEST_WAV=/path/to.wav cargo test --release parakeet_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn parakeet_probe() {
        let parakeet = fetched();
        let audio = crate::transcribe::samples(Path::new(&std::env::var("QUIETNOTE_TEST_WAV").unwrap())).unwrap();
        let audio = &audio[..audio.len().min(16_000 * 20)];
        let started = std::time::Instant::now();
        let pieces = parakeet.pieces(audio, (0, 20_000), &[]);
        println!("{:?} for 20 s", started.elapsed());
        for p in pieces { println!("{:>6}-{:>6} {}", p.start_ms, p.end_ms, p.text); }
    }
}
