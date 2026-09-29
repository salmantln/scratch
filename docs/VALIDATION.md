# QuietNote validation

Validated on macOS Apple Silicon, 28 September 2026.

| Check | Result |
| --- | --- |
| Install | `npm ci` passed; added lint/browser tools; compatible `npm audit fix` completed. |
| Dependency audit | 0 reported vulnerabilities after compatible updates (no forced major upgrades). |
| Lint | `npm run lint` passed for the new shell, tests and tooling. Upstream had no lint script. |
| Typecheck | `npm run typecheck` passed across all frontend source, including retained Scratch code. |
| Frontend build | `npm run build` passed; also run by Tauri's build hook. |
| Browser/model tests | All 6 Playwright tests passed. |
| Native tests | Both Rust tests passed: path-component validation; real Markdown/transcript/metadata round-trip and duplicate protection. |
| Tauri bundle | `npm run tauri build -- --debug --bundles app` succeeded. |
| Native launch | Built executable launched successfully. No startup error in the diagnostic log after removing the unused updater plugin initialization. |
| Native seed/persistence smoke | Read back 6 native metadata files with matching meeting.md and transcript.md files and a completed initialization marker. |
| Responsive library | Tested 600, 800, 1080 and 1440px wide without horizontal overflow. |
| Visual review | Inspected generated library, summary, privacy and editor screenshots; tightened summary header to expose all four tasks at 1280 × 900. |
| Diff hygiene | `git diff --check` passed. |

## Browser coverage

1. Six coherent seeded meetings; structured Markdown sections; Notes headings survive; transcript content remains separate; tasks toggle and content search includes notes/transcript.
2. Project filtering, full-content search, meeting selection and task persistence after reload.
3. Actual upstream TipTap editing, immediate switching to another meeting, switching back, reload persistence, separate transcript and transcript filtering. No browser page errors.
4. Explicit capture confirmation, recording properties, pause/resume, stop, processing, ready, and a persisted seventh prototype meeting.
5. Disabled cloud fallback, privacy preference persistence, retention selection and desktop window widths.
6. Simulated archive write failure, retained draft, reload recovery and successful retry.

## Native evidence

Archive initialized at:

`~/Library/Application Support/app.quietnote.desktop/meetings/`

| Meeting | Duration (seconds) | Status | Files verified |
| --- | ---: | --- | --- |
| Acme onboarding call | 2520 | ready | metadata.json, meeting.md, transcript.md |
| Client strategy review | 3300 | ready | metadata.json, meeting.md, transcript.md |
| Hiring debrief | 1560 | ready | metadata.json, meeting.md, transcript.md |
| Weekly product sync | 1860 | ready | metadata.json, meeting.md, transcript.md |
| Sales discovery call | 2880 | ready | metadata.json, meeting.md, transcript.md |
| Quarterly planning | 2220 | ready | metadata.json, meeting.md, transcript.md |

The native smoke check initially exposed an inherited updater-plugin startup panic after removal of the upstream update configuration. The unused plugin initialization was removed and the application was rebuilt and successfully relaunched. This is why native launch was checked separately from compilation.

## Material limits

- Capture/audio/transcription/AI and planned privacy policies are not implemented; the UI labels them honestly.
- Browser tests exercise the complete UI and preview persistence. Native file tests and a real app launch verify the desktop archive; native WebView click automation was not performed.
- Only macOS was built and launched. Windows/Linux configurations and existing shell code are retained, but these platforms were not built here.
- The bundle is an unsigned/unnotarized development artifact, not a production release.
- The retained Mermaid/ELK engine is about 1.5 MB minified. It loads only when a Mermaid block is rendered; the explicit 1.6 MB vendor chunk budget accommodates it. The shell and editor are separately loaded and each stay below 600 KB.
- The original Markdown workspace retains its advanced Git/AI tools. They are outside the primary QuietNote flow and are never automatically invoked.
- No cross-process conflict merge, transactional multi-file commit, archive migration, or production crash recovery is claimed.

## Final product check

| Question | Result |
| --- | --- |
| Does this still feel like a generic notes app? | Default navigation, metadata, library and summary are meeting-first. Generic editing is secondary. |
| Is the meeting the primary object? | Yes: project-organized bundles own their metadata, structured notes and separate transcript. |
| Does “No bot joined” feel like a product property? | It sits with the live capture status and controls, alongside the visible prototype label. |
| Can realistic screenshots be taken today? | Six screenshots were generated from working views. |
| Does it feel local, calm and trustworthy? | Flat warm surfaces, explicit user controls, real desktop files and honest planned labels. |
| Is the Markdown/local-file foundation intact? | Yes: the original editor and filesystem/search infrastructure remain in use. |
