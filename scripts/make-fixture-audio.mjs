// Writes fixtures/dictation-es-mx.wav: a soft, low-volume sine+noise mix,
// mono 16kHz 16-bit PCM, ~21s (kept under the 700KB budget). This is purely
// a stand-in file to exercise upload/storage/streaming plumbing — the
// FixtureSttProvider never reads it; it always returns the canned transcript
// in fixtures/dictation-es-mx.json regardless of input.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "fixtures", "dictation-es-mx.wav");

const SAMPLE_RATE = 16000;
const DURATION_S = 21;
const BASE_FREQ_HZ = 220;
const AMPLITUDE = 0.06; // soft, low volume
const numSamples = SAMPLE_RATE * DURATION_S;

const dataSize = numSamples * 2; // 16-bit mono
const buffer = Buffer.alloc(44 + dataSize);

buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16); // fmt chunk size
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(1, 22); // mono
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
buffer.writeUInt16LE(2, 32); // block align
buffer.writeUInt16LE(16, 34); // bits per sample
buffer.write("data", 36);
buffer.writeUInt32LE(dataSize, 40);

// Deterministic pseudo-random noise (mulberry32) so the fixture is reproducible.
let seed = 0x1a2b3c4d;
function nextRandom() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

for (let i = 0; i < numSamples; i++) {
  const t = i / SAMPLE_RATE;
  const tone = Math.sin(2 * Math.PI * BASE_FREQ_HZ * t) * 0.6;
  const noise = (nextRandom() * 2 - 1) * 0.4;
  const sample = (tone + noise) * AMPLITUDE * 32767;
  buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), 44 + i * 2);
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, buffer);
console.log(`wrote ${OUT_PATH} (${buffer.length} bytes, ${(buffer.length / 1024).toFixed(1)} KB)`);
