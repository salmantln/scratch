//! Summary suggestions: a summary and action items drafted from a recorded transcript by the model
//! the user chose, Claude with their own Anthropic key or a model in Ollama on this computer. Only the
//! transcript's text is sent, only when the user asks, and nothing is written: the user accepts each item.
//! Every action item must cite the transcript line it came from with an exact quote, or it's dropped.
//!
//! Enhanced notes (`notes_enhance`) send the user's notes too, with a template (`templates`): the notes are
//! rewritten under its sections and filled in from the transcript. Each line must quote either the
//! user's notes or a transcript line, or it's dropped.
use crate::connectors::keychain;
use crate::meetings;
use crate::templates::Template;
use crate::transcript::{clock, Transcript, Turn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const ANTHROPIC: &str = "https://api.anthropic.com";
const MODEL: &str = "claude-opus-5-5";
const OLLAMA: &str = "http://127.0.0.1:11434";
/// The largest context Ollama is asked for; a longer meeting is refused rather than silently cut.
const OLLAMA_CONTEXT: usize = 32_768;
const KEY: &str = "anthropic";

const INSTRUCTIONS: &str = "You draft the record of a meeting from its transcript. Each transcript line is `[mm:ss] Speaker: text`. \
The speakers are \"You\" (the person who recorded the meeting), and \"Others\" or \"Speaker 1\", \"Speaker 2\"… for everyone else on the call \
(voices told apart by sound, not by name). People's names appear only where someone says them.

Return:
- summary: two to four short sentences on what the meeting covered and where it ended up. Plain prose, no lists or headings.
- actions: only tasks someone clearly committed to, or was asked to do and accepted.

For every action, `at` is the timestamp of the line where it was said, copied exactly (for example \"12:04\"), \
and `quote` is a short phrase of three to twelve words copied word for word from that line.
An action's owner is a person's name only if the transcript says who will do it, \"You\" if the person who recorded committed to it, \
and otherwise an empty string. Never guess a name.

A wrong action item is worse than a missing one: when unsure, leave it out. An empty list is fine. \
Write in the language of the meeting.";

fn schema() -> Value {
    let item = json!({
        "type": "object", "additionalProperties": false, "required": ["text", "owner", "at", "quote"],
        "properties": { "text": { "type": "string" }, "owner": { "type": "string" }, "at": { "type": "string" }, "quote": { "type": "string" } }
    });
    json!({
        "type": "object", "additionalProperties": false, "required": ["summary", "actions"],
        "properties": { "summary": { "type": "string" }, "actions": { "type": "array", "items": item } }
    })
}

#[derive(Deserialize)]
struct Draft { summary: String, actions: Vec<Claim> }
#[derive(Deserialize)]
struct Claim { text: String, #[serde(default)] owner: String, at: String, quote: String }
/// A suggested action item and the transcript line it cites.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cited { text: String, owner: String, at_ms: u64, quote: String }
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestions { summary: String, actions: Vec<Cited>, dropped: usize }

/// The lines the model reads: the clean text of each turn, under the timestamp the Transcript tab shows.
fn lines(turns: &[Turn]) -> String {
    turns.iter().filter_map(|t| { let text = t.clean(); (!text.trim().is_empty()).then(|| format!("[{}] {}: {}", clock(t.start_ms), t.speaker, text.trim())) }).collect::<Vec<_>>().join("\n")
}
fn words(text: &str) -> Vec<String> {
    text.split_whitespace().map(|w| w.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>()).filter(|w| !w.is_empty()).collect()
}
fn contains(haystack: &[String], needle: &[String]) -> bool { !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle) }
/// The turn a claim cites, if its timestamp is a turn's and its quote is in that turn's words.
fn cited<'a>(turns: &'a [Turn], claim: &Claim) -> Option<&'a Turn> {
    let at = claim.at.trim().trim_start_matches('[').trim_end_matches(']');
    let quote = words(&claim.quote);
    turns.iter().find(|t| clock(t.start_ms) == at && (contains(&words(&t.clean()), &quote) || contains(&words(&t.text), &quote)))
}
/// An owner is kept only if it's the recording person, a voice the transcript tells apart ("Speaker 2"),
/// or a name someone said.
fn owner(turns: &[Turn], owner: &str) -> String {
    let owner = owner.trim();
    let named = !words(owner).is_empty() && turns.iter().any(|t| contains(&words(&t.text), &words(owner)));
    let speaker = turns.iter().any(|t| t.speaker == owner);
    if owner != "Others" && (owner == "You" || speaker || named) { owner.into() } else { String::new() }
}
/// Keeps only the claims that trace back to the transcript, once each.
fn ground(turns: &[Turn], draft: Draft) -> Suggestions {
    let mut dropped = 0;
    let mut actions: Vec<Cited> = Vec::new();
    for claim in draft.actions {
        let text = claim.text.trim().to_string();
        match cited(turns, &claim) {
            Some(turn) if !text.is_empty() && !actions.iter().any(|k| k.text.eq_ignore_ascii_case(&text)) =>
                actions.push(Cited { owner: owner(turns, &claim.owner), text, at_ms: turn.start_ms, quote: claim.quote.trim().into() }),
            _ => dropped += 1,
        }
    }
    Suggestions { summary: draft.summary.trim().into(), actions, dropped }
}

fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("QuietNote").timeout(Duration::from_secs(seconds)).build().map_err(|e| e.to_string())
}
fn anthropic_error(status: u16, body: &Value) -> String {
    if status == 401 { return "Anthropic rejected this key. Check it, or create a new one.".into(); }
    format!("Anthropic: {}", body["error"]["message"].as_str().unwrap_or("the request failed"))
}
/// The model's JSON from a Messages API response, or why there is none.
fn anthropic_text(body: &Value) -> Result<String, String> {
    match body["stop_reason"].as_str() {
        Some("refusal") => return Err("Claude declined to summarize this meeting.".into()),
        Some("max_tokens") => return Err("The summary was cut off before it finished. Try again.".into()),
        _ => {}
    }
    body["content"].as_array().into_iter().flatten().find(|b| b["type"] == "text").and_then(|b| b["text"].as_str()).map(String::from)
        .ok_or_else(|| "Claude didn’t return a summary.".into())
}
async fn anthropic(key: &str, system: &str, content: &str, schema: Value) -> Result<String, String> {
    let request = json!({
        "model": MODEL, "max_tokens": 16000, "system": system,
        "messages": [{ "role": "user", "content": content }],
        "output_config": { "format": { "type": "json_schema", "schema": schema } },
        "fallbacks": "default",
    });
    let response = client(300)?.post(format!("{ANTHROPIC}/v1/messages")).header("x-api-key", key).header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01").json(&request).send().await.map_err(|e| format!("Couldn’t reach Anthropic. {e}"))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status >= 400 { return Err(anthropic_error(status, &body)); }
    anthropic_text(&body)
}
/// Ollama's context in tokens for a transcript, with room for the instructions and the answer.
fn ollama_context(transcript: &str) -> Result<usize, String> {
    let needed = transcript.len() / 3 + 4096;
    if needed > OLLAMA_CONTEXT { return Err("This meeting is too long for a model in Ollama. Use Claude for it, or summarize it yourself.".into()); }
    Ok(needed.max(8192))
}
async fn ollama(model: &str, system: &str, content: &str, schema: Value) -> Result<String, String> {
    let request = json!({
        "model": model, "stream": false, "format": schema,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": content }],
        "options": { "temperature": 0, "num_ctx": ollama_context(content)? },
    });
    let response = client(900)?.post(format!("{OLLAMA}/api/chat")).json(&request).send().await.map_err(|_| "Ollama isn’t running on this computer. Open it and try again.".to_string())?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status >= 400 { return Err(format!("Ollama: {}", body["error"].as_str().unwrap_or("the request failed"))); }
    body["message"]["content"].as_str().map(String::from).ok_or_else(|| "Ollama didn’t return a summary.".into())
}

