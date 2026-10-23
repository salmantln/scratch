//! Telling the others apart (macOS). The call audio is one track with everyone else on it, so after
//! Stop it's split by voice on this Mac: pyannote segmentation finds where each voice speaks, speaker
//! embeddings (3D-Speaker ERes2Net) and clustering say which stretches are the same voice (sherpa-onnx).
//! Each of the others' sentences then takes the voice it overlaps most: "Speaker 1", "Speaker 2"… in
//! the order they first speak. With only one voice, the others stay "Others". Nothing here identifies
//! anyone; it only groups by sound.
use crate::transcribe::{locate, verified};
use crate::transcript::Piece;
use sherpa_onnx::{FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig, OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig, SpeakerEmbeddingExtractorConfig};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const SEGMENTATION: &str = "pyannote-segmentation-3.0.onnx";
pub const EMBEDDING: &str = "3dspeaker-eres2net-en-voxceleb-16k.onnx";
/// The same pins as `scripts/fetch-models.mjs`.
const MODELS: [(&str, u64, &str); 2] = [
    (SEGMENTATION, 5_992_913, "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"),
    (EMBEDDING, 26_485_263, "c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5"),
];
/// How different two stretches' voices must be to count as two people (distance between their
/// embeddings). Chosen on four real meetings (`accuracy::measures_accuracy`, AMI corpus): at 0.6 three
/// people became 21–44 voices and half their speech had the right one; at 1.0, 6–12 voices and 77%.
/// 1.1 scored the same with fewer voices, and 1.2 merged people, which naming can't undo.
pub(crate) const THRESHOLD: f32 = 1.0;
/// How far the segmentation's 10-second window moves each step, as a share of it. Half a window
/// grouped voices as well as smaller steps on the test call, about 2 minutes per hour of audio (an M-series Mac).
pub(crate) const SHIFT: f32 = 0.5;
/// A sentence that overlaps no voice (Whisper's timing can fall just outside one) takes the nearest
/// within this many ms; further away, it stays with "Others".
const NEAR_MS: u64 = 1000;

/// When each voice spoke on the call track: `(start ms, end ms, voice)`, voices numbered from 0 in the
/// order they first speak.
pub type Voices = Vec<(u64, u64, usize)>;

fn models(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let [(segmentation, s_size, s_hash), (embedding, e_size, e_hash)] = MODELS;
    Ok((verified(locate(app, segmentation), segmentation, s_size, s_hash)?, verified(locate(app, embedding), embedding, e_size, e_hash)?))
}
/// Splits `audio` (16 kHz call audio) by voice.
pub fn voices(app: &AppHandle, audio: &[f32]) -> Result<Voices, String> {
    let (segmentation, embedding) = models(app)?;
    split(&segmentation, &embedding, audio)
}
pub(crate) fn split(segmentation: &Path, embedding: &Path, audio: &[f32]) -> Result<Voices, String> { tuned(segmentation, embedding, audio, THRESHOLD, SHIFT) }
pub(crate) fn tuned(segmentation: &Path, embedding: &Path, audio: &[f32], threshold: f32, shift: f32) -> Result<Voices, String> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8) as i32;
    let path = |p: &Path| Some(p.to_string_lossy().into_owned());
    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig { pyannote: OfflineSpeakerSegmentationPyannoteModelConfig { model: path(segmentation), window_shift_ratio: shift }, num_threads: threads, ..Default::default() },
        embedding: SpeakerEmbeddingExtractorConfig { model: path(embedding), num_threads: threads, ..Default::default() },
        clustering: FastClusteringConfig { threshold, ..Default::default() },
        ..Default::default()
    };
    let diarizer = OfflineSpeakerDiarization::create(&config).ok_or("Couldn’t load the speaker models")?;
    // Too short to tell voices apart, and the models need a full window.
    if audio.len() < 16_000 * 2 { return Ok(Vec::new()); }
    let result = diarizer.process(audio).ok_or("Couldn’t tell the voices apart")?;
    let mut order: Vec<i32> = Vec::new();
    Ok(result.sort_by_start_time().into_iter().map(|s| {
        let voice = order.iter().position(|v| *v == s.speaker).unwrap_or_else(|| { order.push(s.speaker); order.len() - 1 });
        ((s.start.max(0.0) * 1000.0) as u64, (s.end.max(0.0) * 1000.0) as u64, voice)
    }).collect())
}

