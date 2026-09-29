//! Transcript assembly: the mic ("You") and system audio ("Others") tracks are transcribed separately,
//! then merged into timed turns. `transcript.json` keeps the raw words plus cleanup deletions;
//! `transcript.md` is rendered from it in the `### mm:ss Speaker` format the app already reads.
use crate::cleanup;
use serde::{Deserialize, Serialize};

pub const YOU: &str = "You";
pub const OTHERS: &str = "Others";
/// Consecutive pieces from one speaker closer than this are one turn.
const TURN_GAP_MS: u64 = 2000;

/// A piece of recognized speech on one track.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    /// The voice activity detector heard a clear pause (at least half a second) just before it.
    #[serde(skip)]
    pub pause_before: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: String,
    pub text: String,
    /// Byte ranges of `text` removed by cleanup (fillers, stutters).
    #[serde(default)]
    pub removed: Vec<[usize; 2]>,
    /// Byte offsets where a clear pause ended an unpunctuated sentence; the clean view adds a full stop.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub breaks: Vec<usize>,
}
impl Turn {
    pub fn clean(&self) -> String { cleanup::render(&self.text, &self.removed, &self.breaks) }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub version: u32,
    pub model: String,
    pub turns: Vec<Turn>,
    /// Mic pieces dropped as the call's echo, kept only to diagnose the echo check. Never shown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub echo: Vec<Piece>,
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace().map(|w| w.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>()).filter(|w| !w.is_empty()).collect()
}
/// How many of `heard` appear in `played` in the same order (a word that's missing is skipped).
fn in_order(heard: &[String], played: &[String]) -> usize {
    let mut at = 0;
    heard.iter().filter(|w| played[at..].iter().position(|p| p == *w).map(|i| at += i + 1).is_some()).count()
}
/// The sentences of a piece with their estimated times (Whisper times whole segments, so a sentence's
/// time is interpolated from its position in the text).
fn sentences(piece: &Piece) -> Vec<Piece> {
    let text = piece.text.trim();
    let (len, span) = (text.len().max(1) as u64, piece.end_ms.saturating_sub(piece.start_ms));
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        if matches!(c, '.' | '?' | '!') && text[end..].starts_with(' ') || end == text.len() {
            let sentence = text[start..end].trim();
            if !sentence.is_empty() {
                let at = |offset: usize| piece.start_ms + span * offset as u64 / len;
                out.push(Piece { start_ms: at(start), end_ms: at(end), text: sentence.into(), pause_before: start == 0 && piece.pause_before });
            }
            start = end;
        }
    }
    out
}
/// On speakers, the mic also hears the other people, and Whisper often puts the user's words and
/// that echo in one segment. So each sentence of a mic piece is checked against the call audio that
/// was playing when it began: it's echo only when the call said the same words, in order (short
/// sentences exactly). A sentence that starts after the call's sentence ended is the user speaking,
/// so repeating "next Friday?" a moment later is never lost. When unsure, the sentence stays: a
/// duplicate line is better than a lost one.
fn split_echo(mic: Piece, system: &[Piece]) -> (Option<Piece>, Vec<Piece>) {
    let played_sentences: Vec<Piece> = system.iter().flat_map(sentences).collect();
    let (mut kept, mut echo): (Vec<Piece>, Vec<Piece>) = (Vec::new(), Vec::new());
    for sentence in sentences(&mic) {
        let heard = words(&sentence.text);
        let during: Vec<&Piece> = played_sentences.iter().filter(|s| sentence.start_ms < s.end_ms && s.start_ms < sentence.end_ms + 500).collect();
        let played: Vec<String> = during.iter().flat_map(|s| words(&s.text)).collect();
        // Word timings can put a sentence's start early (at the end of the silence before it), but echo
        // ends when the call's sentence ends, so either edge lining up counts.
        let near = during.iter().any(|s| s.start_ms.abs_diff(sentence.start_ms) <= 2500 || s.end_ms.abs_diff(sentence.end_ms) <= 1000);
        let same = if heard.len() < 3 { during.iter().any(|s| words(&s.text) == heard) } else { in_order(&heard, &played) * 5 >= heard.len() * 4 };
        if near && same && !heard.is_empty() { echo.push(sentence); } else { kept.push(sentence); }
    }
    if echo.is_empty() { return (Some(mic), echo); }
    let piece = kept.first().map(|first| Piece {
        start_ms: first.start_ms, end_ms: kept.last().map_or(first.end_ms, |l| l.end_ms),
        text: kept.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" "), pause_before: first.pause_before,
    });
    (piece, echo)
}

