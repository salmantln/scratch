//! Note templates: the sections enhanced notes are organized under (`summarize::notes_enhance`), each with
//! what belongs in it. A few are built in; the user's own are Markdown files in the archive's hidden
//! `.templates` folder (a title, then a `##` heading per section with what goes there under it), and
//! one with a built-in's name replaces it.
use crate::meetings;
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

pub const FOLDER: &str = ".templates";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Section { pub heading: String, pub description: String }
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template { pub name: String, pub sections: Vec<Section>, pub built_in: bool }

const BUILT_IN: &[(&str, &[(&str, &str)])] = &[
    ("General", &[
        ("Overview", "What the meeting was about and where it ended up, in a sentence or two."),
        ("Discussion", "The main topics, each with what was said about it."),
        ("Next steps", "What happens next, and who does it where that was said."),
    ]),
    ("1:1", &[
        ("Updates", "What each person shared since last time."),
        ("Feedback", "Feedback given, in either direction."),
        ("Blockers", "What's in the way, and any help that was asked for."),
        ("Next steps", "What each person will do before the next one."),
    ]),
    ("Standup", &[
        ("Progress", "What was done since the last standup, by whom."),
        ("Next", "What each person is working on now."),
        ("Blockers", "What's in the way, and who can help."),
    ]),
    ("Sales call", &[
        ("Context", "Who they are, their team and why they're looking now."),
        ("Needs", "The problems they described and what they need, in their words where possible."),
        ("Questions and objections", "What they asked or pushed back on, and the answers given."),
        ("Next steps", "What was agreed to happen next, with dates where they were said."),
    ]),
    ("User interview", &[
        ("About them", "Their role, context and how they work today."),
        ("What they said", "Their experiences and problems, in their words where possible."),
        ("Feedback", "What they said about the product or ideas shown."),
        ("Follow-ups", "Anything to send them or check with them."),
    ]),
    ("Project kickoff", &[
        ("Goals", "What the project is for and how success was described."),
        ("Scope and timeline", "What's in and out, and the dates mentioned."),
        ("Roles", "Who does what."),
        ("Risks and open questions", "What could get in the way, and what's still undecided."),
        ("Next steps", "What happens first, and who does it."),
    ]),
];

fn built_in() -> Vec<Template> {
    BUILT_IN.iter().map(|(name, sections)| Template {
        name: name.to_string(), built_in: true,
        sections: sections.iter().map(|(heading, description)| Section { heading: heading.to_string(), description: description.to_string() }).collect(),
    }).collect()
}
/// A template file: `# Name` (or the file's name), then `## Heading` and what goes in that section.
pub fn parse(markdown: &str, fallback: &str) -> Option<Template> {
    let mut name = None;
    let mut sections: Vec<Section> = Vec::new();
    for line in markdown.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            sections.push(Section { heading: heading.trim().into(), description: String::new() });
        } else if let Some(title) = line.strip_prefix("# ").filter(|_| sections.is_empty()) {
            name = Some(title.trim().to_string());
        } else if let Some(section) = sections.last_mut() {
            let text = line.trim();
            if !text.is_empty() { section.description = [section.description.as_str(), text].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" "); }
        }
    }
    sections.retain(|s| !s.heading.is_empty());
    let name = name.filter(|n| !n.is_empty()).unwrap_or_else(|| fallback.to_string());
    (!sections.is_empty()).then_some(Template { name, sections, built_in: false })
}
/// The built-in templates, with the user's in `root/.templates` after them (or in place of one of the same name).
pub fn all(root: &Path) -> Vec<Template> {
    let mut templates = built_in();
    let Ok(entries) = std::fs::read_dir(root.join(FOLDER)) else { return templates };
    let mut own: Vec<Template> = entries.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "md")).filter_map(|e| {
        let stem = e.path().file_stem()?.to_string_lossy().into_owned();
        parse(&std::fs::read_to_string(e.path()).ok()?, &stem)
    }).collect();
    own.sort_by_key(|t| t.name.to_lowercase());
    for template in own {
        match templates.iter_mut().find(|t| t.name.eq_ignore_ascii_case(&template.name)) { Some(existing) => *existing = template, None => templates.push(template) }
    }
    templates
}

#[tauri::command]
pub async fn note_templates(app: AppHandle) -> Result<Vec<Template>, String> { Ok(all(&meetings::root(&app)?)) }
/// Opens the folder for the user's own templates, creating it (with one to start from) the first time.
#[tauri::command]
pub async fn open_templates(app: AppHandle) -> Result<(), String> {
    let folder = meetings::root(&app)?.join(FOLDER);
    if !folder.exists() {
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let example = "# My template\n\n## Overview\nWhat the meeting was about and where it ended up.\n\n## Discussion\nThe main topics, each with what was said about it.\n\n## Next steps\nWhat happens next, and who does it.\n";
        meetings::atomic_write(&folder.join("My template.md"), example.as_bytes())?;
    }
    open::that_detached(&folder).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_a_template_file() {
        let t = parse("# Weekly sync\n\nSome intro that isn't a section.\n\n## Wins\nWhat went well.\nKeep it short.\n\n## Risks\n\n## \n", "file").unwrap();
        assert_eq!(t.name, "Weekly sync");
        assert_eq!(t.sections, vec![
            Section { heading: "Wins".into(), description: "What went well. Keep it short.".into() },
            Section { heading: "Risks".into(), description: String::new() },
        ]);
        assert_eq!(parse("## Notes\nAnything.", "Retro").unwrap().name, "Retro");
        assert_eq!(parse("# Empty\nNo sections at all.", "x"), None);
    }
    #[test]
    fn the_users_templates_follow_the_built_in_ones_and_can_replace_them() {
        let root = std::env::temp_dir().join(format!("quietnote-templates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(all(&root).iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["General", "1:1", "Standup", "Sales call", "User interview", "Project kickoff"]);
        std::fs::create_dir_all(root.join(FOLDER)).unwrap();
        std::fs::write(root.join(FOLDER).join("Retro.md"), "## Went well\n## To change\n").unwrap();
        std::fs::write(root.join(FOLDER).join("standup.md"), "# Standup\n## Done\n## Doing\n").unwrap();
        std::fs::write(root.join(FOLDER).join("notes.txt"), "## Ignored\n").unwrap();
        let templates = all(&root);
        assert_eq!(templates.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["General", "1:1", "Standup", "Sales call", "User interview", "Project kickoff", "Retro"]);
        let standup = &templates[2];
        assert_eq!((standup.built_in, standup.sections.len()), (false, 2));
        std::fs::remove_dir_all(root).unwrap();
    }
}
