//! Delete-only transcript cleanup: removes filler sounds ("um", "uh") and stutters ("I I think")
//! without rewriting words. The raw text is kept; cleanup is a list of removed byte ranges, so the
//! transcript can always be shown verbatim. Anything that could carry meaning is left alone: words
//! whose sense depends on context ("like", "you know", "I mean", "actually"), self-corrections
//! ("2… actually 3"), numbers, names and quoted speech.

const FILLERS: &[&str] = &["um", "umm", "ummm", "uh", "uhh", "uhhh", "uhm", "erm", "er", "hm", "hmm", "hmmm", "mm", "mmm"];
/// Sounds that are fillers only as a pause mid-sentence (", ah,"); at the start they're a reaction ("Ah, I see").
const PAUSES: &[&str] = &["ah", "eh"];
/// Opening words whose comma is grammar even when a filler follows ("So, um, the plan").
const MARKERS: &[&str] = &["so", "well", "yeah", "yes", "no", "okay", "ok", "right", "now", "look", "alright", "sure", "hi", "hey", "hello", "thanks", "honestly", "anyway", "oh"];
/// Repeats that are usually grammatical or deliberate rather than a stutter.
const KEEP_DOUBLED: &[&str] = &["had", "that", "bye", "very", "so", "no", "yeah", "okay", "ok"];
/// Spoken numbers repeat for a reason ("twenty twenty", "two two five").
const NUMBERS: &[&str] = &["zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million", "billion"];

struct Token { start: usize, end: usize, core_start: usize, core_end: usize, word: String, capitalized: bool, quoted: bool }
impl Token {
    /// Ends a sentence: "went." or "right?", but not a trailing ellipsis ("uh...").
    fn terminal(&self, text: &str) -> bool {
        let p = &text[self.core_end..self.end];
        p.contains(['?', '!']) || (p.contains('.') && !p.contains("..") && !p.contains('…'))
    }
    fn numeric(&self) -> bool { !self.word.is_empty() && (self.word.chars().all(|c| c.is_ascii_digit()) || NUMBERS.contains(&self.word.as_str())) }
}
fn tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut start = None;
    let mut in_quote = false;
    for (i, c) in text.char_indices().chain([(text.len(), ' ')]) {
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(s)) => {
                let raw = &text[s..i];
                let core_start = s + raw.find(|c: char| c.is_alphanumeric()).unwrap_or(raw.len());
                let core_end = s + raw.rfind(|c: char| c.is_alphanumeric()).map_or(0, |p| p + raw[p..].chars().next().map_or(1, char::len_utf8));
                let core_end = core_end.max(core_start);
                let word = text[core_start..core_end].chars().filter(|c| c.is_alphanumeric() || *c == '\'' || *c == '’')
                    .map(|c| if c == '’' { '\'' } else { c }).flat_map(char::to_lowercase).collect();
                let capitalized = text[core_start..core_end].chars().next().is_some_and(char::is_uppercase);
                // Quoted speech is someone's exact words: a token that opens, closes or sits inside quotes.
                let quoted = in_quote || raw.contains(['"', '“', '”']);
                for q in raw.chars() {
                    match q { '"' => in_quote = !in_quote, '“' => in_quote = true, '”' => in_quote = false, _ => {} }
                }
                out.push(Token { start: s, end: i, core_start, core_end, word, capitalized, quoted });
                start = None;
            }
            _ => {}
        }
    }
    out
}

