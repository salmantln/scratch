//! Apple Intelligence as a summary provider: Apple's model on this Mac, through the `quietnote-ai` helper
//! (`swift/quietnote-ai.swift`, built by build.rs and bundled next to the app), since FoundationModels is
//! Swift only. Nothing leaves the Mac. The helper reads one JSON request per line and answers each with one
//! line. Where it isn't there (other platforms, `cargo test`) Apple Intelligence is simply unavailable.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// What the helper says about the model on this Mac.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This copy was built with Apple Intelligence (an SDK with FoundationModels).
    #[serde(default)]
    pub built: bool,
    #[serde(default)]
    pub available: bool,
    /// Why it isn't available: osTooOld, deviceNotEligible, appleIntelligenceNotEnabled, modelNotReady, notBuilt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Tokens the model reads at once, prompt and answer together.
    #[serde(default)]
    pub context_size: usize,
}
impl Status {
    fn missing() -> Status { Status { reason: Some("notBuilt".into()), ..Default::default() } }
}

/// Why a request got no answer, as the code asking needs to know: too long (ask with less), declined
/// (skip this part), or failed (stop).
#[derive(Debug, PartialEq)]
pub enum Failure { TooLong, Declined(String), Failed(String) }

fn helper() -> Option<PathBuf> {
    // The live tests (`apple_live`) point at the built helper; tests never find it otherwise.
    #[cfg(test)]
    if let Ok(path) = std::env::var("QUIETNOTE_AI_HELPER") { return Some(path.into()); }
    let path = std::env::current_exe().ok()?.canonicalize().ok()?.with_file_name("quietnote-ai");
    path.is_file().then_some(path)
}
fn spawn() -> Option<Child> {
    Command::new(helper()?).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().ok()
}

/// The model's state on this Mac. Runs its own helper, so it never waits for a request in progress.
pub async fn status() -> Status {
    let Some(child) = spawn() else { return Status::missing() };
    let Some(mut io) = Io::new(child) else { return Status::missing() };
    match io.send(&json!({ "op": "status" }), Duration::from_secs(15)).await {
        Ok(reply) => parse_status(reply),
        Err(_) => Status::missing(),
    }
}
fn parse_status(reply: Value) -> Status { serde_json::from_value(reply).unwrap_or_else(|_| Status::missing()) }

/// One request and its line of answer.
struct Io { _child: Child, stdin: ChildStdin, stdout: Lines<BufReader<ChildStdout>> }
impl Io {
    fn new(mut child: Child) -> Option<Io> {
        let (stdin, stdout) = (child.stdin.take()?, child.stdout.take()?);
        Some(Io { _child: child, stdin, stdout: BufReader::new(stdout).lines() })
    }
    async fn send(&mut self, request: &Value, timeout: Duration) -> Result<Value, String> {
        let line = format!("{request}\n");
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;
        let answer = tokio::time::timeout(timeout, self.stdout.next_line()).await
            .map_err(|_| "Apple Intelligence took too long to answer.".to_string())?.map_err(|e| e.to_string())?
            .ok_or("Apple Intelligence stopped unexpectedly.")?;
        serde_json::from_str(&answer).map_err(|e| e.to_string())
    }
}

/// Apple Intelligence requests are one at a time across the app: the model answers one at a time anyway.
static GATE: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));

