# Scratch audit — before implementation

Audited upstream `9126a5adf78abbabd111302ca0b659ca9278d43a` before changing application code.

| Area | Existing implementation | QuietNote decision |
| --- | --- | --- |
| Desktop | Tauri 2, Rust commands in `src-tauri/src/lib.rs`; plugins for filesystem, dialogs, clipboard, opener, updater | Preserve shell, commands and file association previews. Rebrand app identity; disable upstream update feed. |
| React | `src/main.tsx` → `src/App.tsx`; provider-based notes, theme and Git state | Add meeting shell at entrypoint; retain original workspace as an explicitly accessible Markdown workspace. |
| Editor | `components/editor/Editor.tsx`, TipTap 3; Markdown, tasks, tables, math, code, slash commands, source mode | Reuse actual Editor via its existing `previewMode` file adapter, with ThemeProvider. |
| Persistence | Rust async file IO; `services/notes.ts` / `files.ts`; path validation, filesystem watcher, note cache | Add a narrow meeting bundle command module; preserve existing Markdown IO/search. Separate app identifier prevents changing a Scratch archive. |
| Serialization | `@tiptap/markdown` manager parses/serializes Markdown; 500ms rich-text / 300ms source save and flush on unmount | Reuse for manual notes. Store structured sections in meeting.md, transcript separately. Preserve unknown sections when editing Notes. |
| Model | Note IDs are relative Markdown paths; directories map to folders; folder tree helpers and commands | Meeting metadata adds date, duration, project, participants, status and paths. Project directories hold meeting bundles. |
| Search | Tantivy index plus substring fallback over recursively discovered Markdown | Point retained search at meeting archive; map meeting.md/transcript.md hits back to meeting IDs; supplement metadata matches. |
| Shortcuts | App navigation shortcuts; editor bold/italic/link/source/find/slash commands | Meeting shell maps New to capture, search to meetings, settings and review mode. Keep editor shortcuts. Legacy workspace remains available. |
| Navigation | Sidebar → folder tree → notes; settings/command palette; focus mode | Replace default with meetings, recent records, project filters, capture, search and settings. |
| Theme | ThemeContext, CSS variables, Tailwind 4; light/dark/system and editor typography | Retain provider/editor styling, apply warm QuietNote tokens from existing landing page. |
| Settings | Rust app config + archive `.scratch/settings.json`; General/Editor/Tools/Shortcuts/About | Add privacy with clearly marked prototype preferences; retain advanced editor settings via Markdown workspace. |
| Licensing | README declares MIT; checkout has no LICENSE or copyright notice file | Preserve upstream README and authors; add MIT text and explicit Eric Li attribution, document provenance. |

## Refactoring boundaries

No transcription, recording, networking pipeline, auth or sync. Capture is a clearly labeled simulation. Existing app, editor, folder commands and search stay available. New code owns metadata, bundle initialization, capture lifecycle, meeting UI and preference persistence. Browser preview has a distinctly labeled localStorage adapter; desktop uses real files. Demo data is installed once into a new archive without replacing existing records.

## Acceptance

Six useful meetings; library/project/search navigation; structured Markdown-backed detail and checkboxes; original editor for notes; separate transcript; explicit capture/pause/stop/processing/ready; honest privacy controls; persistence errors visible; rebrand and attribution; frontend and native validation plus interaction checks where tooling permits.
