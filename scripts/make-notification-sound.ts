// Writes apps/web/assets/input-needed.wav, the sound the web client plays when a task needs your input.
// Regenerate with: pnpm exec tsx scripts/make-notification-sound.ts
// The output is deterministic: the same script writes the same bytes.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sampleRate = 22_050;
const duration = 0.5;
const peak = 0.35;
// Three rising tones (A5, C#6, E6). Each starts before the previous one ends.
const notes = [
  { frequency: 880, start: 0, length: 0.26 },
  { frequency: 1108.73, start: 0.12, length: 0.26 },
  { frequency: 1318.51, start: 0.24, length: 0.26 },
];
const attack = 0.008;
const release = 0.03;

function envelope(time: number, length: number): number {
  if (time < 0 || time >= length) return 0;
  // A raised-cosine attack and release keep the edges free of clicks. The decay between them keeps the tone soft.
  const rise = time < attack ? (1 - Math.cos(Math.PI * time / attack)) / 2 : 1;
  const fall = time > length - release ? (1 + Math.cos(Math.PI * (time - (length - release)) / release)) / 2 : 1;
  return rise * fall * Math.exp(-time * 9);
}

const count = Math.round(sampleRate * duration);
const data = Buffer.alloc(count * 2);
for (let index = 0; index < count; index++) {
  const time = index / sampleRate;
  let value = 0;
  for (const note of notes) {
    const local = time - note.start;
    const level = envelope(local, note.length);
    // A quiet second harmonic makes the tone less thin than a pure sine.
    if (level) value += level * (Math.sin(2 * Math.PI * note.frequency * local) + 0.12 * Math.sin(4 * Math.PI * note.frequency * local));
  }
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