/// Merges both tracks into turns ordered by time, with cleanup ranges computed per turn. Returns the
/// turns and the mic sentences dropped as echo.
pub fn merge(mic: Vec<Piece>, system: Vec<Piece>) -> (Vec<Turn>, Vec<Piece>) {
    let (mut kept, mut echo) = (Vec::new(), Vec::new());
    for piece in mic {
        let (piece, dropped) = split_echo(piece, &system);
        kept.extend(piece);
        echo.extend(dropped);
    }
    let mic = kept;
    let mut pieces: Vec<(&str, Piece)> = mic.into_iter().map(|p| (YOU, p)).collect();
    pieces.extend(system.into_iter().map(|p| (OTHERS, p)));
    pieces.retain(|(_, p)| !p.text.trim().is_empty());
    pieces.sort_by_key(|(_, p)| p.start_ms);
    let mut turns: Vec<Turn> = Vec::new();
    for (speaker, piece) in pieces {
        match turns.last_mut() {
            Some(turn) if turn.speaker == speaker && piece.start_ms <= turn.end_ms + TURN_GAP_MS => {
                // Whisper sometimes drops the full stop between segments. It takes two signals to add one:
                // a pause the voice detector heard, and Whisper starting the next piece with a capital.
                let capital = piece.text.trim().chars().find(|c| c.is_alphabetic()).is_some_and(char::is_uppercase);
                if piece.pause_before && capital && !turn.text.ends_with(|c: char| c.is_ascii_punctuation() || c == '…') { turn.breaks.push(turn.text.len()); }
                turn.text = format!("{} {}", turn.text, piece.text.trim());
                turn.end_ms = turn.end_ms.max(piece.end_ms);
            }
            _ => turns.push(Turn { start_ms: piece.start_ms, end_ms: piece.end_ms, speaker: speaker.into(), text: piece.text.trim().into(), removed: vec![], breaks: vec![] }),
        }
    }
    for turn in &mut turns {
        let (removed, breaks) = cleanup::clean_with_breaks(&turn.text);
        turn.removed = removed;
        turn.breaks.extend(breaks);
        turn.breaks.sort_unstable();
        turn.breaks.dedup();
    }
    (turns, echo)
}

