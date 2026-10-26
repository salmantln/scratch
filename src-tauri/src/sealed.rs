//! Recordings encrypted at rest (macOS, `encryptAudio`, on by default). A track is kept as `mic.qna` /
//! `system.qna`: a short header, then AES-256-GCM frames of about a second each, sealed as the recorder
//! flushes, so a crash loses at most the last second, as with a WAV. Each frame is bound to its file and
//! its place in it, so frames can't be reordered or moved between files. The key is random, one per
//! user, and kept in the login Keychain (`connectors::keychain`, account `audio`), which is backed up
//! and migrated with the Mac, so the archive stays readable on a new one. Transcripts and notes stay
//! readable files; only QuietNote reads the audio, and Export audio writes a playable copy.
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A recording's tracks: `<name>.qna` when encrypted, `<name>.wav` from before (or with it off).
pub const TRACKS: [&str; 2] = ["mic", "system"];
pub const EXT: &str = "qna";
/// Recordings are encrypted where the Keychain is available.
pub const AVAILABLE: bool = cfg!(target_os = "macos");
pub const MISSING_KEY: &str = "This recording is encrypted, and its key isn’t in this Mac’s Keychain.";
const MAGIC: &[u8; 4] = b"QNA1";
/// Magic, sample rate (u32), channels (u16) and a random file id, bound into every frame.
const HEADER: usize = 4 + 4 + 2 + 16;
const TAG: usize = 16;
/// A frame is sealed once this much audio is waiting (32 s), so padding a long gap stays in bounds…
const FRAME: usize = 1 << 20;
/// …and a longer one is damage, not audio.
const MAX_FRAME: u64 = 4 << 20;
const ACCOUNT: &str = "audio";

pub struct Key(LessSafeKey);
impl Key {
    pub fn new(bytes: &[u8; 32]) -> Key { Key(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, bytes).expect("a 256-bit key"))) }
}
fn random(out: &mut [u8]) -> io::Result<()> { SystemRandom::new().fill(out).map_err(|_| io::Error::other("No randomness available")) }
fn aad(header: &[u8], index: u32) -> Aad<Vec<u8>> { Aad::from([header, &index.to_le_bytes()].concat()) }
fn invalid(what: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, what.to_string()) }

static KEY: Mutex<Option<Arc<Key>>> = Mutex::new(None);
/// The key recordings are encrypted with, from the Keychain. With `create` it's made the first time a
/// recording needs one; a key that's there but unreadable is never replaced, since audio needs it.
pub fn key(create: bool) -> Result<Option<Arc<Key>>, String> {
    let mut cached = KEY.lock().map_err(|e| e.to_string())?;
    if let Some(key) = cached.as_ref() { return Ok(Some(key.clone())); }
    let bytes = match crate::connectors::keychain::read(ACCOUNT)? {
        Some(stored) => STANDARD.decode(stored.trim()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).ok_or("The recording key in the Keychain is damaged.")?,
        None if create => {
            let mut bytes = [0u8; 32];
            random(&mut bytes).map_err(|e| e.to_string())?;
            crate::connectors::keychain::store(ACCOUNT, &STANDARD.encode(bytes))?;
            bytes
        }
        None => return Ok(None),
    };
    let key = Arc::new(Key::new(&bytes));
    *cached = Some(key.clone());
    Ok(Some(key))
}

/// Where track `name` is kept in `audio`, if it's there.
pub fn path(audio: &Path, name: &str) -> Option<PathBuf> { [EXT, "wav"].map(|e| audio.join(format!("{name}.{e}"))).into_iter().find(|p| p.exists()) }
pub fn encrypted(path: &Path) -> bool { path.extension().is_some_and(|e| e == EXT) }

