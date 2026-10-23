// Makes test meetings with a known transcript for the accuracy test (`measures_accuracy` in
// src-tauri/src/accuracy.rs) from the AMI Meeting Corpus: real meetings of four people, each recorded on
// their own headset, with a word-by-word transcript made by people (CC BY 4.0, https://groups.inf.ed.ac.uk/ami/corpus/).
// One person's headset becomes the microphone ("You") and the others' headsets, added together, the call
// audio, as if they were on a call with you. The people sat in one room, so each headset also hears the
// others; on a call, the call app's echo cancellation and noise suppression would keep that out. So each
// headset is kept while its owner talks (from the reference's word times, with a quarter second either
// side) and silent otherwise, as a call app's noise suppression sends it (turned down by 40 dB, it was
// still transcribed: Whisper scales each window to its loudest sound); `--as-recorded` keeps the room. Each meeting goes to
// test-audio/ami/<meeting>/ (mic.wav, system.wav, reference.json; test-audio/ami-as-recorded/ for the room);
// downloads are kept in test-audio/ami/.cache and pinned by SHA-256.
//
//   node scripts/fetch-ami.mjs                      the pinned meetings, whole
//   node scripts/fetch-ami.mjs ES2004a --minutes 10 one meeting, its first ten minutes
//   node scripts/fetch-ami.mjs IS1009a --you B      that person as "You" (by default whoever says the most)
//   node scripts/fetch-ami.mjs ES2002a --as-recorded every headset as it was, hearing the room
//
// For testing only: nothing here is part of the app.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-audio', 'ami');
const cache = join(out, '.cache');
const corpus = 'https://groups.inf.ed.ac.uk/ami';
const annotations = { name: 'ami_public_manual_1.6.2.zip', url: `${corpus}/AMICorpusAnnotations/ami_public_manual_1.6.2.zip`, sha256: 'b56e5babb2496b8795deeeda7e71178d7fbc9963f94276cf2a3f4b56ebbc9f9d' };
// Each meeting's headsets, by channel: four meetings recorded at three sites (Edinburgh, IDIAP, TNO).
// Other meetings work too, unchecked.
const pinned = {
  ES2002a: ['3bf0627106d6b6f02e5cc8b69f283b70303275c6b354aef3bdc7a50762d3f25e', '285ed5b5eaa4f871cc146900d0cf87487ca757aa57a7062def2eb49feaabc23d', 'f881505606c390b0826a525fec9ecc216e497196adefe7a70fe71522b82e2e92', 'fa65d53a97074e31bf83da4ab4cc6235f6e7625d6d40bd223158467d7df9f581'],
  ES2004a: ['abb4917719c6e033b066fbd400b6d37fe46ddd62c89b513f77016a51f54e2ad1', '9be8e84e4ef93ea7eef669470cd6db017856f38f7321e0054199ad7393a1199c', 'a4f2f8ea7d965ede2c010e36bfc31c14c7792d07419bd5bc9519c8ddd1c8bc28', '5b3cf59816d5160d77ff00315dc7f6db816c175edb65e0d61691679fae633572'],
  IS1009a: ['634f42207e488b0eab3b34a81ff16d565705f8fc5e37be7cc3c3b56617ae3257', 'db98d175dda0d07613795c715667a72b99c5372aabd14ee4dcb94d1fa9c273ee', '9e28bfd55727b07d6a6020b7bf2797d113b35c69a1a3ad25cc4150be0937bf28', '7a0b041ad2f2cd9af1c8fcee08e598d6d88bd8f77a3174d7eb9e281a30ca0413'],
  TS3003a: ['3c027c3cc99e439a9c0850b22c5148674f155f32ce178b43a69d4a39be28b173', '8b3526ddbdbbafbd285d52c08322395e79e3b715ce90d6b749a5d712240cb51f', 'ec768ea3dd2ae1a28ce383fc35a5f64556993416dc28e4d2d87ea9116ee8a5c6', '7055b7dda7ac2d5a5a336e7b5d7e7009277df21774d2a0633dd9772b08eaaacc'],
};

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const minutes = Number(option('--minutes') ?? Infinity);
const chosen = option('--you');
const asRecorded = args.includes('--as-recorded') && Boolean(args.splice(args.indexOf('--as-recorded'), 1));
const meetings = args.length ? args : Object.keys(pinned);

const sha256 = path => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
/** Downloads `url` into the cache once, checking its hash when it's pinned. The corpus's server
 * sometimes refuses or drops a download, so it's tried three times. */
async function cached(name, url, expected) {
  const path = join(cache, name);
  if (existsSync(path)) return path;
  const partial = `${path}.partial`;
  for (let attempt = 1; ; attempt++) {
    console.log(`Downloading ${name}…`);
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Couldn’t download ${name}: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      break;
    } catch (error) {
      rmSync(partial, { force: true });
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }
  const actual = await sha256(partial);
  if (expected && actual !== expected) { rmSync(partial); throw new Error(`${name} failed its checksum (got ${actual}).`); }
  if (!expected) console.log(`  not pinned: ${actual}`);
  renameSync(partial, path);
  return path;
}
/** The 16-bit samples of a 16 kHz mono WAV file. */
function samples(path) {
  const file = readFileSync(path);
  const format = file.indexOf('fmt ');
  if (file.readUInt16LE(format + 10) !== 1 || file.readUInt32LE(format + 12) !== 16000 || file.readUInt16LE(format + 22) !== 16) throw new Error(`${path} isn’t 16 kHz mono 16-bit audio.`);
  for (let at = 12; at + 8 <= file.length; at += 8 + file.readUInt32LE(at + 4) + (file.readUInt32LE(at + 4) % 2)) {
    if (file.toString('latin1', at, at + 4) !== 'data') continue;
    const size = Math.min(file.readUInt32LE(at + 4), file.length - at - 8);
    return new Int16Array(file.buffer.slice(file.byteOffset + at + 8, file.byteOffset + at + 8 + size - (size % 2)));
  }
  throw new Error(`${path} has no audio.`);
}
function writeWav(path, data) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.byteLength, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
}
const entities = text => text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** A person's words in time order: `{ start, end, text, cut }` in seconds. Punctuation joins the word
 * before it; `cut` marks cut-off words ("charac-"). Spelled-out letters ("T_V_") become the word ("TV"). */