/// Byte ranges of `text` to remove, sorted and non-overlapping.
#[cfg(test)]
pub fn clean(text: &str) -> Vec<[usize; 2]> { clean_with_breaks(text).0 }
/// The ranges to remove, and the offsets where a removed filler marked the start of a new sentence
/// that Whisper left unpunctuated ("…to confirm Hmm, that works" → "…to confirm. That works"):
/// Whisper capitalizes a filler mid-line only when a new utterance begins, so deleting it without a
/// full stop would run two sentences into one.
pub fn clean_with_breaks(text: &str) -> (Vec<[usize; 2]>, Vec<usize>) {
    let tokens = tokens(text);
    let mut removed: Vec<[usize; 2]> = Vec::new();
    let mut breaks: Vec<usize> = Vec::new();
    let mut kept: Vec<usize> = Vec::new();
    let next_start = |i: usize| tokens.get(i + 1).map_or(text.len(), |t| t.start);
    let filler = |t: &Token| FILLERS.contains(&t.word.as_str()) && !t.quoted && !text[t.start..t.core_start].chars().any(|c| c.is_alphanumeric());
    for (i, t) in tokens.iter().enumerate() {
        // A capitalized "Um" mid-sentence with no pause after it may be a name ("the Um River").
        let opening = i == 0 || tokens[i - 1].terminal(text);
        let name = t.capitalized && !opening && t.core_end == t.end;
        let pause = PAUSES.contains(&t.word.as_str()) && !t.quoted && !opening && !t.capitalized
            && &text[t.core_end..t.end] == "," && text[tokens[i - 1].core_end..tokens[i - 1].end].ends_with(',');
        if !(filler(t) || pause) || name { kept.push(i); continue; }
        if t.capitalized && !opening { breaks.push(t.start); }
        // "went, um." keeps its full stop: only the filler and the space before it go.
        if t.terminal(text) {
            let from = if i == 0 { t.start } else { tokens[i - 1].end };
            removed.push([from, t.core_end]);
        } else {
            removed.push([t.start, next_start(i)]);
            // Mid-sentence, the comma before a filler marks the pause, not grammar: "could, uh, move" →
            // "could move". It stays after an opening marker ("So, um, the plan") and before a number or
            // a name, where it may be all that separates a correction: "at 2, uh, 3" → "at 2, 3".
            if let Some(&k) = kept.last().filter(|&&k| k + 1 == i) {
                let opening = kept.len() < 2 || tokens[kept[kept.len() - 2]].terminal(text);
                let marker = opening && MARKERS.contains(&tokens[k].word.as_str());
                let next = tokens[i + 1..].iter().find(|t| !filler(t));
                let distinct = next.is_some_and(|t| t.numeric() || t.capitalized);
                if !marker && !distinct && &text[tokens[k].core_end..tokens[k].end] == "," { removed.push([tokens[k].core_end, tokens[k].end]); }
            }
        }
    }
    // Stutters are found among the words left after fillers, so "I, um, I think" collapses too.
    let mut i = 0;
    while i < kept.len() {
        let mut dropped = false;
        for n in [3, 2, 1] {
            if i + 2 * n > kept.len() { continue; }
            let a: Vec<&Token> = kept[i..i + n].iter().map(|&k| &tokens[k]).collect();
            let b: Vec<&Token> = kept[i + n..i + 2 * n].iter().map(|&k| &tokens[k]).collect();
            let same = a.iter().zip(&b).all(|(x, y)| !x.word.is_empty() && x.word == y.word);
            let protected = a.iter().chain(&b).any(|t| t.quoted || t.numeric())
                // Names repeat on purpose: "Bora Bora", "Walla Walla".
                || (n == 1 && a[0].capitalized && b[0].capitalized && a[0].word != "i" && !a[0].word.starts_with("i'"))
                || (n == 1 && KEEP_DOUBLED.contains(&a[0].word.as_str()) && kept.get(i + 2).is_none_or(|&k| tokens[k].word != a[0].word));
            if !same || protected || a.iter().any(|t| t.terminal(text)) { continue; }
            for &k in &kept[i..i + n] { removed.push([tokens[k].start, next_start(k)]); }
            kept.drain(i..i + n);
            dropped = true;
            break;
        }
        if !dropped { i += 1; }
    }
    (merged(removed), breaks)
}
/// `removed` sorted, with overlapping ranges joined.
pub fn merged(mut removed: Vec<[usize; 2]>) -> Vec<[usize; 2]> {
    removed.sort_unstable();
    let mut out: Vec<[usize; 2]> = Vec::with_capacity(removed.len());
    for r in removed {
        match out.last_mut() {
            Some(last) if r[0] <= last[1] => last[1] = last[1].max(r[1]),
            _ => out.push(r),
        }
    }
    out
}

