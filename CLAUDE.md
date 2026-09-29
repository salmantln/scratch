# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

QuietNote is a local-first meeting workspace built on top of **Scratch** (Eric Li's markdown notes app). It is Tauri v2 (Rust) + React 19/TypeScript/Tailwind v4 + TipTap + Tantivy. Meetings are the primary object. Capture is a **prototype**: there is no real audio recording, transcription, AI processing, cloud sync or accounts. Do not fabricate those behaviors (e.g. inventing summaries or audio files for new captures).

Upstream Scratch code is retained, not rewritten. The QuietNote shell lives in `src/quietnote/` and `src-tauri/src/meetings.rs` and reuses Scratch's editor, services and Rust commands. `docs/SCRATCH-AUDIT.md` (pre-change audit) and `docs/MODIFIED-FILES.md` (diff manifest vs. upstream) are the reference for what was changed. Keep `docs/MODIFIED-FILES.md` in sync when touching upstream files.

## Commands

```bash
npm run dev          # Vite dev server at http://localhost:1420 (browser preview, localStorage-backed)
npm run tauri dev    # Full desktop app with real filesystem
npm run build        # tsc + vite build
npm run typecheck    # tsc --noEmit across all frontend code
npm run lint         # ESLint — only covers src/quietnote, tests and tooling config (upstream Scratch code is not linted)
npm test             # Playwright tests (auto-starts the dev server)
npx playwright test -g "capture confirmation"   # run a single test by name
cargo test --manifest-path src-tauri/Cargo.toml # Rust unit tests (meetings.rs)
npm run tauri build -- --debug --bundles app    # macOS dev bundle
```

Playwright needs Chromium (`npx playwright install chromium`). Tests run serially (1 worker) against the browser preview in fresh contexts, so they never touch the real desktop archive.

CI (`.github/workflows/ci.yml`) runs only `npm run build`, `cargo check` and `cargo clippy -- -D warnings`; lint, typecheck and tests must be run locally. The release workflow is manual (`workflow_dispatch`) and creates a draft only; the upstream Scratch update feed is disconnected (update checks are gated on `VITE_QUIETNOTE_UPDATES`).

## Architecture

### Two apps in one bundle
`src/main.tsx` picks the root component from the URL:
- default → `QuietNoteApp` (the meetings shell)
- `?workspace=…` or `?mode=preview` → upstream Scratch `App` (generic Markdown workspace / standalone file preview), lazy-loaded

The Scratch workspace is reachable from Settings → Local archive → Open Markdown workspace, and links back to QuietNote from its About screen.

### QuietNote shell (`src/quietnote/`)
- `QuietNoteApp.tsx`: single `Shell` component that owns all state (meetings, projects, view, selection, save status, drafts, banners, keyboard shortcuts, window-close handling). Views: recent / all / project / meeting / search / settings. With no projects and no meetings it renders the first-run `Welcome` screen instead of the shell. The last view, meeting and tab are remembered in localStorage (`quietnote.place.v1`).
- `Dialogs.tsx` (`Modal`, new project, new meeting), `Capture.tsx` (prototype capture for an existing meeting: `idle` → `recording` → `ready`, no simulated processing) and `Settings.tsx` (Privacy / Local archive / About).
- `model.ts`: `Meeting = { metadata, markdown, transcript }` plus pure helpers for reading and writing `##` sections of `meeting.md` (`section`, `replaceSection`, `toggleAction`, `appendItem`), parsing (`decisions`, `actionItems` with `Owner — task`, `transcriptTurns` from `### mm:ss Speaker`), and search context (`searchMeeting` returns the matching tab and a snippet). The **Notes** section is always last and consumes the rest of the file, so headings inside notes survive.
- `storage.ts`: persistence facade that branches on `isTauri()`:
  - **Desktop**: `invoke()` calls into `meetings.rs` for archive load/create/metadata/preferences. Markdown is saved with Scratch's `saveFileDirect`. On load it points Scratch's notes folder at the archive root and starts its file watcher, so Tantivy search (`indexedSearch`) works over meeting files.
  - **Browser preview**: everything goes to `localStorage` (`quietnote.preview.archive.v1`, `quietnote.preview.projects.v1`, `quietnote.privacy`). It never migrates into the desktop app.
  - Desktop saves are recorded in `ownWrites` so the watcher's `file-change` events for QuietNote's own writes don't trigger the "Files changed outside QuietNote" prompt.
- `MeetingDetail.tsx`: tabs (Summary / Decisions / Action items / Notes / Transcript). The Notes tab lazy-loads Scratch's real `components/editor/Editor`. Summary, decisions and tasks are parsed from Markdown, not stored separately.
- `seeds.ts`: six demo meetings. They are **not** seeded automatically. They are written only via "Explore example meetings" / "Add examples" (`storage.addExamples`, which skips existing ids), and are identified by id with `isExample` so they're always badged Example.

### Rust side
- `src-tauri/src/meetings.rs`: QuietNote commands (`load_meeting_archive` returns `{ root, projects, meetings }` where projects are top-level archive folders; `create_project`; `create_meeting_bundle`; `save_meeting_metadata`; `quietnote_preferences`). Metadata and preferences are written atomically (temp file + rename). Path components are validated with `safe_component`.
- `src-tauri/src/lib.rs`: upstream Scratch commands (notes CRUD, search, watcher, settings, AI/git tools). Every command, including those in `meetings.rs`, must be registered in the `invoke_handler` here. Tauri v2 permissions go in `src-tauri/capabilities/default.json`.

### On-disk archive
`<app data>/app.quietnote.desktop/meetings/<Project>/<YYYY-MM-DD-slug>/` holds `metadata.json` (duration in **seconds**, status `idle|recording|processing|ready|error`, relative paths), `meeting.md` (title/date/project/duration, then Summary, Decisions, Action items as `- [ ]`, Notes), and `transcript.md`. Transcript text lives **only** in `transcript.md`, never in `meeting.md`. The root also holds `.privacy.json`, `.scratch/settings.json` for Scratch compatibility, and `.initialized` in archives from earlier builds that auto-seeded demos. The separate identifier keeps it isolated from a real Scratch install.

### Saving and recovery
Notes are saved through the editor's debounced save. Every keystroke also writes a recovery draft to webview storage, which is retained on save failure and offered for retry/reload. Interrupted `recording`/`processing` records load as `error` in memory ("Needs attention", with Mark as ended). Outside edits raise a "Files changed outside QuietNote" banner with an explicit Refresh; there is no conflict merging.

### Retained upstream Scratch patterns
- `NotesContext` uses a dual context pattern (data/actions separated) for performance.
- Scratch settings: app config at `{APP_DATA}/config.json`, per-folder at `{NOTES_FOLDER}/.scratch/settings.json`.

## Coding Conventions

- Clean, minimal code with low technical debt. Don't add commented-out code or TODOs.
- Match the terse style of `src/quietnote/` when editing there (compact one-line helpers, no heavy abstraction).
- Use `React.memo` for expensive list items and `useCallback`/`useMemo` on hot paths.
- Debounce user-triggered operations (auto-save 300ms, search 150ms, file watcher 500ms, git status 1000ms).
- Keep operations async and non-blocking, and surface errors visibly. Corrupt or unreadable archives must show an error rather than silently resetting data.
- Planned privacy settings only record intent. Keep them in the "Planned" group unless they are actually enforced. Real user meetings must show only data that exists: use empty states ("No summary yet.", "Transcript unavailable."), never generated placeholders.
- Only one cobalt-filled (`.primary`) action per context; everything else uses `.secondary` or `.text-button`. Base element resets in `quietnote.css` use `:where()` so class rules aren't out-specified.
- Preserve Scratch attribution (LICENSE, NOTICE, About/Privacy screens).
