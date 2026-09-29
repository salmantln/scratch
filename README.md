# QuietNote

A calm, local-first meeting workspace built **on Scratch by Eric Li**, not a replacement editor built from scratch. Meetings are the primary object. Capture is explicitly a prototype: no audio recording, transcription, AI processing, bots, cloud sync or accounts are implemented.

![QuietNote meeting library](docs/screenshots/01-library.png)

## Run

Requires Node 22+ and npm. The desktop app additionally needs Rust and the platform prerequisites for Tauri 2.

```sh
npm ci
npm run dev          # browser preview at http://localhost:1420
npm run tauri dev    # real desktop filesystem + native shell
npm run tauri build  # platform desktop bundle
```

A verified macOS development bundle is produced at `src-tauri/target/debug/bundle/macos/QuietNote.app`. It is a local development build, not a signed/notarized distribution release.

For this implementation session, Rust was installed only under `/private/tmp/quietnote-cargo` and `/private/tmp/quietnote-rustup`, without modifying the global PATH. Until those temporary directories are cleared, native commands can be run as:

```sh
CARGO_HOME=/private/tmp/quietnote-cargo \
RUSTUP_HOME=/private/tmp/quietnote-rustup \
PATH=/private/tmp/quietnote-cargo/bin:$PATH npm run tauri dev
```

## What works

- Six believable demo meetings across Acme, Northstar, Internal and Personal; compact library, project filters and chronological sorting.
- Meeting summary, decisions, Markdown task checkboxes, owner initials and participant metadata.
- Scratch's **actual TipTap Editor** for manual notes, with formatting, Markdown source, slash commands, tables, code, math and find.
- Separate timestamped transcript excerpts, transcript search, and meeting-wide search over title, metadata, summary, decisions, tasks, notes and transcript.
- Explicit New capture → confirmation → simulated recording/timer → pause/resume → stop → preparing → ready. It creates a real editable meeting record. “Recording started by you” and “No bot joined” stay visible in the capture panel.
- Privacy preferences persist. Confirmation affects the prototype; audio, processing and retention preferences are labeled Planned. Cloud fallback is disabled.
- Real native local files, save errors, retry, per-keystroke recovery drafts, queued writes and native close handling. A refresh control reloads external edits without silently replacing active editor content.
- Keyboard navigation: Cmd/Ctrl+N capture; Cmd/Ctrl+P or Cmd/Ctrl+Shift+F search; Cmd/Ctrl+, settings; Cmd/Ctrl+\\ or Cmd/Ctrl+Shift+Enter review mode; Cmd/Ctrl+Shift+M Markdown source in the editor. Original editor formatting shortcuts remain intact.

## Reused from Scratch

The Tauri 2 desktop shell, React/Vite foundation, Rust filesystem commands, folder operations, file watcher, Tantivy search with fallback, TipTap editor and Markdown serialization, theme provider, formatting and keyboard tools remain in place. The retained generic workspace is available from **Settings → Local archive → Open Markdown workspace** on desktop (`?workspace=markdown`). Return through its Settings → About → Return to QuietNote meetings. Standalone Markdown file previews still use the upstream preview route.

The full pre-change audit is in [docs/SCRATCH-AUDIT.md](docs/SCRATCH-AUDIT.md). Original source files remain unless replaced by working QuietNote equivalents. AI-provider tools, Git tools and generic note operations remain secondary in that advanced workspace; QuietNote does not automatically invoke them.

## What changed

The new shell lives in `src/quietnote/`. Default navigation is Meetings, recent meetings, Projects, Search and Settings with a persistent capture entry point. Notes are one meeting tab. Projects map to existing filesystem directories. The new `src-tauri/src/meetings.rs` module initializes and reads meeting bundles and persists metadata/preferences; Markdown edits reuse Scratch's file service.

Warm paper, navy, cobalt and mint tokens match the existing QuietNote landing page. The QuietNote logo replaces Scratch's icon and sidebar mark; the concentric quiet pulse remains as a loading and empty-state motif. App/window/package metadata and visible legacy workspace branding are updated. Scratch's automatic update feed is disconnected; draft-release automation is manual and uses QuietNote naming. No release was published.

