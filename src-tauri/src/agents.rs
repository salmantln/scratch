//! Adding `quietnote mcp` to the AI apps on this computer in one click: each app's own MCP settings
//! file gets (or loses) a `quietnote` server that runs this binary. Only apps whose settings folder
//! exists are listed. The rest of each file is kept as it was; a file that isn't plain JSON (comments)
//! or TOML is left alone and says so, and Settings still offers the configuration to copy.
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const NAME: &str = "quietnote";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Format { Servers(&'static str), VsCode, Codex }
#[derive(Clone, Copy)]
enum Base { Home, Support }
/// id, name, where its file lives, and how servers are written in it.
const APPS: [(&str, &str, Base, &str, Format); 8] = [
    ("claude-desktop", "Claude Desktop", Base::Support, "Claude/claude_desktop_config.json", Format::Servers("mcpServers")),
    ("claude-code", "Claude Code", Base::Home, ".claude.json", Format::Servers("mcpServers")),
    ("codex", "Codex", Base::Home, ".codex/config.toml", Format::Codex),
    ("cursor", "Cursor", Base::Home, ".cursor/mcp.json", Format::Servers("mcpServers")),
    ("vscode", "VS Code", Base::Support, "Code/User/mcp.json", Format::VsCode),
    ("windsurf", "Windsurf", Base::Home, ".codeium/windsurf/mcp_config.json", Format::Servers("mcpServers")),
    ("gemini", "Gemini CLI", Base::Home, ".gemini/settings.json", Format::Servers("mcpServers")),
    ("lm-studio", "LM Studio", Base::Home, ".lmstudio/mcp.json", Format::Servers("mcpServers")),
];

/// One app as Settings shows it. `state` is "on" (runs this copy of QuietNote), "other" (a `quietnote`
/// server that runs something else, such as a copy of the app that has moved), "off", or "unreadable".
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent { id: &'static str, name: &'static str, state: &'static str, path: String, problem: Option<String> }

fn home() -> Option<PathBuf> { std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from) }
fn support(home: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") { Some(home.join("Library/Application Support")) }
    else if cfg!(windows) { std::env::var_os("APPDATA").map(PathBuf::from) }
    else { Some(std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"))) }
}
/// The app's settings file, if the app has been used here: its folder exists (or, for a file kept
/// directly in the home folder, the file does).
fn located(home: &Path, base: Base, file: &str) -> Option<PathBuf> {
    let path = match base { Base::Home => home.join(file), Base::Support => support(home)?.join(file) };
    let parent = path.parent()?;
    let used = if parent == home { path.is_file() } else { parent.is_dir() };
    used.then_some(path)
}
fn exe() -> Result<String, String> { std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string()) }

/// Which of `APPS` are on this computer, and whether each runs QuietNote.
#[tauri::command]
pub fn mcp_agents() -> Result<Vec<Agent>, String> {
    let home = home().ok_or("Couldn’t find your home folder.")?;
    let exe = exe()?;
    Ok(APPS.iter().filter_map(|&(id, name, base, file, format)| located(&home, base, file).map(|path| agent(id, name, &path, format, &exe))).collect())
}
/// Adds QuietNote to (or removes it from) one app's settings file.
#[tauri::command]
pub fn mcp_agent_set(id: String, on: bool) -> Result<Agent, String> {
    let home = home().ok_or("Couldn’t find your home folder.")?;
    let &(id, name, base, file, format) = APPS.iter().find(|a| a.0 == id).ok_or("Unknown app")?;
    let path = located(&home, base, file).ok_or_else(|| format!("{name} isn’t set up on this computer."))?;
    let exe = exe()?;
    let text = read(&path)?;
    let changed = if on { add(text.as_deref(), format, &exe) } else { remove(text.as_deref(), format) }.map_err(|e| unreadable(name, &e))?;
    if let Some(changed) = changed { write(&path, &changed)?; }
    Ok(agent(id, name, &path, format, &exe))
}

fn agent(id: &'static str, name: &'static str, path: &Path, format: Format, exe: &str) -> Agent {
    let found = read(path).and_then(|text| state(text.as_deref(), format, exe).map_err(|e| unreadable(name, &e)));
    let (state, problem) = match found { Ok(state) => (state, None), Err(problem) => ("unreadable", Some(problem)) };
    Agent { id, name, state, path: path.display().to_string(), problem }
}
fn unreadable(name: &str, error: &str) -> String { format!("{name}’s settings file couldn’t be read, so it was left as it is ({error}). Copy the configuration and add it by hand.") }
fn read(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn’t read {}: {e}", path.display())),
    }
}
/// Replaces the file in one step, through a link to the real file if it is one (settings kept in a
/// dotfiles folder), with the original's permissions, since these files can hold other apps' keys.
fn write(path: &Path, text: &str) -> Result<(), String> {
    let path = if path.is_symlink() { path.canonicalize().map_err(|e| e.to_string())? } else { path.to_path_buf() };
    let temp = path.with_extension("quietnote-tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let _ = std::fs::remove_file(&temp);
    let result = (|| {
        use std::io::Write;
        let mut file = options.open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        if let Ok(meta) = std::fs::metadata(&path) { std::fs::set_permissions(&temp, meta.permissions())?; }
        std::fs::rename(&temp, &path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result.map_err(|e| format!("Couldn’t save {}: {e}", path.display()))
}

fn state(text: Option<&str>, format: Format, exe: &str) -> Result<&'static str, String> {
    let command = match format {
        Format::Codex => codex(text)?.get("mcp_servers").and_then(|s| s.get(NAME)).map(|s| s.get("command").and_then(|c| c.as_str()).map(str::to_owned)),
        _ => json(text)?.get(servers_key(format)).and_then(|s| s.get(NAME)).map(|s| s.get("command").and_then(|c| c.as_str()).map(str::to_owned)),
    };
    Ok(match command { None => "off", Some(Some(c)) if c == exe => "on", Some(_) => "other" })
}
/// The file with QuietNote's server added or pointed at `exe`, keeping any other settings it has; `None` when nothing changes.
fn add(text: Option<&str>, format: Format, exe: &str) -> Result<Option<String>, String> {
    if state(text, format, exe)? == "on" { return Ok(None); }
    if format == Format::Codex {
        let mut doc = codex(text)?;
        let servers = doc.entry("mcp_servers").or_insert_with(|| { let mut t = toml_edit::Table::new(); t.set_implicit(true); toml_edit::Item::Table(t) });
        let servers = servers.as_table_like_mut().ok_or("mcp_servers isn’t a table")?;
        let server = servers.entry(NAME).or_insert(toml_edit::Item::Table(toml_edit::Table::new())).as_table_like_mut().ok_or("mcp_servers.quietnote isn’t a table")?;
        server.insert("command", toml_edit::value(exe));
        server.insert("args", toml_edit::value(toml_edit::Array::from_iter(["mcp"])));
        return Ok(Some(doc.to_string()));
    }
    let mut root = json(text)?;
    let servers = root.as_object_mut().ok_or("it isn’t a JSON object")?.entry(servers_key(format)).or_insert_with(|| Value::Object(Map::new()));
    let server = servers.as_object_mut().ok_or("its server list isn’t a JSON object")?.entry(NAME).or_insert_with(|| Value::Object(Map::new()));
    let server = server.as_object_mut().ok_or("its quietnote entry isn’t a JSON object")?;
    if format == Format::VsCode { server.insert("type".into(), "stdio".into()); }
    server.insert("command".into(), exe.into());
    server.insert("args".into(), Value::Array(vec!["mcp".into()]));
    Ok(Some(pretty(&root, text)?))
}
/// The file without QuietNote's server; `None` when it has none.
fn remove(text: Option<&str>, format: Format) -> Result<Option<String>, String> {
    if format == Format::Codex {
        let mut doc = codex(text)?;
        let removed = doc.get_mut("mcp_servers").and_then(|s| s.as_table_like_mut()).and_then(|s| s.remove(NAME));
        return Ok(removed.map(|_| doc.to_string()));
    }
    let mut root = json(text)?;
    let removed = root.get_mut(servers_key(format)).and_then(|s| s.as_object_mut()).and_then(|s| s.remove(NAME));
    removed.map(|_| pretty(&root, text)).transpose()
}

fn servers_key(format: Format) -> &'static str { match format { Format::Servers(key) => key, _ => "servers" } }
fn json(text: Option<&str>) -> Result<Value, String> {
    match text.map(str::trim) { None | Some("") => Ok(Value::Object(Map::new())), Some(text) => serde_json::from_str(text).map_err(|e| e.to_string()) }
}
fn pretty(root: &Value, before: Option<&str>) -> Result<String, String> {
    let text = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    Ok(if before.is_some_and(|b| !b.ends_with('\n')) { text } else { text + "\n" })
}
fn codex(text: Option<&str>) -> Result<toml_edit::DocumentMut, String> { text.unwrap_or("").parse().map_err(|e: toml_edit::TomlError| e.message().to_owned()) }

#[cfg(test)]
mod tests {
    use super::*;
    const EXE: &str = "/Applications/QuietNote.app/Contents/MacOS/quietnote";

    #[test]
    fn adds_to_a_new_or_empty_file() {
        for text in [None, Some(""), Some("{}")] {
            let added = add(text, Format::Servers("mcpServers"), EXE).unwrap().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&added).unwrap(), serde_json::json!({ "mcpServers": { "quietnote": { "command": EXE, "args": ["mcp"] } } }));
            assert_eq!(state(Some(&added), Format::Servers("mcpServers"), EXE).unwrap(), "on");
        }
        let vscode = add(None, Format::VsCode, EXE).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&vscode).unwrap()["servers"]["quietnote"]["type"], "stdio");
    }

    #[test]
    fn keeps_everything_else_in_order() {
        let before = "{\n  \"zebra\": 1,\n  \"mcpServers\": {\n    \"other\": { \"command\": \"x\" }\n  },\n  \"alpha\": true\n}";
        let added = add(Some(before), Format::Servers("mcpServers"), EXE).unwrap().unwrap();
        let keys: Vec<&str> = ["\"zebra\"", "\"mcpServers\"", "\"other\"", "\"quietnote\"", "\"alpha\""].into_iter().collect();
        let at: Vec<usize> = keys.iter().map(|k| added.find(k).unwrap()).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{added}");
        assert!(!added.ends_with('\n'));
        let removed = remove(Some(&added), Format::Servers("mcpServers")).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&removed).unwrap(), serde_json::from_str::<Value>(before).unwrap());
        assert_eq!(remove(Some(&removed), Format::Servers("mcpServers")).unwrap(), None);
    }

    #[test]
    fn updates_a_moved_copy_and_keeps_its_own_settings() {
        let before = r#"{"mcpServers":{"quietnote":{"command":"/old/quietnote","args":["mcp"],"env":{"QUIETNOTE_ARCHIVE":"/a"}}}}"#;
        assert_eq!(state(Some(before), Format::Servers("mcpServers"), EXE).unwrap(), "other");
        let added: Value = serde_json::from_str(&add(Some(before), Format::Servers("mcpServers"), EXE).unwrap().unwrap()).unwrap();
        assert_eq!(added["mcpServers"]["quietnote"]["command"], EXE);
        assert_eq!(added["mcpServers"]["quietnote"]["env"]["QUIETNOTE_ARCHIVE"], "/a");
        assert_eq!(add(Some(&added.to_string()), Format::Servers("mcpServers"), EXE).unwrap(), None);
    }

    #[test]
    fn leaves_files_it_cant_read() {
        let commented = "{\n  // my servers\n  \"servers\": {}\n}";
        assert!(state(Some(commented), Format::VsCode, EXE).is_err());
        assert!(add(Some(commented), Format::VsCode, EXE).is_err());
        assert!(add(Some("[]"), Format::Servers("mcpServers"), EXE).is_err());
        assert!(add(Some("model = "), Format::Codex, EXE).is_err());
    }

    #[test]
    fn writes_codex_toml_without_touching_the_rest() {
        let before = "# Codex\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        assert_eq!(state(Some(before), Format::Codex, EXE).unwrap(), "off");
        let added = add(Some(before), Format::Codex, EXE).unwrap().unwrap();
        assert!(added.starts_with(before), "{added}");
        assert!(added.contains(&format!("[mcp_servers.quietnote]\ncommand = \"{EXE}\"\nargs = [\"mcp\"]\n")), "{added}");
        assert_eq!(state(Some(&added), Format::Codex, EXE).unwrap(), "on");
        assert_eq!(remove(Some(&added), Format::Codex).unwrap().unwrap(), before);
        let fresh = add(None, Format::Codex, EXE).unwrap().unwrap();
        assert!(fresh.starts_with("[mcp_servers.quietnote]\n"), "{fresh}");
    }

    #[test]
    fn writes_through_links_and_keeps_permissions() {
        let dir = std::env::temp_dir().join(format!("quietnote-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.json");
        std::fs::write(&real, "{}").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
            let link = dir.join("link.json");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            write(&link, "{\"a\":1}").unwrap();
            assert!(link.is_symlink());
            assert_eq!(std::fs::read_to_string(&real).unwrap(), "{\"a\":1}");
            assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "quietnote-tmp")).count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Which AI apps this computer has and what QuietNote would find in their settings files. Changes nothing.
    #[test]
    #[ignore]
    fn agents_live() {
        for agent in mcp_agents().unwrap() { println!("{:<15} {:<10} {}{}", agent.name, agent.state, agent.path, agent.problem.map(|p| format!("\n    {p}")).unwrap_or_default()); }
    }

    #[test]
    fn lists_only_apps_that_were_used() {
        let home = std::env::temp_dir().join(format!("quietnote-agents-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        assert_eq!(located(&home, Base::Home, ".cursor/mcp.json"), Some(home.join(".cursor/mcp.json")));
        assert_eq!(located(&home, Base::Home, ".gemini/settings.json"), None);
        assert_eq!(located(&home, Base::Home, ".claude.json"), None);
        std::fs::write(home.join(".claude.json"), "{}").unwrap();
        assert!(located(&home, Base::Home, ".claude.json").is_some());
        std::fs::remove_dir_all(&home).unwrap();
    }
}
