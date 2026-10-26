# Recording QA checklist

Run this on real devices before trusting a build with a real meeting. It covers the core loop: tray → meeting → Start → mic and call audio → Stop → local transcription → Clean/Verbatim → recovery → reopen later.

Status key:
- **✓ auto**: covered by automated tests (`cargo test`, `npm test`).
- **✓ live**: verified on a real device during the hardening pass (M3 Pro, macOS 26.6), with the date.
- **☐**: still to check by hand.

Use a signed build (`npm run tauri build`) for anything involving permissions. Debug bundles and `tauri dev` attribute permission prompts differently.

## macOS

### First run and permissions
| Check | Status |
|---|---|
| Before the first recording, the recorder explains both permissions (Microphone; System audio recording) and says nothing records until Start. Start doesn't happen automatically on first run. | ✓ auto |
| Pressing Start shows the macOS Microphone prompt, then the System Audio Recording prompt. The app says "Waiting for permission…" meanwhile. | ☐ |
| Deny the microphone: "Microphone access is off", Open System Settings opens Privacy → Microphone, the meeting stays idle and no recording bar appears. | ✓ auto (UI) ☐ (real prompt) |
| Deny system audio: after 20 s "No call audio yet" with Open System Settings; the mic keeps recording. After allowing, stop and start again, and call audio arrives. | ☐ |
| Permission descriptions in the prompts read correctly (Info.plist). The strings were reworded after the signed test build, so rebuild before checking. | ☐ |

### Signed build
| Check | Status |
|---|---|
| Signed with hardened runtime, `com.apple.security.device.audio-input` embedded, both usage descriptions present, minimum macOS 14.6, both models bundled (580 MB app) | ✓ live 2026-09-29 (Apple Development identity) |
| Gatekeeper accepts the app | ☐ pending: needs a Developer ID Application certificate and notarization; an Apple Development signature is rejected by `spctl`, as expected |
| Permissions, tray and recording behave the same in the notarized build as in development | ☐ pending |
| Launching a second copy (another build with the same identifier) focuses the running one instead of opening a second window | ✓ live 2026-09-29 |

### Devices
| Check | Status |
|---|---|
| Built-in mic plus speakers: both tracks heard, and the transcript has You and Others without duplicated lines. | ✓ live 2026-09-29 (recorder); ☐ (real call) |
| Wired headset | ☐ |
| AirPods (connect mid-call): "Microphone changed to AirPods…" and recording continues | ☐ |
| AirPods switch to another device mid-call: "Microphone disconnected", then reconnects to the new default | ☐ |
| Change the system output device mid-call: call audio keeps recording (the global tap follows all output) | ☐ |
| Unplug the only external mic: notice shown, no silent dead track | ☐ |
| Mac sleeps mid-recording, then wakes: a notice is shown and recording resumes or clearly says why not | ☐ |
| Choose AirPods in the recorder's microphone menu mid-call: "Microphone changed to AirPods…", recording continues, and the next recording uses them too | ✓ auto (UI) ☐ (real) |
| The chosen microphone is disconnected: "… isn't available, so the microphone is …" and the default is used; reconnecting it switches back | ☐ |

