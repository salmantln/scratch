# Project Map

## Purpose
QuietNote: a local-first meeting workspace (desktop app) built on the Scratch markdown notes app. Records mic + system audio, transcribes on device, keeps meetings as Markdown files in a local archive. Optional, user-initiated AI summary suggestions (Anthropic or local Ollama) and connectors (Linear, GitHub).

## Requirements
- Private and bot-free: never joins calls; audio and transcription stay on the device.
- Recording only starts when the user presses Start; may stop itself only after a visible, cancellable countdown.
- Data leaves the device only on explicit user action, and only the minimum needed.
- Keys and tokens live in the macOS Keychain, never in the webview.
- Upstream Scratch code is kept, not rewritten; changes are tracked in docs/MODIFIED-FILES.md.
(Source: CLAUDE.md product principles.)

## Components
- Frontend shell (React 19 + TS + Tailwind v4): `src/quietnote/`. `QuietNoteApp.tsx` owns state; `model.ts` holds pure Markdown helpers; `storage.ts` branches between desktop (Tauri invoke) and browser preview (localStorage).
- Upstream Scratch UI/editor (TipTap): `src/` outside `src/quietnote/`; `src/main.tsx` picks the root from the URL.
- Rust backend (Tauri v2): `src-tauri/src/`. `meetings.rs` (archive), `capture.rs` (recording lifecycle + transcription queue), `recorder.rs` (cpal audio), `transcribe.rs` (whisper.cpp), `live.rs`/`parakeet.rs`/`speakers.rs` (macOS live transcript and speaker separation), `transcript.rs` + `cleanup.rs` (pure merge/cleanup), `summarize.rs`, `connectors.rs` + `oauth.rs`, `calls.rs`, `calendar.rs`, `tray.rs`, `mcp.rs`/`cli.rs`, `lib.rs` (command registration).

## Main Flow
(Verified from CLAUDE.md and file layout; details not yet traced in code together.)

User presses Start --> React shell --invoke--> capture.rs --> recorder.rs writes audio/mic.wav + system.wav
Stop --> capture.rs queue --> transcribe.rs (Whisper) --> transcript.rs/cleanup.rs --> transcript.json/.md on disk
Rust --event quietnote://meeting-changed--> React shell updates the meeting
Notes typed in editor --saveFileDirect--> meeting.md in archive
User asks for suggestions --> summarize.rs --HTTPS--> Anthropic, or localhost Ollama --> suggestions shown, written only on Add

## Data and Trust Boundaries
- Archive on disk: `<app data>/app.quietnote.desktop/meetings/<Project>/<meeting>/` (metadata.json, meeting.md, transcript.md/json, audio/).
- Preferences: `.privacy.json` in the archive root.
- Secrets: macOS Keychain (connector tokens, Anthropic key, license key).
- Network (user-initiated only): Anthropic, Linear, GitHub, Lemon Squeezy. All HTTP from Rust; the webview CSP has no connect-src.
- Browser preview: localStorage only, never shared with the desktop archive.

## Build and Deployment
- `npm run dev` (browser preview), `npm run tauri dev` (desktop), `npm run models` (fetch models first).
- `npm run typecheck`, `npm run lint`, `npm test` (Playwright), `cargo test --manifest-path src-tauri/Cargo.toml`.
- CI: `.github/workflows/ci.yml`; release: `.github/workflows/release.yml` (manual, draft only).

## Unknowns
- Learner's current task not yet named.
- Internals not yet traced together in code (e.g. how capture state moves between Rust and React).
