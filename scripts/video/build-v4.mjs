#!/usr/bin/env node
// Build the v4 demo cut (hands first) from the xr-reel clips and the owner's voice take.
//
//   node scripts/video/build-v4.mjs
//
// In:  media/xr-reel/*.mp4 (scripts/xr-reel.mjs), media/xr-reel/voice/*.m4a|wav (one take of the
//      12 lines in media/xr-reel/VOICEOVER-v4.md), media/xr-reel/audio-ride-bed.m4a.
// Out: media/xr-reel/edit/FINAL-v4.mp4 (gitignored), plus a contact sheet in edit/review/v4/.
//
// Each section plays one line over its clip(s); sections dissolve into each other, the voice is
// cleaned and levelled, and the game's own ride audio sits under it, ducked while she speaks.
// Video is encoded with NVENC on the RTX 4060 (libx264 here is a CPU fallback).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REEL = path.join(ROOT, "media", "xr-reel");
const EDIT = path.join(REEL, "edit");
const CACHE = path.join(EDIT, "cache", "v4");
const REVIEW = path.join(EDIT, "review", "v4");
for (const d of [CACHE, REVIEW]) fs.mkdirSync(d, { recursive: true });

const FPS = 30, W = 1920, H = 1080, XF = 0.4, VO_LEAD = 0.35;
const NVENC = ["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq"];
const FONT = "C\\:/Windows/Fonts/georgia.ttf";
const FONT_I = "C\\:/Windows/Fonts/georgiai.ttf";

function ff(args, what) {
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "pipe"] });
  if (r.status !== 0) throw new Error(`${what} failed:\n${String(r.stderr).slice(-2000)}`);
}
const clip = (n) => path.join(REEL, `${n}.mp4`);
const voiceSrc = fs.readdirSync(path.join(REEL, "voice")).filter((f) => /\.(m4a|wav|mp3)$/i.test(f)).map((f) => path.join(REEL, "voice", f))[0];
if (!voiceSrc) throw new Error("no voice file in media/xr-reel/voice/");

// Voice lines: [in, out] in the take (from the word timings in edit/cache/transcript.json).
const LINES = [
  [0.0, 5.7], [6.22, 15.86], [17.48, 18.62], [19.54, 21.7], [23.18, 37.04], [38.6, 51.14],
  [52.18, 60.3], [60.4, 66.42], [68.3, 74.08], [74.9, 84.8], [85.52, 95.72], [96.56, 103.72],
];

// Sections: clip ranges [name, in, out] played back to back, then the line on top.
const SECTIONS = [
  { parts: [["02-grab-bars-ride-off", 0, 6.56, 1.08]] },
  { parts: [["03-steering-through-village", 0.6, 12.0]] },
  { parts: [["04-brake-pinch", 0.8, 5.6]] },
  { parts: [["05-bell-ring", 0.5, 5.7]] },
  { parts: [["06-reach-and-drag-sun", 1.5, 23.5]] },
  { parts: [["10-desktop-before", 0, 7.0], ["01-enter-vr", 0, 5.9, 1.25]] },
  { parts: [["07-wrist-menu-pause-resume", 0.3, 10.0]] },
  { parts: [["08-comfort-toggle-vignette", 0, 7.5]] },
  { parts: [["12-hands-lost-coast", 0.2, 7.68]] },
  { parts: [["11-stereo-both-eyes", 0, 3.2], ["06b-sunset-ride", 0, 8.4]] },
  { parts: [["09-arrival-at-shrine-dusk", 3.0, 16.0]] },
  { parts: [["13-end-card-ride-again", 0, 7.46]] },
  { card: 4.5 },
];

// 1. Render each section to an intermediate at a fixed size and rate.
const secFiles = [], secDur = [];
SECTIONS.forEach((s, i) => {
  const out = path.join(CACHE, `sec${String(i + 1).padStart(2, "0")}.mp4`);
  if (s.card) {
    const vf = [
      `drawtext=fontfile='${FONT}':text='Summer Cycle':fontsize=120:fontcolor=0x2a241d:x=(w-tw)/2:y=h*0.36`,
      `drawtext=fontfile='${FONT_I}':text='Seated, hands only, in Quest Browser':fontsize=46:fontcolor=0x544a3d:x=(w-tw)/2:y=h*0.53`,
      `drawtext=fontfile='${FONT}':text='starknightt.github.io/summer-cycle-vr':fontsize=40:fontcolor=0x8a3a2a:x=(w-tw)/2:y=h*0.64`,
      `fade=t=out:st=${s.card - 0.8}:d=0.8`,
    ].join(",");
    ff(["-f", "lavfi", "-i", `color=c=0xf3ead8:s=${W}x${H}:r=${FPS}:d=${s.card}`, "-vf", vf, ...NVENC, "16", "-b:v", "0", "-pix_fmt", "yuv420p", out], `card ${i + 1}`);
    secDur.push(s.card);
  } else {
    const inputs = s.parts.flatMap(([n]) => ["-i", clip(n)]);
    // An optional 4th value slows a part down (1.25 = 25% slower) to make room for a long line.
    const chains = s.parts.map(([, a, b, sp = 1], k) => `[${k}:v]trim=${a}:${b},setpts=(PTS-STARTPTS)*${sp},fps=${FPS},scale=${W}:${H},setsar=1[p${k}]`);
    const cat = s.parts.length > 1 ? `${s.parts.map((_, k) => `[p${k}]`).join("")}concat=n=${s.parts.length}:v=1:a=0[v]` : `[p0]null[v]`;
    ff([...inputs, "-filter_complex", [...chains, cat].join(";"), "-map", "[v]", ...NVENC, "16", "-b:v", "0", "-pix_fmt", "yuv420p", "-an", out], `section ${i + 1}`);
    secDur.push(s.parts.reduce((t, [, a, b, sp = 1]) => t + (b - a) * sp, 0));
  }
  secFiles.push(out);
});