## File model and location

Desktop source of truth:

```text
<platform app data>/app.quietnote.desktop/meetings/
  .initialized
  .privacy.json
  .scratch/settings.json          # retained Scratch settings compatibility
  Acme/
    2026-09-28-acme-onboarding/
      metadata.json
      meeting.md
      transcript.md
  Northstar/...
  Internal/...
  Personal/...
```

The exact platform path is shown in Settings. On macOS it is:

```text
~/Library/Application Support/app.quietnote.desktop/meetings/
```

On Windows/Linux, Tauri resolves the platform app-data directory. The separate QuietNote identifier isolates this archive from an existing Scratch installation.

`meeting.md` contains title/date/project/duration, Summary, Decisions, Action items and a final Notes section. Notes consumes the remainder of the file, so headings inside manual notes are preserved. Tasks use `- [ ]` / `- [x]`. Transcript text lives **only** in `transcript.md`. Metadata has `id`, `title`, `date`, duration in **seconds**, project, participants, status (`idle | recording | processing | ready | error`), capture timestamps, nullable audio path, relative transcript/meeting paths and tags. The simulated capture's metadata holds its measured duration; no audio file is fabricated.

New archives receive demo bundles once. Existing meeting directories are never overwritten during seeding. Metadata and preferences use atomic file replacement; Markdown writes use the retained Scratch direct-file save command. These are separate files, not a transactional database. Interrupted recording/processing records display Error on reopening; there is no resumed capture or fabricated result.

Browser preview is explicitly labeled and uses `localStorage`, not desktop files. Recovery drafts also use local webview storage until committed to the archive. Browser data is specific to its origin; it does not automatically migrate into the desktop app. Corrupt or unavailable archives produce a visible error instead of silently resetting data. External file changes are loaded using the refresh button; concurrent editing in another application does not have conflict merging.

## Prototype boundaries

All demo transcripts and summaries are authored examples. Capture simulates state and timing; it never opens a microphone or records system audio. A new capture creates a blank structured record explaining that no audio was captured, rather than inventing an AI summary. The waveform is illustrative and static. No audio, transcript retention, local model, cloud fallback or auto-deletion engine exists. Planned settings store intent only; turning off a planned storage preference does not delete or relocate files.

For real capture/transcription, implement permission-aware device audio capture, durable audio lifecycle, a transcription worker, cancellation/error recovery, timestamps and speaker mapping, and structured-summary generation. Enforce processing/retention preferences at that boundary. No calendar, CRM, payments, authentication or collaboration systems were added.

## Checks and screenshots

```sh
npm run lint       # new shell, browser tests and tooling; upstream had no ESLint setup
npm run typecheck  # entire existing and new frontend
npm test           # Playwright interaction/persistence and Markdown-model tests
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug --bundles app  # macOS development bundle
```

Install a Playwright Chromium browser with `npx playwright install chromium` if one is not already cached. Tests use fresh browser contexts and do not modify the real desktop archive. Native tests write isolated temporary bundles.

[Validation results](docs/VALIDATION.md) include the actual checks performed. [Screenshot gallery](docs/SCREENSHOTS.md) links library, summary, active capture, privacy, manual notes and transcript views. Browser screenshots deliberately retain their preview/prototype labels. [Exact file manifest](docs/MODIFIED-FILES.md) lists every tracked modification and added file relative to upstream, excluding ignored dependencies and build outputs.

## License and attribution

Scratch is by Eric Li and contributors, declared MIT in its upstream README. The audited checkout did not include a separate LICENSE file. Its README is preserved verbatim in [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md); [LICENSE](LICENSE) provides the MIT text and explicit upstream attribution, and [NOTICE](NOTICE) documents provenance. Attribution is visible in both QuietNote privacy settings and the retained Markdown workspace's About screen. No original license/copyright file was removed.
