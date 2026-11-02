//! Recordings packed with Opus once they're transcribed (`compressAudio`, on by default): a track becomes
//! `mic.qno` / `system.qno`, about a tenth of its size. Recording stays uncompressed (`sealed`, or a WAV),
//! so a crash loses at most a second; a track is packed after its transcript is saved, and unpacked
//! before more of the meeting is recorded, since the recorder appends samples. A packed track keeps the
//! encryption it had: an encrypted one's frames are sealed with the same key and bound to the file and
//! their place in it, as in `sealed`. Each copy is written whole and synced before it replaces the other,
//! so a crash halfway leaves one whole track (`tidy` clears up after it).
use crate::sealed::{self, NONCE, TAG, TRACKS};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

pub const EXT: &str = "qno";
const MAGIC: &[u8; 4] = b"QNO1";
/// Magic, sample rate (u32), channels (u16), a random file id, whether frames are sealed (u8) and the
/// encoder's lookahead in samples (u16): bound into every sealed frame.
const HEADER: usize = 4 + 4 + 2 + 16 + 1 + 2;
/// Each frame starts with how many samples it holds and how long it is, in the clear, so a track's
/// length is read without the key, as with `sealed`.
const FRAME_HEAD: usize = 8;
const MAX_FRAME: u64 = 4 << 20;

fn invalid(what: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, what.to_string()) }

pub fn is(path: &Path) -> bool { path.extension().is_some_and(|e| e == EXT) }
/// Whether a packed track's frames are encrypted.
pub fn sealed(path: &Path) -> bool {
    let mut header = [0u8; HEADER];
    File::open(path).and_then(|mut f| f.read_exact(&mut header)).is_ok() && &header[..4] == MAGIC && header[26] == 1
}

struct Frame { samples: u32, start: usize, end: usize }
struct Scan { header: [u8; HEADER], sealed: bool, lookahead: usize, frames: Vec<Frame> }
impl Scan {
    fn samples(&self) -> u64 { self.frames.iter().map(|f| f.samples as u64).sum() }
    fn rate(&self) -> u32 { u32::from_le_bytes(self.header[4..8].try_into().expect("four bytes")) }
}
/// Reads the header and each whole frame's place, not its audio. A partial last frame (never written by
/// `place`, which renames a whole file) ends the track.
fn scan_from(r: &mut (impl Read + Seek), size: u64) -> io::Result<Scan> {
    let mut header = [0u8; HEADER];
    r.seek(SeekFrom::Start(0))?;
    r.read_exact(&mut header).map_err(|_| invalid("Not a QuietNote recording"))?;
    if &header[..4] != MAGIC { return Err(invalid("Not a QuietNote recording")); }
    let sealed = header[26] == 1;
    let lookahead = u16::from_le_bytes([header[27], header[28]]) as usize;
    let extra = if sealed { (NONCE + TAG) as u64 } else { 0 };
    let (mut at, mut frames, mut head) = (HEADER as u64, Vec::new(), [0u8; FRAME_HEAD]);
    while at + FRAME_HEAD as u64 <= size {
        r.seek(SeekFrom::Start(at))?;
        r.read_exact(&mut head)?;
        let samples = u32::from_le_bytes(head[..4].try_into().expect("four bytes"));
        let len = u32::from_le_bytes(head[4..].try_into().expect("four bytes")) as u64;
        let end = at + FRAME_HEAD as u64 + extra + len;
        if len > MAX_FRAME || end > size { break; }
        frames.push(Frame { samples, start: (at + FRAME_HEAD as u64) as usize, end: end as usize });
        at = end;
    }
    Ok(Scan { header, sealed, lookahead, frames })
}
fn file_scan(path: &Path) -> io::Result<Scan> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    scan_from(&mut file, size)
}
/// How long a packed track is, read without the key.
pub fn duration(path: &Path) -> io::Result<std::time::Duration> {
    let scan = file_scan(path)?;
    Ok(std::time::Duration::from_secs_f64(scan.samples() as f64 / scan.rate().max(1) as f64))
}

