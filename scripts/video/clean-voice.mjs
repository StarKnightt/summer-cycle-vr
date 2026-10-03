#!/usr/bin/env node
// Turn the recorded take (edit/voice.m4a) into the edit's voice track, driven by edit/voice-edit.json:
//
//   voice-raw.wav   straight conversion of the take, 48 kHz mono 24-bit (untouched otherwise)
//   voice.wav       the parts listed in `keep` joined together, high-passed at 80 Hz, lightly
//                   de-essed and compressed, normalised to `lufs`, 48 kHz mono 24-bit
//   voice-cues.json the paragraphs and subtitle lines, converted to voice.wav time
//
//   node scripts/video/clean-voice.mjs
import fs from "node:fs";
import path from "node:path";
import { EDIT, CACHE, ff, fx, graphArgs, loudness } from "./lib.mjs";

const V = JSON.parse(fs.readFileSync(path.join(EDIT, "voice-edit.json"), "utf8"));
const src = path.join(EDIT, V.source), raw = path.join(EDIT, V.raw), out = path.join(EDIT, V.out);

if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(src).mtimeMs)
  ff(["-i", src, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", raw], "voice-raw.wav");

/** Original take time -> voice.wav time (a time inside a cut snaps to the end of that cut). */
function toClean(t) {
  let acc = 0;
  for (const [a, b] of V.keep) {
    if (t < a) return acc;
    if (t <= b) return acc + (t - a);
    acc += b - a;
  }
  return acc;
}

// Join the kept parts with 10 ms fades so the joins can't click, then the light processing chain.
const g = V.keep.map(([a, b], i) => `[0:a]atrim=start=${fx(a)}:end=${fx(b)},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=${fx(b - a - 0.01)}:d=0.01[k${i}]`);
const chain = "highpass=f=80:poles=2,deesser=i=0.25:m=0.5:f=0.5,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=140:knee=4:makeup=1";
g.push(`${V.keep.map((_, i) => `[k${i}]`).join("")}concat=n=${V.keep.length}:v=0:a=1,${chain}[v]`);
const pre = path.join(CACHE, "voice-pre.wav");
ff(["-i", raw, ...graphArgs("voice-clean", g.join(";\n")), "-map", "[v]", "-ar", "48000", "-c:a", "pcm_f32le", pre], "clean + process");

// Static gain to the target loudness (no dynamic loudnorm, so the delivery is untouched), then a
// limiter to catch the odd plosive.
const m = loudness(pre);
const gain = V.lufs - m.lufs;
ff(["-i", pre, "-af", `volume=${fx(gain)}dB,alimiter=limit=0.79:attack=3:release=60:level=false`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", out], "normalise");
const L = loudness(out);
console.log(`voice.wav: ${L.lufs} LUFS, true peak ${L.truePeak} dBFS (gain ${gain.toFixed(1)} dB)`);

const cues = {
  paragraphs: Object.fromEntries(Object.entries(V.paragraphs).map(([k, [a, b]]) => [k, [+toClean(a).toFixed(3), +toClean(b).toFixed(3)]])),
  subtitles: V.subtitles.map(([a, b, text]) => ({ start: +toClean(a).toFixed(3), end: +toClean(b).toFixed(3), text })),
};
fs.writeFileSync(path.join(EDIT, V.cues), JSON.stringify(cues, null, 1));
for (const [k, [a, b]] of Object.entries(cues.paragraphs)) console.log(`  ${k}: ${a.toFixed(2)} to ${b.toFixed(2)} (${(b - a).toFixed(2)} s)`);
