//! `quietnote` on the command line: reads the meeting archive straight from disk and prints it. It
//! never writes, never needs the app to be running, and runs in place of the app when the first
//! argument is one of its commands (`main.rs`), so the app's own binary is the tool.
use crate::meetings::{self, Metadata};
use crate::transcript::{self, Transcript};
use std::path::{Path, PathBuf};

const HELP: &str = "Read your QuietNote meetings from the terminal. Nothing is changed.

Usage:
  quietnote meetings [--project NAME] [--limit N] [--json]   List meetings, newest first
  quietnote show MEETING [--json]                            Print a meeting's notes (meeting.md)
  quietnote transcript MEETING [--verbatim]                  Print a meeting's transcript
  quietnote search WORDS… [--limit N]                        Find meetings that mention all the words
  quietnote projects                                         List projects
  quietnote mcp                                              Serve the archive to AI apps (MCP over stdio, read-only)
  quietnote help                                             Show this help

MEETING is a meeting's id, a unique part of it (as `meetings` shows), or a unique part of its title.
The archive is read from QuietNote's app data folder, or QUIETNOTE_ARCHIVE if set.";

const COMMANDS: [&str; 8] = ["meetings", "show", "transcript", "search", "projects", "mcp", "help", "--help"];

/// Runs a command and returns its exit code, or `None` when the arguments aren't a command (the app starts).
pub fn run(args: &[String]) -> Option<i32> {
    let command = args.get(1)?;
    if !COMMANDS.contains(&command.as_str()) { return None; }
    // A conversation on stdin and stdout rather than one answer.
    if command == "mcp" { return Some(crate::mcp::serve()); }
    let mut out = String::new();
    let code = match execute(command, &args[2..], &mut out) {
        Ok(()) => { print!("{out}"); 0 }
        Err(Usage(message)) => { eprintln!("quietnote: {message}\n\n{HELP}"); 2 }
        Err(Failed(message)) => { eprintln!("quietnote: {message}"); 1 }
    };
    Some(code)
}

#[derive(Debug, PartialEq)]
pub(crate) enum Error { Usage(String), Failed(String) }
use Error::{Failed, Usage};

/// The archive folder: where the app keeps it (Tauri's app data folder for its identifier).
pub(crate) fn archive() -> Result<PathBuf, Error> {
    let root = match std::env::var_os("QUIETNOTE_ARCHIVE") { Some(path) => PathBuf::from(path), None => default_archive()? };
    if !root.is_dir() { return Err(Failed(format!("There’s no QuietNote archive at {}. Open QuietNote once to create it.", root.display()))); }
    // The archive's own checks compare canonical paths.
    root.canonicalize().map_err(|e| Failed(format!("Couldn’t open {}: {e}", root.display())))
}
fn default_archive() -> Result<PathBuf, Error> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data = if cfg!(target_os = "macos") { home.map(|h| h.join("Library/Application Support")) }
        else if cfg!(windows) { std::env::var_os("APPDATA").map(PathBuf::from) }
        else { std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".local/share"))) };
    Ok(data.ok_or_else(|| Failed("Couldn’t find your home folder.".into()))?.join("app.quietnote.desktop/meetings"))
}

/// Options after the command: flags with a value, switches, and the rest as words.
#[derive(Default)]
pub(crate) struct Options { pub words: Vec<String>, pub project: Option<String>, pub limit: Option<usize>, pub json: bool, pub verbatim: bool }
fn options(args: &[String]) -> Result<Options, Error> {
    let mut o = Options { words: Vec::new(), project: None, limit: None, json: false, verbatim: false };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = |flag: &str| args.next().cloned().ok_or_else(|| Usage(format!("{flag} needs a value.")));
        match arg.as_str() {
            "--project" => o.project = Some(value("--project")?),
            "--limit" => o.limit = Some(value("--limit")?.parse().map_err(|_| Usage("--limit needs a number.".into()))?),
            "--json" => o.json = true,
            "--verbatim" => o.verbatim = true,
            flag if flag.starts_with("--") => return Err(Usage(format!("Unknown option {flag}."))),
            word => o.words.push(word.into()),
        }
    }
    Ok(o)
}

fn execute(command: &str, args: &[String], out: &mut String) -> Result<(), Error> {
    if matches!(command, "help" | "--help") { out.push_str(HELP); out.push('\n'); return Ok(()); }
    let o = options(args)?;
    let root = archive()?;
    match command {
        "projects" => { for project in projects(&root)? { out.push_str(&project); out.push('\n'); } Ok(()) }
        "meetings" => list(&root, &o, out),
        "show" => show(&root, &o, out),
        "transcript" => print_transcript(&root, &o, out),
        "search" => search(&root, &o, out),
        _ => Err(Usage(format!("Unknown command {command}."))),
    }
}