/// Writes a track as hound's `WavWriter` does: samples wait until `flush` seals them into a frame,
/// appended in one write.
pub struct Writer { file: File, key: Arc<Key>, header: [u8; HEADER], frames: u32, pending: Vec<u8> }
impl Writer {
    pub fn create(path: &Path, key: Arc<Key>, rate: u32) -> io::Result<Writer> {
        let mut header = [0u8; HEADER];
        header[..4].copy_from_slice(MAGIC);
        header[4..8].copy_from_slice(&rate.to_le_bytes());
        header[8..10].copy_from_slice(&1u16.to_le_bytes());
        random(&mut header[10..])?;
        let mut file = File::create(path)?;
        file.write_all(&header)?;
        Ok(Writer { file, key, header, frames: 0, pending: Vec::new() })
    }
    /// Continues a track after its last whole frame; a partial one, from a crash, is cut off.
    pub fn append(path: &Path, key: Arc<Key>) -> io::Result<Writer> {
        let mut file = File::options().read(true).write(true).open(path)?;
        let scan = scan(&mut file)?;
        file.set_len(scan.end)?;
        file.seek(SeekFrom::End(0))?;
        Ok(Writer { file, key, header: scan.header, frames: scan.frames, pending: Vec::new() })
    }
    pub fn write_sample(&mut self, sample: i16) -> io::Result<()> {
        self.pending.extend_from_slice(&sample.to_le_bytes());
        if self.pending.len() >= FRAME { self.flush()?; }
        Ok(())
    }
    pub fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() { return Ok(()); }
        let mut nonce = [0u8; NONCE_LEN];
        random(&mut nonce)?;
        let tag = self.key.0.seal_in_place_separate_tag(Nonce::assume_unique_for_key(nonce), aad(&self.header, self.frames), &mut self.pending)
            .map_err(|_| io::Error::other("Couldn’t encrypt the audio"))?;
        self.file.write_all(&[&(self.pending.len() as u32).to_le_bytes()[..], &nonce, &self.pending, tag.as_ref()].concat())?;
        self.pending.clear();
        self.frames += 1;
        Ok(())
    }
    pub fn finalize(mut self) -> io::Result<()> {
        self.flush()?;
        self.file.sync_data()
    }
}

struct Scan { header: [u8; HEADER], frames: u32, samples: u64, end: u64 }
/// Reads a track's frame lengths, not its audio (the key isn't needed): how many whole frames and
/// samples it holds, and where they end.
fn scan(file: &mut File) -> io::Result<Scan> {
    let size = file.metadata()?.len();
    let mut header = [0u8; HEADER];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut header).map_err(|_| invalid("Not a QuietNote recording"))?;
    if &header[..4] != MAGIC { return Err(invalid("Not a QuietNote recording")); }
    let block = 2 * u16::from_le_bytes([header[8], header[9]]).max(1) as u64;
    let (mut at, mut frames, mut bytes, mut len) = (HEADER as u64, 0u32, 0u64, [0u8; 4]);
    while at + 4 <= size {
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut len)?;
        let n = u32::from_le_bytes(len) as u64;
        let end = at + 4 + NONCE_LEN as u64 + n + TAG as u64;
        if n > MAX_FRAME || end > size { break; }
        (at, frames, bytes) = (end, frames + 1, bytes + n);
    }
    Ok(Scan { header, frames, samples: bytes / block, end: at })
}
/// The samples a track holds, read from its frame lengths.
pub fn length(path: &Path) -> io::Result<u64> { scan(&mut File::open(path)?).map(|s| s.samples) }
/// How long a track is: up to its last whole frame.
pub fn duration(path: &Path) -> io::Result<std::time::Duration> {
    let mut file = File::open(path)?;
    let scan = scan(&mut file)?;
    let rate = u32::from_le_bytes(scan.header[4..8].try_into().map_err(|_| invalid("Not a QuietNote recording"))?).max(1);
    Ok(std::time::Duration::from_secs_f64(scan.samples as f64 / rate as f64))
}