/// Whether an Anthropic key is saved. The key itself never returns to the webview.
#[tauri::command]
pub async fn summary_key_status() -> Result<bool, String> { Ok(keychain::read(KEY)?.is_some()) }
#[tauri::command]
pub async fn summary_set_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() { return Err("Paste a key first.".into()); }
    let response = client(20)?.get(format!("{ANTHROPIC}/v1/models?limit=1")).header("x-api-key", key).header("anthropic-version", "2023-06-01")
        .send().await.map_err(|e| format!("Couldn’t reach Anthropic. {e}"))?;
    let status = response.status().as_u16();
    if status >= 400 { return Err(anthropic_error(status, &response.json().await.unwrap_or(Value::Null))); }
    keychain::store(KEY, key)
}
#[tauri::command]
pub async fn summary_remove_key() -> Result<(), String> { keychain::delete(KEY) }
/// The models installed in Ollama on this computer.
#[tauri::command]
pub async fn summary_ollama_models() -> Result<Vec<String>, String> {
    let response = client(5)?.get(format!("{OLLAMA}/api/tags")).send().await.map_err(|_| "Ollama isn’t running on this computer.".to_string())?;
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(body["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(String::from)).collect())
}
/// The model the user chose answers `content` under `system` with JSON matching `schema`.
async fn ask(root: &Path, system: &str, content: &str, schema: Value) -> Result<String, String> {
    match meetings::preference_str(root, "summaryProvider").as_deref() {
        Some("anthropic") => anthropic(&keychain::read(KEY)?.ok_or("Add your Anthropic key in Settings → Privacy first.")?, system, content, schema).await,
        Some("ollama") => ollama(&meetings::preference_str(root, "ollamaModel").ok_or("Choose an Ollama model in Settings → Privacy first.")?, system, content, schema).await,
        _ => Err("Summary suggestions are off. Turn them on in Settings → Privacy.".into()),
    }
}
/// A recorded meeting's transcript turns (none for a typed or example transcript), and its folder.
fn recorded(app: &AppHandle, meeting_id: &str) -> Result<(PathBuf, Vec<Turn>, PathBuf), String> {
    let root = meetings::root(app)?;
    let (_, dir) = meetings::find(&root, meeting_id)?;
    let turns = match std::fs::read(dir.join("transcript.json")) {
        Ok(bytes) => serde_json::from_slice::<Transcript>(&bytes).map_err(|e| e.to_string())?.turns,
        Err(_) => Vec::new(),
    };
    Ok((root, turns, dir))
}
/// Drafts suggestions for a recorded meeting with the chosen model. Writes nothing.
#[tauri::command]
pub async fn summary_suggest(app: AppHandle, meeting_id: String) -> Result<Suggestions, String> {
    let (root, turns, _) = recorded(&app, &meeting_id)?;
    let transcript = lines(&turns);
    if transcript.is_empty() { return Err("This meeting has no recorded transcript to summarize.".into()); }
    let json = ask(&root, INSTRUCTIONS, &transcript, schema()).await?;
    let draft: Draft = serde_json::from_str(&json).map_err(|_| "The model’s answer couldn’t be read. Try again.".to_string())?;
    Ok(ground(&turns, draft))
}

const NOTES_INSTRUCTIONS: &str = "You write a meeting's notes from the notes the person who recorded it took during the meeting and its transcript. \
Each transcript line is `[mm:ss] Speaker: text`. The speakers are \"You\" (that person), and \"Others\" or \"Speaker 1\", \"Speaker 2\"… \
for everyone else (voices told apart by sound, not by name). People's names appear only where someone says them.

Their notes show what mattered to them, so they lead: keep every point from them, under the section it belongs to, and fill \
each in with what the transcript says about it. Then add what else in the transcript belongs in the template's sections. \
If they wrote little or nothing, the transcript is all there is; if they wrote a lot, follow their order and add only what's important.
Passages they highlighted are listed under \"They highlighted\": those mattered most, so each gets its own item, first in its section, \
filled in with what the transcript says about it.

Return the template's sections, in its order and with its headings exactly, each with short items (one point each, a sentence or two):
- An item from their notes has `source` \"notes\", `quote` a phrase of three to twelve words copied word for word from their notes, and `at` an empty string.
- An item from the transcript has `source` \"transcript\", `at` the timestamp of the line it comes from copied exactly (for example \"12:04\"), \
and `quote` a phrase of three to twelve words copied word for word from that line.

Write only what was said or written: no advice, opinions or guesses about what people meant, and never a name the transcript doesn't give. \
A wrong item is worse than a missing one. A section with nothing for it gets no items. Write in the language of the meeting.";

fn notes_schema() -> Value {
    let item = json!({ "type": "object", "additionalProperties": false, "required": ["text", "source", "at", "quote"], "properties": {
        "text": { "type": "string" }, "source": { "type": "string", "enum": ["notes", "transcript"] }, "at": { "type": "string" }, "quote": { "type": "string" } } });
    json!({ "type": "object", "additionalProperties": false, "required": ["sections"], "properties": { "sections": { "type": "array", "items": {
        "type": "object", "additionalProperties": false, "required": ["heading", "items"], "properties": { "heading": { "type": "string" }, "items": { "type": "array", "items": item } } } } } })
}
#[derive(Deserialize)]
struct NotesDraft { sections: Vec<SectionDraft> }
#[derive(Deserialize)]
struct SectionDraft { heading: String, items: Vec<ItemDraft> }
#[derive(Deserialize)]
struct ItemDraft { text: String, source: String, at: String, quote: String }
/// One line of enhanced notes: from the transcript (`at_ms`, the line it quotes) or from the user's own notes.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Line { text: String, at_ms: Option<u64>, quote: String }
#[derive(Debug, Serialize, PartialEq)]
pub struct NoteSection { heading: String, lines: Vec<Line> }
#[derive(Debug, Serialize, PartialEq)]
pub struct Enhanced { sections: Vec<NoteSection>, dropped: usize }

/// The Notes section of `meeting.md`: everything after its `## Notes` heading.
fn notes_of(markdown: &str) -> String {
    let mut lines = markdown.lines();
    lines.by_ref().find(|l| l.trim().eq_ignore_ascii_case("## notes"));
    lines.collect::<Vec<_>>().join("\n").trim().to_string()
}
/// What they highlighted in their notes (the editor's Highlight, `==text==` in Markdown, as its tokenizer reads it).
fn highlighted(notes: &str) -> Vec<String> {
    static MARK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"==([^=\n]+)==").unwrap());
    MARK.captures_iter(notes).map(|c| c[1].trim().to_string()).filter(|m| !m.is_empty()).collect()
}
/// What the model reads: the template, the user's notes (and what they highlighted in them) and the transcript.
fn notes_request(template: &Template, notes: &str, transcript: &str) -> String {
    let sections: Vec<String> = template.sections.iter().map(|s| format!("## {}\n{}", s.heading, s.description).trim_end().to_string()).collect();
    let marks: Vec<String> = highlighted(notes).iter().map(|m| format!("- {m}")).collect();
    let marks = if marks.is_empty() { String::new() } else { format!("\n\nThey highlighted:\n{}", marks.join("\n")) };
    let notes = if notes.trim().is_empty() { "(They didn't write any.)" } else { notes };
    format!("Template \"{}\":\n{}\n\nTheir notes:\n{notes}{marks}\n\nTranscript:\n{transcript}", template.name, sections.join("\n\n"))
}
/// Keeps only lines that quote the user's notes or a transcript line, under the template's own headings
/// in its order, once each.
fn ground_notes(turns: &[Turn], notes: &str, template: &Template, draft: NotesDraft) -> Enhanced {
    let mut dropped = 0;
    let written = words(notes);
    let mut sections: Vec<NoteSection> = template.sections.iter().map(|s| NoteSection { heading: s.heading.clone(), lines: Vec::new() }).collect();
    for drafted in draft.sections {
        let Some(section) = sections.iter_mut().find(|s| s.heading.eq_ignore_ascii_case(drafted.heading.trim())) else { dropped += drafted.items.len(); continue };
        for item in drafted.items {
            let text = item.text.trim().to_string();
            let at_ms = match item.source.as_str() {
                "notes" if contains(&written, &words(&item.quote)) => Some(None),
                "transcript" => cited(turns, &Claim { text: String::new(), owner: String::new(), at: item.at.clone(), quote: item.quote.clone() }).map(|t| Some(t.start_ms)),
                _ => None,
            };
            match at_ms {
                Some(at_ms) if !text.is_empty() && !section.lines.iter().any(|l| l.text.eq_ignore_ascii_case(&text)) => section.lines.push(Line { text, at_ms, quote: item.quote.trim().into() }),
                _ => dropped += 1,
            }
        }
    }
    sections.retain(|s| !s.lines.is_empty());
    Enhanced { sections, dropped }
}
/// Writes a recorded meeting's notes again under `template`, from the user's notes and the transcript. Writes nothing.
#[tauri::command]
pub async fn notes_enhance(app: AppHandle, meeting_id: String, template: String) -> Result<Enhanced, String> {
    let (root, turns, dir) = recorded(&app, &meeting_id)?;
    let transcript = lines(&turns);
    if transcript.is_empty() { return Err("This meeting has no recorded transcript to enhance its notes with.".into()); }
    let template = crate::templates::all(&root).into_iter().find(|t| t.name == template).ok_or("That template isn’t there any more. Choose another.")?;
    let notes = notes_of(&std::fs::read_to_string(dir.join("meeting.md")).map_err(|e| e.to_string())?);
    let json = ask(&root, NOTES_INSTRUCTIONS, &notes_request(&template, &notes, &transcript), notes_schema()).await?;
    let draft: NotesDraft = serde_json::from_str(&json).map_err(|_| "The model’s answer couldn’t be read. Try again.".to_string())?;
    Ok(ground_notes(&turns, &notes, &template, draft))
}

