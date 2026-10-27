// Writes apps/web/assets/input-needed.wav, the sound the web client plays when a task needs your input.
// Regenerate with: pnpm exec tsx scripts/make-notification-sound.ts
// The output is deterministic: the same script writes the same bytes.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sampleRate = 22_050;
const duration = 0.2;
const peak = 0.6;
// One low, damped knock, like a wood block or a heavy key press.
// The pitch drops a little at the start, and a quiet inharmonic partial gives the woody color.
const frequency = 240;
const attack = 0.002;

// A seeded generator keeps the click noise, and so the output, deterministic.
let seed = 1;
function noise(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 1_073_741_824 - 1;
}

const count = Math.round(sampleRate * duration);
const data = Buffer.alloc(count * 2);
let phase = 0;
let click = 0;
for (let index = 0; index < count; index++) {
  const time = index / sampleRate;
  // A raised-cosine attack keeps the start free of a hard edge. The fast decay keeps the knock short.
  const rise = time < attack ? (1 - Math.cos(Math.PI * time / attack)) / 2 : 1;
  const fade = time > duration - 0.02 ? (duration - time) / 0.02 : 1;
  phase += 2 * Math.PI * frequency * (1 + 0.5 * Math.exp(-time * 120)) / sampleRate;
  const body = Math.sin(phase) * Math.exp(-time * 28) + 0.08 * Math.sin(2.76 * phase) * Math.exp(-time * 45);
  // A short low-passed noise burst is the contact click.
  click += 0.1 * (noise() - click);
  const value = rise * fade * (body + 1.5 * click * Math.exp(-time * 400));
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * peak)) * 32_767), index * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii");
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii");
header.writeUInt32LE(data.length, 40);

const path = resolve(import.meta.dirname, "../apps/web/assets/input-needed.wav");
writeFileSync(path, Buffer.concat([header, data]));
console.log(path);