pub fn clock(ms: u64) -> String {
    let s = ms / 1000;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{:02}:{:02}", s / 60, s % 60) }
}
/// `transcript.md`: cleaned text when `clean` is set, otherwise verbatim. Turns that were only
/// filler disappear from the cleaned version.
pub fn markdown(transcript: &Transcript, clean: bool) -> String {
    let body: Vec<String> = transcript.turns.iter().filter_map(|t| {
        let text = if clean { t.clean() } else { t.text.trim().to_string() };
        (!text.is_empty()).then(|| format!("### {} {}\n{}", clock(t.start_ms), t.speaker, text))
    }).collect();
    if body.is_empty() { return "# Transcript\n\nNo speech was recognized in this recording.\n".into(); }
    format!("# Transcript\n\n{}\n", body.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn piece(start: u64, end: u64, text: &str) -> Piece { Piece { start_ms: start, end_ms: end, text: text.into(), pause_before: false } }
    fn transcript(turns: Vec<Turn>) -> Transcript { Transcript { version: 1, model: "test".into(), turns, echo: vec![] } }
    #[test]
    fn merges_tracks_into_turns_and_drops_echo() {
        let mic = vec![
            piece(0, 2000, "Hi, um, thanks for joining."),
            piece(2500, 4000, "Let's start with the launch."),
            piece(6000, 9000, "we can ship the analytics work next week"),
        ];
        let system = vec![piece(5800, 9200, "We can ship the analytics work next week."), piece(12000, 13000, "Sounds good.")];
        let (turns, echo) = merge(mic, system);
        assert_eq!(turns.iter().map(|t| t.speaker.as_str()).collect::<Vec<_>>(), vec![YOU, OTHERS, OTHERS]);
        assert_eq!(turns[0].text, "Hi, um, thanks for joining. Let's start with the launch.");
        assert_eq!(turns[0].end_ms, 4000);
        assert_eq!(turns[1].start_ms, 5800);
        assert_eq!(echo.len(), 1);
        let md = markdown(&transcript(turns), true);
        assert!(md.starts_with("# Transcript\n\n### 00:00 You\nHi, thanks for joining. Let's start with the launch.\n\n### 00:05 Others\n"));
    }
    #[test]
    fn echo_check_never_drops_the_users_own_words() {
        let system = vec![
            piece(10_000, 12_000, "Can you send the deck by Friday?"),
            piece(12_000, 13_000, "Sounds good."),
            piece(13_000, 16_000, "I will share the credentials with Priya."),
            piece(20_000, 21_000, "Yeah."),
        ];
        let you = |start, end, text| merge(vec![piece(start, end, text)], system.clone()).0.into_iter().find(|t| t.speaker == YOU).map(|t| t.text);
        // Speakers: the same words at the same moment (split differently, or partly heard at low volume).
        assert_eq!(you(10_100, 12_100, "can you send the deck by friday"), None);
        assert_eq!(you(12_080, 16_000, "Sounds good. I will share the credentials with Priya."), None);
        assert_eq!(you(13_300, 15_500, "share the credentials with"), None);
        assert_eq!(you(20_050, 20_900, "Yeah."), None);
        // Whisper put the user's line and the echo in one segment: only the echo goes.
        assert_eq!(you(13_000, 20_000, "I will share the credentials with Priya. Okay, I think we should ship the analytics work first.").as_deref(), Some("Okay, I think we should ship the analytics work first."));
        // The user: repeating a moment later, talking over the call, or agreeing briefly.
        for (start, end, text) in [
            (12_500, 14_000, "Send the deck by Friday, sure."),
            (10_500, 12_500, "Sorry, I missed the first part."),
            (13_100, 13_600, "Okay."),
            (21_100, 21_600, "Yeah."),
            (13_000, 16_000, "Sorry, I will share the deck with Tom later today."),
            (30_000, 32_000, "Can you send the deck by Friday?"),
        ] { assert_eq!(you(start, end, text).as_deref(), Some(text), "{text}"); }
    }
    #[test]
    fn a_heard_pause_ends_an_unpunctuated_sentence_in_the_clean_view_only() {
        let mut next = piece(12_900, 16_000, "Uh, I will share the credentials");
        next.pause_before = true;
        let mut continuation = piece(16_700, 18_000, "and the sample data.");
        continuation.pause_before = true;
        let (turns, _) = merge(vec![], vec![piece(12_100, 12_700, "Sounds good"), next, continuation]);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "Sounds good Uh, I will share the credentials and the sample data.");
        assert_eq!(turns[0].clean(), "Sounds good. I will share the credentials and the sample data.");
        let unpaused = merge(vec![], vec![piece(0, 1000, "I talked to"), piece(1000, 2000, "Maya about it.")]).0;
        assert_eq!(unpaused[0].clean(), "I talked to Maya about it.");
        assert_eq!(markdown(&transcript(turns), false), "# Transcript\n\n### 00:12 Others\nSounds good Uh, I will share the credentials and the sample data.\n");
    }
    #[test]
    fn verbatim_keeps_fillers_and_empty_turns_disappear_when_clean() {
        let (turns, _) = merge(vec![piece(0, 1000, "Um."), piece(5000, 6000, "Uh, yes.")], vec![]);
        let transcript_ = transcript(turns);
        assert_eq!(markdown(&transcript_, true), "# Transcript\n\n### 00:05 You\nYes.\n");
        assert_eq!(markdown(&transcript_, false), "# Transcript\n\n### 00:00 You\nUm.\n\n### 00:05 You\nUh, yes.\n");
        assert_eq!(markdown(&transcript(vec![]), true), "# Transcript\n\nNo speech was recognized in this recording.\n");
    }
    #[test]
    fn clock_switches_to_hours() {
        assert_eq!(clock(65_000), "01:05");
        assert_eq!(clock(3_723_000), "1:02:03");
    }
}