// 2. Dissolve the sections together; section k starts at start[k].
const start = [0];
for (let k = 1; k < secDur.length; k++) start.push(start[k - 1] + secDur[k - 1] - XF);
const total = start.at(-1) + secDur.at(-1);
let g = [], last = "[0:v]";
for (let k = 1; k < secFiles.length; k++) {
  const o = k === secFiles.length - 1 ? "[vx]" : `[x${k}]`;
  g.push(`${last}[${k}:v]xfade=transition=fade:duration=${XF}:offset=${(start[k]).toFixed(3)}${o}`);
  last = o;
}
g.push(`[vx]fade=t=in:st=0:d=0.5[vout]`);
const videoOnly = path.join(CACHE, "video.mp4");
ff([...secFiles.flatMap((f) => ["-i", f]), "-filter_complex", g.join(";"), "-map", "[vout]", ...NVENC, "17", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", String(FPS), videoOnly], "dissolves");

// 3. Voice: clean once, cut each line, place it at its section's start.
const voiceClean = path.join(CACHE, "voice-clean.wav");
ff(["-i", voiceSrc, "-ac", "1", "-ar", "48000", "-af", "highpass=f=80,lowpass=f=14000,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=10:release=150,loudnorm=I=-17:TP=-2:LRA=9", voiceClean], "voice clean");
const vin = LINES.map(() => ["-i", voiceClean]).flat();
const vg = LINES.map(([a, b], k) => {
  const at = Math.round((start[k] + VO_LEAD) * 1000);
  return `[${k}:a]atrim=${Math.max(0, a - 0.12)}:${b + 0.25},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${(b + 0.25 - Math.max(0, a - 0.12) - 0.12).toFixed(3)}:d=0.12,adelay=${at}|${at}[l${k}]`;
});
vg.push(`${LINES.map((_, k) => `[l${k}]`).join("")}amix=inputs=${LINES.length}:normalize=0,apad,atrim=0:${total.toFixed(3)}[vo]`);
const voTrack = path.join(CACHE, "vo.wav");
ff([...vin, "-filter_complex", vg.join(";"), "-map", "[vo]", "-ac", "1", "-ar", "48000", voTrack], "voice track");

// 4. Mix: the ride bed (looped to length) ducked under the voice, then levelled to -16 LUFS.
const final = path.join(EDIT, "FINAL-v4.mp4");
const mix = [
  `[1:a]aformat=channel_layouts=stereo,asplit=2[vo1][vo2]`,
  `[2:a]aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},volume=0.55,afade=t=in:d=1.5,afade=t=out:st=${(total - 3).toFixed(3)}:d=3[bed]`,
  `[bed][vo1]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=400[duck]`,
  `[duck][vo2]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
].join(";");
ff(["-i", videoOnly, "-i", voTrack, "-stream_loop", "1", "-i", path.join(REEL, "audio-ride-bed.m4a"), "-filter_complex", mix,
  "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", final], "mix");

// 5. Review sheet: a frame every 6 s.
ff(["-i", final, "-vf", "fps=1/6,scale=480:-2,tile=5x4:padding=4", "-frames:v", "1", path.join(REVIEW, "sheet.jpg")], "sheet");
console.log(`FINAL-v4.mp4  ${total.toFixed(2)} s`);
console.log("line starts:", LINES.map((_, k) => (start[k] + VO_LEAD).toFixed(1)).join(" "));
// Gap between one line's last word and the next line's first word; under 0.5 s reads as rushed.
LINES.slice(0, -1).forEach(([a, b], k) => {
  const gap = (start[k + 1] + VO_LEAD + 0.12) - (start[k] + VO_LEAD + 0.12 + (b - a));
  if (gap < 0.5) console.log(`  tight: line ${k + 1} -> ${k + 2} gap ${gap.toFixed(2)} s`);
});
