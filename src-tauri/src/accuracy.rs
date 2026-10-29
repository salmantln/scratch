//! How well QuietNote does its job, measured on meetings whose transcript is known (tests only). A
//! meeting folder holds `mic.wav` and `system.wav` (16 kHz mono, as the recorder writes them) and
//! `reference.json`, what was said: `[{ "speaker": "You", "startMs": 77440, "endMs": 80870, "text": "Hi, I'm David." }]`,
//! "You" for whoever is on the microphone and any other name for the people on the call.
//! `scripts/fetch-ami.mjs` makes such folders from the AMI Meeting Corpus. The scores:
//! - **Word error rate**: substituted, missing and added words over the words said, for what you said
//!   and what the others said, each against what QuietNote put under that side. Fillers (um, uh, hmm)
//!   and punctuation don't count on either side, and numbers are words ("25" is "twenty five"). A word
//!   under the wrong side counts twice: missing on one, added on the other. Only sentences within the
//!   reference's first and last words count (`MARGIN_MS`).
//! - The same for the **clean** transcript, which should be no worse: cleanup only deletes fillers.
//! - **Who said what** among the others: of the time exactly one of them talks, the share inside a
//!   sentence with that person's voice (each label matched one to one to the person it overlaps most),
//!   another voice, or no sentence at all.
use crate::transcript::{Piece, Turn};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Said { pub speaker: String, pub start_ms: u64, pub end_ms: u64, pub text: String }

/// Sounds that aren't words, left out on both sides (Whisper writes some, people transcribing write others).
const FILLERS: &[&str] = &["um", "umm", "uh", "uhm", "erm", "er", "hm", "hmm", "mm", "mmm", "mhm", "ah", "eh", "mm-hmm", "uh-huh", "mm-mm", "uh-uh"];
const ONES: [&str; 20] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