pub(crate) fn projects(root: &Path) -> Result<Vec<String>, Error> {
    let mut projects: Vec<String> = std::fs::read_dir(root).map_err(|e| Failed(e.to_string()))?.flatten()
        .filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).filter(|n| !n.starts_with('.')).collect();
    projects.sort_by_key(|p| p.to_lowercase());
    Ok(projects)
}
/// Every meeting, newest first.
fn all(root: &Path) -> Result<Vec<(Metadata, PathBuf)>, Error> {
    let mut meetings = meetings::read_metadata(root).map_err(Failed)?;
    meetings.sort_by(|(a, _), (b, _)| (&b.date, &b.capture_started_at).cmp(&(&a.date, &a.capture_started_at)));
    Ok(meetings)
}
/// The part of an id people type: after its date, the first block (`2026-09-29-43602b8f-…` → `43602b8f`).
fn short(id: &str) -> &str {
    let dated = id.len() > 11 && id.as_bytes()[10] == b'-' && chrono::NaiveDate::parse_from_str(&id[..10], "%Y-%m-%d").is_ok();
    if dated { id[11..].split('-').next().unwrap_or(id) } else { id }
}
fn find(root: &Path, query: &[String]) -> Result<(Metadata, PathBuf), Error> {
    let query = query.join(" ");
    if query.is_empty() { return Err(Usage("Which meeting? Give its id or part of its title.".into())); }
    let meetings = all(root)?;
    if let Some(exact) = meetings.iter().find(|(m, _)| m.id == query) { return Ok(exact.clone()); }
    let needle = query.to_lowercase();
    let matches: Vec<_> = meetings.into_iter().filter(|(m, _)| m.id.contains(&query) || m.title.to_lowercase().contains(&needle)).collect();
    match matches.len() {
        1 => Ok(matches.into_iter().next().expect("one match")),
        0 => Err(Failed(format!("No meeting matches “{query}”."))),
        n => Err(Failed(format!("{n} meetings match “{query}”:\n{}", matches.iter().map(|(m, _)| row(m)).collect::<Vec<_>>().join("\n")))),
    }
}
fn duration(seconds: u64) -> String {
    match seconds { 0 => String::new(), s if s < 60 => format!("{s}s"), s if s < 3600 => format!("{}m", s / 60), s => format!("{}h{:02}m", s / 3600, s / 60 % 60) }
}
/// Local time of day the recording started, if it was recorded.
fn time(metadata: &Metadata) -> String {
    metadata.capture_started_at.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default()
}
fn row(m: &Metadata) -> String {
    let title: String = if m.title.chars().count() > 44 { format!("{}…", m.title.chars().take(43).collect::<String>()) } else { m.title.clone() };
    let status = if matches!(m.status.as_str(), "idle" | "ready") { "" } else { m.status.as_str() };
    format!("{}  {:>5}  {:>6}  {:<14}  {:<44}  {:<10}  {}", m.date.get(..10).unwrap_or(&m.date), time(m), duration(m.duration), m.project, title, status, short(&m.id)).trim_end().to_string()
}
pub(crate) fn list(root: &Path, o: &Options, out: &mut String) -> Result<(), Error> {
    let mut meetings = all(root)?;
    if let Some(project) = &o.project { meetings.retain(|(m, _)| m.project.eq_ignore_ascii_case(project)); }
    meetings.truncate(o.limit.unwrap_or(usize::MAX));
    if o.json {
        let metadata: Vec<&Metadata> = meetings.iter().map(|(m, _)| m).collect();
        out.push_str(&serde_json::to_string_pretty(&metadata).map_err(|e| Failed(e.to_string()))?);
        out.push('\n');
        return Ok(());
    }
    if meetings.is_empty() { out.push_str("No meetings yet.\n"); }
    for (m, _) in &meetings { out.push_str(&row(m)); out.push('\n'); }
    Ok(())
}
fn read(path: &Path) -> Result<String, Error> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(Failed(format!("Couldn’t read {}: {e}", path.display()))),
    }
}
pub(crate) fn show(root: &Path, o: &Options, out: &mut String) -> Result<(), Error> {
    let (metadata, dir) = find(root, &o.words)?;
    let markdown = read(&dir.join("meeting.md"))?;
    if o.json {
        let value = serde_json::json!({ "metadata": metadata, "markdown": markdown, "transcript": read(&dir.join("transcript.md"))? });
        out.push_str(&serde_json::to_string_pretty(&value).map_err(|e| Failed(e.to_string()))?);
        out.push('\n');
    } else {
        out.push_str(&markdown);
        if !markdown.ends_with('\n') { out.push('\n'); }
    }
    Ok(())
}
/// The transcript as the app shows it: `transcript.md`, or the words as recognized with `--verbatim`.
pub(crate) fn print_transcript(root: &Path, o: &Options, out: &mut String) -> Result<(), Error> {
    let (metadata, dir) = find(root, &o.words)?;
    let text = if o.verbatim {
        let bytes = std::fs::read(dir.join("transcript.json")).map_err(|_| Failed(format!("“{}” has no recorded transcript, so there’s no verbatim version.", metadata.title)))?;
        let recorded: Transcript = serde_json::from_slice(&bytes).map_err(|e| Failed(format!("The transcript of “{}” couldn’t be read: {e}", metadata.title)))?;
        transcript::markdown(&recorded, false)
    } else { read(&dir.join("transcript.md"))? };
    if text.trim().is_empty() { return Err(Failed(format!("“{}” has no transcript yet.", metadata.title))); }
    out.push_str(&text);
    if !text.ends_with('\n') { out.push('\n'); }
    Ok(())
}
/// Meetings whose title, notes or transcript contain every word, with the first matching line.
pub(crate) fn search(root: &Path, o: &Options, out: &mut String) -> Result<(), Error> {
    let words: Vec<String> = o.words.iter().map(|w| w.to_lowercase()).collect();
    if words.is_empty() { return Err(Usage("Search for what?".into())); }
    let mut found = 0;
    for (m, dir) in all(root)? {
        if o.limit.is_some_and(|limit| found >= limit) { break; }
        let text = format!("{}\n{}\n{}", m.title, read(&dir.join("meeting.md"))?, read(&dir.join("transcript.md"))?);
        let lower = text.to_lowercase();
        if !words.iter().all(|w| lower.contains(w)) { continue; }
        found += 1;
        out.push_str(&row(&m));
        out.push('\n');
        if let Some(line) = text.lines().find(|l| !l.starts_with('#') && words.iter().any(|w| l.to_lowercase().contains(w))) {
            let line = line.trim();
            let line: String = if line.chars().count() > 120 { format!("{}…", line.chars().take(119).collect::<String>()) } else { line.into() };
            out.push_str(&format!("    {line}\n"));
        }
    }
    if found == 0 { out.push_str("No meetings mention that.\n"); }
    Ok(())
}

