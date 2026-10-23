//! `quietnote mcp`: the meeting archive for AI apps (Claude Desktop, Claude Code, other MCP clients), as a
//! Model Context Protocol server on stdin and stdout. It's the command line's read-only view (`cli`) in
//! tool form: it lists, shows, searches and reads transcripts, and never writes. What the connected app
//! does with what it reads is up to that app.
use crate::cli::{self, Error, Options};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

/// Protocol versions this server speaks, newest first; a client asking for another gets the newest.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Answers requests, one JSON-RPC message per line, until stdin closes.
pub fn serve() -> i32 {
    let mut stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        if let Some(reply) = handle(&line, cli::archive) {
            if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() { break; }
        }
    }
    0
}

fn reply(id: &Value, result: Value) -> Value { json!({ "jsonrpc": "2.0", "id": id, "result": result }) }
fn failure(id: &Value, code: i64, message: &str) -> Value { json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }) }

/// One message in, the reply out (`None` for notifications). The archive is found per call, so a server
/// started before QuietNote first ran still works once it has.
fn handle(line: &str, archive: impl Fn() -> Result<PathBuf, Error>) -> Option<Value> {
    let Ok(message) = serde_json::from_str::<Value>(line) else { return Some(failure(&Value::Null, -32700, "Parse error")) };
    let Some(method) = message["method"].as_str() else { return Some(failure(&message["id"], -32600, "Invalid request")) };
    // Notifications (no id) get no reply.
    let id = message.get("id")?;
    let params = &message["params"];
    Some(match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or_default();
            reply(id, json!({
                "protocolVersion": VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "quietnote", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Read-only access to the user's QuietNote meetings: notes, decisions, action items and transcripts, kept on their Mac. Find meetings with list_meetings or search_meetings, then read one with get_meeting or get_transcript.",
            }))
        }
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tools() })),
        "tools/call" => reply(id, call(params["name"].as_str().unwrap_or_default(), &params["arguments"], archive)),
        _ => failure(id, -32601, &format!("Method not found: {method}")),
    })
}

fn tools() -> Value {
    let meeting = json!({ "type": "string", "description": "The meeting's id, a unique part of it, or a unique part of its title." });
    let limit = json!({ "type": "integer", "minimum": 1, "description": "At most this many." });
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false });
    json!([
        { "name": "list_meetings", "title": "List meetings", "description": "The user's meetings, newest first, as JSON metadata (id, title, date, duration in seconds, project, participants, status).",
          "inputSchema": { "type": "object", "properties": { "project": { "type": "string", "description": "Only this project's meetings." }, "limit": limit }, "additionalProperties": false }, "annotations": read_only },
        { "name": "list_projects", "title": "List projects", "description": "The user's projects (folders of meetings).",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }, "annotations": read_only },
        { "name": "search_meetings", "title": "Search meetings", "description": "Meetings whose title, notes or transcript mention every word of the query, newest first, each with the first line that matches.",
          "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "limit": limit }, "required": ["query"], "additionalProperties": false }, "annotations": read_only },
        { "name": "get_meeting", "title": "Read a meeting", "description": "A meeting's metadata and its notes file: summary, decisions, action items (`- [ ]` open, `- [x]` done, `Owner — task`) and the user's notes.",
          "inputSchema": { "type": "object", "properties": { "meeting": meeting }, "required": ["meeting"], "additionalProperties": false }, "annotations": read_only },
        { "name": "get_transcript", "title": "Read a transcript", "description": "A recorded meeting's transcript as `### mm:ss Speaker` turns. \"You\" is the user; the others are \"Others\" or \"Speaker 1\", \"Speaker 2\"… unless named. Clean by default (filler words removed); verbatim keeps every recognized word.",
          "inputSchema": { "type": "object", "properties": { "meeting": meeting, "verbatim": { "type": "boolean" } }, "required": ["meeting"], "additionalProperties": false }, "annotations": read_only },
    ])
}