const NAMES_INSTRUCTIONS: &str = "You suggest a meeting's title and who its unnamed speakers are, from its transcript and, when given, \
the names of the people invited. Each transcript line is `[mm:ss] Speaker: text`. \"You\" is the person who recorded it. \
The others are \"Speaker 1\", \"Speaker 2\"… (voices told apart by sound), or all together \"Others\" when they weren't told apart.

Return:
- title: a short title for what the meeting was about, two to six words, like a calendar event's (\"Q3 pricing review\", \"Onboarding feedback\"). \
No dates, and no names of people or companies unless the transcript says them.
- speakers: only labels you can name from the transcript: `speaker` is the label exactly, `name` the person's name as said in the transcript \
or as written in the invite, `at` the timestamp of the line that shows who it is (copied exactly), and `quote` three to twelve words copied \
word for word from that line. That line is the person introducing themselves, being addressed by name right before they answer, or \
saying their name. Never guess from how someone talks or what they talk about; when unsure, leave the speaker out. Never name \"You\".";

fn names_schema() -> Value {
    json!({ "type": "object", "additionalProperties": false, "required": ["title", "speakers"], "properties": {
        "title": { "type": "string" },
        "speakers": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["speaker", "name", "at", "quote"],
            "properties": { "speaker": { "type": "string" }, "name": { "type": "string" }, "at": { "type": "string" }, "quote": { "type": "string" } } } } } })
}
#[derive(Deserialize)]
struct NamesDraft { title: String, speakers: Vec<SpeakerDraft> }
#[derive(Deserialize)]
struct SpeakerDraft { speaker: String, name: String, at: String, quote: String }
/// A suggested name for a voice, and the transcript line that shows it.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerName { speaker: String, name: String, at_ms: u64, quote: String }
#[derive(Debug, Serialize, PartialEq)]
pub struct Names { title: String, speakers: Vec<SpeakerName>, dropped: usize }

