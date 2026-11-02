//! Summary suggestions: a summary and action items drafted from a recorded transcript by the model
//! the user chose: Claude with their own Anthropic key, a model in Ollama on this computer, or Apple
//! Intelligence on this Mac (`apple`). Only the transcript's text is sent, only when the user asks, and
//! nothing is written: the user accepts each item. Every action item must cite the transcript line it
//! came from with an exact quote, or it's dropped.
//!
//! Enhanced notes (`notes_enhance`) send the user's notes too, with a template (`templates`): the notes are
//! rewritten under its sections and filled in from the transcript. Each line must quote either the
//! user's notes or a transcript line, or it's dropped. `meeting_ask` answers a question about a meeting,
//! each sentence citing its transcript.
//!
//! A meeting longer than the model reads at once (Ollama, and Apple Intelligence's 4,096 tokens) is read
//! in parts (`parts`): each part is asked on its own and grounded against its own lines, then the
//! results are combined.
use crate::apple::{self, Failure};
use crate::connectors::keychain;
use crate::meetings;
use crate::templates::Template;
use crate::transcript::{clock, Transcript, Turn};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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
        "properties": { "summary": { "type": "string" }, "actions": { "type": "array", "maxItems": 10, "items": item } }
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
/// `partial`: part of the meeting couldn't be read (the model declined it).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestions { summary: String, actions: Vec<Cited>, dropped: usize, partial: bool }

/// The line the model reads for a turn: its clean text under the timestamp the Transcript tab shows.
fn line(t: &Turn) -> Option<String> {
    let text = t.clean();
    (!text.trim().is_empty()).then(|| format!("[{}] {}: {}", clock(t.start_ms), t.speaker, text.trim()))
}
#[cfg(test)]
fn lines(turns: &[Turn]) -> String { turns.iter().filter_map(line).collect::<Vec<_>>().join("\n") }
/// Whether anyone said anything the model could read.
fn spoken(turns: &[Turn]) -> bool { turns.iter().any(|t| !t.clean().trim().is_empty()) }
/// About how many tokens `text` is: a token is a few letters of English, and about one character of
/// most other scripts. On the high side, so a part fits.
fn est_tokens(text: &str) -> usize { text.chars().map(|c| if c.is_ascii() { 1 } else { 3 }).sum::<usize>() / 3 }

/// Some of a transcript's lines, each with the turn it comes from.
#[derive(Clone, Debug, Default, PartialEq)]
struct Part { lines: Vec<(usize, String)> }
impl Part {
    fn text(&self) -> String { self.lines.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join("\n") }
    /// The turns its lines come from, to ground what the model says about this part against.
    fn turns(&self, all: &[Turn]) -> Vec<Turn> {
        let mut seen: Vec<usize> = self.lines.iter().map(|(i, _)| *i).collect();
        seen.dedup();
        seen.into_iter().map(|i| all[i].clone()).collect()
    }
    fn halves(&self) -> Option<(Part, Part)> {
        (self.lines.len() > 1).then(|| { let (a, b) = self.lines.split_at(self.lines.len() / 2); (Part { lines: a.to_vec() }, Part { lines: b.to_vec() }) })
    }
}
/// A turn's line, split at sentence ends (or words, for a very long sentence) into pieces of at most
/// `budget` tokens, each under the turn's own timestamp so it still cites the turn.
fn pieces(t: &Turn, line: String, budget: usize) -> Vec<String> {
    if est_tokens(&line) <= budget { return vec![line]; }
    let head = format!("[{}] {}: ", clock(t.start_ms), t.speaker);
    let room = budget.saturating_sub(est_tokens(&head)).max(20);
    let text = line[head.len()..].to_string();
    let mut units: Vec<String> = Vec::new();
    for sentence in text.split_inclusive(['.', '?', '!']) {
        if est_tokens(sentence) <= room { units.push(sentence.trim().to_string()); continue; }
        let mut words = String::new();
        for w in sentence.split_whitespace() {
            if !words.is_empty() && est_tokens(&words) + est_tokens(w) + 1 > room { units.push(std::mem::take(&mut words)); }
            if !words.is_empty() { words.push(' '); }
            words.push_str(w);
        }
        if !words.is_empty() { units.push(words); }
    }
    let mut out: Vec<String> = Vec::new();
    let mut piece = String::new();
    for unit in units.into_iter().filter(|u| !u.is_empty()) {
        if !piece.is_empty() && est_tokens(&piece) + est_tokens(&unit) + 1 > room { out.push(format!("{head}{}", std::mem::take(&mut piece))); }
        if !piece.is_empty() { piece.push(' '); }
        piece.push_str(&unit);
    }
    if !piece.is_empty() { out.push(format!("{head}{piece}")); }
    out
}
/// The transcript in parts of at most `budget` tokens, in order, every line in exactly one.
fn parts(turns: &[Turn], budget: usize) -> Vec<Part> {
    let mut out = Vec::new();
    let (mut part, mut used) = (Part::default(), 0);
    for (i, t) in turns.iter().enumerate() {
        let Some(line) = line(t) else { continue };
        for piece in pieces(t, line, budget) {
            let cost = est_tokens(&piece) + 1;
            if used + cost > budget && !part.lines.is_empty() { out.push(std::mem::take(&mut part)); used = 0; }
            used += cost;
            part.lines.push((i, piece));
        }
    }
    if !part.lines.is_empty() { out.push(part); }
    out
}

