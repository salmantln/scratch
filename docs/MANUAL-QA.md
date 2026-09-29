# Manual QA checklist (alpha)

Run this on a Mac with a signed build (`npm run tauri build`) before handing QuietNote to an alpha tester. It follows a first-time user from a fresh install to finding a meeting again after relaunch. Device and call detail (Zoom, Meet, Teams, sleep/wake, device switching) is in [QA-RECORDING.md](QA-RECORDING.md); the reasoning behind the flows is in [UX-AUDIT.md](UX-AUDIT.md).

To reset for a fresh install, quit QuietNote. Then move `~/Library/Application Support/app.quietnote.desktop` aside and reset the permissions with `tccutil reset Microphone app.quietnote.desktop` and `tccutil reset AudioCapture app.quietnote.desktop`.

Result key:
- **Pass**: checked and correct. *(auto)* means the automated suite checks it: Playwright drives the UI in the browser preview or through the desktop stand-in, and `cargo test` checks the logic. It still needs a real-device run.
- **Fail**: checked and wrong. Note what happened.
- **Not tested**: not checked on a real device in this pass.

Last updated: 2026-09-29 (pre-alpha UX hardening). Every real-device row starts as Not tested.

## Fresh install

| Check | Result | Evidence |
|---|---|---|
| Launch: one window and one menu bar icon. The first screen says QuietNote records and transcribes on this Mac, no bot joins, and nothing records until Start | Pass (auto) · Not tested (real) | Test O; fresh-eyes pass |
| Create your first project: one field; invalid names are explained; it lands in the empty project ("No meetings in … yet.") | Pass (auto) · Not tested (real) | Test A |
| First meeting: New meeting shows Title (optional), Project (preselected), Create meeting and **Start recording** | Pass (auto) · Not tested (real) | Test K |
| First Start recording: the recorder strip explains Microphone and System audio recording before macOS asks; nothing starts until Start is pressed | Pass (auto) · Not tested (real) | Test L |
| The macOS Microphone prompt appears, then the System Audio Recording prompt; the button reads "Waiting for permission…" meanwhile | Not tested | |
| The prompt wording (Info.plist) reads correctly | Not tested | |
| Deny the microphone: "Microphone access is off", Open System Settings, Try again; the meeting stays idle; no recording bar | Pass (auto) · Not tested (real) | Test L |
| Deny system audio: after ~20 s "No call audio yet" with Open System Settings; the mic keeps recording | Pass (auto, UI) · Not tested (real) | Test J |
| Revoke the microphone in System Settings after setup, then start: the denied state appears, not a silent recording | Not tested | |
| Tray with no project: Start recording… → New project → New meeting opens with Start recording | Pass (auto) · Not tested (real) | Test O |

## Recording

| Check | Result | Evidence |
|---|---|---|
| Built-in mic + speakers: Mic ✓ and Call audio ✓ appear once people talk | Not tested | |
| Wired headset | Not tested | |
| Bluetooth / AirPods, including connecting mid-call ("Microphone changed to …") | Not tested | |
| Start recording on an idle meeting starts at once (one press) | Pass (auto) · Not tested (real) | Test J |
| While recording, "Recording", the elapsed time and Stop recording show in the meeting's recorder strip (Notes open and editable) and in the window bar of every other view | Pass (auto) · Not tested (real) | Tests J, N |
| Tray while recording: ● Recording: title, "Started … by you · No bot joined", Stop recording, Open meeting; no recent meetings or projects; the menu bar shows the elapsed time | Pass (auto, menu model) · Not tested (real) | `tray.rs` test |
| Tray and window timers agree | Not tested | |
| Close the window (⌘W) while recording: recording continues; the tray timer keeps counting | Not tested | |
| Reopen from the tray or Dock: the same window, the same recording, no duplicate window or session | Not tested | |
| A second meeting can't start while one records (disabled, with the reason) | Pass (auto) · Not tested (real) | Test N |
| A device problem shows in the recorder, the window bar (labelled for screen readers) and the tray | Pass (auto) · Not tested (real) | Test N; `tray.rs` test |
| Stop from the recorder strip: the strip goes and the meeting shows "Transcribing on this Mac… n%"; Notes stays open | Pass (auto) · Not tested (real) | Test K |
| Type in Notes while recording and while transcribing; the editor never blanks the window (an editor failure shows "Notes couldn’t open." with Reload) | Pass (auto) · Not tested (real) | Tests B, S |
| Stop from the window bar or the tray while elsewhere: a "Recording saved" banner with Open meeting; then "Transcript ready" | Pass (auto) · Not tested (real) | Tests J, O |
| No "Are you sure?" on Stop | Pass (auto) | Tests J, K |

## Transcription

| Check | Result | Evidence |
|---|---|---|
| A successful transcription: the transcript appears with You / Others turns and sensible timestamps | Not tested | |
| Clean is the default view; Verbatim shows the raw words; switching writes nothing | Pass (auto) · Not tested (real) | Test J |
| Filler removal on a real meeting: um / uh / erm / hmm and stutters go; "like", "you know", "I mean", numbers, names, quotes and self-corrections stay | Pass (auto, rules) · Not tested (real) | `cleanup.rs` tests |
| Failure (e.g. remove the model): "Transcription couldn't finish. Your recording is still saved (n min)", Details shows the reason, Show audio opens the audio folder | Pass (auto, UI) · Not tested (real) | Test M |
| Retry transcription requeues the meeting and succeeds once the cause is fixed | Pass (auto, UI) · Not tested (real) | Test M |
| Delete audio after transcribing: on success the audio folder is gone; on failure it's kept; audio from earlier meetings is untouched | Pass (auto, logic) · Not tested (real) | `capture.rs` tests |

## Recovery

| Check | Result | Evidence |
|---|---|---|
| Quit from the tray mid-recording ("Stop recording and quit"): the recording is finalized and transcribed on the next launch | Not tested | |
| `kill -9` mid-recording, relaunch: "Recovered recording" banner and notice, then the transcript or a clear failure with the audio kept | Pass (auto, logic + UI) · Not tested (real) | Test M; `capture.rs` tests |
| Crash during transcription, relaunch: retried once; after a second crash it waits, with Retry transcription | Pass (auto, logic) · Not tested (real) | `capture.rs` tests |
| Unsaved notes after ⌘Q: offered back as Save now / Discard | Pass (auto, preview) · Not tested (real) | Test F |

## Search

| Check | Result | Evidence |
|---|---|---|
| ⌘K, type a meeting title or project: the result opens that meeting | Pass (auto) · Not tested (real) | Test D |
| A decision ("What did we decide about SSO?"): ⌘K → type → click opens the Decisions tab | Pass (auto) · Not tested (real) | Test D |
| A transcript phrase: opens the Transcript tab filtered to the phrase; clearing the filter shows everything | Pass (auto) · Not tested (real) | Test D |
| A proper noun heard only in audio is found after transcription (Tantivy index) | Not tested | |
| A no-result term: "No meetings found for '…'." | Pass (auto) | Test D |
| Results show the date, project and matching tab, never file paths | Pass (auto) | Test D |

## Relaunch

| Check | Result | Evidence |
|---|---|---|
| Quit and relaunch: the meeting is still there, with its transcript | Not tested | |
| The project is still there with its meeting count | Not tested | |
| Preferences persist (Remove filler words, Delete audio after transcribing) | Not tested | Test E only checks that a preview preference survives a reload |
| The last view, meeting and tab are restored | Pass (auto, preview) · Not tested (real) | Test A |
| Found again tomorrow: Home → row, or ⌘K | Not tested | |
