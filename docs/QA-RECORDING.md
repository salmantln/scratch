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

### Calls
| Check | Status |
|---|---|
| Zoom | ☐ |
| Google Meet (browser) | ☐ |
| Microsoft Teams | ☐ |
| No bot or attendee appears in any call | ☐ |

### Recording state and tray
| Check | Status |
|---|---|
| While recording, the window shows the recording bar (title, elapsed time, Stop) in every view, and the tray shows ● Recording, "Started … by you · No bot joined", and Stop | ✓ auto (window, tray menu model) ☐ (real tray) |
| The tray timer and window timer agree, including after hiding and reopening the window | ☐ |
| Start from the tray: New meeting opens with "Start recording"; nothing records until it's pressed | ✓ auto |
| Stop from the tray with the window hidden; reopen and see Transcribing, then the transcript | ☐ |
| A second meeting can't start while one records (the button is disabled with a reason) | ✓ auto |
| Only one window, one tray icon | ☐ |

### Quit, crash, recovery
| Check | Status |
|---|---|
| Tray quit while recording reads "Stop recording and quit"; the audio is finalized, and the next launch transcribes it | ✓ auto (menu, recovery) ☐ (real) |
| ⌘Q while recording: the next launch transcribes the recording | ☐ |
| `kill -9` mid-recording: the next launch shows "Recovered recording" (banner and notice), then the transcript or a clear failure | ✓ auto (recovery logic, UI) ☐ (real) |
| QuietNote crashes during transcription twice: the meeting shows "closed while transcribing" under Details, the audio is kept, and Retry transcription works | ✓ auto (logic) ☐ (real) |

### Transcription and retention
| Check | Status |
|---|---|
| 30+ minute call: timer stable, audio valid, transcription completes, UI responsive | ✓ live 60-min recorder soak, 60-min synthetic transcription (see PERFORMANCE.md) ☐ real call |
| Clean is the default; Verbatim shows the fillers; switching changes nothing on disk | ✓ auto |
| Transcription failure (e.g. remove the model from the app bundle): "Transcription couldn't finish. Your recording is still saved", reason under Details, audio kept, Retry transcription | ✓ auto (UI, logic) ☐ (real) |
| Delete audio after transcribing on: audio is gone after success; after a failure it's still there | ✓ auto |
| Disk nearly full: Start is refused below 1 GB; recording stops cleanly below 150 MB | ✓ auto (thresholds) ☐ (real) |

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