/// Lines Whisper makes up over silence, music or noise: it learned from the subtitles of online videos,
/// which end like this. Nobody says them in a meeting. "Thank you." isn't here: people say it.
pub const MADE_UP: &[&str] = &[
    "Thank you for watching", "Thanks for watching", "Thank you so much for watching", "Thank you very much for watching",
    "Please subscribe to my channel", "Please like and subscribe", "Don't forget to like and subscribe", "Like and subscribe",
    "Subtitles by the Amara.org community", "Transcription by CastingWords",
    "Untertitel der Amara.org-Community", "Sous-titres réalisés par la communauté d'Amara.org",
    "Subtítulos realizados por la comunidad de Amara.org", "Ondertiteld door de Amara.org gemeenschap", "Sottotitoli creati dalla comunità Amara.org",
    "(C) TV GELDERLAND 2020", "(C) TV GELDERLAND 2021",
];
/// Notes, the way subtitles write music: "♪".
fn notes(raw: &str) -> bool { !raw.is_empty() && raw.chars().all(|c| matches!(c, '♪' | '♫' | '♬')) }
/// Sounds the way subtitles write them, as `(first token, last token)`: notes, a few words in square
/// brackets ("[Music]") anywhere, and a few words in round brackets or asterisks ("( silence )",
/// "*crickets*") only on their own between sentences, since people say things in brackets too: "We ship
/// (hopefully) on Friday", "5 * 3 * 2".
fn sounds(text: &str, tokens: &[Token]) -> Vec<(usize, usize)> {
    let raw = |t: &Token| text[t.start..t.end].trim_end_matches(['.', ',']);
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let first = raw(&tokens[i]);
        if notes(first) { out.push((i, i)); i += 1; continue; }
        let close = match first.chars().next() { Some('[') => ']', Some('(') => ')', Some('*') => '*', _ => { i += 1; continue } };
        let Some(j) = (i..tokens.len().min(i + 5)).find(|&j| { let r = raw(&tokens[j]); r.ends_with(close) && (j > i || r.len() > 2) }) else { i += 1; continue };
        let before = i == 0 || tokens[i - 1].terminal(text) || out.last().is_some_and(|&(_, e)| e + 1 == i);
        let after = tokens.get(j + 1).is_none_or(|t| { let r = raw(t); t.capitalized || notes(r) || r.starts_with(['[', '(', '*']) });
        if close == ']' || before && after { out.push((i, j)); i = j + 1; } else { i += 1; }
    }
    out
}
/// The words of `text` as transcripts are compared everywhere (echo, citations, hidden lines):
/// lowercase, without punctuation.
pub fn words(text: &str) -> Vec<String> {
    text.split_whitespace().map(|w| w.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>()).filter(|w| !w.is_empty()).collect()
}
/// What the clean view keeps of `text`'s tokens: not sounds, and not taken out by cleanup (`removed`).
fn kept(tokens: &[Token], sounds: &[(usize, usize)], removed: &[[usize; 2]]) -> Vec<(usize, bool)> {
    (0..tokens.len()).filter(|&k| !sounds.iter().any(|&(i, j)| (i..=j).contains(&k)))
        .map(|k| (k, !removed.iter().any(|r| r[0] <= tokens[k].core_start && tokens[k].core_end <= r[1]))).collect()
}
/// Lines to hide, read once the way `ignored` reads a sentence: the words the clean view would show.
pub fn phrases<S: AsRef<str>>(lines: impl IntoIterator<Item = S>) -> Vec<Vec<String>> {
    lines.into_iter().map(|line| {
        let line = line.as_ref();
        let tokens = tokens(line);
        kept(&tokens, &sounds(line, &tokens), &clean_with_breaks(line).0).into_iter().filter(|&(_, said)| said)
            .flat_map(|(k, _)| words(&line[tokens[k].start..tokens[k].end])).collect::<Vec<_>>()
    }).filter(|p| !p.is_empty()).collect()
}
/// Byte ranges of what nobody said in `text`, each with the space after it: sounds in brackets
/// (`sounds`), and sentences that are exactly one of `phrases` (from `phrases`) as the clean view shows
/// them, without the fillers and stutters in `removed`. Only whole sentences ("Thanks for watching the
/// demo" stays), never quoted speech. A sentence ends at a full stop, a question or exclamation mark, a
/// trailing "..." before a capital, one of `breaks` (a pause Whisper left unpunctuated) or a sound.
/// Nothing is hidden without `phrases`.
pub fn ignored(text: &str, removed: &[[usize; 2]], breaks: &[usize], phrases: &[Vec<String>]) -> Vec<[usize; 2]> {
    if phrases.is_empty() { return vec![]; }
    let tokens = tokens(text);
    let next = |i: usize| tokens.get(i + 1).map_or(text.len(), |n| n.start);
    let sounds = sounds(text, &tokens);
    let mut out: Vec<[usize; 2]> = sounds.iter().map(|&(i, j)| [tokens[i].start, next(j)]).collect();
    let kept = kept(&tokens, &sounds, removed);
    let ends = |n: usize| {
        let (k, t) = (kept[n].0, &tokens[kept[n].0]);
        let trailing = &text[t.core_end..t.end];
        t.terminal(text) || (trailing.contains("..") || trailing.contains('…')) && tokens.get(k + 1).is_none_or(|n| n.capitalized)
            || breaks.iter().any(|&b| t.end <= b && b <= next(k)) || kept.get(n + 1).is_none_or(|&(h, _)| h != k + 1)
    };
    let mut first = 0;
    for n in 0..kept.len() {
        if !ends(n) { continue; }
        let sentence = &kept[first..=n];
        let words: Vec<String> = sentence.iter().filter(|&&(_, said)| said).flat_map(|&(k, _)| words(&text[tokens[k].start..tokens[k].end])).collect();
        if !sentence.iter().any(|&(k, _)| tokens[k].quoted) && phrases.contains(&words) { out.extend(sentence.iter().map(|&(k, _)| [tokens[k].start, next(k)])); }
        first = n + 1;
    }
    merged(out)
}

