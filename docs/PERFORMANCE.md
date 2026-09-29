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

## App
- **Not measured yet: idle, recording and transcribing memory of the signed app.** A `tauri dev` instance was running during the pass, and the single-instance guard (working as intended) handed the signed app's launch to it.
- A debug dev instance measured **53 MB** for its main process at idle. WebKit's web content runs in separate system processes, which aren't included.
- From the measurements above:
  - While recording: about 10–20 MB more (the recorder).
  - While transcribing: about 750–900 MB more for the duration of the job. The model is loaded per job and freed afterwards.

## Caveats
- The audio is synthetic and clean. Real rooms, accents, crosstalk and Bluetooth (HFP) quality will lower accuracy, and echo in a real room is messier than a delayed copy.
- Windows hasn't been measured. Whisper runs on the CPU there, and large-v3-turbo is expected to be much slower (roughly real time). See [WINDOWS.md](WINDOWS.md).
- These are single runs, not averages.