fn spell(n: u64) -> Vec<String> {
    let scale = |unit: u64, name: &str| { let mut words = spell(n / unit); words.push(name.into()); if !n.is_multiple_of(unit) { words.extend(spell(n % unit)); } words };
    match n {
        0..=19 => vec![ONES[n as usize].into()],
        20..=99 => { let mut words = vec![TENS[n as usize / 10].to_string()]; if !n.is_multiple_of(10) { words.push(ONES[n as usize % 10].into()); } words }
        100..=999 => scale(100, "hundred"),
        1_000..=999_999 => scale(1_000, "thousand"),
        _ => scale(1_000_000, "million"),
    }
}
fn ordinal(mut words: Vec<String>) -> Vec<String> {
    let last = words.pop().unwrap_or_default();
    words.push(match last.as_str() {
        "one" => "first".into(), "two" => "second".into(), "three" => "third".into(), "five" => "fifth".into(),
        "eight" => "eighth".into(), "nine" => "ninth".into(), "twelve" => "twelfth".into(),
        w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
        w => format!("{w}th"),
    });
    words
}
/// A number written in digits as it's said: "25" → twenty five, "2.5" → two point five, "3rd" → third.
fn number(token: &str) -> Option<Vec<String>> {
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    for suffix in ["st", "nd", "rd", "th"] {
        if let Some(n) = token.strip_suffix(suffix).filter(|n| digits(n)) { return n.parse().ok().map(|n| ordinal(spell(n))); }
    }
    let plain = token.replace(',', "");
    let (whole, fraction) = plain.split_once('.').unwrap_or((&plain, ""));
    if !digits(whole) || !(fraction.is_empty() || digits(fraction)) { return None; }
    let mut words = spell(whole.parse().ok()?);
    if !fraction.is_empty() { words.push("point".into()); words.extend(fraction.chars().map(|c| ONES[c as usize - '0' as usize].to_string())); }
    Some(words)
}
/// The words of `text` as they're compared: lower case, no punctuation or fillers, numbers spelled out,
/// hyphenated words split, and a few spellings made one ("ok" is okay, "gonna" is going to).
pub fn normalize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.split_whitespace() {
        let lower = raw.to_lowercase();
        let unit = if lower.contains('%') { Some("percent") } else if lower.starts_with('$') { Some("dollars") } else if lower.starts_with('€') { Some("euros") } else if lower.starts_with('£') { Some("pounds") } else { None };
        let core = lower.trim_matches(|c: char| !c.is_alphanumeric());
        if core.is_empty() || FILLERS.contains(&core) { continue; }
        if let Some(words) = number(core) { out.extend(words); out.extend(unit.map(String::from)); continue; }
        for part in core.split(|c: char| !c.is_alphanumeric() && c != '\'') {
            let part = part.trim_matches('\'');
            match part {
                "" => {}
                p if FILLERS.contains(&p) => {}
                "ok" | "kay" => out.push("okay".into()),
                "alright" => out.extend(["all".into(), "right".into()]),
                "gonna" => out.extend(["going".into(), "to".into()]),
                "wanna" => out.extend(["want".into(), "to".into()]),
                "gotta" => out.extend(["got".into(), "to".into()]),
                p => out.extend(number(p).unwrap_or_else(|| vec![p.to_string()])),
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Errors { pub words: usize, pub substituted: usize, pub missing: usize, pub added: usize }
impl Errors {
    pub fn rate(&self) -> f64 { (self.substituted + self.missing + self.added) as f64 / self.words.max(1) as f64 }
    fn add(&mut self, other: Errors) { self.words += other.words; self.substituted += other.substituted; self.missing += other.missing; self.added += other.added; }
}
/// One difference between what was said and what was heard: a word said as another, missed, or added.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Miss { Substituted(String, String), Missing(String), Added(String) }

/// The fewest substitutions, missing and added words that turn `said` into `heard` (Levenshtein), and what they were.
pub fn align(said: &[String], heard: &[String]) -> (Errors, Vec<Miss>) {
    let (n, m) = (said.len(), heard.len());
    // One byte per cell for the way back (0 diagonal, 1 missing, 2 added); costs a row at a time.
    let mut way = vec![0u8; (n + 1) * (m + 1)];
    let mut row: Vec<u32> = (0..=m as u32).collect();
    way[1..=m].fill(2);
    for i in 1..=n {
        let mut diagonal = row[0];
        row[0] = i as u32;
        way[i * (m + 1)] = 1;
        for j in 1..=m {
            let up = row[j];
            let options = [diagonal + u32::from(said[i - 1] != heard[j - 1]), up + 1, row[j - 1] + 1];
            let best = (0..3).min_by_key(|&k| options[k]).unwrap();
            row[j] = options[best];
            way[i * (m + 1) + j] = best as u8;
            diagonal = up;
        }
    }
    let (mut errors, mut misses) = (Errors { words: n, ..Default::default() }, Vec::new());
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        match way[i * (m + 1) + j] {
            0 => { if said[i - 1] != heard[j - 1] { errors.substituted += 1; misses.push(Miss::Substituted(said[i - 1].clone(), heard[j - 1].clone())); } i -= 1; j -= 1; }
            1 => { errors.missing += 1; misses.push(Miss::Missing(said[i - 1].clone())); i -= 1; }
            _ => { errors.added += 1; misses.push(Miss::Added(heard[j - 1].clone())); j -= 1; }
        }
    }
    misses.reverse();
    (errors, misses)
}

/// Who said what among the others, in ms of the time exactly one of them talks.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Voices { pub people: usize, pub voices: usize, pub right: u64, pub wrong: u64, pub unheard: u64 }
impl Voices {
    fn add(&mut self, other: Voices) { self.people += other.people; self.voices += other.voices; self.right += other.right; self.wrong += other.wrong; self.unheard += other.unheard; }
    pub fn share(&self, ms: u64) -> f64 { ms as f64 / (self.right + self.wrong + self.unheard).max(1) as f64 }
    pub fn line(&self) -> String {
        format!("{} voices for {} people; while one of them talks, {:.0}% in a sentence with their voice, {:.0}% another voice, {:.0}% in no sentence",
            self.voices, self.people, self.share(self.right) * 100.0, self.share(self.wrong) * 100.0, self.share(self.unheard) * 100.0)
    }
}
const FRAME_MS: u64 = 100;
/// Scores the labels of the call track's sentences (`pieces`, unlabelled meaning "Others") against
/// who of the others was talking.
pub fn who_said_what(said: &[Said], pieces: &[Piece]) -> Voices {
    let others: Vec<&Said> = said.iter().filter(|s| s.speaker != "You").collect();
    let mut people: Vec<&str> = others.iter().map(|s| s.speaker.as_str()).collect();
    people.sort_unstable();
    people.dedup();
    let mut labels: Vec<String> = pieces.iter().map(|p| p.speaker.clone().unwrap_or_else(|| "Others".into())).collect();
    labels.sort_unstable();
    labels.dedup();
    let frames = others.iter().map(|s| s.end_ms).chain(pieces.iter().map(|p| p.end_ms)).max().unwrap_or(0) / FRAME_MS + 1;
    // Per frame: the one person talking (None when nobody or several), and the labels heard.
    let mut talking: Vec<Option<Option<usize>>> = vec![None; frames as usize];
    for s in &others {
        let person = people.iter().position(|p| *p == s.speaker).unwrap();
        for f in s.start_ms / FRAME_MS..s.end_ms.div_ceil(FRAME_MS) {
            let slot = &mut talking[f as usize];
            *slot = match *slot { None => Some(Some(person)), Some(Some(p)) if p == person => Some(Some(p)), _ => Some(None) };
        }
    }
    let mut heard = vec![0u64; frames as usize];
    for p in pieces {
        let label = labels.iter().position(|l| *l == p.speaker.as_deref().unwrap_or("Others")).unwrap();
        for f in p.start_ms / FRAME_MS..p.end_ms.div_ceil(FRAME_MS) { heard[f as usize] |= 1 << label.min(63); }
    }
    let mut overlap = vec![vec![0u64; labels.len()]; people.len()];
    for (f, slot) in talking.iter().enumerate() {
        if let Some(Some(person)) = slot { for (l, o) in overlap[*person].iter_mut().enumerate() { if heard[f] & (1 << l.min(63)) != 0 { *o += 1; } } }
    }
    // Each person gets the label they share the most time with, one to one, best total.
    fn best(person: usize, overlap: &[Vec<u64>], used: &mut Vec<bool>) -> (u64, Vec<Option<usize>>) {
        if person == overlap.len() { return (0, Vec::new()); }
        let (mut top, mut choice) = { let (t, mut rest) = best(person + 1, overlap, used); rest.insert(0, None); (t, rest) };
        for l in 0..used.len() {
            if used[l] || overlap[person][l] == 0 { continue; }
            used[l] = true;
            let (t, mut rest) = best(person + 1, overlap, used);
            used[l] = false;
            if t + overlap[person][l] > top { top = t + overlap[person][l]; rest.insert(0, Some(l)); choice = rest; }
        }
        (top, choice)
    }
    let (_, matched) = best(0, &overlap, &mut vec![false; labels.len()]);
    let mut voices = Voices { people: people.len(), voices: labels.iter().filter(|l| *l != "Others").count().max(1), ..Default::default() };
    for (f, slot) in talking.iter().enumerate() {
        let Some(Some(person)) = slot else { continue };
        if heard[f] == 0 { voices.unheard += FRAME_MS; }
        else if matched[*person].is_some_and(|l| heard[f] & (1 << l.min(63)) != 0) { voices.right += FRAME_MS; }
        else { voices.wrong += FRAME_MS; }
    }
    voices
}

/// A meeting's scores: verbatim and clean for each side, and who said what.
#[derive(Clone, Debug, Default)]
pub struct Score { pub you: [Errors; 2], pub others: [Errors; 2], pub voices: Voices, pub misses: Vec<Miss> }
impl Score {
    pub fn add(&mut self, other: &Score) {
        for k in 0..2 { self.you[k].add(other.you[k]); self.others[k].add(other.others[k]); }
        self.voices.add(other.voices);
        self.misses.extend(other.misses.iter().cloned());
    }
}
/// How far outside the reference's first and last words a sentence still counts. A transcript made by
/// people can start after the recording does (AMI's skip the chat before the meeting), and words nobody
/// transcribed aren't errors.
const MARGIN_MS: u64 = 2_000;
fn within(said: &[Said], start_ms: u64, end_ms: u64) -> bool {
    let from = said.iter().map(|s| s.start_ms).min().unwrap_or(0).saturating_sub(MARGIN_MS);
    end_ms > from && start_ms < said.iter().map(|s| s.end_ms).max().unwrap_or(0) + MARGIN_MS
}
/// Who said what, for the call track's sentences inside the reference.
pub fn voices(said: &[Said], pieces: &[Piece]) -> Voices {
    who_said_what(said, &pieces.iter().filter(|p| within(said, p.start_ms, p.end_ms)).cloned().collect::<Vec<_>>())
}
pub fn score(said: &[Said], turns: &[Turn], pieces: &[Piece]) -> Score {
    let turns: Vec<&Turn> = turns.iter().filter(|t| within(said, t.start_ms, t.end_ms)).collect();
    let mut said: Vec<&Said> = said.iter().collect();
    said.sort_by_key(|s| s.start_ms);
    let reference = |you: bool| said.iter().filter(|s| (s.speaker == "You") == you).flat_map(|s| normalize(&s.text)).collect::<Vec<_>>();
    let heard = |you: bool, clean: bool| turns.iter().filter(|t| (t.speaker == "You") == you)
        .flat_map(|t| normalize(&if clean { t.clean() } else { t.text.clone() })).collect::<Vec<_>>();
    let (you, mut misses) = align(&reference(true), &heard(true, false));
    let (others, more) = align(&reference(false), &heard(false, false));
    misses.extend(more);
    Score {
        you: [you, align(&reference(true), &heard(true, true)).0],
        others: [others, align(&reference(false), &heard(false, true)).0],
        voices: voices(&said.into_iter().cloned().collect::<Vec<_>>(), pieces),
        misses,
    }
}
/// The differences seen most often, for the report.
pub fn common(misses: &[Miss], count: usize) -> Vec<(Miss, usize)> {
    let mut seen: HashMap<&Miss, usize> = HashMap::new();
    for m in misses { *seen.entry(m).or_default() += 1; }
    let mut seen: Vec<(Miss, usize)> = seen.into_iter().map(|(m, n)| (m.clone(), n)).collect();
    seen.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| format!("{:?}", a.0).cmp(&format!("{:?}", b.0))));
    seen.truncate(count);
    seen
}
pub fn report(score: &Score) -> String {
    let row = |name: &str, [verbatim, clean]: [Errors; 2]| format!("  {name:<15}{:>6}  {:>7.1}%  {:>7.1}%   {} / {} / {}\n", verbatim.words, verbatim.rate() * 100.0, clean.rate() * 100.0, verbatim.substituted, verbatim.missing, verbatim.added);
    let v = score.voices;
    let mut out = format!("  {:<15}{:>6}  {:>8}  {:>8}   substituted / missing / added\n", "", "words", "verbatim", "clean");
    out += &row("You", score.you);
    out += &row("The others", score.others);
    out += &format!("  Who said what: {}\n", v.line());
    let common = common(&score.misses, 12).into_iter().map(|(m, n)| match m {
        Miss::Substituted(said, heard) => format!("“{said}” → “{heard}” ×{n}"),
        Miss::Missing(said) => format!("missing “{said}” ×{n}"),
        Miss::Added(heard) => format!("added “{heard}” ×{n}"),
    }).collect::<Vec<_>>();
    out + &format!("  Most common: {}\n", common.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn words(text: &str) -> Vec<String> { text.split_whitespace().map(String::from).collect() }
    #[test]
    fn words_are_compared_without_fillers_punctuation_or_spelling_differences() {
        assert_eq!(normalize("Um, OK so it's 25 euros, uh, I'm gonna say."), words("okay so it's twenty five euros i'm going to say"));
        assert_eq!(normalize("Mm-hmm. The 3rd and 21st, €12.50, 40% of 1,200 people."), words("the third and twenty first twelve point five zero euros forty percent of one thousand two hundred people"));
        assert_eq!(normalize("Kick-off, 'kay? Alright… multi-purpose"), words("kick off okay all right multi purpose"));
        assert_eq!(normalize("Hmm… uh-huh, (hmm)"), Vec::<String>::new());
    }
    #[test]
    fn errors_count_substituted_missing_and_added_words() {
        let (errors, misses) = align(&words("please send the notes on friday"), &words("send a notes on friday now"));
        assert_eq!(errors, Errors { words: 6, substituted: 1, missing: 1, added: 1 });
        assert_eq!(misses, [Miss::Missing("please".into()), Miss::Substituted("the".into(), "a".into()), Miss::Added("now".into())]);
        assert_eq!(errors.rate(), 0.5);
        assert_eq!(align(&[], &words("hello")).0.added, 1);
    }
    #[test]
    fn each_voice_is_matched_to_the_person_it_overlaps_most() {
        let said = |speaker: &str, start, end| Said { speaker: speaker.into(), start_ms: start, end_ms: end, text: "words".into() };
        let piece = |start, end, speaker: &str| Piece { start_ms: start, end_ms: end, text: "Words.".into(), speaker: Some(speaker.into()), ..Default::default() };
        // B is Speaker 2 throughout; C is Speaker 1, except one second labelled Speaker 2 and one second in no sentence.
        let reference = [said("You", 0, 1_000), said("B", 1_000, 5_000), said("C", 5_000, 10_000)];
        let pieces = [piece(1_000, 5_000, "Speaker 2"), piece(5_000, 8_000, "Speaker 1"), piece(8_000, 9_000, "Speaker 2")];
        let v = who_said_what(&reference, &pieces);
        assert_eq!((v.people, v.voices, v.right, v.wrong, v.unheard), (2, 2, 7_000, 1_000, 1_000));
        // One voice for one other person: "Others" is right.
        let v = who_said_what(&[said("B", 0, 2_000)], &[Piece { start_ms: 0, end_ms: 2_000, ..Default::default() }]);
        assert_eq!((v.right, v.wrong), (2_000, 0));
    }

    #[test]
    fn only_sentences_within_the_reference_count() {
        let said = [Said { speaker: "You".into(), start_ms: 60_000, end_ms: 62_000, text: "Ship it on Friday.".into() }];
        let turn = |start_ms, text: &str| Turn { start_ms, end_ms: start_ms + 2_000, speaker: "You".into(), text: text.into(), removed: Vec::new(), breaks: Vec::new() };
        // The chat before the transcript starts isn't an error; what's within it is.
        let score = score(&said, &[turn(0, "Can you hear me?"), turn(60_000, "Um, ship it Friday.")], &[]);
        assert_eq!(score.you[0], Errors { words: 4, substituted: 0, missing: 1, added: 0 });
        assert_eq!(score.others[0], Errors::default());
    }
    /// Runs the whole job (transcription of both tracks, telling the others apart, merging) on meetings
    /// with a known transcript and prints the scores:
    /// `QUIETNOTE_TEST_ACCURACY=test-audio/ami cargo test --release accuracy -- --ignored --nocapture`
    /// (a meeting folder, or a folder of them; `node scripts/fetch-ami.mjs` makes them). Each meeting's
    /// transcript is written next to it as `quietnote.md` to compare by eye.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore]
    fn measures_accuracy() {
        use crate::transcribe::{recognize, samples, MODEL, VAD};
        use std::path::{Path, PathBuf};
        // A relative path is from the repository, where `fetch-ami.mjs` puts the meetings.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(std::env::var("QUIETNOTE_TEST_ACCURACY").expect("QUIETNOTE_TEST_ACCURACY"));
        let models = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
        let mut meetings: Vec<PathBuf> = if root.join("reference.json").exists() { vec![root.clone()] } else {
            std::fs::read_dir(&root).expect("a folder").flatten().map(|e| e.path()).filter(|p| p.join("reference.json").exists()).collect()
        };
        meetings.sort();
        assert!(!meetings.is_empty(), "no meeting folders (with reference.json) in {}", root.display());
        let (mut total, mut seconds, mut working) = (Score::default(), 0.0, std::time::Duration::ZERO);
        let mut sweep: Vec<(PathBuf, f32, Voices)> = Vec::new();
        for dir in &meetings {
            let said: Vec<Said> = serde_json::from_slice(&std::fs::read(dir.join("reference.json")).unwrap()).expect("reference.json");
            let length = samples(&dir.join("mic.wav")).unwrap().len() as f64 / 16_000.0;
            let started = std::time::Instant::now();
            let [mic, mut system] = recognize(&models.join(MODEL), &models.join(VAD), &|name| crate::transcribe::track(dir, name), 0, std::sync::Arc::new(|_| {})).unwrap();
            let transcribed = started.elapsed();
            #[cfg(target_os = "macos")]
            {
                use crate::speakers::{label, tuned, EMBEDDING, SEGMENTATION, SHIFT, THRESHOLD};
                let call = samples(&dir.join("system.wav")).unwrap();
                let split = |threshold| tuned(&models.join(SEGMENTATION), &models.join(EMBEDDING), &call, threshold, SHIFT).unwrap();
                // QUIETNOTE_THRESHOLDS=0.6,0.8,1.0 also scores telling voices apart at those thresholds.
                for threshold in std::env::var("QUIETNOTE_THRESHOLDS").unwrap_or_default().split(',').filter_map(|t| t.trim().parse::<f32>().ok()) {
                    let mut pieces = system.clone();
                    label(&mut pieces, &split(threshold), 1);
                    sweep.push((dir.clone(), threshold, voices(&said, &pieces)));
                }
                label(&mut system, &split(THRESHOLD), 1);
            }
            let took = started.elapsed();
            let (turns, echo) = crate::transcript::merge(mic, system.clone());
            let score = score(&said, &turns, &system);
            let name = dir.file_name().unwrap().to_string_lossy();
            println!("\n{name} · {:.1} min · transcribed in {:.0} s ({:.0}× real time), voices told apart in {:.0} s · {} mic sentences dropped as echo\n{}",
                length / 60.0, transcribed.as_secs_f64(), length / transcribed.as_secs_f64(), (took - transcribed).as_secs_f64(), echo.len(), report(&score));
            let transcript = crate::transcript::Transcript { version: 1, model: MODEL.into(), turns, echo };
            std::fs::write(dir.join("quietnote.md"), crate::transcript::markdown(&transcript, false)).unwrap();
            total.add(&score);
            seconds += length;
            working += took;
        }
        if meetings.len() > 1 { println!("\nAll {} meetings · {:.1} min in {:.0} s\n{}", meetings.len(), seconds / 60.0, working.as_secs_f64(), report(&total)); }
        let mut thresholds: Vec<f32> = sweep.iter().map(|s| s.1).collect();
        thresholds.sort_by(f32::total_cmp);
        thresholds.dedup();
        for threshold in thresholds {
            let mut all = Voices::default();
            for (dir, _, v) in sweep.iter().filter(|s| s.1 == threshold) { println!("threshold {threshold}: {} · {}", dir.file_name().unwrap().to_string_lossy(), v.line()); all.add(*v); }
            if meetings.len() > 1 { println!("threshold {threshold}: all · {}", all.line()); }
        }
    }
}