/// Runs a tool. A problem (no such meeting, no archive) is the tool's answer, marked as an error.
fn call(name: &str, arguments: &Value, archive: impl Fn() -> Result<PathBuf, Error>) -> Value {
    let text = |key: &str| arguments[key].as_str().map(String::from);
    let mut o = Options { project: text("project"), limit: arguments["limit"].as_u64().map(|n| n as usize), verbatim: arguments["verbatim"].as_bool().unwrap_or(false), ..Default::default() };
    let mut out = String::new();
    let result = archive().and_then(|root| match name {
        "list_meetings" => { o.json = true; cli::list(&root, &o, &mut out) }
        "list_projects" => cli::projects(&root).map(|p| out = if p.is_empty() { "No projects yet.".into() } else { p.join("\n") }),
        "search_meetings" => { o.words = text("query").unwrap_or_default().split_whitespace().map(String::from).collect(); cli::search(&root, &o, &mut out) }
        "get_meeting" => { o.words = text("meeting").into_iter().collect(); o.json = true; cli::show(&root, &o, &mut out) }
        "get_transcript" => { o.words = text("meeting").into_iter().collect(); cli::print_transcript(&root, &o, &mut out) }
        _ => Err(Error::Usage(format!("There’s no tool called “{name}”."))),
    });
    match result {
        Ok(()) => json!({ "content": [{ "type": "text", "text": out.trim_end() }] }),
        Err(Error::Usage(message) | Error::Failed(message)) => json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ask(root: &std::path::Path, line: &str) -> Value {
        let root = root.to_path_buf();
        handle(line, move || Ok(root.clone())).expect("a reply")
    }
    fn tool(root: &std::path::Path, name: &str, arguments: Value) -> Value {
        ask(root, &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": arguments } }).to_string())["result"].clone()
    }
    #[test]
    fn speaks_the_protocol() {
        let root = cli::tests::archive("mcp-protocol");
        let init = ask(&root, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#);
        assert_eq!((init["id"].as_i64(), init["result"]["protocolVersion"].as_str()), (Some(1), Some("2025-03-26")));
        assert_eq!(ask(&root, r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#)["result"]["protocolVersion"], VERSIONS[0]);
        assert!(handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, || unreachable!()).is_none());
        assert_eq!(ask(&root, r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)["result"], json!({}));
        let names: Vec<String> = ask(&root, r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["list_meetings", "list_projects", "search_meetings", "get_meeting", "get_transcript"]);
        assert_eq!(ask(&root, r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#)["error"]["code"], -32601);
        assert_eq!(ask(&root, "not json")["error"]["code"], -32700);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn tools_read_the_archive_and_report_problems_as_results() {
        let root = cli::tests::archive("mcp-tools");
        let list: Value = serde_json::from_str(tool(&root, "list_meetings", json!({ "project": "Acme", "limit": 1 }))["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!((list.as_array().unwrap().len(), list[0]["title"].as_str()), (1, Some("Pricing review")));
        assert_eq!(tool(&root, "list_projects", json!({}))["content"][0]["text"], "Acme\nPersonal");
        assert!(tool(&root, "search_meetings", json!({ "query": "annual plan" }))["content"][0]["text"].as_str().unwrap().contains("Test the annual plan."));
        let meeting: Value = serde_json::from_str(tool(&root, "get_meeting", json!({ "meeting": "dentist" }))["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(meeting["markdown"].as_str().unwrap().contains("Tuesday 9:00."));
        assert_eq!(tool(&root, "get_transcript", json!({ "meeting": "pricing", "verbatim": true }))["content"][0]["text"], "# Transcript\n\n### 00:00 You\nUm, ship it.");
        let missing = tool(&root, "get_meeting", json!({ "meeting": "nothing like it" }));
        assert_eq!((missing["isError"].as_bool(), missing["content"][0]["text"].as_str()), (Some(true), Some("No meeting matches “nothing like it”.")));
        assert_eq!(tool(&root, "delete_meeting", json!({}))["isError"], true);
        std::fs::remove_dir_all(root).unwrap();
    }
}
