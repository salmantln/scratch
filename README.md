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

- **First launch** is a single screen: create your first project, or explore six example meetings (badged *Example*). New archives start empty; nothing is seeded without asking.
- **Projects** are created in one step (a name) and map to folders in the archive. **New meeting** asks only for an optional title and a project, then opens the meeting.
- **Library**: Recent, All meetings and per-project views. Rows show title, project, date and duration, grouped as Today / Yesterday / Previous 7 days / month. Status appears only when a meeting needs attention (Capturing, Preparing notes, Needs attention).
- **Meeting workspace**: sticky title and tabs for Summary, Decisions, Action items, Notes and Transcript. Summary previews up to three decisions and links to open action items. Decisions and action items can be added inline (`Owner — task` sets an owner). Tasks stay Markdown checkboxes.
- **Notes** use Scratch's **actual TipTap Editor**, with formatting, Markdown source, slash commands, tables, code, math and find.
- **Prototype capture**: Start capture on a meeting opens a small panel labelled *Prototype — this version does not record audio*. It shows Capturing, an elapsed timer and "Started by you · No bot joins the call". Stop saves the real duration and says "Capture ended. No audio was recorded." There is no waveform, no pause, no simulated processing, and no summary or transcript is invented.
- **Search** (Cmd/Ctrl+K) covers titles, summaries, decisions, action items, notes and transcripts. Results show context with the match highlighted and open the meeting on the tab where the match was found. Enter opens the first result.
- **Privacy** separates *Active now* (facts that are true today, plus the enforced *Confirm before capture* switch) from *Planned* preferences, which are saved but have no effect. Cloud processing is unavailable.
- **Local archive** settings: Open archive, Reload from disk, and an Advanced section with the path, the Markdown workspace and example meetings.
- **Recovery**: per-keystroke drafts, serialized writes and native close handling. A failed save shows "Your latest changes haven't been saved to disk" with Retry and Reload saved version. Drafts from a previous session are offered back as *Save now* or *Discard*. Files changed outside QuietNote raise an explicit Refresh prompt; QuietNote's own saves don't. A meeting interrupted mid-capture reopens as *Needs attention* with Add notes and Mark as ended.
- **Returning**: QuietNote reopens the last view, meeting and tab.
- **Keyboard**: Cmd/Ctrl+N new meeting; Cmd/Ctrl+K (or P, or Shift+F) search; Cmd/Ctrl+, settings; Cmd/Ctrl+\\ or Cmd/Ctrl+Shift+Enter hide the sidebar; Cmd/Ctrl+Shift+M Markdown source in the editor; Esc closes dialogs; arrow keys move between meeting tabs. Cmd/Ctrl+K inside the editor still inserts a link.
- **Narrow windows**: below 720px the sidebar becomes an icon rail with project initials; no horizontal scrolling.

## Reused from Scratch

The Tauri 2 desktop shell, React/Vite foundation, Rust filesystem commands, folder operations, file watcher, Tantivy search with fallback, TipTap editor and Markdown serialization, theme provider, formatting and keyboard tools remain in place. The retained generic workspace is available from **Settings → Local archive → Open Markdown workspace** on desktop (`?workspace=markdown`). Return through its Settings → About → Return to QuietNote meetings. Standalone Markdown file previews still use the upstream preview route.

The full pre-change audit is in [docs/SCRATCH-AUDIT.md](docs/SCRATCH-AUDIT.md). Original source files remain unless replaced by working QuietNote equivalents. AI-provider tools, Git tools and generic note operations remain secondary in that advanced workspace; QuietNote does not automatically invoke them.

## What changed

The new shell lives in `src/quietnote/`. Default navigation is New meeting, Recent, All meetings, Projects, Search and Settings. Notes are one meeting tab. Projects are top-level archive folders. The new `src-tauri/src/meetings.rs` module lists projects, creates project folders and meeting bundles, reads them and persists metadata/preferences; Markdown edits reuse Scratch's file service. The interaction rationale is in [docs/UX-AUDIT.md](docs/UX-AUDIT.md).

Warm paper, navy, cobalt and mint tokens match the existing QuietNote landing page. The QuietNote logo replaces Scratch's icon and sidebar mark; App/window/package metadata and visible legacy workspace branding are updated. Scratch's automatic update feed is disconnected; draft-release automation is manual and uses QuietNote naming. No release was published.

## File model and location

Desktop source of truth:

```text
<platform app data>/app.quietnote.desktop/meetings/
  .initialized                    # written by earlier builds only
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

New archives start empty. Example meetings are written only when you choose *Explore example meetings* (first launch) or *Add examples* (Settings → Local archive → Advanced), and existing meeting directories are never overwritten. Archives created by earlier builds keep their demo meetings, which are recognised and badged Example. Metadata and preferences use atomic file replacement; Markdown writes use the retained Scratch direct-file save command. These are separate files, not a transactional database. A meeting left in `recording`/`processing` reopens as *Needs attention* (`error` in memory until you choose *Mark as ended*); there is no resumed capture or fabricated result.

Browser preview is explicitly labeled and uses `localStorage`, not desktop files. Recovery drafts also use local webview storage until committed to the archive. Browser data is specific to its origin; it does not automatically migrate into the desktop app. Corrupt or unavailable archives produce a visible error instead of silently resetting data. External file changes are loaded using the refresh button; concurrent editing in another application does not have conflict merging.

## Prototype boundaries

All demo transcripts and summaries are authored examples. Capture tracks a real session (start, elapsed time, stop) but never opens a microphone or records system audio. A new meeting's Summary, Decisions, Action items and Transcript stay empty until you add something; the UI says *No summary yet* and *Transcript unavailable* rather than inventing content. No audio, transcript retention, local model, cloud fallback or auto-deletion engine exists. Planned settings store intent only; turning off a planned storage preference does not delete or relocate files.

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