/// After a crash halfway through packing or unpacking: drops unfinished copies, and a packed track
/// beside a recorded one, which is the whole track (it's removed only once the packed one is in place).
pub fn tidy(audio: &Path) {
    for entry in std::fs::read_dir(audio).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().ends_with(".part") { let _ = std::fs::remove_file(entry.path()); }
    }
    for name in TRACKS {
        let packed = audio.join(format!("{name}.{EXT}"));
        if packed.exists() && [sealed::EXT, "wav"].iter().any(|e| audio.join(format!("{name}.{e}")).exists()) { let _ = std::fs::remove_file(packed); }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use codec::*;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod codec {
    use super::*;
    use crate::sealed::Key;
    use std::io::{Cursor, Write};
    use std::sync::Arc;
    pub(super) fn scan(bytes: &[u8]) -> io::Result<Scan> { scan_from(&mut Cursor::new(bytes), bytes.len() as u64) }
    fn fail(e: impl std::fmt::Display) -> String { format!("Couldn’t pack the audio: {e}") }
    /// 20 ms Opus packets at 16 kHz, 500 to a frame (10 s).
    const PACKET: usize = 320;
    const PER_FRAME: usize = 500;
    /// Speech at 24 kbit/s: transcripts come out as from the recording (docs/PERFORMANCE.md).
    pub const BITRATE: i32 = 24_000;
    const DAMAGED: &str = "This recording is damaged or was encrypted with another key, so it can’t be read.";
    /// What a sealed frame is bound to: the file's header, the frame's place and how many samples it holds.
    fn bound(header: &[u8], index: usize, samples: u32) -> Vec<u8> { [header, &(index as u32).to_le_bytes(), &samples.to_le_bytes()].concat() }

    /// A packed file of `samples` (16-bit, mono), with frames sealed when there's a key.
    pub fn encode(rate: u32, samples: &[i16], key: Option<&Key>) -> Result<Vec<u8>, String> { encode_at(rate, samples, key, BITRATE) }
    pub(super) fn encode_at(rate: u32, samples: &[i16], key: Option<&Key>, bitrate: i32) -> Result<Vec<u8>, String> {
        let mut encoder = opus::Encoder::new(rate, opus::Channels::Mono, opus::Application::Voip).map_err(fail)?;
        encoder.set_bitrate(opus::Bitrate::Bits(bitrate)).map_err(fail)?;
        // The decoder's output trails its input by this much; the end is padded with it, and it's
        // dropped from the start again when unpacking.
        let lookahead = encoder.get_lookahead().map_err(fail)? as usize;
        let mut header = [0u8; HEADER];
        header[..4].copy_from_slice(MAGIC);
        header[4..8].copy_from_slice(&rate.to_le_bytes());
        header[8..10].copy_from_slice(&1u16.to_le_bytes());
        sealed::random(&mut header[10..26]).map_err(fail)?;
        header[26] = key.is_some() as u8;
        header[27..29].copy_from_slice(&(lookahead as u16).to_le_bytes());
        let (total, mut out) = (samples.len(), header.to_vec());
        let packets = (total + lookahead).div_ceil(PACKET);
        let frames = total.div_ceil(PACKET * PER_FRAME);
        let (mut tail, mut packet) = ([0i16; PACKET], [0u8; 1500]);
        for frame in 0..frames {
            let first = frame * PER_FRAME;
            let last = if frame + 1 == frames { packets } else { first + PER_FRAME };
            let mut body = Vec::new();
            for p in first..last {
                let start = p * PACKET;
                let input = if start + PACKET <= total { &samples[start..start + PACKET] } else {
                    let have = total.saturating_sub(start);
                    tail.fill(0);
                    tail[..have].copy_from_slice(&samples[start.min(total)..start.min(total) + have]);
                    &tail[..]
                };
                let n = encoder.encode(input, &mut packet).map_err(fail)?;
                body.extend_from_slice(&(n as u16).to_le_bytes());
                body.extend_from_slice(&packet[..n]);
            }
            let count = (total - first * PACKET).min(PACKET * PER_FRAME) as u32;
            out.extend_from_slice(&count.to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            match key {
                Some(key) => {
                    let (nonce, tag) = key.seal(&bound(&header, frame, count), &mut body).map_err(fail)?;
                    out.extend_from_slice(&nonce);
                    out.extend_from_slice(&body);
                    out.extend_from_slice(&tag);
                }
                None => out.extend_from_slice(&body),
            }
        }
        Ok(out)
    }

    /// Unpacks every whole frame. One that doesn't decrypt or decode fails the track.
    pub fn decode(bytes: Vec<u8>, key: Option<&Key>) -> Result<(u32, Vec<i16>), String> {
        let mut out = Vec::new();
        let scan = packets(&bytes, key, |pcm| out.extend_from_slice(pcm))?;
        out.drain(..scan.lookahead.min(out.len()));
        out.resize(scan.samples() as usize, 0);
        Ok((scan.rate(), out))
    }
    /// Decodes a packed track, handing each packet's samples to `each` (the encoder's lookahead included),
    /// so it can be checked without keeping them.
    fn packets(bytes: &[u8], key: Option<&Key>, mut each: impl FnMut(&[i16])) -> Result<Scan, String> {
        let scan = scan(bytes).map_err(|_| "This isn’t a QuietNote recording.".to_string())?;
        let key = if scan.sealed { Some(key.ok_or(sealed::MISSING_KEY)?) } else { None };
        let mut decoder = opus::Decoder::new(scan.rate(), opus::Channels::Mono).map_err(|_| DAMAGED.to_string())?;
        let (mut pcm, mut open) = (vec![0i16; 5760], Vec::new());
        for (index, frame) in scan.frames.iter().enumerate() {
            let body: &[u8] = match key {
                Some(key) => {
                    let nonce: [u8; NONCE] = bytes[frame.start..frame.start + NONCE].try_into().map_err(|_| DAMAGED)?;
                    open.clear();
                    open.extend_from_slice(&bytes[frame.start + NONCE..frame.end]);
                    key.open(&nonce, &bound(&scan.header, index, frame.samples), &mut open).ok_or(DAMAGED)?
                }
                None => &bytes[frame.start..frame.end],
            };
            let mut at = 0;
            while at + 2 <= body.len() {
                let n = u16::from_le_bytes([body[at], body[at + 1]]) as usize;
                let packet = body.get(at + 2..at + 2 + n).ok_or(DAMAGED)?;
                let got = decoder.decode(packet, &mut pcm, false).map_err(|_| DAMAGED.to_string())?;
                each(&pcm[..got]);
                at += 2 + n;
            }
        }
        Ok(scan)
    }

    /// A packed track's sample rate and samples, with the key from the Keychain when it's encrypted.
    pub fn samples(path: &Path) -> Result<(u32, Vec<i16>), String> {
        let key = if sealed(path) { Some(sealed::key(false)?.ok_or(sealed::MISSING_KEY)?) } else { None };
        read(path, key.as_deref())
    }
    pub fn read(path: &Path, key: Option<&Key>) -> Result<(u32, Vec<i16>), String> {
        decode(std::fs::read(path).map_err(|e| format!("Couldn’t read {}: {e}", path.display()))?, key)
    }
    /// A recorded (not packed) track: encrypted, or a WAV.
    pub fn recorded(path: &Path, key: Option<&Key>) -> Result<(u32, Vec<i16>), String> {
        if sealed::encrypted(path) { return sealed::read(path, key.ok_or(sealed::MISSING_KEY)?); }
        let reader = hound::WavReader::open(path).map_err(|e| format!("Couldn’t read {}: {e}", path.display()))?;
        let rate = reader.spec().sample_rate;
        if reader.spec().channels != 1 || reader.spec().bits_per_sample != 16 { return Err(format!("{} isn’t 16-bit mono audio", path.display())); }
        Ok((rate, reader.into_samples::<i16>().map_while(Result::ok).collect()))
    }

    /// The packed form of the recorded track at `path`, encrypted when it is, and checked by unpacking
    /// it again. Returns it with the samples it holds.
    pub fn pack(path: &Path, key: Option<&Key>) -> Result<(Vec<u8>, u64), String> {
        let (rate, samples) = recorded(path, key)?;
        let key = key.filter(|_| sealed::encrypted(path));
        let bytes = encode(rate, &samples, key)?;
        let length = samples.len() as u64;
        drop(samples);
        // Read back whole before the recording is replaced, without a second copy of its samples.
        let mut decoded = 0;
        let scan = packets(&bytes, key, |pcm| decoded += pcm.len())?;
        if scan.samples() != length || decoded < length as usize { return Err(fail("it didn’t read back")); }
        Ok((bytes, length))
    }
    /// Puts packed track `name` in place of the recorded one in `audio`, if that's still the one packed
    /// (`samples` long; the meeting may have moved meanwhile, never been recorded into): written whole
    /// and synced first, then renamed, then the recorded one is removed.
    pub fn place(audio: &Path, name: &str, recorded: &Path, bytes: &[u8], samples: u64) -> Result<(), String> {
        let here = audio.join(recorded.file_name().ok_or("No such track")?);
        let now = if sealed::encrypted(&here) { sealed::length(&here).map_err(fail)? } else { hound::WavReader::open(&here).map_err(fail)?.duration() as u64 };
        if now != samples { return Err(fail("the recording changed while it was packed")); }
        let (part, packed) = (audio.join(format!("{name}.{EXT}.part")), audio.join(format!("{name}.{EXT}")));
        let mut file = File::create(&part).map_err(fail)?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(fail)?;
        std::fs::rename(&part, &packed).map_err(fail)?;
        std::fs::remove_file(&here).map_err(fail)
    }
    /// Turns packed track `name` back into a recorded one, encrypted again when it was, else a WAV, so
    /// more can be recorded after it. Written whole first, like `place`.
    pub fn unpack(audio: &Path, name: &str, key: Option<&Arc<Key>>) -> Result<(), String> {
        let packed = audio.join(format!("{name}.{EXT}"));
        let encrypted = sealed(&packed);
        let (rate, samples) = read(&packed, key.map(|k| &**k))?;
        let ext = if encrypted { sealed::EXT } else { "wav" };
        let (part, recorded) = (audio.join(format!("{name}.{ext}.part")), audio.join(format!("{name}.{ext}")));
        let fail = |e: &dyn std::fmt::Display| format!("Couldn’t unpack the audio: {e}");
        if encrypted {
            let mut writer = sealed::Writer::create(&part, key.ok_or(sealed::MISSING_KEY)?.clone(), rate).map_err(|e| fail(&e))?;
            for s in samples { writer.write_sample(s).map_err(|e| fail(&e))?; }
            writer.finalize().map_err(|e| fail(&e))?;
        } else {
            let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let mut writer = hound::WavWriter::create(&part, spec).map_err(|e| fail(&e))?;
            for s in samples { writer.write_sample(s).map_err(|e| fail(&e))?; }
            writer.finalize().map_err(|e| fail(&e))?;
            File::open(&part).and_then(|f| f.sync_all()).map_err(|e| fail(&e))?;
        }
        std::fs::rename(&part, &recorded).map_err(|e| fail(&e))?;
        std::fs::remove_file(&packed).map_err(|e| fail(&e))
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;
    use crate::sealed::Key;
    use std::path::PathBuf;
    use std::sync::Arc;
    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quietnote-packed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// A voice-like test signal: two tones that rise and fall, with pauses.
    fn speech(seconds: f32) -> Vec<i16> {
        (0..(16_000.0 * seconds) as usize).map(|i| {
            let t = i as f32 / 16_000.0;
            let envelope = ((t * 2.3).sin() * 0.5 + 0.5) * if (t as usize) % 4 == 3 { 0.0 } else { 1.0 };
            (((t * 220.0 * std::f32::consts::TAU).sin() * 0.6 + (t * 660.0 * std::f32::consts::TAU).sin() * 0.3) * envelope * 12_000.0) as i16
        }).collect()
    }
    fn wav(path: &Path, samples: &[i16]) {
        let spec = hound::WavSpec { channels: 1, sample_rate: 16_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for s in samples { w.write_sample(*s).unwrap(); }
        w.finalize().unwrap();
    }
    /// How close two signals are, in dB of signal to the difference.
    fn snr(a: &[i16], b: &[i16]) -> f64 {
        let signal: f64 = a.iter().map(|s| (*s as f64).powi(2)).sum();
        let noise: f64 = a.iter().zip(b).map(|(x, y)| (*x as f64 - *y as f64).powi(2)).sum();
        10.0 * (signal / noise.max(1.0)).log10()
    }

    /// Packs real recordings and writes them back as WAVs (with each folder's reference.json) into
    /// QUIETNOTE_TEST_OUT, to transcribe and score with `measures_accuracy`; prints sizes and speed.
    /// QUIETNOTE_TEST_BITRATE (bit/s) tries another bitrate.
    #[test]
    #[ignore]
    fn packs_recordings() {
        let source = PathBuf::from(std::env::var("QUIETNOTE_TEST_AUDIO").expect("QUIETNOTE_TEST_AUDIO"));
        let out = PathBuf::from(std::env::var("QUIETNOTE_TEST_OUT").expect("QUIETNOTE_TEST_OUT"));
        let bitrate = std::env::var("QUIETNOTE_TEST_BITRATE").ok().and_then(|b| b.parse().ok()).unwrap_or(BITRATE);
        let mut folders: Vec<PathBuf> = if source.join("mic.wav").exists() { vec![source.clone()] } else {
            std::fs::read_dir(&source).unwrap().flatten().map(|e| e.path()).filter(|p| p.join("mic.wav").exists()).collect()
        };
        folders.sort();
        let (mut before, mut after, mut seconds, mut packing, mut unpacking) = (0u64, 0u64, 0.0, std::time::Duration::ZERO, std::time::Duration::ZERO);
        for dir in folders {
            let into = out.join(dir.file_name().unwrap());
            std::fs::create_dir_all(&into).unwrap();
            if dir.join("reference.json").exists() { std::fs::copy(dir.join("reference.json"), into.join("reference.json")).unwrap(); }
            for name in TRACKS {
                let path = dir.join(format!("{name}.wav"));
                let Ok((rate, samples)) = recorded(&path, None) else { continue };
                let started = std::time::Instant::now();
                let bytes = encode_at(rate, &samples, None, bitrate).unwrap();
                packing += started.elapsed();
                let started = std::time::Instant::now();
                let (_, back) = decode(bytes.clone(), None).unwrap();
                unpacking += started.elapsed();
                assert_eq!(back.len(), samples.len());
                wav(&into.join(format!("{name}.wav")), &back);
                (before, after, seconds) = (before + std::fs::metadata(&path).unwrap().len(), after + bytes.len() as u64, seconds + samples.len() as f64 / rate as f64);
                println!("{} {name}: {:.1} MB → {:.2} MB, {:.1} dB", dir.display(), std::fs::metadata(&path).unwrap().len() as f64 / 1e6, bytes.len() as f64 / 1e6, snr(&samples, &back));
            }
        }
        let hours = seconds / 3600.0;
        println!("{bitrate} bit/s: {:.0} MB → {:.1} MB ({:.1}×), {:.1} MB per track-hour; packing {:.0}× real time, unpacking {:.0}×",
            before as f64 / 1e6, after as f64 / 1e6, before as f64 / after as f64, after as f64 / 1e6 / hours, seconds / packing.as_secs_f64(), seconds / unpacking.as_secs_f64());
    }
    #[test]
    fn packs_a_tenth_of_the_size_keeping_every_sample_in_its_place() {
        let audio = speech(61.3);
        let bytes = encode(16_000, &audio, None).unwrap();
        assert!(bytes.len() * 8 < audio.len() * 2, "{} bytes for {} samples", bytes.len(), audio.len());
        let (rate, back) = decode(bytes.clone(), None).unwrap();
        assert_eq!((rate, back.len()), (16_000, audio.len()));
        // Lined up with the original (the encoder's lookahead is taken off), not just as long.
        assert!(snr(&audio, &back) > 8.0, "{:.1} dB", snr(&audio, &back));
        let shifted = snr(&audio[40..], &back[..back.len() - 40]);
        assert!(snr(&audio, &back) > shifted + 3.0);
        let scanned = scan(&bytes).unwrap();
        assert_eq!((scanned.samples(), scanned.frames.len(), scanned.sealed), (audio.len() as u64, 7, false));
        assert!(encode(16_000, &[], None).map(|b| decode(b, None).unwrap().1.is_empty()).unwrap());
    }
    #[test]
    fn an_encrypted_track_stays_encrypted_and_bound_to_its_file() {
        let key = Key::new(&[5; 32]);
        let audio = speech(25.0);
        let bytes = encode(16_000, &audio, Some(&key)).unwrap();
        assert_eq!(decode(bytes.clone(), Some(&key)).unwrap().1.len(), audio.len());
        assert_eq!(decode(bytes.clone(), None).unwrap_err(), sealed::MISSING_KEY);
        assert!(decode(bytes.clone(), Some(&Key::new(&[6; 32]))).is_err());
        let mut changed = bytes.clone();
        changed[HEADER + FRAME_HEAD + NONCE + 30] ^= 1;
        assert!(decode(changed, Some(&key)).is_err());
        // A frame's sample count can't be changed either.
        let mut shorter = bytes.clone();
        shorter[HEADER] ^= 1;
        assert!(decode(shorter, Some(&key)).is_err());
        // The length is read without the key.
        let dir = folder("sealed");
        std::fs::write(dir.join("mic.qno"), &bytes).unwrap();
        assert!(sealed(&dir.join("mic.qno")) && sealed::encrypted(&dir.join("mic.qno")));
        assert_eq!(duration(&dir.join("mic.qno")).unwrap(), std::time::Duration::from_secs(25));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn packing_replaces_the_recording_and_unpacking_brings_it_back_in_the_same_form() {
        let dir = folder("place");
        let key = Arc::new(Key::new(&[7; 32]));
        let audio = speech(12.0);
        // An encrypted mic track and a WAV system track, as from a Mac where the Keychain failed once.
        let mut writer = sealed::Writer::create(&dir.join("mic.qna"), key.clone(), 16_000).unwrap();
        for s in &audio { writer.write_sample(*s).unwrap(); }
        writer.finalize().unwrap();
        wav(&dir.join("system.wav"), &audio);
        for name in TRACKS {
            let recorded = sealed::path(&dir, name).unwrap();
            let (bytes, samples) = pack(&recorded, Some(&key)).unwrap();
            place(&dir, name, &recorded, &bytes, samples).unwrap();
        }
        assert_eq!(sealed::path(&dir, "mic"), Some(dir.join("mic.qno")));
        assert!(!dir.join("mic.qna").exists() && !dir.join("system.wav").exists());
        assert!(sealed(&dir.join("mic.qno")) && !sealed(&dir.join("system.qno")));
        assert_eq!(read(&dir.join("system.qno"), None).unwrap().1.len(), audio.len());
        for name in TRACKS { unpack(&dir, name, Some(&key)).unwrap(); }
        assert_eq!(sealed::read(&dir.join("mic.qna"), &key).unwrap().1.len(), audio.len());
        assert_eq!(hound::WavReader::open(dir.join("system.wav")).unwrap().duration() as usize, audio.len());
        assert!(!dir.join("mic.qno").exists() && !dir.join("system.qno").exists());
        // A recording that changed meanwhile isn't replaced.
        let recorded = dir.join("system.wav");
        let (bytes, samples) = pack(&recorded, None).unwrap();
        wav(&recorded, &audio[..1000]);
        assert!(place(&dir, "system", &recorded, &bytes, samples).is_err());
        assert!(recorded.exists() && !dir.join("system.qno").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_crash_halfway_leaves_the_whole_recorded_track() {
        let dir = folder("tidy");
        let audio = speech(3.0);
        wav(&dir.join("mic.wav"), &audio);
        let (bytes, _) = pack(&dir.join("mic.wav"), None).unwrap();
        // Renamed into place, but the recording wasn't removed yet; and an unfinished copy of the other.
        std::fs::write(dir.join("mic.qno"), &bytes).unwrap();
        std::fs::write(dir.join("system.qno.part"), &bytes[..100]).unwrap();
        tidy(&dir);
        assert!(dir.join("mic.wav").exists() && !dir.join("mic.qno").exists() && !dir.join("system.qno.part").exists());
        // A packed track on its own is the track.
        std::fs::remove_file(dir.join("mic.wav")).unwrap();
        std::fs::write(dir.join("mic.qno"), &bytes).unwrap();
        tidy(&dir);
        assert_eq!(sealed::path(&dir, "mic"), Some(dir.join("mic.qno")));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
