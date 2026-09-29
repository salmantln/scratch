# Windows readiness

Recording and transcription compile for Windows, but **nothing has been run on Windows yet**. This page lists what was checked by reading the code, the known risks, and what to verify first. The manual checklist is in [QA-RECORDING.md](QA-RECORDING.md).

## Capture (`src-tauri/src/recorder.rs`)
- **Mic**: cpal on the default WASAPI input device.
  - If the microphone privacy toggle is off, we expect cpal to report `PermissionDenied`, which becomes "Microphone access is off" with Open Settings (`ms-settings:privacy-microphone`). This is unverified: Windows may instead deliver silence. In that case the 20-second silent-mic notice is the fallback.
- **Call audio**: WASAPI loopback, from an input stream built on the default output device.
  - Loopback delivers nothing while nothing plays. The writer pads silence by wall-clock time so both tracks stay aligned, and the stall watchdog is off for this track (`WATCH_STALL`).
  - Unverified: how well alignment holds over long silent stretches.
- **Device changes**: every 2 s the capture loop compares the default input and output device ids with the ones it opened. On a change it reopens and says so ("Call audio now comes from …"). cpal 0.18 also reroutes default-device streams on its own; reopening explicitly keeps the behavior the same on both platforms.
- **Exclusive-mode apps** can block loopback or the mic. Expected result: a stream error, then the "Reconnecting…" notice. Untested.
- **No permission prompt exists on Windows**, so the first-run explainer (tied to the macOS permission state) doesn't show. Windows users get the regular ready-state copy.

## Transcription (`src-tauri/src/transcribe.rs`)
- **Model path encoding.** whisper.cpp opens files with narrow (ANSI) paths.
  - A per-user install under a profile with a non-ASCII name (`C:\Users\José\…`) could fail to open the model. The main model is therefore read in Rust and loaded from memory on Windows (`WhisperContext::new_from_buffer_with_params`), at the cost of a brief extra ~550 MB during load.
  - **The VAD model is still opened by path** (whisper-rs has no buffer API for it). This is an open risk for such profiles; a failure there would show as a clear transcription error, with the audio kept.
- **CPU only.** There's no GPU build on Windows. large-v3-turbo q5 on a typical 8-core laptop CPU is expected to run at roughly real time or slower, so a 1-hour meeting could take about an hour to transcribe. Progress is shown and the app stays usable. Measure this before promising timings.
- **Build**: whisper-rs needs CMake and LLVM (`LIBCLANG_PATH`, set in `release.yml`).

## App shell
- **Tray**: left click opens the window and right click opens the menu. While recording, the icon switches to `icons/tray-recording.png` (red dot) and the tooltip shows the elapsed time. Menu `&` characters are escaped.
- **Paths**: the archive lives under `%APPDATA%\app.quietnote.desktop\meetings`. Relative paths inside metadata use `/`; "Show audio" converts them to `\` for Explorer.
- **Disk space** is read with `fs4` (`GetDiskFreeSpaceExW`).
- **Quit**: tray Quit ("Stop recording and quit" while recording) and `RunEvent::Exit` finalize the recording. Recovery on the next launch works as on macOS.

## Verify first on Windows
1. Record 5 minutes with speakers and with a headset. Check both WAVs play and the transcript separates You and Others.
2. Turn off the microphone privacy toggle and press Start.
3. Change the default output device mid-recording.
4. Record for 30 minutes with long silent stretches, and check the two tracks are the same length.
5. Time transcription of a 30-minute meeting.
6. Install for a user with a non-ASCII profile name and transcribe.