/// Keeps a speaker's name only if the label is one of the transcript's unnamed voices, the cited line is in
/// the transcript, and the name is said there or is someone invited; "Others" (everyone else together) only
/// when one other person was invited. One name per voice and one voice per name.
fn ground_names(turns: &[Turn], invited: &[String], draft: NamesDraft) -> Names {
    let unnamed = |label: &str| label == "Others" || label.strip_prefix("Speaker ").is_some_and(|n| n.parse::<u32>().is_ok());
    let mut dropped = 0;
    let mut speakers: Vec<SpeakerName> = Vec::new();
    for s in draft.speakers {
        let (label, name) = (s.speaker.trim().to_string(), s.name.trim().to_string());
        let claim = Claim { text: String::new(), owner: String::new(), at: s.at.clone(), quote: s.quote.clone() };
        let said = turns.iter().any(|t| contains(&words(&t.text), &words(&name)));
        let known = invited.iter().any(|i| i.eq_ignore_ascii_case(&name) || i.split_whitespace().next().is_some_and(|f| f.eq_ignore_ascii_case(&name)));
        let fits = unnamed(&label) && turns.iter().any(|t| t.speaker == label) && (label != "Others" || invited.len() == 1);
        match cited(turns, &claim) {
            Some(turn) if fits && !name.is_empty() && name.chars().count() <= 60 && (said || known)
                && !speakers.iter().any(|k| k.speaker == label || k.name.eq_ignore_ascii_case(&name)) =>
                speakers.push(SpeakerName { speaker: label, name, at_ms: turn.start_ms, quote: s.quote.trim().into() }),
            _ => dropped += 1,
        }
    }
    let title = draft.title.trim().trim_matches(['"', '“', '”', '.']).trim().to_string();
    let title = if title.chars().count() <= 60 && title.split_whitespace().count() <= 8 { title } else { String::new() };
    Names { title, speakers, dropped }
}
/// Suggests a recorded meeting's title and names for its voices with the chosen model, from its transcript
/// and the names of the people invited. Writes nothing.
#[tauri::command]
pub async fn meeting_names(app: AppHandle, meeting_id: String) -> Result<Names, String> {
    let (root, turns, _) = recorded(&app, &meeting_id)?;
    let transcript = lines(&turns);
    if transcript.is_empty() { return Err("This meeting has no recorded transcript to read names from.".into()); }
    let (metadata, _) = meetings::find(&root, &meeting_id)?;
    let invited: Vec<String> = if metadata.attendees.is_empty() { metadata.participants.clone() } else { metadata.attendees.iter().filter(|a| !a.me).map(|a| a.name.clone()).collect() };
    let content = if invited.is_empty() { format!("Transcript:\n{transcript}") } else { format!("Invited: {}\n\nTranscript:\n{transcript}", invited.join(", ")) };
    let json = ask(&root, NAMES_INSTRUCTIONS, &content, names_schema()).await?;
    let draft: NamesDraft = serde_json::from_str(&json).map_err(|_| "The model’s answer couldn’t be read. Try again.".to_string())?;
    Ok(ground_names(&turns, &invited, draft))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn turn(start_ms: u64, speaker: &str, text: &str) -> Turn {
        Turn { start_ms, end_ms: start_ms + 5000, speaker: speaker.into(), text: text.into(), removed: vec![], breaks: vec![] }
    }
    fn claim(text: &str, owner: &str, at: &str, quote: &str) -> Claim { Claim { text: text.into(), owner: owner.into(), at: at.into(), quote: quote.into() } }
    fn meeting() -> Vec<Turn> {
        vec![
            turn(0, "Others", "Okay so Maya will send the pricing draft by Friday."),
            turn(65_000, "You", "Great, then we go with the annual plan. I'll update the landing page."),
            turn(3_725_000, "Others", "Sounds good."),
        ]
    }
    #[test]
    fn writes_lines_with_the_transcript_timestamps() {
        assert_eq!(lines(&meeting()), "[00:00] Others: Okay so Maya will send the pricing draft by Friday.\n[01:05] You: Great, then we go with the annual plan. I'll update the landing page.\n[1:02:05] Others: Sounds good.");
        assert_eq!(lines(&[turn(0, "You", "  ")]), "");
    }
    #[test]
    fn keeps_only_claims_that_cite_the_transcript() {
        let draft = Draft {
            summary: " Pricing was settled. ".into(),
            actions: vec![
                claim("Send the pricing draft by Friday", "Maya", "00:00", "Maya will send the pricing draft"),
                claim("Update the landing page", "You", "[01:05]", "I'll update the landing page"),
                claim("Launch next week", "", "01:05", "we launch next week"),
                claim("Book the venue", "Tim", "00:30", "book the venue"),
                claim("Follow up", "Jordan", "1:02:05", "Sounds good"),
            ],
        };
        let s = ground(&meeting(), draft);
        assert_eq!(s.summary, "Pricing was settled.");
        assert_eq!(s.actions.iter().map(|a| (a.text.as_str(), a.owner.as_str(), a.at_ms)).collect::<Vec<_>>(), [("Send the pricing draft by Friday", "Maya", 0), ("Update the landing page", "You", 65_000), ("Follow up", "", 3_725_000)]);
        assert_eq!(s.dropped, 2);
    }
    #[test]
    fn drops_duplicates_and_empty_text() {
        let draft = Draft { summary: String::new(), actions: vec![claim("Annual plan", "", "01:05", "annual plan"), claim("annual plan", "", "01:05", "annual plan"), claim(" ", "", "01:05", "annual plan")] };
        let s = ground(&meeting(), draft);
        assert_eq!(s.actions.len(), 1);
        assert_eq!(s.dropped, 2);
    }
    #[test]
    fn owners_are_never_guessed() {
        let turns = meeting();
        assert_eq!(owner(&turns, "Maya"), "Maya");
        assert_eq!(owner(&turns, "You"), "You");
        assert_eq!(owner(&turns, "Others"), "");
        assert_eq!(owner(&turns, "J_ and J_"), "");
        // A voice told apart is someone in the transcript, but not one it doesn't have.
        let voices = [turn(0, "Speaker 2", "I'll send the pricing draft.")];
        assert_eq!(owner(&voices, "Speaker 2"), "Speaker 2");
        assert_eq!(owner(&voices, "Speaker 3"), "");
        assert_eq!(owner(&turns, ""), "");
    }
    #[test]
    fn reads_the_messages_response() {
        let ok = json!({ "stop_reason": "end_turn", "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": "{}" }] });
        assert_eq!(anthropic_text(&ok).unwrap(), "{}");
        assert!(anthropic_text(&json!({ "stop_reason": "refusal", "content": [] })).unwrap_err().contains("declined"));
        assert!(anthropic_text(&json!({ "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "{" }] })).unwrap_err().contains("cut off"));
        assert!(anthropic_error(401, &Value::Null).contains("rejected this key"));
        assert_eq!(anthropic_error(429, &json!({ "error": { "message": "Rate limited" } })), "Anthropic: Rate limited");
    }
    #[test]
    fn enhanced_notes_keep_only_lines_that_quote_the_notes_or_the_transcript() {
        let template = crate::templates::parse("# Sync\n## Overview\n## Next steps\n", "Sync").unwrap();
        let notes = "- pricing: annual plan?\n- Maya pricing draft Friday";
        let item = |text: &str, source: &str, at: &str, quote: &str| ItemDraft { text: text.into(), source: source.into(), at: at.into(), quote: quote.into() };
        let draft = NotesDraft { sections: vec![
            SectionDraft { heading: "overview".into(), items: vec![
                item("Pricing: the team went with the annual plan.", "transcript", "01:05", "we go with the annual plan"),
                item("Annual plan or not was the open question.", "notes", "", "pricing annual plan"),
                item("Everyone was excited.", "transcript", "01:05", "everyone was excited"),
                item("Churn is too high.", "notes", "", "churn is too high"),
            ] },
            SectionDraft { heading: "Next steps".into(), items: vec![
                item("Maya sends the pricing draft by Friday.", "notes", "", "Maya pricing draft Friday"),
                item("Maya sends the pricing draft by Friday.", "transcript", "00:00", "Maya will send the pricing draft"),
            ] },
            SectionDraft { heading: "Risks".into(), items: vec![item("Launch could slip.", "transcript", "01:05", "launch")] },
        ] };
        let e = ground_notes(&meeting(), notes, &template, draft);
        type Shown<'a> = Vec<(&'a str, Option<u64>)>;
        let shown: Vec<(&str, Shown)> = e.sections.iter().map(|s| (s.heading.as_str(), s.lines.iter().map(|l| (l.text.as_str(), l.at_ms)).collect())).collect();
        assert_eq!(shown, [
            ("Overview", vec![("Pricing: the team went with the annual plan.", Some(65_000)), ("Annual plan or not was the open question.", None)]),
            ("Next steps", vec![("Maya sends the pricing draft by Friday.", None)]),
        ]);
        // Invented by the model, not in their notes, a repeat, or under a heading the template doesn't have.
        assert_eq!(e.dropped, 4);
        assert_eq!(notes_of("# T\n\n## Summary\nS\n\n## Notes\n- one\n## Heading in notes\n- two\n"), "- one\n## Heading in notes\n- two");
        assert!(notes_request(&template, "  ", "[00:00] You: Hi.").contains("Their notes:\n(They didn't write any.)\n\nTranscript:\n[00:00] You: Hi."));
        assert_eq!(highlighted("- Pilot starts 3 Nov\n- ==SSO is the blocker==, a == b\n- ==  == and ==legal== review"), ["SSO is the blocker", "legal"]);
        assert!(notes_request(&template, "- ==SSO is the blocker==", "[00:00] You: Hi.").contains("Their notes:\n- ==SSO is the blocker==\n\nThey highlighted:\n- SSO is the blocker\n\nTranscript:"));
        // A quote of a highlighted passage still matches the notes: the marks aren't words.
        assert!(contains(&words("- ==SSO is the blocker=="), &words("SSO is the blocker")));
    }
    #[test]
    fn names_a_voice_only_with_a_line_that_shows_who_it_is() {
        let turns = vec![
            turn(0, "You", "Thanks for joining. Maria, do you want to start?"),
            turn(4_000, "Speaker 1", "Sure, I'm Maria from Globex, I lead pricing."),
            turn(9_000, "Speaker 2", "And I'm Sam."),
            turn(12_000, "Speaker 3", "Hi all."),
        ];
        let invited = ["Maria Lopez".to_string(), "Sam Lee".to_string(), "Tom Baker".to_string()];
        let s = |speaker: &str, name: &str, at: &str, quote: &str| SpeakerDraft { speaker: speaker.into(), name: name.into(), at: at.into(), quote: quote.into() };
        let draft = NamesDraft { title: "“Globex pricing kickoff.”".into(), speakers: vec![
            s("Speaker 1", "Maria Lopez", "00:04", "I'm Maria from Globex"),
            s("Speaker 2", "Sam", "00:09", "And I'm Sam"),
            s("Speaker 3", "Tom Baker", "00:12", "they sound like Tom"),
            s("Speaker 2", "Samuel", "00:09", "And I'm Sam"),
            s("You", "Jordan", "00:00", "Thanks for joining"),
            s("Others", "Maria", "00:04", "I'm Maria from Globex"),
            s("Speaker 4", "Ana", "00:12", "Hi all"),
        ] };
        let names = ground_names(&turns, &invited, draft);
        assert_eq!(names.title, "Globex pricing kickoff");
        assert_eq!(names.speakers.iter().map(|n| (n.speaker.as_str(), n.name.as_str(), n.at_ms)).collect::<Vec<_>>(), [("Speaker 1", "Maria Lopez", 4_000), ("Speaker 2", "Sam", 9_000)]);
        // A guess without its line, a second name for one voice, "You", "Others" with three invited, a voice that isn't there.
        assert_eq!(names.dropped, 5);
        // With one other person invited, "Others" can be them; a long title is left out.
        let one = ground_names(&[turn(0, "Others", "Hi, Maria here.")], &["Maria Lopez".into()], NamesDraft { title: "A title that goes on and on for far too many words".into(), speakers: vec![s("Others", "Maria Lopez", "00:00", "Maria here")] });
        assert_eq!((one.title.as_str(), one.speakers.len()), ("", 1));
    }
    #[test]
    fn refuses_meetings_too_long_for_ollama() {
        assert_eq!(ollama_context("short").unwrap(), 8192);
        assert!(ollama_context(&"word ".repeat(30_000)).is_err());
    }
    #[test]
    fn schema_requires_every_field() {
        let s = schema();
        assert_eq!(s["properties"]["actions"]["items"]["required"], json!(["text", "owner", "at", "quote"]));
        assert_eq!(s["properties"]["actions"]["items"]["additionalProperties"], json!(false));
        assert_eq!(s["required"], json!(["summary", "actions"]));
    }
}