/// The clean text: `removed` ranges taken out, spacing and punctuation tidied, a sentence that now
/// starts lowercase ("um, so we…") capitalized, and a full stop at each of `breaks` (byte offsets
/// where a clear pause ended an unpunctuated sentence) unless punctuation is already there.
pub fn render(text: &str, removed: &[[usize; 2]], breaks: &[usize]) -> String {
    if removed.is_empty() && breaks.is_empty() { return text.trim().to_string(); }
    let mut out = String::with_capacity(text.len() + breaks.len());
    // A cut pending capitalization, and whether what it removed began with a capital: at the very
    // start only a removed capital ("Um, so we…") makes the next word a sentence start.
    let (mut at, mut next_break, mut cut) = (0, 0, None::<bool>);
    for &[from, to] in removed.iter().chain([&[text.len(), text.len()]]) {
        let (from, to) = (from.clamp(at, text.len()), to.clamp(at, text.len()));
        if !text.is_char_boundary(from) || !text.is_char_boundary(to) { continue; }
        let mut start = at;
        while let Some(&b) = breaks.get(next_break).filter(|&&b| b <= from) {
            let b = b.max(start);
            if text.is_char_boundary(b) { cut = push(&mut out, &text[start..b], cut); start = b; }
            if end_sentence(&mut out) { cut = Some(true); }
            next_break += 1;
        }
        cut = push(&mut out, &text[start..from], cut);
        while breaks.get(next_break).is_some_and(|&b| b < to) { if end_sentence(&mut out) { cut = Some(true); } next_break += 1; }
        if to > from { cut = Some(cut.unwrap_or(false) || text[from..to].chars().find(|c| c.is_alphabetic()).is_some_and(char::is_uppercase)); }
        at = to;
    }
    tidy(&out)
}
/// Appends `piece`, capitalizing its first letter when it follows a cut at a sentence start.
/// Returns the cut still pending when the piece had no letters.
fn push(out: &mut String, piece: &str, cut: Option<bool>) -> Option<bool> {
    let Some(capital) = cut else { out.push_str(piece); return None; };
    match piece.char_indices().find(|(_, c)| c.is_alphabetic()) {
        Some((i, c)) => {
            out.push_str(&piece[..i]);
            let start = sentence_start(out) && (capital || out.chars().any(char::is_alphanumeric));
            if c.is_lowercase() && start { out.extend(c.to_uppercase()); } else { out.push(c); }
            out.push_str(&piece[i + c.len_utf8()..]);
            None
        }
        None => { out.push_str(piece); cut }
    }
}
fn end_sentence(out: &mut String) -> bool {
    let trimmed = out.trim_end();
    let last = trimmed.chars().last();
    if !trimmed.chars().any(char::is_alphanumeric) || last.is_some_and(|c| ".?!…,;:".contains(c)) { return false; }
    out.truncate(trimmed.len());
    out.push_str(". ");
    true
}
fn sentence_start(before: &str) -> bool {
    let before = before.trim_end_matches([' ', ',']);
    before.is_empty() || (before.ends_with(['.', '?', '!']) && !before.ends_with("..") && !before.ends_with('…'))
}
fn tidy(text: &str) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [(" ,", ","), (" .", "."), (" ?", "?"), (" !", "!"), (" ;", ";"), (" :", ":"), (",,", ","), (",.", "."), (",?", "?"), (",!", "!")] {
        while out.contains(from) { out = out.replace(from, to); }
    }
    if !out.chars().any(char::is_alphanumeric) { return String::new(); }
    out.trim_start_matches([',', ';', ':', '.', '?', '!', ' ']).trim_end_matches([',', ' ']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cleaned(text: &str) -> String { let (removed, breaks) = clean_with_breaks(text); render(text, &removed, &breaks) }
    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase().replace('’', "'")).filter(|w| !w.is_empty()).collect()
    }
    /// Cleanup may only delete: the cleaned words must appear, in order, in the original.
    fn only_deletes(original: &str, cleaned: &str) -> bool {
        let mut source = words(original).into_iter();
        words(cleaned).iter().all(|w| source.any(|o| &o == w))
    }
    #[test]
    fn removes_fillers_stutters_and_fixes_the_sentence() {
        let cases = [
            ("Um, so we should ship on Friday.", "So we should ship on Friday."),
            ("We could, uh, move it to Monday.", "We could move it to Monday."),
            ("Erm, the numbers are fine.", "The numbers are fine."),
            ("Hmm, let me check.", "Let me check."),
            ("I think we went, um.", "I think we went."),
            ("It was, uhh... fine. um, next item", "It was fine. Next item"),
            ("Hmm.", ""),
            ("Um. So we start.", "So we start."),
            ("So, um, the plan. Hmm, let's, uh, move it.", "So, the plan. Let's move it."),
            ("Um, so, uh, I think we should, um, we should ship.", "So, I think we should ship."),
            ("Umbrella policy, erm, is fine", "Umbrella policy is fine"),
            ("I I I think that's right.", "I think that's right."),
            ("We should we should ship it.", "We should ship it."),
            ("Can we can we move on?", "Can we move on?"),
            ("I, um, I think so.", "I think so."),
            ("the the dashboard is ready", "the dashboard is ready"),
            ("I'm I'm not sure.", "I'm not sure."),
            ("Don't don't worry.", "Don't worry."),
            ("I was... um, thinking", "I was... thinking"),
            // A correction keeps the comma that separates it.
            ("We'll meet at 2, uh, 3.", "We'll meet at 2, 3."),
            ("Send it to Tom, um, Maya.", "Send it to Tom, Maya."),
            // A capitalized filler mid-line starts a new utterance; removing it mustn't merge the two.
            ("Let's meet at 2, actually 3 on Thursday to confirm Hmm, that works, can you check?", "Let's meet at 2, actually 3 on Thursday to confirm. That works, can you check?"),
            ("I will Um, share the credentials", "I will. Share the credentials"),
            ("Can you, ah, also check the numbers?", "Can you also check the numbers?"),
        ];
        for (text, expected) in cases {
            assert_eq!(cleaned(text), expected, "{text}");
            assert!(only_deletes(text, &cleaned(text)), "{text}");
        }
    }
    #[test]
    fn leaves_anything_that_carries_meaning() {
        for text in [
            "He had had enough.",
            "No no, that's fine.",
            "It was 20 20 minutes.",
            "It's twenty twenty vision.",
            "It went well. Well, mostly.",
            "Let's meet at 2... actually 3.",
            "Monday, no, Tuesday works.",
            "We moved from 2 to 3, actually 4.",
            "We flew to Bora Bora last year.",
            "Walla Walla is the site.",
            "She said \"no no no\" to that.",
            "He wrote “um, maybe” in the doc.",
            "it's its own thing",
            "I like it, you know, actually.",
            "I mean it.",
            "So... what next?",
            "Right, let's go.",
            "The UH-60 and the Um River.",
            "Ah, I see. Eh, fine.",
            "It was ah, fine.",
            // Context-dependent words and acknowledgements carry meaning; "like" as a hedge stays.
            "It was, like, really fast.",
            "Uh-huh, that works.",
            "Mm-hmm, agreed.",
            "You know what, let's ship it.",
            "I mean, the 3 of us.",
        ] {
            assert_eq!(cleaned(text), text);
        }
    }
    #[test]
    fn ranges_only_delete() {
        let text = "Um, I I think, uh, we we should, um.";
        let removed = clean(text);
        assert!(removed.windows(2).all(|w| w[0][1] <= w[1][0]));
        let kept: String = { let mut at = 0; let mut s = String::new(); for r in &removed { s.push_str(&text[at..r[0]]); at = r[1]; } s.push_str(&text[at..]); s };
        assert!(only_deletes(text, &kept));
    }
    #[test]
    fn breaks_end_unpunctuated_sentences_only() {
        assert_eq!(render("Sounds good I will share it", &[], &[11]), "Sounds good. I will share it");
        assert_eq!(render("Sounds good, I will share it", &[], &[12]), "Sounds good, I will share it");
        assert_eq!(render("Sounds good. i will", &[], &[12]), "Sounds good. i will");
        let text = "Sounds good Uh, I will";
        let (removed, breaks) = clean_with_breaks(text);
        assert_eq!(breaks, vec![12]);
        assert_eq!(render(text, &removed, &[11]), "Sounds good. I will");
        assert_eq!(render(text, &removed, &breaks), "Sounds good. I will");
        assert_eq!(render("okay then", &[], &[4]), "okay. Then");
    }
    #[test]
    fn hides_whole_sentences_nobody_said_only() {
        let phrases = phrases(MADE_UP.iter().copied().chain(["Bye bye"]));
        let hidden = |text: &str| { let (mut removed, breaks) = clean_with_breaks(text); removed.extend(ignored(text, &removed, &breaks, &phrases)); render(text, &merged(removed), &breaks) };
        assert_eq!(hidden("Let's ship it. Thank you for watching!"), "Let's ship it.");
        assert_eq!(hidden("THANKS FOR WATCHING. Okay, um, where were we?"), "Okay, where were we?");
        assert_eq!(hidden("Subtitles by the Amara.org community"), "");
        assert_eq!(hidden("bye-bye."), "bye-bye.");
        assert_eq!(hidden("Bye, bye."), "");
        // Part of a sentence is someone talking.
        assert_eq!(hidden("Thanks for watching the demo, everyone."), "Thanks for watching the demo, everyone.");
        assert_eq!(hidden("Thank you. See you Friday."), "Thank you. See you Friday.");
        assert_eq!(hidden("[Music] Okay, let's start. (Applause.) ♪ ♪"), "Okay, let's start.");
        assert_eq!(hidden("[ Silence ]"), "");
        for sound in ["[BLANK_AUDIO]", "[ BLANK_AUDIO ]", "[MUSIC PLAYING]", "( retirement bell rang )", "(Applause.)", "*crickets *", "♪", "(upbeat music playing)", "[VIDEO PLAYBACK]"] {
            assert_eq!(hidden(&format!("Right. {sound} So.")), "Right. So.", "{sound}");
        }
        assert_eq!(hidden("We agreed [Music] Thanks for watching."), "We agreed");
        assert_eq!(hidden("Music. That was the plan."), "Music. That was the plan.");
        assert_eq!(hidden("(C) TV GELDERLAND 2020"), "");
        // An opening bracket that never closes, or one stretching past a few words, is words.
        assert_eq!(hidden("(and this is important, we ship on Friday."), "(and this is important, we ship on Friday.");
        assert!(ignored("Thank you for watching. [Music]", &[], &[], &[]).is_empty());
        // Words in brackets mid-sentence are said: only a bracketed sound on its own between sentences goes.
        for said in ["We ship (hopefully) on Friday.", "Option (a) is cheaper.", "Budget is (about two million) total.", "It's 5 * 3 * 2 in all."] {
            assert_eq!(hidden(said), said);
        }
        // Read as the clean view shows it: without its fillers and stutters.
        assert_eq!(hidden("Okay. Um, thank you for watching."), "Okay.");
        assert_eq!(hidden("Okay. Thanks for for watching."), "Okay.");
        assert_eq!(hidden("Thanks for watching... Okay, let's begin."), "Okay, let's begin.");
        assert_eq!(hidden("Thanks for watching... the demo, I mean."), "Thanks for watching... the demo, I mean.");
        // Quoted, someone is reading it out.
        assert_eq!(hidden("She said \"Please like and subscribe.\""), "She said \"Please like and subscribe.\"");
        assert_eq!(hidden("\"Please like and subscribe.\""), "\"Please like and subscribe.\"");
        // A phrase is read the same way, so "Um, bye bye" and "[Music] Bye bye" are "Bye bye".
        assert_eq!(super::phrases(["Um, bye bye.", "[Music] Bye bye", "  ", "[Music]"]), vec![vec!["bye", "bye"], vec!["bye", "bye"]]);
    }
}
