// Downloads the speech models bundled with the macOS and Windows apps into src-tauri/resources/models.
// Runs at build time only; the app itself never downloads anything. Files are pinned by SHA-256 and
// skipped when already present, so this is a no-op after the first run.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'resources', 'models');
const models = [
  { name: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { name: 'ggml-silero-v6.2.0.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin', size: 885098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' },
];
const sha256 = path => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

// Linux builds don't record, so they don't need the models.
if (process.platform === 'linux' && !process.env.QUIETNOTE_FETCH_MODELS) process.exit(0);
mkdirSync(dir, { recursive: true });
for (const model of models) {
  const path = join(dir, model.name);
  // Size is checked on every run; the full hash only after a download, to keep dev startup fast.
  if (existsSync(path) && statSync(path).size === model.size) continue;
  console.log(`Downloading ${model.name} (${Math.round(model.size / 1e6)} MB)…`);
  const response = await fetch(model.url);
  if (!response.ok || !response.body) throw new Error(`Couldn’t download ${model.name}: HTTP ${response.status}`);
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== model.sha256) { rmSync(partial); throw new Error(`${model.name} failed its checksum (got ${actual}).`); }
  renameSync(partial, path);
}
