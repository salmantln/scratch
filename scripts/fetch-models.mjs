// Downloads the speech models bundled with the macOS and Windows apps into src-tauri/resources/models,
// and on macOS the sherpa-onnx library the speaker and Parakeet models run on (src-tauri/resources/sherpa,
// read by its build script through SHERPA_ONNX_ARCHIVE_DIR in src-tauri/.cargo/config.toml).
// Runs at build time only; the app itself never downloads anything. Files are pinned by SHA-256 and
// skipped when already present, so this is a no-op after the first run.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const tauri = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const dir = join(tauri, 'resources', 'models');
const releases = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const models = [
  { name: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { name: 'ggml-silero-v6.2.0.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin', size: 885098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' },
];
// macOS only: telling the others apart (speaker segmentation and voice embeddings) and the faster English live transcript.
const macModels = [
  { name: 'pyannote-segmentation-3.0.onnx', url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx', size: 5992913, sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079' },
  { name: '3dspeaker-eres2net-en-voxceleb-16k.onnx', url: 'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx', size: 26485263, sha256: 'c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5' },
  {
    name: 'parakeet-tdt-110m-en-int8', url: `${releases}/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2`, size: 108035095, sha256: 'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
    // The archive's folder, and the files kept from it (each pinned too, as the app checks them).
    folder: 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8',
    files: [
      { name: 'encoder.int8.onnx', size: 131113202, sha256: '0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657' },
      { name: 'decoder.int8.onnx', size: 3955863, sha256: 'f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19' },
      { name: 'joiner.int8.onnx', size: 1411403, sha256: 'bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6' },
      { name: 'tokens.txt', size: 9953, sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10' },
    ],
  },
];
// The sherpa-onnx static library for this Mac's architecture, as its crate's build script expects it.
const sherpa = {
  arm64: { name: 'sherpa-onnx-v1.13.8-osx-arm64-static-lib.tar.bz2', size: 20965936, sha256: '9091bf160dc7fdacedbc906b212badf53c2993f4e5277a0e03998e96c31d60da' },
  x64: { name: 'sherpa-onnx-v1.13.8-osx-x64-static-lib.tar.bz2', size: 20575933, sha256: 'a3f88da3e54c850a12d61431e73f8affcd1f13738b75b768847dd79541835b4b' },
};
const sha256 = path => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
const present = (path, size) => existsSync(path) && statSync(path).size === size;
/** Downloads `url` to `path` and checks its hash; a failed or wrong download leaves nothing behind. */
async function download({ name, url, size, sha256: expected }, path) {
  console.log(`Downloading ${name} (${Math.round(size / 1e6)} MB)…`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Couldn’t download ${name}: HTTP ${response.status}`);
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== expected) { rmSync(partial); throw new Error(`${name} failed its checksum (got ${actual}).`); }
  renameSync(partial, path);
}

// Linux builds don't record, so they don't need the models.
if (process.platform === 'linux' && !process.env.QUIETNOTE_FETCH_MODELS) process.exit(0);
mkdirSync(dir, { recursive: true });
for (const model of models.concat(process.platform === 'darwin' ? macModels : [])) {
  if (!model.files) {
    // Size is checked on every run; the full hash only after a download, to keep dev startup fast.
    const path = join(dir, model.name);
    if (!present(path, model.size)) await download(model, path);
    continue;
  }
  const folder = join(dir, model.name);
  if (model.files.every(f => present(join(folder, f.name), f.size))) continue;
  const work = mkdtempSync(join(dir, '.extract-'));
  try {
    const archive = join(work, 'archive.tar.bz2');
    await download(model, archive);
    execFileSync('tar', ['-xjf', archive, '-C', work]);
    mkdirSync(folder, { recursive: true });
    for (const file of model.files) {
      const from = join(work, model.folder, file.name);
      if (!present(from, file.size) || await sha256(from) !== file.sha256) throw new Error(`${model.name}: ${file.name} in the archive isn’t the pinned file.`);
      renameSync(from, join(folder, file.name));
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
}
if (process.platform === 'darwin') {
  const lib = sherpa[process.arch];
  if (!lib) throw new Error(`No sherpa-onnx library is pinned for ${process.arch}.`);
  const libs = join(tauri, 'resources', 'sherpa');
  mkdirSync(libs, { recursive: true });
  const path = join(libs, lib.name);
  if (!present(path, lib.size)) await download({ ...lib, url: `${releases}/v1.13.8/${lib.name}` }, path);
}