/// The voice a piece overlaps most, or else the nearest one close enough.
fn voice_of(piece: &Piece, voices: &Voices) -> Option<usize> {
    let mut by_voice: Vec<u64> = Vec::new();
    for &(start, end, voice) in voices {
        if by_voice.len() <= voice { by_voice.resize(voice + 1, 0); }
        by_voice[voice] += end.min(piece.end_ms).saturating_sub(start.max(piece.start_ms));
    }
    match by_voice.iter().enumerate().max_by_key(|(_, o)| **o) {
        Some((voice, overlap)) if *overlap > 0 => Some(voice),
        _ => voices.iter().map(|&(start, end, voice)| (start.saturating_sub(piece.end_ms).max(piece.start_ms.saturating_sub(end)), voice))
            .filter(|(gap, _)| *gap <= NEAR_MS).min_by_key(|(gap, _)| *gap).map(|(_, voice)| voice),
    }
}
/// Labels the others' pieces by voice, numbered from `first` ("Speaker 3" after an earlier part had
/// two). Returns how many numbers were used. With fewer than two voices among the pieces, nothing is
/// labelled.
pub fn label(pieces: &mut [Piece], voices: &Voices, first: usize) -> usize {
    let assigned: Vec<Option<usize>> = pieces.iter().map(|p| voice_of(p, voices)).collect();
    let mut heard: Vec<usize> = assigned.iter().flatten().copied().collect();
    heard.sort_unstable();
    heard.dedup();
    if heard.len() < 2 { return 0; }
    // Numbered in the order they first speak in these pieces.
    let mut numbered: Vec<usize> = Vec::new();
    for (piece, voice) in pieces.iter_mut().zip(assigned) {
        let Some(voice) = voice else { continue };
        let n = numbered.iter().position(|v| *v == voice).unwrap_or_else(|| { numbered.push(voice); numbered.len() - 1 });
        piece.speaker = Some(format!("Speaker {}", first + n));
    }
    numbered.len()
}
/// The highest "Speaker N" in earlier turns, so a resumed recording's new voices continue after it.
pub fn numbered(speakers: impl Iterator<Item = String>) -> usize {
    speakers.filter_map(|s| s.strip_prefix("Speaker ").and_then(|n| n.parse().ok())).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn piece(start: u64, end: u64) -> Piece { Piece { start_ms: start, end_ms: end, text: "Words.".into(), ..Default::default() } }
    #[test]
    fn sentences_take_the_voice_they_overlap_most() {
        let voices: Voices = vec![(0, 4_000, 0), (4_200, 9_000, 1), (9_100, 12_000, 0), (20_000, 21_000, 2)];
        let mut pieces = vec![piece(100, 3_900), piece(3_800, 8_800), piece(9_000, 11_500), piece(12_500, 13_000), piece(14_000, 15_000), piece(19_000, 23_000)];
        assert_eq!(label(&mut pieces, &voices, 1), 3);
        let speakers: Vec<Option<&str>> = pieces.iter().map(|p| p.speaker.as_deref()).collect();
        // Just after a voice ends, a sentence is still that voice; two seconds from any, it stays with "Others".
        assert_eq!(speakers, [Some("Speaker 1"), Some("Speaker 2"), Some("Speaker 1"), Some("Speaker 1"), None, Some("Speaker 3")]);
        // A resumed part's numbers continue after the earlier part's.
        let mut pieces = vec![piece(100, 3_900), piece(4_300, 8_800)];
        label(&mut pieces, &voices, 3);
        assert_eq!(pieces.iter().map(|p| p.speaker.as_deref()).collect::<Vec<_>>(), [Some("Speaker 3"), Some("Speaker 4")]);
        // One voice: the others stay "Others".
        let mut alone = vec![piece(100, 3_900), piece(9_200, 11_000)];
        assert_eq!(label(&mut alone, &voices, 1), 0);
        assert!(alone.iter().all(|p| p.speaker.is_none()));
        assert_eq!(numbered(["You", "Speaker 2", "Others", "Speaker 10", "Maria"].map(String::from).into_iter()), 10);
    }
    /// Splits a recording's call audio by voice and prints who spoke when, with the bundled models:
    /// `QUIETNOTE_TEST_AUDIO=/path/to/audio cargo test --release splits_voices -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn splits_voices_in_a_recording() {
        let audio = PathBuf::from(std::env::var("QUIETNOTE_TEST_AUDIO").expect("QUIETNOTE_TEST_AUDIO"));
        let models = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
        let call = crate::transcribe::samples(&audio.join("system.wav")).unwrap();
        let started = std::time::Instant::now();
        let setting = |name: &str, fallback: f32| std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback);
        let voices = tuned(&models.join(SEGMENTATION), &models.join(EMBEDDING), &call, setting("QUIETNOTE_THRESHOLD", THRESHOLD), setting("QUIETNOTE_SHIFT", SHIFT)).unwrap();
        println!("{:.0}s of call audio in {:?}: {} voices", call.len() as f64 / 16_000.0, started.elapsed(), voices.iter().map(|v| v.2 + 1).max().unwrap_or(0));
        for (start, end, voice) in &voices { println!("{:>7.1}–{:>7.1}s  voice {voice}", *start as f64 / 1000.0, *end as f64 / 1000.0); }
        if std::env::var("QUIETNOTE_TEST_TRANSCRIBE").is_ok() {
            use crate::transcribe::{MODEL, VAD};
            let [mic, mut system] = crate::transcribe::recognize(&models.join(MODEL), &models.join(VAD), &audio, 0, std::sync::Arc::new(|_| {})).unwrap();
            label(&mut system, &voices, 1);
            let (turns, echo) = crate::transcript::merge(mic, system);
            println!("{}", crate::transcript::markdown(&crate::transcript::Transcript { version: 1, model: MODEL.into(), turns, echo }, true));
        }
    }
}