/// A request asked of each part: `content` turns a part's lines into what the model reads.
struct Request<'a> { system: &'a str, content: &'a (dyn Fn(&str) -> String + Sync), schema: Value, reserve: usize }
/// What answers a request: the chosen model, or a stand-in in tests.
trait Respond {
    async fn respond(&mut self, system: &str, content: &str, schema: &Value, reserve: usize) -> Result<String, Failure>;
}
/// Asks about each part in turn, reporting "part 3 of 12" to `progress`, and reads each answer. A part too
/// long for the model is asked again in halves; one it declines, or whose answer can't be read, is skipped,
/// and the answer is marked partial.
async fn each_part<T: DeserializeOwned>(model: &mut impl Respond, parts: Vec<Part>, request: &Request<'_>, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<(Vec<(Part, T)>, bool), String> {
    let mut queue: VecDeque<Part> = parts.into();
    let (mut done, mut answered, mut skipped, mut unreadable) = (0, Vec::new(), false, false);
    while let Some(part) = queue.pop_front() {
        if done + queue.len() > 0 { progress(done + 1, done + queue.len() + 1); }
        match model.respond(request.system, &(request.content)(&part.text()), &request.schema, request.reserve).await {
            Ok(json) => match serde_json::from_str(&json) {
                Ok(answer) => answered.push((part, answer)),
                Err(_) => (skipped, unreadable) = (true, true),
            },
            Err(Failure::TooLong) => match part.halves() {
                Some((a, b)) => { queue.push_front(b); queue.push_front(a); continue; }
                None => skipped = true,
            },
            Err(Failure::Declined(_)) => skipped = true,
            Err(Failure::Failed(e)) => return Err(e),
        }
        done += 1;
    }
    if answered.is_empty() {
        return Err(if unreadable { UNREADABLE.into() } else if skipped { "The model declined to read this meeting.".into() } else { "This meeting has nothing to read.".into() });
    }
    Ok((answered, skipped))
}
const UNREADABLE: &str = "The model’s answer couldn’t be read. Try again.";
#[cfg(test)]
fn read<'a, T: Deserialize<'a>>(json: &'a str) -> Result<T, String> { serde_json::from_str(json).map_err(|_| UNREADABLE.to_string()) }
use crate::cleanup::words;
fn contains(haystack: &[String], needle: &[String]) -> bool { !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle) }
/// `mm:ss` or `h:mm:ss` in ms.
fn at_ms(at: &str) -> Option<u64> {
    at.split(':').try_fold(0u64, |total, part| part.parse::<u64>().ok().map(|n| total * 60 + n)).map(|s| s * 1000)
}
/// The turn a claim cites: the one at its timestamp whose words hold its quote. A model that copied the
/// quote but slipped a line on the time gets the nearest turn within a minute that holds it, so the
/// citation shows where the words really are.
fn cited<'a>(turns: &'a [Turn], claim: &Claim) -> Option<&'a Turn> {
    let at = claim.at.trim().trim_start_matches('[').trim_end_matches(']');
    let quote = words(&claim.quote);
    let holds = |t: &Turn| contains(&words(&t.clean()), &quote) || contains(&words(&t.text), &quote);
    turns.iter().find(|t| clock(t.start_ms) == at && holds(t)).or_else(|| {
        let ms = at_ms(at)?;
        turns.iter().filter(|t| t.start_ms.abs_diff(ms) <= 60_000 && holds(t)).min_by_key(|t| t.start_ms.abs_diff(ms))
    })
}
/// An owner is kept only if it's the recording person, a voice the transcript tells apart ("Speaker 2"),
/// or a name someone said.
fn owner(turns: &[Turn], owner: &str) -> String {
    let owner = owner.trim();
    let named = !words(owner).is_empty() && turns.iter().any(|t| contains(&words(&t.text), &words(owner)));
    let speaker = turns.iter().any(|t| t.speaker == owner);
    if owner != "Others" && (owner == "You" || speaker || named) { owner.into() } else { String::new() }
}
/// Keeps only the claims that trace back to `read` (the turns the model was given), once each. Owners are
/// checked against the whole meeting, `all`, since a name may be said in another part.
fn ground(read: &[Turn], all: &[Turn], draft: Draft) -> Suggestions {
    let mut dropped = 0;
    let mut actions: Vec<Cited> = Vec::new();
    for claim in draft.actions {
        let text = claim.text.trim().to_string();
        match cited(read, &claim) {
            Some(turn) if !text.is_empty() && !actions.iter().any(|k| k.text.eq_ignore_ascii_case(&text)) =>
                actions.push(Cited { owner: owner(all, &claim.owner), text, at_ms: turn.start_ms, quote: claim.quote.trim().into() }),
            _ => dropped += 1,
        }
    }
    Suggestions { summary: draft.summary.trim().into(), actions, dropped, partial: false }
}

fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("QuietNote").timeout(Duration::from_secs(seconds)).build().map_err(|e| e.to_string())
}
fn anthropic_error(status: u16, body: &Value) -> String {
    if status == 401 { return "Anthropic rejected this key. Check it, or create a new one.".into(); }
    format!("Anthropic: {}", body["error"]["message"].as_str().unwrap_or("the request failed"))
}
/// The model's JSON from a Messages API response, or why there is none.
fn anthropic_text(body: &Value) -> Result<String, Failure> {
    match body["stop_reason"].as_str() {
        Some("refusal") => return Err(Failure::Declined("Claude declined to read this meeting.".into())),
        Some("max_tokens") => return Err(Failure::Failed("The answer was cut off before it finished. Try again.".into())),
        _ => {}
    }
    body["content"].as_array().into_iter().flatten().find(|b| b["type"] == "text").and_then(|b| b["text"].as_str()).map(String::from)
        .ok_or_else(|| Failure::Failed("Claude didn’t return an answer.".into()))
}
/// `schema` without `maxItems`, which Claude's structured outputs don't take (the other models use it to
/// keep an answer within its room).
fn unbounded(mut schema: Value) -> Value {
    if let Some(object) = schema.as_object_mut() {
        object.remove("maxItems");
        for value in object.values_mut() { *value = unbounded(value.take()); }
    }
    schema
}
async fn anthropic(key: &str, system: &str, content: &str, schema: Value) -> Result<String, Failure> {
    let schema = unbounded(schema);
    let request = json!({
        "model": MODEL, "max_tokens": 16000, "system": system,
        "messages": [{ "role": "user", "content": content }],
        "output_config": { "format": { "type": "json_schema", "schema": schema } },
        "fallbacks": "default",
    });
    let response = client(300).map_err(Failure::Failed)?.post(format!("{ANTHROPIC}/v1/messages")).header("x-api-key", key).header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01").json(&request).send().await.map_err(|e| Failure::Failed(format!("Couldn’t reach Anthropic. {e}")))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status >= 400 { return Err(Failure::Failed(anthropic_error(status, &body))); }
    anthropic_text(&body)
}
/// Ollama's context in tokens for a request of about `tokens`, with room for the answer; longer than
/// Ollama is asked for, it's too long (and is asked in smaller parts).
fn ollama_context(tokens: usize) -> Result<usize, Failure> {
    if tokens > OLLAMA_CONTEXT { return Err(Failure::TooLong); }
    Ok(tokens.max(8192))
}
async fn ollama(model: &str, system: &str, content: &str, schema: Value, reserve: usize) -> Result<String, Failure> {
    let request = json!({
        "model": model, "stream": false, "format": schema,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": content }],
        "options": { "temperature": 0, "num_ctx": ollama_context(est_tokens(system) + est_tokens(content) + reserve)? },
    });
    let failed = |e: String| Failure::Failed(e);
    let response = client(900).map_err(failed)?.post(format!("{OLLAMA}/api/chat")).json(&request).send().await.map_err(|_| failed("Ollama isn’t running on this computer. Open it and try again.".into()))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status >= 400 { return Err(failed(format!("Ollama: {}", body["error"].as_str().unwrap_or("the request failed")))); }
    body["message"]["content"].as_str().map(String::from).ok_or_else(|| failed("Ollama didn’t return an answer.".into()))
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
/// The model the user chose, opened once for a command (Apple Intelligence's helper stays loaded for it).
enum Provider { Anthropic(String), Ollama(String), Apple(Box<apple::Session>) }
impl Provider {
    /// `report` hears (0, 0) while Apple Intelligence waits for another command to finish with it, then (1, 1).
    async fn open(root: &Path, report: &impl Fn(usize, usize)) -> Result<Provider, String> {
        match meetings::preference_str(root, "summaryProvider").as_deref() {
            Some("anthropic") => Ok(Provider::Anthropic(keychain::read(KEY)?.ok_or("Add your Anthropic key in Settings → Suggestions first.")?)),
            Some("ollama") => Ok(Provider::Ollama(meetings::preference_str(root, "ollamaModel").ok_or("Choose an Ollama model in Settings → Suggestions first.")?)),
            Some("apple") => {
                let session = apple::Session::open(|| report(0, 0)).await?;
                // Clears the waiting line, which one-part meetings never replace with a part.
                report(1, 1);
                Ok(Provider::Apple(Box::new(session)))
            }
            _ => Err("Summary suggestions are off. Turn them on in Settings → Suggestions.".into()),
        }
    }
    /// Tokens the model reads at once, prompt and answer together; `None` when a whole meeting fits.
    fn context(&self) -> Option<usize> {
        match self { Provider::Anthropic(_) => None, Provider::Ollama(_) => Some(OLLAMA_CONTEXT), Provider::Apple(session) => Some(session.context) }
    }
    /// The transcript tokens one request can carry beside `system`, `extra` (notes, a question) and an
    /// answer of `reserve` tokens, with a margin since tokens are estimated. `None`: the whole meeting.
    /// `long` says what to shorten when there's no room for the transcript.
    fn budget(&self, system: &str, extra: &str, reserve: usize, long: &str) -> Result<Option<usize>, String> {
        let Some(context) = self.context() else { return Ok(None) };
        let room = context.saturating_sub(est_tokens(system) + est_tokens(extra) + reserve) * 9 / 10;
        if room < 300 { return Err(long.into()); }
        Ok(Some(room))
    }
    /// The transcript in the parts this model reads.
    fn parts(&self, turns: &[Turn], system: &str, extra: &str, reserve: usize, long: &str) -> Result<Vec<Part>, String> {
        Ok(match self.budget(system, extra, reserve, long)? {
            Some(budget) => parts(turns, budget),
            None => vec![Part { lines: turns.iter().enumerate().filter_map(|(i, t)| line(t).map(|l| (i, l))).collect() }],
        })
    }
}
impl Respond for Provider {
    async fn respond(&mut self, system: &str, content: &str, schema: &Value, reserve: usize) -> Result<String, Failure> {
        match self {
            Provider::Anthropic(key) => anthropic(key, system, content, schema.clone()).await,
            Provider::Ollama(model) => ollama(model, system, content, schema.clone(), reserve).await,
            Provider::Apple(session) => session.respond(system, content, schema, reserve).await,
        }
    }
}
/// Reports "part 3 of 12" of a long meeting to the window, for `kind`: "suggest" (suggestions, enhanced
/// notes, names) or "ask", which can run at the same time.
fn progress(app: &AppHandle, meeting_id: &str, kind: &'static str) -> impl Fn(usize, usize) + Sync {
    let (app, id) = (app.clone(), meeting_id.to_string());
    move |done, total| { let _ = app.emit("quietnote://suggest-progress", json!({ "meetingId": id, "kind": kind, "done": done, "total": total })); }
}
/// One small extra request: the parts' summaries or titles made into one.
async fn combine(provider: &mut Provider, system: &str, items: &[String], field: &str, reserve: usize) -> Option<String> {
    let schema = json!({ "type": "object", "additionalProperties": false, "required": [field], "properties": { field: { "type": "string" } } });
    let list = items.iter().enumerate().map(|(i, s)| format!("{}. {s}", i + 1)).collect::<Vec<_>>().join("\n");
    let json = provider.respond(system, &list, &schema, reserve).await.ok()?;
    serde_json::from_str::<Value>(&json).ok()?[field].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
/// A recorded meeting's transcript turns (none for a typed or example transcript), and its folder.
fn recorded(app: &AppHandle, meeting_id: &str) -> Result<(PathBuf, Vec<Turn>, PathBuf), String> {
    let root = meetings::root(app)?;
    let _files = meetings::files();
    let (_, dir) = meetings::find(&root, meeting_id)?;
    let turns = match std::fs::read(dir.join("transcript.json")) {
        Ok(bytes) => serde_json::from_slice::<Transcript>(&bytes).map_err(|e| e.to_string())?.turns,
        Err(_) => Vec::new(),
    };
    Ok((root, turns, dir))
}
/// Room for the model's answer, in tokens, per kind of request.
const SUGGEST_RESERVE: usize = 700;
const NOTES_RESERVE: usize = 1000;
const NAMES_RESERVE: usize = 300;
const ASK_RESERVE: usize = 400;
/// What to shorten when a request leaves no room for the transcript, per kind of request.
const SUGGEST_LONG: &str = "This model can’t read the transcript beside its instructions. Use Claude.";
const NOTES_LONG: &str = "Your notes are too long for this model to read with the transcript. Shorten them, or use Claude.";
const NAMES_LONG: &str = "The invite lists too many people for this model to read with the transcript. Use Claude.";
const ASK_LONG: &str = "Your question is too long for this model to read with the transcript. Ask a shorter one, or use Claude.";
const SUMMARIES: &str = "These are summaries of consecutive parts of one meeting, in order. Write one summary of the whole meeting: \
two to four short sentences on what it covered and where it ended up, plain prose, using only what they say. Write in their language.";
const TITLES: &str = "These are titles suggested for consecutive parts of one meeting, in order. Return one title for the whole meeting, \
two to six words like a calendar event's, using only topics and names from them.";

/// The same action item suggested by two parts is kept once.
fn same(a: &Cited, b: &Cited) -> bool { a.text.eq_ignore_ascii_case(&b.text) || (a.at_ms == b.at_ms && words(&a.quote) == words(&b.quote)) }
/// Combines what each part suggested: its grounded action items once each, and its summary.
fn merge_suggestions(answers: Vec<Suggestions>) -> (Vec<String>, Suggestions) {
    let mut merged = Suggestions { summary: String::new(), actions: Vec::new(), dropped: 0, partial: false };
    let mut summaries = Vec::new();
    for answer in answers {
        merged.dropped += answer.dropped;
        if !answer.summary.is_empty() { summaries.push(answer.summary); }
        for action in answer.actions {
            // Another part's copy was traced too: it isn't counted as left out.
            if !merged.actions.iter().any(|k| same(k, &action)) { merged.actions.push(action); }
        }
    }
    (summaries, merged)
}
/// Drafts suggestions for a recorded meeting with the chosen model. Writes nothing.
#[tauri::command]
pub async fn summary_suggest(app: AppHandle, meeting_id: String) -> Result<Suggestions, String> {
    let (root, turns, _) = recorded(&app, &meeting_id)?;
    if !spoken(&turns) { return Err("This meeting has no recorded transcript to summarize.".into()); }
    let mut provider = Provider::open(&root, &progress(&app, &meeting_id, "suggest")).await?;
    let parts = provider.parts(&turns, INSTRUCTIONS, "", SUGGEST_RESERVE, SUGGEST_LONG)?;
    let request = Request { system: INSTRUCTIONS, content: &|t| t.to_string(), schema: schema(), reserve: SUGGEST_RESERVE };
    let (answered, skipped) = each_part::<Draft>(&mut provider, parts, &request, &progress(&app, &meeting_id, "suggest")).await?;
    let grounded = answered.into_iter().map(|(part, draft)| ground(&part.turns(&turns), &turns, draft)).collect();
    let (summaries, mut merged) = merge_suggestions(grounded);
    merged.summary = match summaries.len() {
        0 => String::new(),
        1 => summaries[0].clone(),
        _ => combine(&mut provider, SUMMARIES, &summaries, "summary", 300).await.unwrap_or_else(|| summaries.join(" ")),
    };
    merged.partial = skipped;
    Ok(merged)
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
    json!({ "type": "object", "additionalProperties": false, "required": ["sections"], "properties": { "sections": { "type": "array", "maxItems": 8, "items": {
        "type": "object", "additionalProperties": false, "required": ["heading", "items"], "properties": { "heading": { "type": "string" }, "items": { "type": "array", "maxItems": 6, "items": item } } } } } })
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
pub struct Enhanced { sections: Vec<NoteSection>, dropped: usize, partial: bool }

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
    Enhanced { sections, dropped, partial: false }
}
/// Combines each part's enhanced notes under the template's headings in its order: a line once, and a
/// point from the user's notes once however many parts quote it.
fn merge_notes(template: &Template, answers: Vec<Enhanced>) -> Enhanced {
    let mut sections: Vec<NoteSection> = template.sections.iter().map(|s| NoteSection { heading: s.heading.clone(), lines: Vec::new() }).collect();
    let mut dropped = 0;
    for answer in answers {
        dropped += answer.dropped;
        for drafted in answer.sections {
            let Some(section) = sections.iter_mut().find(|s| s.heading == drafted.heading) else { continue };
            for line in drafted.lines {
                let repeat = section.lines.iter().any(|l| l.text.eq_ignore_ascii_case(&line.text) || (l.at_ms.is_none() && line.at_ms.is_none() && words(&l.quote) == words(&line.quote)));
                if !repeat { section.lines.push(line); }
            }
        }
    }
    sections.retain(|s| !s.lines.is_empty());
    Enhanced { sections, dropped, partial: false }
}
/// Writes a recorded meeting's notes again under `template`, from the user's notes and the transcript. Writes nothing.
#[tauri::command]
pub async fn notes_enhance(app: AppHandle, meeting_id: String, template: String) -> Result<Enhanced, String> {
    let (root, turns, dir) = recorded(&app, &meeting_id)?;
    if !spoken(&turns) { return Err("This meeting has no recorded transcript to enhance its notes with.".into()); }
    let template = crate::templates::all(&root).into_iter().find(|t| t.name == template).ok_or("That template isn’t there any more. Choose another.")?;
    let notes = notes_of(&std::fs::read_to_string(dir.join("meeting.md")).map_err(|e| e.to_string())?);
    let mut provider = Provider::open(&root, &progress(&app, &meeting_id, "suggest")).await?;
    let parts = provider.parts(&turns, NOTES_INSTRUCTIONS, &notes_request(&template, &notes, ""), NOTES_RESERVE, NOTES_LONG)?;
    let content = |t: &str| notes_request(&template, &notes, t);
    let request = Request { system: NOTES_INSTRUCTIONS, content: &content, schema: notes_schema(), reserve: NOTES_RESERVE };
    let (answered, skipped) = each_part::<NotesDraft>(&mut provider, parts, &request, &progress(&app, &meeting_id, "suggest")).await?;
    let grounded = answered.into_iter().map(|(part, draft)| ground_notes(&part.turns(&turns), &notes, &template, draft)).collect();
    Ok(Enhanced { partial: skipped, ..merge_notes(&template, grounded) })
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
        "speakers": { "type": "array", "maxItems": 8, "items": { "type": "object", "additionalProperties": false, "required": ["speaker", "name", "at", "quote"],
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
    if !spoken(&turns) { return Err("This meeting has no recorded transcript to read names from.".into()); }
    let (metadata, _) = meetings::find(&root, &meeting_id)?;
    let invited: Vec<String> = if metadata.attendees.is_empty() { metadata.participants.clone() } else { metadata.attendees.iter().filter(|a| !a.me).map(|a| a.name.clone()).collect() };
    let invite = if invited.is_empty() { String::new() } else { format!("Invited: {}\n\n", invited.join(", ")) };
    let mut provider = Provider::open(&root, &progress(&app, &meeting_id, "suggest")).await?;
    let parts = provider.parts(&turns, NAMES_INSTRUCTIONS, &invite, NAMES_RESERVE, NAMES_LONG)?;
    let content = |t: &str| format!("{invite}Transcript:\n{t}");
    let request = Request { system: NAMES_INSTRUCTIONS, content: &content, schema: names_schema(), reserve: NAMES_RESERVE };
    let (answered, _) = each_part::<NamesDraft>(&mut provider, parts, &request, &progress(&app, &meeting_id, "suggest")).await?;
    let drafts: Vec<NamesDraft> = answered.into_iter().map(|(_, draft)| draft).collect();
    let titles: Vec<String> = drafts.iter().map(|d| d.title.trim().to_string()).filter(|t| !t.is_empty()).collect();
    let first = titles.first().cloned().unwrap_or_default();
    let title = if titles.len() > 1 { combine(&mut provider, TITLES, &titles, "title", 60).await.unwrap_or(first) } else { first };
    // One name per voice across the meeting: every part's names are checked together.
    Ok(ground_names(&turns, &invited, NamesDraft { title, speakers: drafts.into_iter().flat_map(|d| d.speakers).collect() }))
}

const ASK_INSTRUCTIONS: &str = "You answer a question about a meeting from its transcript, and from nothing else. \
Each transcript line is `[mm:ss] Speaker: text`. \"You\" is the person who recorded the meeting and is asking; the others are \
\"Others\" or \"Speaker 1\", \"Speaker 2\"… (voices told apart by sound, not by name).
Return the answer as one to five short sentences, each from one line: `at` is that line's timestamp copied exactly (for example \
\"12:04\"), `quote` three to twelve words copied word for word from it, and `text` the sentence of the answer.
Say only what the transcript says, never a guess or advice. If the transcript doesn't answer the question, return no sentences. \
Write in the language of the question.";

fn ask_schema() -> Value {
    json!({ "type": "object", "additionalProperties": false, "required": ["lines"], "properties": { "lines": { "type": "array", "maxItems": 5, "items": {
        "type": "object", "additionalProperties": false, "required": ["at", "quote", "text"],
        "properties": { "at": { "type": "string" }, "quote": { "type": "string" }, "text": { "type": "string" } } } } } })
}
#[derive(Deserialize)]
struct AnswerDraft { lines: Vec<AnswerLine> }
#[derive(Deserialize)]
struct AnswerLine { at: String, quote: String, text: String }
/// Only some of a long meeting was read: `read` of its `total` lines, those with these `words`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Partial { read: usize, total: usize, words: Vec<String> }
/// An answer about a meeting, each sentence with the transcript line it cites.
#[derive(Debug, Serialize, PartialEq)]
pub struct Answer { lines: Vec<Line>, dropped: usize, partial: Option<Partial>, unanswered: bool }

/// Words a question is about, without the ones every question has.
const COMMON: &[&str] = &["the", "and", "but", "are", "was", "were", "been", "did", "does", "what", "who", "whom", "when", "where", "why", "how",
    "which", "that", "this", "these", "those", "its", "our", "your", "their", "his", "her", "them", "there", "any", "anything", "anyone", "said",
    "say", "says", "talk", "talked", "discuss", "discussed", "meeting", "call", "from", "about", "with", "for", "not", "can", "could", "would",
    "should", "will", "have", "has", "had", "get", "got", "all", "some", "then", "than", "also", "just", "into", "out", "over", "after", "before",
    "mention", "mentioned", "tell", "know", "you", "they", "she", "him"];
/// "decided" and "decide" alike.
fn stem(word: &str) -> String { word.chars().take(5).collect() }
/// The turns about `question` that fit `budget` tokens: those sharing its words, the best first, each with
/// the turn before and after for context, in time order. `None` when no turn shares a word, or none that does fits.
fn relevant(turns: &[Turn], question: &str, budget: usize) -> Option<(Vec<usize>, Vec<String>)> {
    let mut asked: Vec<String> = words(question).into_iter().filter(|w| w.chars().count() >= 3 && !COMMON.contains(&w.as_str())).collect();
    let mut seen = HashSet::new();
    asked.retain(|w| seen.insert(w.clone()));
    let stems: Vec<String> = asked.iter().map(|w| stem(w)).collect();
    // Each spoken turn's index, its cost as a line, and the stems of its words, worked out once.
    let spoken: Vec<(usize, usize, Vec<String>)> = turns.iter().enumerate().filter_map(|(i, t)| {
        let clean = t.clean();
        (!clean.trim().is_empty()).then(|| (i, est_tokens(&format!("[{}] {}: {}", clock(t.start_ms), t.speaker, clean.trim())) + 1, words(&clean).iter().map(|w| stem(w)).collect()))
    }).collect();
    let mut scored: Vec<(usize, usize)> = spoken.iter().enumerate()
        .map(|(k, (_, _, said))| (k, said.iter().filter(|w| stems.contains(w)).count())).filter(|(_, n)| *n > 0).collect();
    if scored.is_empty() { return None; }
    scored.sort_by_key(|&(k, n)| (std::cmp::Reverse(n), k));
    let mut chosen = BTreeSet::new();
    let mut used = 0;
    let mut take = |j: usize, chosen: &mut BTreeSet<usize>| {
        if chosen.contains(&j) { return true; }
        if used + spoken[j].1 > budget { return false; }
        used += spoken[j].1;
        chosen.insert(j)
    };
    for (k, _) in scored {
        // A match's neighbours give it context, so they come only with it.
        if !take(k, &mut chosen) { continue; }
        for j in [k.checked_sub(1), Some(k + 1)].into_iter().flatten().filter(|&j| j < spoken.len()) { take(j, &mut chosen); }
    }
    if chosen.is_empty() { return None; }
    let matched: Vec<String> = asked.into_iter().filter(|w| { let w = stem(w); chosen.iter().any(|&j| spoken[j].2.contains(&w)) }).collect();
    Some((chosen.into_iter().map(|j| spoken[j].0).collect(), matched))
}
/// Keeps the sentences of an answer whose line is in `turns` and whose quote is in that line, once each.
fn ground_answer(turns: &[Turn], draft: AnswerDraft) -> (Vec<Line>, usize) {
    let (mut lines, mut dropped): (Vec<Line>, usize) = (Vec::new(), 0);
    for l in draft.lines {
        let text = l.text.trim().to_string();
        let claim = Claim { text: String::new(), owner: String::new(), at: l.at, quote: l.quote.clone() };
        match cited(turns, &claim) {
            Some(turn) if !text.is_empty() && !lines.iter().any(|k| k.text.eq_ignore_ascii_case(&text)) => lines.push(Line { text, at_ms: Some(turn.start_ms), quote: l.quote.trim().into() }),
            _ => dropped += 1,
        }
    }
    (lines, dropped)
}
/// How many turns `parts` hold lines of.
fn turns_in(parts: &[Part]) -> usize { parts.iter().flat_map(|p| p.lines.iter().map(|(i, _)| *i)).collect::<BTreeSet<_>>().len() }
/// At most this many parts are read when nothing in a long meeting shares the question's words.
const ASK_PARTS: usize = 8;
/// Answers a question about a recorded meeting with the chosen model, from its transcript only. A meeting
/// too long for the model is read where it mentions the question's words; if nothing does, in parts.
/// Writes nothing.
#[tauri::command]
pub async fn meeting_ask(app: AppHandle, meeting_id: String, question: String) -> Result<Answer, String> {
    let question = question.trim().to_string();
    if question.is_empty() { return Err("Type a question first.".into()); }
    if question.chars().count() > 500 { return Err("Ask a shorter question.".into()); }
    let (root, turns, _) = recorded(&app, &meeting_id)?;
    if !spoken(&turns) { return Err("This meeting has no recorded transcript to ask about.".into()); }
    let mut provider = Provider::open(&root, &progress(&app, &meeting_id, "ask")).await?;
    let ask = format!("Question: {question}\n\nTranscript:\n");
    let content = |t: &str| format!("{ask}{t}");
    let request = Request { system: ASK_INSTRUCTIONS, content: &content, schema: ask_schema(), reserve: ASK_RESERVE };
    let mut parts = provider.parts(&turns, ASK_INSTRUCTIONS, &ask, ASK_RESERVE, ASK_LONG)?;
    // Counted in turns (a long one may be in several pieces), as `relevant` chooses them.
    let total = turns.iter().filter(|t| line(t).is_some()).count();
    let mut partial = None;
    if parts.len() > 1 {
        let budget = provider.budget(ASK_INSTRUCTIONS, &ask, ASK_RESERVE, ASK_LONG)?.unwrap_or(usize::MAX);
        match relevant(&turns, &question, budget) {
            Some((chosen, words)) => {
                partial = Some(Partial { read: chosen.len(), total, words });
                parts = vec![Part { lines: chosen.into_iter().filter_map(|i| line(&turns[i]).map(|l| (i, l))).collect() }];
            }
            None if parts.len() > ASK_PARTS => {
                // Evenly through the meeting.
                let step = parts.len() as f64 / ASK_PARTS as f64;
                parts = (0..ASK_PARTS).map(|k| parts[(k as f64 * step) as usize].clone()).collect();
                partial = Some(Partial { read: turns_in(&parts), total, words: vec![] });
            }
            None => {}
        }
    }
    let (answered, skipped) = each_part::<AnswerDraft>(&mut provider, parts, &request, &progress(&app, &meeting_id, "ask")).await?;
    let (mut lines, mut dropped) = (Vec::new(), 0);
    let read = turns_in(&answered.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>());
    for (part, draft) in answered {
        let (kept, left) = ground_answer(&part.turns(&turns), draft);
        dropped += left;
        for line in kept { if !lines.iter().any(|l: &Line| l.text.eq_ignore_ascii_case(&line.text)) { lines.push(line); } }
    }
    if skipped && partial.is_none() { partial = Some(Partial { read, total, words: vec![] }); }
    let unanswered = lines.is_empty();
    Ok(Answer { lines, dropped, partial, unanswered })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn turn(start_ms: u64, speaker: &str, text: &str) -> Turn {
        Turn { start_ms, end_ms: start_ms + 5000, speaker: speaker.into(), text: text.into(), removed: vec![], breaks: vec![], hidden: vec![] }
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
        let s = ground(&meeting(), &meeting(), draft);
        assert_eq!(s.summary, "Pricing was settled.");
        assert_eq!(s.actions.iter().map(|a| (a.text.as_str(), a.owner.as_str(), a.at_ms)).collect::<Vec<_>>(), [("Send the pricing draft by Friday", "Maya", 0), ("Update the landing page", "You", 65_000), ("Follow up", "", 3_725_000)]);
        assert_eq!(s.dropped, 2);
    }
    #[test]
    fn drops_duplicates_and_empty_text() {
        let draft = Draft { summary: String::new(), actions: vec![claim("Annual plan", "", "01:05", "annual plan"), claim("annual plan", "", "01:05", "annual plan"), claim(" ", "", "01:05", "annual plan")] };
        let s = ground(&meeting(), &meeting(), draft);
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
        assert!(matches!(anthropic_text(&json!({ "stop_reason": "refusal", "content": [] })), Err(Failure::Declined(m)) if m.contains("declined")));
        assert!(matches!(anthropic_text(&json!({ "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "{" }] })), Err(Failure::Failed(m)) if m.contains("cut off")));
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
    fn a_request_too_long_for_ollama_is_asked_in_parts() {
        assert_eq!(ollama_context(100).unwrap(), 8192);
        assert_eq!(ollama_context(20_000).unwrap(), 20_000);
        assert_eq!(ollama_context(40_000), Err(Failure::TooLong));
    }
    #[test]
    fn schema_requires_every_field() {
        let s = schema();
        assert_eq!(s["properties"]["actions"]["items"]["required"], json!(["text", "owner", "at", "quote"]));
        assert_eq!(s["properties"]["actions"]["items"]["additionalProperties"], json!(false));
        assert_eq!(s["required"], json!(["summary", "actions"]));
    }
    /// The Apple Intelligence helper converts these keywords and no others (`swift/quietnote-ai.swift`),
    /// and generates properties in the order `required` lists them.
    #[test]
    fn claude_gets_its_schemas_without_list_limits() {
        assert!(!unbounded(ask_schema()).to_string().contains("maxItems"));
        assert_eq!(unbounded(ask_schema())["properties"]["lines"]["items"]["required"], json!(["at", "quote", "text"]));
        assert!(schema().to_string().contains("maxItems"));
    }
    #[test]
    fn schemas_use_only_what_the_apple_helper_reads() {
        fn check(node: &Value) {
            let object = node.as_object().unwrap();
            for key in object.keys() {
                assert!(["type", "properties", "required", "additionalProperties", "items", "enum", "description", "maxItems"].contains(&key.as_str()), "{key}");
            }
            if node["type"] == "object" { assert_eq!(node["required"].as_array().unwrap().len(), node["properties"].as_object().unwrap().len()); }
            for child in object.get("properties").and_then(Value::as_object).into_iter().flat_map(|p| p.values()).chain(node.get("items")) { check(child); }
        }
        for s in [schema(), notes_schema(), names_schema(), ask_schema()] { check(&s); }
    }
    fn talk(n: usize) -> Vec<Turn> {
        (0..n).map(|i| turn(i as u64 * 10_000, if i % 2 == 0 { "You" } else { "Others" }, &format!("Line {i} is about the pricing plan and the launch date we settled."))).collect()
    }
    #[test]
    fn a_long_meeting_is_read_in_parts_that_keep_every_line_once() {
        let turns = talk(60);
        let parts = parts(&turns, 200);
        assert!(parts.len() > 5);
        assert!(parts.iter().all(|p| est_tokens(&p.text()) <= 200));
        let lines: Vec<String> = parts.iter().flat_map(|p| p.lines.iter().map(|(_, l)| l.clone())).collect();
        assert_eq!(lines.join("\n"), super::lines(&turns));
        assert_eq!(parts[1].turns(&turns)[0].start_ms, parts[1].lines[0].0 as u64 * 10_000);
        // One very long turn is split at its sentences, each piece under the turn's own time.
        let long = turn(65_000, "Others", &"We need to finish the pricing review before the launch. ".repeat(40));
        let pieces = pieces(&long, line(&long).unwrap(), 120);
        assert!(pieces.len() > 3 && pieces.iter().all(|p| p.starts_with("[01:05] Others: We need") && est_tokens(p) <= 120));
        assert_eq!(pieces.iter().map(|p| p.trim_start_matches("[01:05] Others: ")).collect::<Vec<_>>().join(" "), long.text.trim());
        // A part with one line can't be halved.
        assert!(Part { lines: vec![(0, "x".into())] }.halves().is_none());
    }
    /// Answers each request from a list, recording what it was asked.
    struct Script { answers: VecDeque<Result<String, Failure>>, asked: Vec<String> }
    impl Respond for Script {
        async fn respond(&mut self, _: &str, content: &str, _: &Value, _: usize) -> Result<String, Failure> {
            self.asked.push(content.to_string());
            self.answers.pop_front().unwrap_or(Ok("{}".into()))
        }
    }
    #[test]
    fn a_part_too_long_is_halved_and_one_declined_is_skipped() {
        let turns = talk(8);
        let parts = parts(&turns, 1000);
        assert_eq!(parts.len(), 1);
        let mut script = Script { answers: VecDeque::from([Err(Failure::TooLong), Ok("{}".into()), Err(Failure::Declined("no".into()))]), asked: vec![] };
        let request = Request { system: "", content: &|t| t.to_string(), schema: json!({}), reserve: 0 };
        let seen = std::sync::Mutex::new(Vec::new());
        let (answered, skipped) = tauri::async_runtime::block_on(each_part::<Value>(&mut script, parts, &request, &|d, t| seen.lock().unwrap().push((d, t)))).unwrap();
        assert_eq!((answered.len(), skipped), (1, true));
        assert_eq!(answered[0].0.lines.len(), 4);
        assert_eq!(script.asked.len(), 3);
        assert_eq!(*seen.lock().unwrap(), [(1, 2), (2, 2)]);
        let mut failing = Script { answers: VecDeque::from([Err(Failure::Failed("down".into()))]), asked: vec![] };
        assert_eq!(tauri::async_runtime::block_on(each_part::<Value>(&mut failing, super::parts(&turns, 1000), &request, &|_, _| {})).unwrap_err(), "down");
        let mut declining = Script { answers: VecDeque::from([Err(Failure::Declined("no".into()))]), asked: vec![] };
        assert!(tauri::async_runtime::block_on(each_part::<Value>(&mut declining, super::parts(&turns, 1000), &request, &|_, _| {})).unwrap_err().contains("declined"));
        // An answer that can't be read loses only its own part; if every one is unreadable, it says so.
        let mut garbling = Script { answers: VecDeque::from([Ok("not json".into()), Ok("{}".into())]), asked: vec![] };
        let (answered, skipped) = tauri::async_runtime::block_on(each_part::<Value>(&mut garbling, super::parts(&turns, 40), &request, &|_, _| {})).unwrap();
        assert!(skipped && !answered.is_empty() && garbling.asked.len() > answered.len());
        let mut garbled = Script { answers: VecDeque::from([Ok("not json".into())]), asked: vec![] };
        assert_eq!(tauri::async_runtime::block_on(each_part::<Value>(&mut garbled, super::parts(&turns, 1000), &request, &|_, _| {})).unwrap_err(), UNREADABLE);
    }
    #[test]
    fn each_part_is_grounded_against_its_own_lines_then_combined_once() {
        let turns = meeting();
        let first = Part { lines: vec![(0, line(&turns[0]).unwrap())] };
        let second = Part { lines: vec![(1, line(&turns[1]).unwrap()), (2, line(&turns[2]).unwrap())] };
        // The second part's model cites the first part's line: it never read it, so it's dropped there.
        let a = ground(&first.turns(&turns), &turns, Draft { summary: "Maya sends a draft.".into(), actions: vec![claim("Send the pricing draft", "Maya", "00:00", "Maya will send the pricing draft")] });
        let b = ground(&second.turns(&turns), &turns, Draft { summary: "Annual plan.".into(), actions: vec![
            claim("Send the pricing draft", "Maya", "00:00", "Maya will send the pricing draft"),
            claim("send the pricing draft", "", "01:05", "update the landing page"),
            claim("Update the landing page", "You", "01:05", "I'll update the landing page"),
        ] });
        assert_eq!((a.dropped, b.dropped), (0, 1));
        let (summaries, merged) = merge_suggestions(vec![a, b]);
        assert_eq!(summaries, ["Maya sends a draft.", "Annual plan."]);
        assert_eq!(merged.actions.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["Send the pricing draft", "Update the landing page"]);
        // Only b's untraced claim is left out: a copy another part also found isn't.
        assert_eq!(merged.dropped, 1);
        // An owner named in another part is kept.
        let c = ground(&second.turns(&turns), &turns, Draft { summary: String::new(), actions: vec![claim("Go with the annual plan", "Maya", "01:05", "we go with the annual plan")] });
        assert_eq!(c.actions[0].owner, "Maya");
        // Enhanced notes: the template's order, a line once, and a point from the notes once however many parts quote it.
        let template = crate::templates::parse("# Sync\n## Overview\n## Next steps\n", "Sync").unwrap();
        let line = |text: &str, at_ms: Option<u64>, quote: &str| Line { text: text.into(), at_ms, quote: quote.into() };
        let notes = merge_notes(&template, vec![
            Enhanced { sections: vec![NoteSection { heading: "Next steps".into(), lines: vec![line("Maya sends the draft.", None, "Maya pricing draft")] }], dropped: 1, partial: false },
            Enhanced { sections: vec![
                NoteSection { heading: "Overview".into(), lines: vec![line("Annual plan.", Some(65_000), "annual plan")] },
                NoteSection { heading: "Next steps".into(), lines: vec![line("Maya will send the pricing draft.", None, "Maya, pricing draft!"), line("Landing page.", Some(65_000), "landing page")] },
            ], dropped: 0, partial: false },
        ]);
        assert_eq!(notes.sections.iter().map(|s| (s.heading.as_str(), s.lines.len())).collect::<Vec<_>>(), [("Overview", 1), ("Next steps", 2)]);
        assert_eq!(notes.dropped, 1);
    }
    #[test]
    fn a_question_reads_the_lines_that_mention_it_with_their_neighbours() {
        let mut turns = talk(30);
        turns[12].text = "The budget for Q3 is still open.".into();
        turns[20].text = "We decided the budget stays at forty thousand.".into();
        let (chosen, matched) = relevant(&turns, "What did we decide about the budget?", 2000).unwrap();
        assert_eq!(chosen, [11, 12, 13, 19, 20, 21]);
        assert_eq!(matched, ["decide", "budget"]);
        // The best match first when not everything fits.
        let (few, _) = relevant(&turns, "What did we decide about the budget?", 25).unwrap();
        assert_eq!(few, [20]);
        // Only common words, or words nobody said: nothing to go on.
        assert!(relevant(&turns, "What was said in the meeting?", 2000).is_none());
        assert!(relevant(&turns, "Any word on hiring?", 2000).is_none());
        // A word asked twice is listed once; a match too long for the budget is no match.
        assert_eq!(relevant(&turns, "What budget did we decide, and is the budget final?", 2000).unwrap().1, ["budget", "decide"]);
        assert!(relevant(&turns, "What did we decide about the budget?", 5).is_none());
        // A match too long to fit doesn't bring its neighbours: they'd say nothing about the question.
        turns[20].text = "The budget, the budget and the budget again. ".repeat(30);
        assert_eq!(relevant(&turns, "What about the budget?", 100).unwrap().0, [11, 12, 13]);
    }
    #[test]
    fn an_answer_keeps_only_sentences_that_cite_the_transcript() {
        let a = |at: &str, quote: &str, text: &str| AnswerLine { at: at.into(), quote: quote.into(), text: text.into() };
        let (lines, dropped) = ground_answer(&meeting(), AnswerDraft { lines: vec![
            a("00:00", "Maya will send the pricing draft", "Maya sends the pricing draft by Friday."),
            a("01:05", "we go with the annual plan", "They chose the annual plan."),
            a("01:05", "we launch next week", "Launch is next week."),
            a("00:00", "Maya will send", "maya sends the pricing draft by friday."),
            a("00:00", "Maya will send", " "),
            // The right words a line off on the time: cited where they really are, within a minute only.
            a("01:10", "I'll update the landing page", "You'll update the landing page."),
            a("1:01:00", "Sounds good", "Everyone agreed."),
        ] });
        assert_eq!(lines.iter().map(|l| (l.text.as_str(), l.at_ms)).collect::<Vec<_>>(), [("Maya sends the pricing draft by Friday.", Some(0)), ("They chose the annual plan.", Some(65_000)), ("You'll update the landing page.", Some(65_000))]);
        assert_eq!(dropped, 4);
        assert_eq!((at_ms("01:05"), at_ms("1:02:05"), at_ms("soon")), (Some(65_000), Some(3_725_000), None));
    }
    /// The real Apple Intelligence over a made-up 25-minute meeting, in parts:
    /// `QUIETNOTE_AI_HELPER=target/debug/quietnote-ai cargo test apple_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn apple_live() {
        let said = ["We need the pricing page live before the launch on the twelfth.", "Maya, can you send the new pricing draft by Friday?",
            "Sure, I'll send it Friday morning.", "The annual plan stays at forty dollars a month.", "I'll update the landing page once the draft is in.",
            "Legal still has to review the terms, that's the blocker.", "Tom will chase legal this week.", "Okay, and support needs the FAQ updated too."];
        let turns: Vec<Turn> = (0..150).map(|i| turn(i as u64 * 10_000, if i % 3 == 0 { "You" } else { "Speaker 1" }, said[i % said.len()])).collect();
        tauri::async_runtime::block_on(async {
            let mut provider = Provider::Apple(Box::new(apple::Session::open(|| {}).await.expect("Apple Intelligence")));
            let started = std::time::Instant::now();
            let parts = provider.parts(&turns, INSTRUCTIONS, "", SUGGEST_RESERVE, SUGGEST_LONG).unwrap();
            println!("{} parts", parts.len());
            let request = Request { system: INSTRUCTIONS, content: &|t| t.to_string(), schema: schema(), reserve: SUGGEST_RESERVE };
            let (answered, skipped) = each_part::<Draft>(&mut provider, parts, &request, &|d, t| println!("part {d} of {t} at {:?}", started.elapsed())).await.unwrap();
            let grounded: Vec<Suggestions> = answered.into_iter().map(|(part, draft)| ground(&part.turns(&turns), &turns, draft)).collect();
            let (summaries, merged) = merge_suggestions(grounded);
            let summary = combine(&mut provider, SUMMARIES, &summaries, "summary", 300).await;
            println!("suggest: {:?}, skipped {skipped}\nsummary: {summary:?}\nactions: {:#?}\ndropped {}", started.elapsed(), merged.actions, merged.dropped);
            let started = std::time::Instant::now();
            let ask = "Question: Who is chasing legal?\n\nTranscript:\n";
            let budget = provider.budget(ASK_INSTRUCTIONS, ask, ASK_RESERVE, ASK_LONG).unwrap().unwrap();
            let (chosen, words) = relevant(&turns, "Who is chasing legal?", budget).unwrap();
            let part = Part { lines: chosen.into_iter().filter_map(|i| line(&turns[i]).map(|l| (i, l))).collect() };
            let json = provider.respond(ASK_INSTRUCTIONS, &format!("{ask}{}", part.text()), &ask_schema(), ASK_RESERVE).await.unwrap();
            println!("ask: {:?}, read {} lines with {words:?}: {json}\n{:?}", started.elapsed(), part.lines.len(), ground_answer(&part.turns(&turns), read(&json).unwrap()));
        });
    }
}
