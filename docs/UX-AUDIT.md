# QuietNote first-time user audit (pre-alpha)

This audit covers the shell as it is before the pre-alpha hardening pass: real recording and transcription on macOS/Windows, the prototype recorder in the browser preview, the tray, and recovery. It was written before any code changed. The fixes that followed are listed under [What changed](#what-changed), and the [fresh-eyes pass](#fresh-eyes-pass) re-checks the result.

The previous audit (commit `d0c9c23`, before recording existed) covered the prototype shell: library, sidebar, search and the Markdown sections. Its decisions still stand and are not repeated here.

Method:
- Every screen was read in code (`src/quietnote/*`, `src-tauri/src/tray.rs`, `capture.rs`).
- Every screen was screenshotted in a fresh browser context: the browser preview, and the desktop recording UI through the same `mockDesktop` stand-in the Playwright tests use (empty archive, first-run microphone, live recording, stopped, failed transcription).
- The real macOS permission prompts and the real menu bar can't be driven from here. Those items are marked as such, and they're listed in [MANUAL-QA.md](MANUAL-QA.md).

## Current user journey (desktop, fresh install)

| Step | What the user sees | Hesitation |
|---|---|---|
| Launch | Logo, "Keep the useful part of every meeting.", "QuietNote keeps your meeting workspace local and organized around projects.", **Create your first project**, *Explore example meetings* | *Is this a notes app?* Nothing says it records, that no bot joins, or that recording waits for me. |
| Create first project | One field, "Project name", **Create project** | None. |
| Empty project | "Nothing here yet." / "Meetings for Acme will appear here." / New meeting (secondary) | *How do meetings get here? Do they import from my calendar?* Nothing points to recording. |
| New meeting | Title (optional), Project (preselected), **Create meeting** | *Where's record?* Creating a meeting doesn't record it, and nothing says so. |
| Meeting page (idle) | Title, meta, tabs, "No summary yet. Automatic summaries aren't available…", **Add notes**; *Start recording* is a grey button top-right | The largest block on screen is an empty state about summaries. Start recording has the same weight as Add notes. |
| Start recording | The recorder opens with **Start recording** again (confirm preference on by default); first run shows the permission explainer | *Didn't I just press that?* The same label twice in a row. |
| macOS prompts | Microphone, then System Audio Recording (real device only) | Covered by the explainer. The button reads "Waiting for permission…". |
| Recording | Recorder: "● Recording", large timer, "Started by you · No bot joined", "Mic ✓ · Call audio: no sound yet", "Recording continues in the menu bar if you close this.", **Hide** / **Stop recording**. The window bar shows the same state in every view. | "Hide" is vague; otherwise clear. |
| Hide window | The recording bar stays in every view; the tray icon shows the elapsed time | *None in the window.* The tray menu still lists Recent and Projects under the recording lines. |
| Stop (from the bar or the tray) | The bar vanishes. Nothing else changes unless you happen to be looking at the library row ("Transcribing"). | *Did it save? Where did it go?* |
| Stop (from the recorder) | "Recording ended", "Transcribing on this Mac… 40%" / "Waiting to transcribe…" | *Is the audio safe if this fails?* Not said here. |
| Transcription fails | "The transcript couldn't be made." then raw text ("Transcription failed: whisper_full returned -7 The audio is saved…"), **Show audio**, **Try again** | A developer message in the headline area. |
| Transcript | Clean / Verbatim toggle, a one-line caption, Show audio, Find in transcript | Clear. |
| Find it later | ⌘K → type → result shows the date, project and "in Decisions" plus a snippet → opens that tab | A transcript hit opens the Transcript tab at the top, so you then look for the phrase. |
| Quit / relaunch | The tray has Quit QuietNote (or "Stop recording and quit"); the last place is remembered | *Closing the window doesn't quit.* That's expected for a menu bar app, and the recorder says so while recording. |

## 5-second tests

| Screen | After 5 seconds the user should know | What the current UI communicates | Verdict |
|---|---|---|---|
| First launch | 1. It's for meetings. 2. It records locally with no bot, only when I start. 3. Create a project first. | 1 yes (headline). 2 **no**: "workspace local and organized around projects". 3 yes. | Fail on 2 |
| Empty project | 1. This project has no meetings. 2. I can record or create one. 3. Where the button is. | 1 yes. 2 half: "Meetings for X will appear here" suggests they arrive by themselves. 3 yes. | Weak |
| New meeting | 1. A title is optional. 2. Which project it goes in. 3. How to start recording. | 1, 2 yes. 3 **no**: only Create meeting (except when opened from the tray). | Fail on 3 |
| Meeting page (idle) | 1. Which meeting. 2. It isn't recording yet. 3. Press Start recording. | 1 yes. 2 implied. 3 weak: grey button, competing "Add notes". | Weak |
| Recorder, first run | 1. What macOS will ask and why. 2. No bot. 3. Nothing records until Start. | All three, in a short list. | Pass |
| Recording | 1. It's recording. 2. For how long. 3. How to stop. | "● Recording", timer, Stop in the recorder and in every view's window bar; tray title timer. | Pass |
| Tray idle | 1. New meeting / Start recording. 2. Recent meetings. 3. Open QuietNote. | Yes, plus the Project submenu. | Pass |
| Tray recording | 1. What's recording and since when. 2. Stop. 3. Open meeting. | Yes, but Recent and Projects stay underneath and dilute it. | Weak |
| Stopped / transcribing | 1. Recording stopped. 2. Audio is saved. 3. Transcript is coming. | In the recorder, 1 and 3. From the bar/tray, **none**. The meeting page says "The audio is kept until the transcript is saved." | Fail when stopped outside the recorder |
| Meeting detail with transcript | 1. What was agreed. 2. Who said what. 3. Where my notes are. | Summary shows decisions and open actions; tabs are clear. | Pass |
| Clean / Verbatim | 1. Two views of the same words. 2. Clean only removes fillers. 3. The original is kept. | Segmented control plus caption "Clean removes simple filler words and repeated stutters. Verbatim keeps the original transcription." | Pass |
| Library | 1. My meetings by date. 2. Which need attention. 3. How to open one. | Date groups, a status only when needed, rows are buttons. | Pass |
| Search | 1. Type to search everything. 2. Where it matched. 3. Click to open. | Snippets, "in Decisions", highlighted match. | Pass |
| Settings / privacy | 1. What's true today. 2. What I can change. 3. Nothing hidden. | "Active now" facts are clear. "Planned" shows a disabled "Allow cloud processing" and an inert retention picker in the real recording app. | Weak: reads as security theater |
| Recovery | 1. What happened. 2. Whether audio survived. 3. What to do. | Banner "Recovered recording… the audio up to that point was saved." and a meeting notice. | Pass |
| Transcription error | 1. It failed. 2. The recording is still saved. 3. Retry. | 2 and 3 exist but sit behind a raw technical message. | Weak |

## Click-count audit

| Job | Before | Target | After this pass |
|---|---|---|---|
| Start recording from the app (existing project) | New meeting → Create meeting → Start recording → Start recording (4 clicks, 2 modals) | ≤ 2 | New meeting → **Start recording** (2 clicks, 1 modal; first run adds the permission explainer's Start) |
| Start recording on an existing idle meeting | Start recording → Start recording (2) | 1 | **Start recording** (1) |
| Start recording from the tray | Start recording… → Start recording (2) | 1–3 | Unchanged (2) |
| Start from the tray with no project yet | Start recording… → New project → Create project → (intent lost) → New meeting → Create → Start ×2 | 1–3 | Start recording… → Create project → **Start recording** (3) |
| Stop recording | 1 (recorder, window bar, meeting notice or tray) | 1 | 1 |
| Reopen the current meeting | 1 (title in the window bar, or the tray's Open meeting) | 1 | 1 |
| Find a recent meeting | Home → row (1–2) | 1–2 | 1–2 |
| "What did we decide about SSO in the Acme meeting?" | ⌘K → type "SSO" → click (opens Decisions) | shortcut → type → click | Same; transcript hits also land on the phrase |

## Terminology

| Concept | Canonical term | Alternatives found | Action |
|---|---|---|---|
| The main object | Meeting | — | — |
| Grouping | Project | — | — |
| Audio capture | Recording / Start recording / Stop recording | "Capture", "Start capture", "Capturing", "Confirm before capture", "while capture was running" | Fixed in the desktop paths. The **prototype recorder** (browser preview, Linux) deliberately keeps "capture", because it records nothing and "Recording" would be false. |
| Text of the audio | Transcript / Transcription | "The transcript couldn't be made" | → "Transcription couldn't finish" |
| Cleaned view | Clean / Verbatim | — | — |
| The other side of the call | Call audio | "System audio recording" (the macOS permission name, used only when naming that permission) | Kept: the explainer maps the permission name to what it does. |
| Where files live | Local archive | "archive", "Markdown workspace" (Advanced only) | OK |
| Error status | Needs attention | — | Observe (see 16) |

Button copy: *Hide* → **Hide recorder**; *Try again* (transcription) → **Retry transcription**. *Try again* (microphone) stays, because it retries the start. *Add notes*, *Open meeting*, *Create project*, *Start recording* and *Stop recording* already describe outcomes. No *Continue*, *Submit* or *Done* was found.

## Issues

### 1. First launch doesn't say what QuietNote does with audio
- **Location**: Welcome screen (`QuietNoteApp.tsx` `Welcome`)
- **What a first-time user expects**: to learn in one line that this records meetings locally, with no bot, only when they start.
- **What currently happens**: "QuietNote keeps your meeting workspace local and organized around projects." Recording, transcription and the no-bot promise aren't mentioned.
- **Why this matters**: the product's core promise, and its main difference from cloud note-takers, isn't visible on the only screen everyone sees.
- **Severity**: High
- **Recommended fix**: replace the line with one plain sentence: "Records and transcribes your meetings on this Mac. No bot joins the call, and nothing records until you press Start." The browser preview says that recording needs the desktop app.

### 2. Starting a recording takes four clicks and the same label twice
- **Location**: New meeting dialog; meeting page → recorder (`confirm` preference)
- **What a first-time user expects**: New meeting → Start recording.
- **What currently happens**: New meeting only has **Create meeting**. The meeting page then has *Start recording*, which opens the recorder with another **Start recording** (the confirm preference defaults to on). The tray is the only way to record straight from New meeting.
- **Why this matters**: the most frequent job has avoidable steps, and pressing Start recording without recording starting feels broken.
- **Severity**: High
- **Recommended fix**: when recording is available, New meeting's primary button is **Start recording** (Enter), with **Create meeting** as secondary. *Start recording* on a meeting starts at once. Remove the "Confirm before capture" preference. The first-run explainer still waits for an explicit Start before macOS asks.

### 3. On an idle meeting, Start recording is the weakest-looking action
- **Location**: meeting header (`MeetingDetail.tsx`)
- **What a first-time user expects**: the obvious next step on a meeting that hasn't happened yet is to record it.
- **What currently happens**: a grey secondary button top-right, while the largest block is "No summary yet… Add notes".
- **Why this matters**: visual hierarchy points at notes, not at the main job.
- **Severity**: High
- **Recommended fix**: when recording is available, make it the page's one primary action, with a record dot.

### 4. Stopping from the window bar or the tray gives no feedback
- **Location**: recording bar and tray Stop recording (Shell)
- **What a first-time user expects**: confirmation that the recording stopped and was saved, and where it went.
- **What currently happens**: the bar disappears. Unless the library happens to be on screen, nothing says the recording was saved or is being transcribed.
- **Why this matters**: "Did I just lose it?" is the worst moment for a recording app.
- **Severity**: High
- **Recommended fix**: a status banner, "Recording saved. Transcribing “Acme onboarding” on this Mac.", with **Open meeting**. It becomes "Transcript ready for “…”." when done, and hides while that meeting is open (its own notice says the same).

### 5. The recorder's after-Stop state doesn't say the audio is safe
- **Location**: recorder, processing state (`Capture.tsx`)
- **What a first-time user expects**: recording stopped; audio saved; transcript on the way.
- **What currently happens**: "Recording ended · Transcribing on this Mac… 40%" or "Waiting to transcribe…".
- **Why this matters**: people worry about losing a meeting most right after stopping.
- **Severity**: High
- **Recommended fix**: "Recording saved. Transcribing on this Mac… 40%" / "Recording saved. Waiting to transcribe…". The percentage comes from Whisper's own progress callback, not a fake animation, so it stays.

### 6. Transcription failures show developer messages
- **Location**: meeting error notice, recovered-recording notice (`MeetingDetail.tsx`), and the banner raised by the Rust worker (`capture.rs` `work`)
- **What a first-time user expects**: what happened, whether the recording is safe, what to do.
- **What currently happens**: "The transcript couldn't be made." then "Transcription failed: whisper_full returned -7 The audio is saved (2 min), so you can try again." The banner also appends the raw error.
- **Why this matters**: the technical text is the most prominent part and hides the reassurance.
- **Severity**: High
- **Recommended fix**: "Transcription couldn't finish. Your recording is still saved (2 min)." Actions: **Retry transcription**, **Show audio**. The raw reason goes under a *Details* disclosure; the banner drops it.

### 7. "Capture" and "Recording" are used for the same thing
- **Location**: Settings ("Confirm before capture", "Capture starts only when you choose"), the no-audio interrupted notice ("while capture was running"), the meeting header fallback ("Start capture")
- **What a first-time user expects**: one word.
- **What currently happens**: both.
- **Why this matters**: two words suggest two features.
- **Severity**: Medium
- **Recommended fix**: use "recording" everywhere the desktop app can show it. Keep "capture" only in the prototype recorder, which records nothing.

### 8. "Delete audio after transcribing" doesn't say when it applies
- **Location**: Settings → Privacy
- **What a first-time user expects**: to know whether turning it on deletes audio that already exists.
- **What currently happens**: "A meeting's audio is deleted once its transcript is saved…". It doesn't say that existing audio is untouched and that only transcriptions finished after it's turned on are affected.
- **Why this matters**: a privacy setting has to be precise, or people either over-trust it or fear it.
- **Severity**: Medium
- **Recommended fix**: "Audio is deleted only after its transcript is saved, for meetings transcribed after you turn this on. Audio you already have is kept. If transcription fails, the audio is kept so you can retry. Deleted audio can't be transcribed again."

### 9. Inert "Planned" controls in the real recording app
- **Location**: Settings → Privacy → Planned (desktop)
- **What a first-time user expects**: settings that do something.
- **What currently happens**: a disabled "Allow cloud processing" switch and a "Keep meeting data: Forever / 30 / 7 days" picker that does nothing.
- **Why this matters**: a cloud switch in a local-only app raises the question it's meant to answer; an inert retention picker is security theater.
- **Severity**: Medium
- **Recommended fix**: hide the Planned group when recording is real. The browser preview keeps it, where it honestly describes what isn't built.

### 10. The tray keeps the idle menu while recording
- **Location**: `tray.rs` `entries`
- **What a first-time user expects**: a control surface. What's recording, Stop, Open meeting.
- **What currently happens**: the recording lines, then Recent meetings and the Project submenu, as when idle.
- **Why this matters**: extra rows dilute the one thing that matters while recording.
- **Severity**: Medium
- **Recommended fix**: while recording, hide Recent and Projects. Keep the recording lines, Stop, Open meeting, any transcribing line, Open QuietNote, Settings… and "Stop recording and quit".

### 11. The recording bar's problem icon has no accessible name
- **Location**: `RecordingBar`
- **What a first-time user expects**: a screen reader to announce the problem.
- **What currently happens**: an icon with a `title` only, so it's hover-only and unnamed.
- **Why this matters**: device problems are the most important in-recording state.
- **Severity**: Medium (accessibility)
- **Recommended fix**: `role="img"` with `aria-label` set to the problem. The full text is also in the recorder and the tray.

### 12. "Hide" in the recorder is vague
- **Location**: recorder while recording
- **What a first-time user expects**: to know what gets hidden. The recording? The window?
- **What currently happens**: "Hide", with an explanatory line above.
- **Severity**: Low
- **Recommended fix**: "Hide recorder".

### 13. Tray "Start recording…" with no project drops the intent
- **Location**: Shell `newMeeting` → `createProject`
- **What a first-time user expects**: create the project, then carry on to record.
- **What currently happens**: after the project is created, the user lands in the empty project and has to start over.
- **Severity**: Medium
- **Recommended fix**: after the project is created, open New meeting with Start recording.

### 14. The empty project doesn't suggest recording
- **Location**: library empty state
- **What currently happens**: "Nothing here yet. Meetings for Acme will appear here." That suggests meetings arrive by themselves.
- **Severity**: Low
- **Recommended fix**: "No meetings in Acme yet." / "Record a meeting, or create one to take notes." (the preview has no recording, so it says "Create a meeting to take notes.").

### 15. A search hit in a transcript lands at the top of the transcript
- **Location**: search → meeting Transcript tab
- **What a first-time user expects**: to see the matching passage.
- **What currently happens**: the tab opens unfiltered; the phrase may be far down a one-hour transcript.
- **Severity**: Medium
- **Recommended fix**: prefill *Find in transcript* with the search, so only matching turns show. Clearing it shows everything.

### 16. "Needs attention" is used for two different problems
- **Location**: status label (library and meeting meta)
- **What currently happens**: a failed transcription (audio kept) and an interrupted meeting with no audio both read "Needs attention". The notice on the meeting explains which.
- **Severity**: Low
- **Recommended fix**: observe during alpha. Rename it only if testers misread it.

### 17. The recovered-recording banner comes back every launch until dismissed in the meeting
- **Location**: Shell banner
- **What currently happens**: *Dismiss* on the banner lasts for the session; *Dismiss* in the meeting clears it for good.
- **Severity**: Low
- **Recommended fix**: observe. It errs toward telling the user.

### 18. About says "Prototype" in the real recording app
- **Location**: Settings → About
- **Severity**: Low
- **Recommended fix**: later, as a product call on the alpha name and version.

### 19. Closing the window when not recording hides QuietNote to the menu bar without saying so
- **Location**: window lifecycle
- **What currently happens**: the recorder explains this while recording; otherwise it's silent, which is conventional for menu bar apps.
- **Severity**: Low
- **Recommended fix**: observe.

### 20. A lone "Mm." is removed as a filler
- **Location**: `cleanup.rs` (`FILLERS` includes `mm`)
- **What currently happens**: "Mm." on its own, which can be an acknowledgement, disappears in Clean. "Mm-hmm" and "Uh-huh" are kept.
- **Severity**: Low
- **Recommended fix**: observe with real transcripts. Verbatim always has it.

### 21. The first-run permission explainer is macOS-only
- **Location**: recorder first run
- **What currently happens**: Windows doesn't prompt the same way, so nothing is shown there; `docs/WINDOWS.md` tracks the Windows risks.
- **Severity**: Low
- **Recommended fix**: later, once Windows is tested.

## Areas checked with no change needed

- **Permissions**: the explainer comes before macOS asks, and auto-start is suppressed while the permission is undetermined. A denied microphone shows "Microphone access is off" with Open System Settings and Try again, and the meeting stays idle (test L). A revoked mic mid-recording shows "Your microphone is silent" with Open System Settings. System audio can't be queried, so after 20 s of silence "No call audio yet" explains what to allow.
- **Recording confidence**: the word "Recording", the elapsed time, a pulsing dot and a labelled Stop appear in the recorder, in the window bar of every view, and on the meeting page. The tray title shows the same clock. The dot is never the only signal.
- **Hide/reopen**: one window, a single-instance plugin, and Rust owns the session and its start time, so the window and tray timers agree (live-checked earlier, see [QA-RECORDING.md](QA-RECORDING.md)).
- **Clean / Verbatim**: both views come from `transcript.json`; switching writes nothing (test J). Cleanup is delete-only and keeps "like", "you know", "I mean", self-corrections, numbers, names and quoted speech (`cleanup.rs` tests, extended in this pass).
- **Readability**: breaks are added only where a heard pause and a capital agree, and Whisper's capitalized mid-line filler marks a new utterance. Nothing paraphrases.
- **Audio retention**: `save_transcript` writes the transcript, then `ready`, and only then deletes; `record_failure` never deletes (Rust tests).
- **Search**: no file paths in results; the date, project and matching tab are shown; ⌘K focuses the field; Enter opens the first result.
- **Cards**: one bordered surface per notice, with no card-on-card. Dividers are used elsewhere.
- **Typography**: one sans family; sizes 22/26/16/14/13/12/11; muted text #5f6573 on #fcf9f3 is about 5.6:1.
- **Accessibility**: dialogs are `role=dialog` with a label, focus trap and Escape; tabs are ARIA tabs with arrow keys; focus rings are visible; `prefers-reduced-motion` stops the pulsing dot and transitions; status is always text plus a dot.
- **Privacy**: nothing records without a press; no network use except Connections' explicit Send; transcription is local.

## Severity buckets

**Fix before alpha**: 1, 2, 3, 4, 5, 6 (first use, recording state, transcription, trust); 7, 8, 9 (trust and precision); 10 (tray agrees with the window); 11 (accessibility); 12, 13, 14, 15 (tiny, obvious value).

**Observe during alpha**: 16, 17, 19, 20.

**Later**: 18, 21.

## What changed

All "Fix before alpha" items were implemented without new features or architecture changes. The tests were updated to the new intent and extended; none were loosened:
- **Welcome** says what QuietNote does and doesn't do (1).
- **New meeting** has **Start recording** as its primary button when recording is available. *Start recording* on a meeting starts at once, and the confirm preference is gone. The first-run explainer still waits for Start (2).
- An idle meeting's **Start recording** is its primary action (3).
- Stopping anywhere shows **Recording saved…** with Open meeting, then **Transcript ready…** (4).
- The recorder says **Recording saved** after Stop (5).
- Failures read **Transcription couldn't finish. Your recording is still saved.** with **Retry transcription**, and the raw reason under Details (6).
- "Recording" is used throughout the desktop app (7).
- The Delete audio copy is precise (8). The Planned group is hidden when recording is real (9).
- The tray is slimmed while recording (10). Its idle *New meeting…* and *Start recording…* opened the same dialog after change 2, so it keeps one entry: *Start recording…*, or *New meeting…* where recording is unavailable. The problem icon is labelled (11). "Hide recorder" (12).
- The tray's record intent survives project creation (13). The empty project copy is clearer (14). Transcript search hits open filtered to the phrase (15).

## Fresh-eyes pass

After the fixes, the app was reset (a fresh browser context: empty archive, no preferences, microphone permission undetermined) and walked through again as a new user, using the desktop recording UI through the test stand-in. The real menu bar and the macOS prompts can't be driven here; those checks are in [MANUAL-QA.md](MANUAL-QA.md).

| Question | Answer from the interface alone | Needs docs? |
|---|---|---|
| What is this? | "Keep the useful part of every meeting." / "Records and transcribes your meetings on this Mac. No bot joins the call, and nothing records until you press Start." | No |
| What should I click? | The most prominent button on each screen: **Create your first project** → (empty project) **New meeting** → **Start recording** | No |
| Is it recording? | "● Recording" with a running timer and **Stop recording** in the recorder; the same in the window bar of every view and on the meeting; the tray title timer | No |
| Can I close this safely? | While recording: "Recording continues in the menu bar if you close this." While transcribing: "You can keep working or close the window." | No (when idle, closing hides to the menu bar without saying so; see 19) |
| What happens after I stop? | "Recording saved · Transcribing on this Mac… n%" in the recorder, or a **Recording saved** banner with Open meeting wherever you are; then **Transcript ready** | No |
| Where is the transcript? | The meeting's Transcript tab (Clean by default, Verbatim one click away); the Transcript ready banner opens straight to it | No |
| How do I find this meeting tomorrow? | Home (grouped Today / Yesterday…), the project in the sidebar, or ⌘K from anywhere | No |

Remaining friction, left for alpha observation rather than fixed:
- On an idle meeting, both the sidebar's *New meeting* and the meeting's *Start recording* are cobalt. They're separate contexts and the meeting's button is nearer the content, but testers should be watched for hesitation here.
- On an idle meeting, the largest block is still "No summary yet." Once Start recording is primary it no longer competes, but it's visual weight with no action behind it.
- Issues 16–21 above.