/// An encrypted track's sample rate and samples, with the key from the Keychain.
pub fn samples(path: &Path) -> Result<(u32, Vec<i16>), String> { read(path, &*key(false)?.ok_or(MISSING_KEY)?) }
pub fn read(path: &Path, key: &Key) -> Result<(u32, Vec<i16>), String> {
    decrypt(std::fs::read(path).map_err(|e| format!("Couldn’t read {}: {e}", path.display()))?, key)
}
/// Decrypts every whole frame. One that doesn't decrypt (damaged, or sealed with another key) fails the
/// track; a partial last frame, from a crash, is left out.
fn decrypt(mut bytes: Vec<u8>, key: &Key) -> Result<(u32, Vec<i16>), String> {
    let damaged = "This recording is damaged or was encrypted with another key, so it can’t be read.";
    if bytes.len() < HEADER || &bytes[..4] != MAGIC { return Err("This isn’t a QuietNote recording.".into()); }
    let header: [u8; HEADER] = bytes[..HEADER].try_into().map_err(|_| damaged)?;
    let rate = u32::from_le_bytes(header[4..8].try_into().map_err(|_| damaged)?);
    let (mut at, mut index, mut samples) = (HEADER, 0u32, Vec::with_capacity(bytes.len() / 2));
    while at + 4 <= bytes.len() {
        let n = u32::from_le_bytes(bytes[at..at + 4].try_into().map_err(|_| damaged)?) as usize;
        let (start, end) = (at + 4 + NONCE_LEN, at + 4 + NONCE_LEN + n + TAG);
        if n as u64 > MAX_FRAME || end > bytes.len() { break; }
        let nonce = Nonce::assume_unique_for_key(bytes[at + 4..start].try_into().map_err(|_| damaged)?);
        let plain = key.0.open_in_place(nonce, aad(&header, index), &mut bytes[start..end]).map_err(|_| damaged)?;
        samples.extend(plain.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)));
        (at, index) = (end, index + 1);
    }
    Ok((rate, samples))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quietnote-sealed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn write(path: &Path, key: &Arc<Key>, samples: impl IntoIterator<Item = i16>, every: usize) {
        let mut writer = Writer::create(path, key.clone(), 16_000).unwrap();
        for (i, s) in samples.into_iter().enumerate() {
            writer.write_sample(s).unwrap();
            if (i + 1) % every == 0 { writer.flush().unwrap(); }
        }
        writer.finalize().unwrap();
    }
    #[test]
    fn round_trips_and_measures_without_the_key() {
        let dir = folder("round");
        let (path, key) = (dir.join("mic.qna"), Arc::new(Key::new(&[7; 32])));
        let audio: Vec<i16> = (0..40_000).map(|i| (i % 2000) as i16 - 1000).collect();
        write(&path, &key, audio.clone(), 16_000);
        assert_eq!(decrypt(std::fs::read(&path).unwrap(), &key).unwrap(), (16_000, audio));
        assert_eq!(length(&path).unwrap(), 40_000);
        assert_eq!(duration(&path).unwrap(), std::time::Duration::from_millis(2500));
        // The audio isn't in the file as written.
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.windows(8).any(|w| w == [0x18, 0xfc, 0x19, 0xfc, 0x1a, 0xfc, 0x1b, 0xfc]));
        assert_eq!(super::path(&dir, "mic"), Some(dir.join("mic.qna")));
        assert!(encrypted(&dir.join("mic.qna")) && !encrypted(&dir.join("mic.wav")));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_crash_loses_only_the_partial_frame_and_recording_more_continues_after_it() {
        let dir = folder("crash");
        let (path, key) = (dir.join("system.qna"), Arc::new(Key::new(&[1; 32])));
        write(&path, &key, vec![5; 32_000], 16_000);
        // Half a frame written when QuietNote was killed.
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(&1000u32.to_le_bytes());
        bytes.extend_from_slice(&[9; 300]);
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(length(&path).unwrap(), 32_000);
        assert_eq!(decrypt(bytes, &key).unwrap().1.len(), 32_000);
        let mut writer = Writer::append(&path, key.clone()).unwrap();
        for _ in 0..8_000 { writer.write_sample(-3).unwrap(); }
        writer.finalize().unwrap();
        let samples = decrypt(std::fs::read(&path).unwrap(), &key).unwrap().1;
        assert_eq!(samples.len(), 40_000);
        assert!(samples[..32_000].iter().all(|s| *s == 5) && samples[32_000..].iter().all(|s| *s == -3));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refuses_another_key_a_changed_frame_and_frames_out_of_order() {
        let dir = folder("tamper");
        let (path, key) = (dir.join("mic.qna"), Arc::new(Key::new(&[2; 32])));
        write(&path, &key, (0..3000).map(|i| i as i16), 1000);
        let bytes = std::fs::read(&path).unwrap();
        assert!(decrypt(bytes.clone(), &Key::new(&[3; 32])).is_err());
        let mut changed = bytes.clone();
        changed[HEADER + 4 + NONCE_LEN + 10] ^= 1;
        assert!(decrypt(changed, &key).is_err());
        // Swapping the first two frames (each 4 + 12 + 2000 + 16 bytes).
        let frame = 4 + NONCE_LEN + 2000 + TAG;
        let mut swapped = bytes[..HEADER].to_vec();
        swapped.extend_from_slice(&bytes[HEADER + frame..HEADER + 2 * frame]);
        swapped.extend_from_slice(&bytes[HEADER..HEADER + frame]);
        swapped.extend_from_slice(&bytes[HEADER + 2 * frame..]);
        assert!(decrypt(swapped, &key).is_err());
        // A frame moved from another recording, even one with the same key.
        let other = dir.join("other.qna");
        write(&other, &key, (0..1000).map(|i| i as i16), 1000);
        let mut moved = bytes[..HEADER].to_vec();
        moved.extend_from_slice(&std::fs::read(&other).unwrap()[HEADER..]);
        assert!(decrypt(moved, &key).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn padding_a_long_gap_is_sealed_in_bounded_frames() {
        let dir = folder("long");
        let (path, key) = (dir.join("mic.qna"), Arc::new(Key::new(&[4; 32])));
        // Twenty minutes of silence in one go, as even_tracks pads a resumed recording.
        write(&path, &key, std::iter::repeat_n(0, 16_000 * 1200), usize::MAX);
        assert_eq!(length(&path).unwrap(), 16_000 * 1200);
        assert_eq!(decrypt(std::fs::read(&path).unwrap(), &key).unwrap().1.len(), 16_000 * 1200);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