/// A helper kept for one command's requests, so the model loads once however many parts a meeting has.
pub struct Session { io: Io, pub context: usize, _turn: OwnedSemaphorePermit }
impl Session {
    /// `waiting` is called when another command has the model, before waiting for it.
    pub async fn open(waiting: impl FnOnce()) -> Result<Session, String> {
        let turn = match GATE.clone().try_acquire_owned() {
            Ok(turn) => turn,
            Err(_) => { waiting(); GATE.clone().acquire_owned().await.map_err(|e| e.to_string())? }
        };
        let mut io = spawn().and_then(Io::new).ok_or_else(|| unavailable(&Status::missing()))?;
        let status = parse_status(io.send(&json!({ "op": "status" }), Duration::from_secs(15)).await?);
        if !status.available { return Err(unavailable(&status)); }
        Ok(Session { io, context: status.context_size.max(1024), _turn: turn })
    }
    /// Answers `prompt` under `instructions` with JSON matching `schema`, in at most `reserve` tokens. A busy
    /// model is tried again a few times.
    pub async fn respond(&mut self, instructions: &str, prompt: &str, schema: &Value, reserve: usize) -> Result<String, Failure> {
        let request = json!({ "op": "respond", "instructions": instructions, "prompt": prompt, "schema": schema, "maxTokens": reserve });
        for wait in [2, 4, 8, 0] {
            let reply = self.io.send(&request, Duration::from_secs(240)).await.map_err(Failure::Failed)?;
            if reply["error"] != "busy" || wait == 0 { return parse_reply(&reply); }
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
        unreachable!("the last try returns")
    }
}
fn parse_reply(reply: &Value) -> Result<String, Failure> {
    if reply["ok"] == true { return reply["json"].as_str().map(String::from).ok_or_else(|| Failure::Failed("Apple Intelligence didn’t return an answer.".into())); }
    let message = reply["message"].as_str().unwrap_or("Apple Intelligence couldn’t answer.").to_string();
    match reply["error"].as_str() {
        Some("tooLong") => Err(Failure::TooLong),
        Some("guardrail" | "refusal") => Err(Failure::Declined(message)),
        _ => Err(Failure::Failed(message)),
    }
}
/// Why Apple Intelligence can't be used, as the user can act on it.
pub fn unavailable(status: &Status) -> String {
    match status.reason.as_deref() {
        Some("appleIntelligenceNotEnabled") => "Turn on Apple Intelligence in System Settings → Apple Intelligence & Siri first.",
        Some("modelNotReady") => "Apple Intelligence is still downloading on this Mac. Try again later.",
        Some("deviceNotEligible") => "This Mac can’t run Apple Intelligence. Choose Claude or Ollama in Settings → Suggestions.",
        Some("osTooOld") => "Apple Intelligence needs macOS 26 or later.",
        _ => "This copy of QuietNote can’t use Apple Intelligence.",
    }.into()
}

/// Whether Apple Intelligence can draft suggestions on this Mac, and if not, why.
#[tauri::command]
pub async fn summary_apple_status() -> Status { status().await }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_the_helpers_answers() {
        assert_eq!(parse_reply(&json!({ "ok": true, "json": "{}" })), Ok("{}".into()));
        assert_eq!(parse_reply(&json!({ "ok": false, "error": "tooLong", "message": "", "tokens": 5000 })), Err(Failure::TooLong));
        assert_eq!(parse_reply(&json!({ "ok": false, "error": "guardrail", "message": "Declined." })), Err(Failure::Declined("Declined.".into())));
        assert_eq!(parse_reply(&json!({ "ok": false, "error": "language", "message": "No." })), Err(Failure::Failed("No.".into())));
        assert_eq!(parse_reply(&json!({ "ok": true })), Err(Failure::Failed("Apple Intelligence didn’t return an answer.".into())));
        let ready = parse_status(json!({ "built": true, "available": true, "contextSize": 4096 }));
        assert_eq!((ready.available, ready.context_size, ready.reason), (true, 4096, None));
        assert_eq!(parse_status(json!("nonsense")), Status::missing());
        assert!(unavailable(&parse_status(json!({ "built": true, "reason": "appleIntelligenceNotEnabled" }))).contains("Turn on Apple Intelligence"));
    }
    #[test]
    fn the_helper_is_missing_in_tests_so_nothing_runs() {
        assert!(helper().is_none());
        assert_eq!(tauri::async_runtime::block_on(status()), Status::missing());
    }
    /// The helper uses Apple's model on this Mac, never Private Cloud Compute: that would send the
    /// transcript off the Mac.
    #[test]
    fn the_helper_never_leaves_the_mac() {
        let source = include_str!("../swift/quietnote-ai.swift");
        assert!(!source.contains("PrivateCloudCompute"));
        assert!(source.contains("SystemLanguageModel.default"));
    }
}