### Calls
| Check | Status |
|---|---|
| Zoom | ☐ |
| Google Meet (browser) | ☐ |
| Microsoft Teams | ☐ |
| No bot or attendee appears in any call | ☐ |
| Joining a Zoom call shows "Meeting detected · Zoom" top right within ~5 s, without taking focus from Zoom | ☐ |
| A Google Meet call in Chrome shows "Meeting detected · Chrome" (also Safari, Arc) | ☐ |
| The panel shows over a full-screen call | ☐ |
| Record on the panel opens QuietNote on a new "Zoom call" meeting, recording, on Notes | ☐ |
| With the microphone never asked for (a fresh install, or a re-signed dev build), Record on the panel still starts at once: macOS asks for the microphone, and no "Before your first recording" card shows | ☐ |
| …as a narrow column at the right of the call's screen (just the meeting, recorder and live transcript), not the whole app | ✓ auto (layout) ☐ (real window) |
| Open full window (↗) puts the window back where and how big it was; so does ⌘, / ⌘K or a tray action | ✓ auto (layout) ☐ (real window) |
| The compact column on a second screen, and when the window was full screen before | ☐ |
| Leaving the call hides the panel; dismissing it keeps it away until the next call | ☐ |
| QuietNote opened once (release build in /Applications) appears in System Settings → General → Login Items (and an old `~/Library/LaunchAgents/app.quietnote.desktop.plist` is gone); after logging out and in it's in the menu bar with no window, and joining a call shows the panel | ☐ |
| Removing QuietNote from Login Items in System Settings: the next launch doesn't add it back, and Settings → Privacy → Open at login shows off | ☐ |
| Settings → Privacy → Open at login off removes it from Login Items; nothing opens QuietNote at the next login | ☐ |
| ⌘Q (*Close to Menu Bar*) closes the windows and the Dock icon but QuietNote stays in the menu bar and a call still shows the panel; QuietNote → Quit QuietNote quits | ✓ live 2026-10-24 (debug bundle: window closed, still running as a menu bar app; Quit exits) ☐ (call) |
| Closing the window (red button, ⌘W) removes QuietNote from the Dock and ⌘-Tab while the menu bar icon stays and a call still shows the panel; Open QuietNote, a relaunch or the panel's Record brings back the window and the Dock icon. A login launch has no Dock icon, and a preview window keeps it while open | ☐ |
| A second meeting in the same browser while the browser still holds the microphone is not offered (as in Granola); leaving, then joining a new one is | ✓ live 2026-10-23 (Chrome, Meet) |
| Don't notify for Chrome stops Chrome prompts; Settings → Privacy → Notify again brings them back | ☐ |
| Nothing is offered while QuietNote is recording, or after stopping mid-call | ☐ |
| Dictation or Voice Memos using the mic never show the panel | ☐ |
| With "Recognize meetings in browsers" on: turning it on shows macOS's Accessibility prompt; until allowed, Settings says so and every browser is still offered | ✓ auto (UI) ☐ (real prompt) |
| …once allowed: a Meet tab in Chrome (also in the background, and in Safari and Arc) shows "Meeting detected · Google Meet"; a browser using the mic with no meeting open (a dictation site) shows nothing | ✓ live 2026-10-23 (Chrome tabs read, no meeting open) ☐ (real Meet) |
| Speaker names from the call app: not built. Run `call_window_live` with `QUIETNOTE_AX_DEPTH=12` during a test call (it prints every name on screen, so not in a real meeting) to see how Zoom, Teams and Meet show who's speaking | ☐ |