/// For Settings: the Terminal command that makes `quietnote` available everywhere, as a link to this
/// app's own binary (as VS Code does for `code`). It needs the user's password, so the user runs it.
#[tauri::command]
pub fn cli_setup_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let quoted = format!("'{}'", exe.display().to_string().replace('\'', "'\\''"));
    Ok(format!("sudo mkdir -p /usr/local/bin && sudo ln -sf {quoted} /usr/local/bin/quietnote"))
}

/// For Settings: the MCP client configuration that runs this app's binary as `quietnote mcp`, for Claude
/// Desktop, Claude Code or another app to read the archive.
#[tauri::command]
pub fn mcp_config() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let config = serde_json::json!({ "mcpServers": { "quietnote": { "command": exe.to_string_lossy(), "args": ["mcp"] } } });
    serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    /// A small archive of three meetings in two projects, for tests of what reads it.
    pub(crate) fn archive(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("quietnote-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (project, id, title, date, notes) in [
            ("Acme", "2026-09-29-43602b8f-45f4-4e9d", "Weekly sync", "2026-09-29", "## Notes\nRetention is up."),
            ("Acme", "2026-10-02-ac7515bc-aac7-48a4", "Pricing review", "2026-10-02", "## Notes\nTest the annual plan."),
            ("Personal", "2026-10-01-25e4c2fc-9810-4280", "Dentist call", "2026-10-01", "## Notes\nTuesday 9:00."),
        ] {
            let dir = root.join(project).join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let metadata = serde_json::json!({"id":id,"title":title,"date":date,"duration":1500,"project":project,"participants":[],"status":"ready","captureStartedAt":null,"captureEndedAt":null,"audioPath":null,"transcriptPath":format!("{project}/{id}/transcript.md"),"meetingPath":format!("{project}/{id}/meeting.md"),"tags":[]});
            std::fs::write(dir.join("metadata.json"), metadata.to_string()).unwrap();
            std::fs::write(dir.join("meeting.md"), format!("# {title}\n\n{notes}\n")).unwrap();
            std::fs::write(dir.join("transcript.md"), "# Transcript\n\n### 00:00 Others\nShall we test the annual plan first?\n").unwrap();
        }
        let id = "2026-10-02-ac7515bc-aac7-48a4";
        let turns = vec![transcript::Turn { start_ms: 0, end_ms: 1000, speaker: "You".into(), text: "Um, ship it.".into(), removed: vec![[0, 4]], breaks: vec![] }];
        let recorded = Transcript { version: 1, model: "test".into(), turns, echo: vec![] };
        std::fs::write(root.join("Acme").join(id).join("transcript.json"), serde_json::to_vec(&recorded).unwrap()).unwrap();
        root.canonicalize().unwrap()
    }
    fn exec(root: &Path, args: &[&str]) -> Result<String, Error> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let o = options(&args[1..])?;
        let mut out = String::new();
        match args[0].as_str() {
            "meetings" => list(root, &o, &mut out),
            "show" => show(root, &o, &mut out),
            "transcript" => print_transcript(root, &o, &mut out),
            "search" => search(root, &o, &mut out),
            _ => unreachable!(),
        }?;
        Ok(out)
    }
    #[test]
    fn lists_meetings_newest_first_and_filters_by_project() {
        let root = archive("list");
        let all = exec(&root, &["meetings"]).unwrap();
        let titles: Vec<&str> = all.lines().map(|l| if l.contains("Pricing") { "Pricing" } else if l.contains("Dentist") { "Dentist" } else { "Weekly" }).collect();
        assert_eq!(titles, ["Pricing", "Dentist", "Weekly"]);
        assert!(all.lines().next().unwrap().starts_with("2026-10-02") && all.contains("25m") && all.contains("ac7515bc"));
        assert_eq!(exec(&root, &["meetings", "--project", "personal"]).unwrap().lines().count(), 1);
        assert_eq!(exec(&root, &["meetings", "--limit", "2"]).unwrap().lines().count(), 2);
        let json: serde_json::Value = serde_json::from_str(&exec(&root, &["meetings", "--json"]).unwrap()).unwrap();
        assert_eq!(json[0]["title"], "Pricing review");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn finds_a_meeting_by_id_part_or_title() {
        let root = archive("find");
        assert!(exec(&root, &["show", "43602b8f"]).unwrap().starts_with("# Weekly sync"));
        assert!(exec(&root, &["show", "dentist"]).unwrap().contains("Tuesday 9:00."));
        // Part of every id: the user is told which meetings it could be.
        let Err(Failed(message)) = exec(&root, &["show", "2026-"]) else { panic!("ambiguous") };
        assert!(message.starts_with("3 meetings match") && message.contains("Dentist call"));
        assert_eq!(exec(&root, &["show", "nothing like it"]), Err(Failed("No meeting matches “nothing like it”.".into())));
        assert!(matches!(exec(&root, &["show"]), Err(Usage(_))));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn prints_transcripts_clean_or_verbatim_and_searches_everything() {
        let root = archive("transcript");
        assert!(exec(&root, &["transcript", "pricing"]).unwrap().contains("Shall we test the annual plan first?"));
        assert_eq!(exec(&root, &["transcript", "pricing", "--verbatim"]).unwrap(), "# Transcript\n\n### 00:00 You\nUm, ship it.\n");
        assert!(matches!(exec(&root, &["transcript", "weekly", "--verbatim"]), Err(Failed(m)) if m.contains("no recorded transcript")));
        let found = exec(&root, &["search", "annual", "PLAN"]).unwrap();
        assert_eq!(found.lines().filter(|l| l.starts_with("2026")).count(), 3);
        assert!(found.contains("    Test the annual plan."));
        assert_eq!(exec(&root, &["search", "retention"]).unwrap().lines().count(), 2);
        assert_eq!(exec(&root, &["search", "zebra"]).unwrap(), "No meetings mention that.\n");
        assert!(matches!(exec(&root, &["meetings", "--bogus"]), Err(Usage(_))));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn only_its_own_commands_replace_the_app() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(run(&args(&["quietnote"])), None);
        assert_eq!(run(&args(&["quietnote", "/Users/me/notes.md"])), None);
        assert_eq!(short("2026-09-29-43602b8f-45f4-4e9d-afbb"), "43602b8f");
        assert_eq!(short("example-launch"), "example-launch");
    }
}
