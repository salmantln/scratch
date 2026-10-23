# Performance

Rough numbers from the recording hardening pass (2026-09-29), measured on one machine. They show where the costs are; they aren't guarantees.

**Machine:** MacBook Pro, Apple M3 Pro (12 cores), 18 GB RAM, macOS 26.6. Release build. Whisper runs on Metal.

## Recording
Measured with the live recorder test (`records_live`, real built-in mic plus the system-audio tap), sampled every 10 s:

| Run | Memory (RSS) | CPU | Track length vs wall clock |
|---|---|---|---|
| 30 s | 18–20 MB | <1% | mic −0.17 s, call −0.23 s |
| 60 min | 13–20 MB, flat | 0.7% mean, 4.5% peak | mic −0.17 s, call −0.54 s |

- **No drift over an hour.** The small shortfall is a fixed startup cost (opening devices and the resampler's delay), not drift.
- **Disk:** two 16 kHz mono 16-bit tracks, about 115 MB per track per hour (about 230 MB an hour). Both files are flushed every second.
- **The UI timer** is computed from the wall-clock start, so it can't drift from the tray's.
- **Found and fixed during the soak:** the call-audio tap's device sometimes appeared in Core Audio's device list only seconds after it was created. At the start of the 60-minute run, call audio was missing for about 60 s. It was reported in the UI, padded with silence, and then reconnected automatically. QuietNote now waits up to 3 s for the device, with a fresh id each attempt. Repeated starts afterwards found it immediately.

## Transcription
Synthetic two-voice meetings (the macOS `say` voices, with fillers and pauses) on two tracks, through the ignored `transcribes_a_recording` test, measured with `/usr/bin/time -l`:

| Meeting | Wall time | Speed | Peak RSS |
|---|---|---|---|
| 5 min, headphones | 25 s | ~12× real time | ~740 MB |
| 5 min, speakers (loud or quiet echo) | 24 s | ~12× | ~740 MB |
| 5 min, user talking over a remote speaker | 26 s | ~12× | ~740 MB |
| 30 min, headphones | 127 s | ~14× | 783 MB (975 MB peak footprint) |
| 60 min, headphones | 252 s | ~14× | 894 MB (1.2 GB peak footprint) |

- CPU time is small (about 48 s of CPU for 60 minutes of audio) because the model runs on the GPU.
- Transcription runs on a background thread, the UI only receives progress events, and recording another meeting at the same time works.

**Quality checks on the same audio:**
- **User lines are never lost.** Every one of the user's lines was kept in every condition (5 lines × every repetition).
- **No decoder loops remain.** Before the fix, Whisper's built-in VAD stitching produced repetition loops on the call track ("I will send the link to the link to the link…"). They're gone now: QuietNote transcribes its own speech chunks (≤25 s, cut only at pauses), retries a looping chunk with beam search, and removes any remaining repeats.
- **Echo** (mic hearing the call through speakers), counted as call sentences left under "You":

  | Condition | Call sentences left under "You" |
  |---|---|
  | Loud speakers | 0 |
  | Quiet speakers | 0 |
  | Talking over | 1 (a duplicate line at a chunk edge, not a lost line) |

- **No initial prompt.** With a prompt built from the meeting name, Whisper wrote the name ("Acme.") into the transcript as if someone had said it, so no prompt is used.

## Live transcript
The same model follows a recording while it runs (macOS). Measured with the ignored `follows_a_recording` test, which replays real recordings (two tracks) through the live pass three seconds at a time, as the recorder feeds it:

| Recording | Model load | Time per 3 s step | Words live vs. full pass | Memory (RSS) |
|---|---|---|---|---|
| 4 min, one speaker | 0.34 s | 0.29 s mean, 1.6 s slowest | 219 vs. 240 | 673 MB |
| 2 min, one speaker | 0.41 s | 0.26 s mean, 1.6 s slowest | 170 vs. 179 | — |

- **It keeps up.** The slowest step is about half the time between steps, so the text runs a few seconds behind speech (the sentence has to end first, then the next step picks it up).
- **It's a draft.** It gets a few words fewer than the full pass, and splits into more turns. The full pass after Stop still makes the transcript that's kept, and it's unchanged: the same recording gives word-for-word the same transcript as before this change.
- **Memory:** the model stays loaded for the whole recording, about 650–700 MB more. It's freed when the recording stops. The full pass after Stop loads its own copy.
- Not measured yet: CPU and GPU load during a real call with the live transcript on, and a recording longer than a few minutes.

## Echo cancellation
The mic track goes through WebRTC's AEC3 (Sonora, in Rust) as it's written, with the call track as the reference; only the linear filter's output is kept (2026-10-23, same machine):

- **Cost:** 129 s of real audio in 0.5 s (about 250× real time); a debug build is still about 9× real time. It adds up to 200 ms of buffering to the mic writer, never to the recording's clock.
- **Synthetic echo** (noise bursts played back 60 ms later at −6 dB, `cancels_the_call_heard_through_speakers_but_keeps_the_users_voice`): over 15 dB less echo once adapted, whichever track arrives first; the user talking over it stays within 3 dB.
- **Real voice, simulated room** (a real mic recording plus TTS call speech played back through a 120 ms room at −18 dB and −8 dB, then the full Whisper pass):

  | Echo | Without cancellation | With it |
  |---|---|---|
  | −18 dB (quiet speakers) | A call line repeated as "You"; most of the user's words lost while both talk | No repeat; the user's words kept while both talk |
  | −8 dB (loud speakers) | No repeat, but the user's words while both talk are lost entirely | No repeat; the user's words while both talk come back partly garbled |

- **Found and fixed:** AEC3's suppressor (after the linear filter) muted the user under continuous call audio. On a real recording with music playing, "working on QuietNode, the app we're currently using" became "working quite not with it currently". Keeping only the linear output fixed that. Right after loud call audio starts, the filter's estimate can also make a block *louder*; such blocks are kept as they were. Talking over loud music still loses a word or two ("QuietNode" → "quiet not"), so the setting can be turned off.
- Not measured yet: a real call on speakers, and the delay between tracks on a live device (the offline tests line the tracks up by file position, as the recorder does).

## Telling the others apart
Pyannote segmentation 3.0 and 3D-Speaker ERes2Net (VoxCeleb) through sherpa-onnx, on the CPU, after Stop (`splits_voices_in_a_recording`):

- **Speed:** a 56 s four-voice call in 1.9 s with a half-window step (about 2 minutes per hour of audio); a 0.1 step took 8.6 s and grouped no better.
- **Accuracy on synthetic voices** (four macOS voices, twelve turns): two male voices and the group of female voices were always told apart; two similar female voices (Samantha and Karen) were merged at every threshold tried, and lower thresholds split one person in two. WeSpeaker CAM++ did worse on the same call.
- Not measured yet: real people on a real call, and more than four voices.

## Parakeet live transcript
English meetings switch from Whisper to Parakeet TDT 110M once Whisper has settled the language (`follows_a_recording` with `QUIETNOTE_TEST_PARAKEET=1`, a real 129 s recording, music playing in its second half):

| | Whisper | Parakeet |
|---|---|---|
| Step | every 3 s, 272 ms mean | every 1 s, 130–150 ms mean, plus the sentence being spoken |
| Memory (RSS) | 660 MB | 210–455 MB (Whisper is freed after the switch) |
| Clean speech (first 73 s) | lost "to check how we can convert" | complete |
| Over loud music | mostly right | lost one sentence, added a "No." |

The full Whisper pass after Stop still makes the kept transcript, so the draft's misses don't carry over.

## App
- **Not measured yet: idle, recording and transcribing memory of the signed app.** A `tauri dev` instance was running during the pass, and the single-instance guard (working as intended) handed the signed app's launch to it.
- A debug dev instance measured **53 MB** for its main process at idle. WebKit's web content runs in separate system processes, which aren't included.
- From the measurements above:
  - While recording: about 10–20 MB more (the recorder).
  - While recording with the live transcript on (macOS): about 650–700 MB more, until the recording stops.
  - While transcribing: about 750–900 MB more for the duration of the job. The model is loaded per job and freed afterwards.

## Caveats
- The audio is synthetic and clean. Real rooms, accents, crosstalk and Bluetooth (HFP) quality will lower accuracy, and echo in a real room is messier than a delayed copy.
- Windows hasn't been measured. Whisper runs on the CPU there, and large-v3-turbo is expected to be much slower (roughly real time). See [WINDOWS.md](WINDOWS.md).
- These are single runs, not averages.