function words(xml) {
  const said = [];
  for (const [, attributes, text] of xml.matchAll(/<w ([^>]*)>([^<]*)<\/w>/g)) {
    const attribute = name => attributes.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    const word = entities(text).replace(/([A-Za-z])_/g, '$1');
    if (attribute('punc') === 'true') { if (said.length) said[said.length - 1].text += word; continue; }
    said.push({ start: Number(attribute('starttime')), end: Number(attribute('endtime')), text: word, cut: attribute('trunc') === 'true' });
  }
  return said;
}
/** `audio` kept while its owner talks (`said`, a quarter second either side) and silent otherwise, with
 * 10 ms fades so the changes don't click. */
function gated(audio, said) {
  const talking = new Uint8Array(audio.length);
  for (const w of said) talking.fill(1, Math.max(0, Math.round((w.start - 0.25) * 16000)), Math.min(audio.length, Math.round((w.end + 0.25) * 16000)));
  const out = new Int16Array(audio.length);
  let gain = 0;
  for (let i = 0; i < audio.length; i++) {
    const target = talking[i];
    gain += Math.max(-1 / 160, Math.min(1 / 160, target - gain));
    out[i] = Math.round(audio[i] * gain);
  }
  return out;
}
/** Words joined into stretches of one person talking, split at pauses of half a second or more. */
function stretches(said, speaker) {
  const out = [];
  for (const w of said) {
    const last = out[out.length - 1];
    if (last && w.start - last.end < 0.5) { last.end = Math.max(last.end, w.end); last.text += ` ${w.text}`; }
    else out.push({ speaker, start: w.start, end: w.end, text: w.text });
  }
  return out.map(s => ({ speaker: s.speaker, startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text }));
}

mkdirSync(cache, { recursive: true });
const zip = await cached(annotations.name, annotations.url, annotations.sha256);
const unzip = file => execFileSync('unzip', ['-p', zip, file], { maxBuffer: 1 << 28 }).toString('latin1');
const directory = unzip('corpusResources/meetings.xml');
for (const meeting of meetings) {
  const entry = directory.match(new RegExp(`observation="${meeting}"[\\s\\S]*?</meeting>`))?.[0];
  if (!entry) throw new Error(`There’s no AMI meeting called ${meeting}.`);
  const people = [...entry.matchAll(/<speaker [^>]*>/g)].map(([tag]) => ({ agent: tag.match(/nxt_agent="(\w)"/)[1], channel: Number(tag.match(/channel="(\d)"/)[1]) })).sort((a, b) => a.channel - b.channel);
  const said = Object.fromEntries(people.map(({ agent }) => [agent, words(unzip(`words/${meeting}.${agent}.words.xml`))]));
  // Cut-off words are left out of the reference, as no recognizer writes them.
  const spoken = agent => said[agent].filter(w => !w.cut);
  const you = chosen ?? people.map(p => p.agent).sort((a, b) => spoken(b).length - spoken(a).length)[0];
  if (!said[you]) throw new Error(`${meeting} has no person ${you} (it has ${people.map(p => p.agent).join(', ')}).`);
  const end = minutes * 60;
  const tracks = [];
  for (const { agent, channel } of people) {
    const name = `${meeting}.Headset-${channel}.wav`;
    const audio = samples(await cached(name, `${corpus}/AMICorpusMirror/amicorpus/${meeting}/audio/${name}`, pinned[meeting]?.[channel]));
    const kept = audio.subarray(0, Math.min(audio.length, Math.round(end * 16000)));
    tracks.push({ agent, audio: asRecorded ? kept : gated(kept, said[agent]) });
  }
  // The call audio is everyone else's headset added together.
  const length = Math.max(...tracks.map(t => t.audio.length));
  const call = new Int16Array(length);
  let clipped = 0;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const t of tracks) if (t.agent !== you) sum += t.audio[i] ?? 0;
    if (sum > 32767 || sum < -32768) clipped++;
    call[i] = Math.max(-32768, Math.min(32767, sum));
  }
  const mic = new Int16Array(length);
  mic.set(tracks.find(t => t.agent === you).audio);
  const reference = people.flatMap(({ agent }) => stretches(spoken(agent).filter(w => w.start < end), agent === you ? 'You' : `Person ${agent}`))
    .sort((a, b) => a.startMs - b.startMs);
  const folder = join(asRecorded ? `${out}-as-recorded` : out, meeting);
  mkdirSync(folder, { recursive: true });
  writeWav(join(folder, 'mic.wav'), mic);
  writeWav(join(folder, 'system.wav'), call);
  writeFileSync(join(folder, 'reference.json'), JSON.stringify(reference, null, 1));
  const count = speaker => reference.filter(s => (s.speaker === 'You') === speaker).reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  console.log(`${meeting}: ${(length / 16000 / 60).toFixed(1)} min, You are ${you} (${count(true)} words), ${people.length - 1} others (${count(false)} words)${clipped ? `, ${clipped} call samples clipped` : ''} → ${folder}`);
}