### Recording state and tray
| Check | Status |
|---|---|
| While recording, the window shows the recording bar (title, elapsed time, Stop) in every view, and the tray shows ● Recording, "Started … by you · No bot joined", and Stop | ✓ auto (window, tray menu model) ☐ (real tray) |
| The tray timer and window timer agree, including after hiding and reopening the window | ☐ |
| One press records: Home's Start recording, the tray's Start recording and ⌘⇧R open an "Untitled meeting" on Notes and record it, with no dialog; never over an open dialog | ✓ auto ☐ (real tray) |
| In person, with no call app running: one press records the microphone, and the transcript has only You | ☐ |
| ⌃⌥R with Zoom (or any other app) in front, QuietNote hidden: the window comes forward and records. A key changed in Settings → Shortcuts works at once; one another app holds is refused | ✓ auto (Settings) ☐ (real key) |
| With the calendar on, during an event: one press names the meeting after it, or records into the meeting made with Prepare notes | ✓ auto ☐ (real calendar) |
| Stop from the tray with the window hidden; reopen and see Transcribing, then the transcript | ☐ |
| A second meeting can't start while one records (the button is disabled with a reason) | ✓ auto |
| Only one window, one tray icon | ☐ |
| The recorder stays pinned to the bottom of the meeting while notes grow longer than the window | ✓ auto |
| Pause: the clock stops in the window and the tray (❙❙), macOS's microphone indicator goes off, and nothing is recorded until Resume | ✓ auto (UI, clock) ☐ (mic indicator) |
| Resume after a pause: both tracks continue from the same moment, and the transcript has no gap or overlap at the pause | ✓ auto (files) ☐ (real call) |
| Pause and Resume from the tray, with the window hidden | ☐ |
| Quit or crash while paused: the next launch recovers and transcribes everything recorded before the pause | ☐ |
| Close the lid (no external display) mid-recording: it's paused before the Mac sleeps, with "Paused because the Mac went to sleep" in the recorder, and it waits for Resume after waking; with an external display it keeps recording | ☐ |
| Music playing in Music, Spotify or a browser pauses when recording starts or resumes (Settings → "Pause music when recording starts"), and nothing starts playing afterwards | ✓ live 2026-10-23 (the pause command is accepted on macOS 26.6) ☐ (with music playing) |
| Copy message (beside "Let everyone know you're recording") copies the consent message; pasted into Zoom, Meet and Teams chat it reads correctly | ✓ auto (copy) ☐ (pasted) |
| Leave a Zoom or Meet call while recording: within about 6 s the call panel (also with QuietNote's window hidden), the recorder and the tray show "The Zoom call ended. Recording stops in 0:59" with Keep recording; it stops a minute later once nobody's talking, and Keep recording cancels it | ✓ auto (UI, countdown logic) ☐ (real call) |
| Mute yourself in Zoom, Meet and Teams while recording: that alone never counts as the call ending | ☐ |
| Leave a recording running in silence for 15 minutes: a 2-minute countdown starts, and speaking cancels it | ✓ auto (logic) ☐ (real) |

### Quit, crash, recovery
| Check | Status |
|---|---|
| Tray quit while recording reads "Stop recording and quit"; the audio is finalized, and the next launch transcribes it | ✓ auto (menu, recovery) ☐ (real) |
| ⌘Q while recording: the recording carries on in the menu bar | ☐ |
| Dock → Quit while recording: the next launch transcribes the recording | ☐ |
| `kill -9` mid-recording: the next launch shows "Recovered recording" (banner and notice), then the transcript or a clear failure | ✓ auto (recovery logic, UI) ☐ (real) |
| QuietNote crashes during transcription twice: the meeting shows "closed while transcribing" under Details, the audio is kept, and Retry transcription works | ✓ auto (logic) ☐ (real) |

### Transcription and retention
| Check | Status |
|---|---|
| 30+ minute call: timer stable, audio valid, transcription completes, UI responsive | ✓ live 60-min recorder soak, 60-min synthetic transcription (see PERFORMANCE.md) ☐ real call |
| Clean is the default; Verbatim shows the fillers; switching changes nothing on disk | ✓ auto |
| A long stretch of talking reads as paragraphs of about 15 s, each with its own time; with only one side speaking there are no speaker labels | ✓ auto |
| Transcription failure (e.g. remove the model from the app bundle): "Transcription couldn't finish. Your recording is still saved", reason under Details, audio kept, Retry transcription | ✓ auto (UI, logic) ☐ (real) |
| Delete audio after transcribing on: audio is gone after success; after a failure it's still there | ✓ auto |
| Encrypt recordings on (the default): a new recording's `audio/` folder holds `mic.qna` and `system.qna`, no WAV; it transcribes and tells voices apart as before | ✓ auto (format, recorder) ☐ (real) |
| The first encrypted recording adds an `audio` item to Keychain Access (`app.quietnote.desktop.connectors`); a release build doesn't ask for the Keychain password | ☐ |
| Force-quit while recording encrypted: the next launch recovers the audio up to about the last second and transcribes it | ✓ auto (logic) ☐ (real) |
| Export audio… asks for a folder every time and writes playable WAVs there (`<meeting> mic.wav`, `… 2.wav` beside an earlier export); cancelling writes nothing | ✓ auto (UI, files) ☐ (real) |
| Encrypt recordings off: new recordings are WAV; recording more of a meeting recorded encrypted keeps it encrypted; WAVs from earlier builds still transcribe and export | ✓ auto |
| Disk nearly full: Start is refused below 1 GB; recording stops cleanly below 150 MB | ✓ auto (thresholds) ☐ (real) |
| On speakers, the others' words aren't transcribed as yours, and talking over them keeps your words; with "Remove call audio from your microphone" off, mic.wav is the raw microphone | ✓ auto (synthetic), ✓ live 2026-10-23 (real voice, simulated room; see PERFORMANCE) ☐ (real call on speakers) |
| With headphones, your voice in mic.wav sounds the same with echo cancellation on as off | ☐ |
| A call with three or more others reads "Speaker 1", "Speaker 2"… in the order they first spoke, and one other person stays "Others"; "Tell the others apart" off keeps "Others" | ✓ auto (labelling), ✓ live 2026-10-23 (synthetic four-voice call) ☐ (real people) |
| Recording more of a meeting with Speaker 1 and 2: new voices continue from Speaker 3 | ✓ auto ☐ (real) |

### Live transcript (macOS)
| Check | Status |
|---|---|
| Words appear in the recorder a few seconds after each sentence ends, You on the right and Others on the left; dots show while someone talks | ✓ auto (UI); ✓ live 2026-09-29 (real recordings replayed, see PERFORMANCE) ☐ (real call) |
| Starting a recording isn't delayed by loading the model ("Starting the live transcript…" shows meanwhile) | ☐ |
| After Stop, the Transcript tab keeps the draft (labelled) until the full transcript replaces it | ✓ auto |
| Settings → Privacy → "Show the transcript while recording" off: the next recording has no live transcript and uses no extra memory | ☐ |
| Activity Monitor during a 30-minute call with the live transcript on: memory about 1 GB more than without; the call stays smooth | ☐ |
| An English meeting switches to Parakeet within the first minute: words then appear about a second after they're said, the sentence being spoken updates as it grows, and memory drops by several hundred MB | ✓ live 2026-10-23 (real recording replayed) ☐ (real call) |
| A meeting in another language stays with Whisper | ☐ |

### Notes, last time and enhancing (any platform)
| Check | Status |
|---|---|
| The next "Weekly sync" shows the last one's open action items above its notes; ticking one there ticks it in the last meeting's file | ✓ auto |
| Enhance notes with Claude and with an Ollama model: the confirm says what's sent, the template matches the title, the preview's lines quote your notes or the transcript, and Use as summary writes headed sections without touching Notes | ✓ auto (UI, grounding) ☐ (a real model) |
| Edit templates opens `.templates` with an example; a template added there appears in the picker, and one named like a built-in replaces it | ✓ auto (parsing) ☐ (real folder) |

### Calendar, People and names
| Check | Status |
|---|---|
| Settings → Privacy → Use your calendar shows macOS's Calendar prompt; denied says so with Open System Settings; until it's on, nothing calendar shows | ✓ auto (UI) ☐ (real prompt) |
| With Google and Outlook accounts added to macOS: Home's Up next and the menu bar's Next line show today's meetings (not all-day or declined ones), and change within a minute of the calendar changing | ☐ |
| Prepare notes makes the meeting with the event's title, attendees and the series' project, without recording; New meeting during an event fills in from it; a call recorded from the panel is named after the event | ✓ auto ☐ (real calendar) |
| Next week's meeting of a series shows this week's open items (Last time), even when renamed | ✓ auto (logic) ☐ (real series) |
| People lists invited people grouped by company, not by gmail.com or your own domain; a person's page shows their meetings and the items they own | ✓ auto |
| Renaming a title or a voice changes meeting.md / transcript.md and nothing else; naming suggestions cite the line and send the invited names only when asked | ✓ auto (UI, grounding) ☐ (a real model) |
| `quietnote mcp` added to Claude Desktop and Claude Code: listing, searching and reading a meeting work, and nothing can be changed | ✓ live 2026-10-23 (stdio round trip on this Mac's archive) ☐ (in Claude Desktop) |

### Recording more of a finished meeting
| Check | Status |
|---|---|
| Resume recording on a finished meeting: the clock carries on, and after Stop the new part follows the earlier transcript with continuing times | ✓ auto (UI, transcript merge, recovery) ☐ (real) |
| With "Delete audio after transcribing" on: resuming records into new files and the earlier transcript is kept | ☐ |
| A meeting whose transcript was typed, not recorded, refuses to record more instead of replacing it | ☐ |

## Windows (pending: nothing below has been run on Windows)
Everything above applies, with these differences. See [WINDOWS.md](WINDOWS.md) for the known risks.

| Check | Status |
|---|---|
| Microphone privacy toggle off: "Microphone access is off"; Open Settings opens Privacy → Microphone | ☐ pending |
| Built-in mic, speakers, headset, Bluetooth headset | ☐ pending |
| Change the default output mid-call: "Call audio now comes from …", no gap beyond the switch | ☐ pending |
| Nothing playing for minutes (loopback is silent): tracks stay aligned | ☐ pending |
| Zoom / Meet / Teams | ☐ pending |
| Tray: left click opens the window, right click shows the menu, tooltip shows elapsed time, red-dot icon while recording | ☐ pending |
| Quit / crash / recovery as above | ☐ pending |
| 30+ minute call, transcription time on CPU | ☐ pending |
| A user profile with a non-ASCII name (per-user install) | ☐ pending |
