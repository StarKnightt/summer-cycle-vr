#!/usr/bin/env node
// Vertical (1080x1920) X teaser in the v2 style: the sun-drag shot under a kinetic hook, with
// word-timed captions from the voiceover ("You reach up, pinch it, and pull it down... like
// you're holding the light"), a light leak into the dusk shot, generated pad and sound design.
//
//   node scripts/video/build-teaser-v2.mjs [--frames]
//
// --frames also writes review stills to edit/review/v2/teaser-*.jpg.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EDIT, CACHE, FPS, REEL, HERE, media, ff, fx, frames, hash, gfx, gfxSeq, captionPhrases, closeGfx, timedOverlay, graphArgs, buildAudio, loudness, probe } from "./lib.mjs";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const VW = 1080, VH = 1920, BOX = { x: 40, y: 430, w: 1000, h: 1000 };
const CAP = { y: BOX.y + BOX.h, h: 250, size: 58, bottom: 78 };
const CLIP = "06-reach-and-drag-sun.mp4";
const S = BOX.w / 1080;

// Voice: P7 from "You reach up" to "holding the light." in voice.wav time, placed at VO_AT.
const VO = { from: 55.92, to: 67.55 }, VO_AT = 1.3;
// "pinch" is spoken at VO_AT + (57.16 - 55.92); the on-screen pinch is clip 6.4.
const shots = [
  { in: 6.4 - (VO_AT + 57.16 - VO.from), out: 17.6, cropX: 400, zoom: { t0: 4.5, t1: 13.5, z: 1.06, x: 520, y: 360 },
    callout: { atClip: 5.75, x: 956, y: 388, r: 74, label: "pinch" }, bed: { src: 20, atClip: 6.4 }, accent: { atClip: 6.4, db: 6 } },
  { in: 24.4, out: 28.6, cropX: 480, zoom: { t0: 0, t1: 4.2, z: 1.05, x: 500, y: 420 }, bedIn: 45.5,
    kinetic: { at: 0.55, dur: 3.6, lines: [{ text: "Seated.", at: 0, size: 92, italic: true }, { text: "Hands only.", at: 0.55, size: 92, italic: true, accent: true }] } },
];
let f0 = 0;
for (const s of shots) { s.frames = frames(s.out - s.in); s.dur = s.frames / FPS; s.start = f0 / FPS; f0 += s.frames; }
const TOTAL = f0 / FPS, CUT = shots[1].start;
console.log(`Teaser v2: ${TOTAL.toFixed(2)} s, cut at ${CUT.toFixed(2)}`);

// ------------------------------------------------------------------ captions
const WORDS = JSON.parse(fs.readFileSync(path.join(EDIT, "voice-words.json"), "utf8"));
const T2 = JSON.parse(fs.readFileSync(path.join(EDIT, "timeline-v2.json"), "utf8"));
const words = WORDS.filter((w) => w.s >= VO.from - 0.05 && w.e <= VO.to + 0.05).map((w) => ({ w: w.w, s: w.s - VO.from + VO_AT, e: w.e - VO.from + VO_AT }));
const PH = captionPhrases(words, { keywords: T2.captions?.keywords, keyPhrases: T2.captions?.keyPhrases, target: 18, max: 26, total: TOTAL });
for (const p of PH) console.log(`  ${p.t0.toFixed(2)}-${p.t1.toFixed(2)}  ${p.words.map((w) => (w.key ? `*${w.w}*` : w.w)).join(" ")}`);

// ------------------------------------------------------------------ graphics
const bg = await gfx("t2-bg", { type: "teaserbg", w: VW, h: VH, box: BOX }, { alpha: false });
const fg = await gfx("t2-frame", { type: "splitfg", w: VW, h: VH, boxes: [{ ...BOX, label: "" }] });
const hook = await gfx("t2-hook", { type: "kinetic", w: VW, h: 430, y: 225, veilW: 10, veilH: 10,
  lines: [{ text: "Pull the sun down", at: 0.15, size: 86 }, { text: "with your bare hands.", at: 0.55, size: 74, italic: true, accent: true }] }, { seconds: 1.8, html: "kinetic.html" });
const foot = await gfx("t2-foot", { type: "teaserfoot", w: VW, h: VH, top: 1700, title: "Summer Cycle", line: "for Meta Quest  ·  @prasenx" });
const callout = await gfx("t2-callout", { type: "callout", w: BOX.w, h: BOX.h, x: Math.round((shots[0].callout.x - shots[0].cropX) * S), y: Math.round(shots[0].callout.y * S), r: Math.round(shots[0].callout.r * S), label: "pinch" }, { seconds: 1.3 });
const kin = await gfx("t2-kin", { type: "kinetic", tone: "light", w: BOX.w, h: BOX.h, y: 330, out: 3.0, lines: shots[1].kinetic.lines }, { seconds: shots[1].kinetic.dur, html: "kinetic.html" });
const leak = await gfx("t2-leak", { type: "leak", kind: "leak", dur: 1.1, w: BOX.w, h: BOX.h }, { seconds: 1.1, html: "kinetic.html" });
const capVisible = (t) => PH.some((p) => t >= p.t0 && t < p.t1 + 0.2);
const cap = await gfxSeq("t2-captrack", { w: VW, h: CAP.h, size: CAP.size, bottom: CAP.bottom, phrases: PH }, { n: f0, html: "captions.html", visible: capVisible });
const wide = (cap.info || []).filter((w) => w > VW - 120);
if (wide.length) console.warn(`  ! ${wide.length} caption phrases wider than the frame margin`);
await closeGfx();

// ------------------------------------------------------------------ video
const inputs = [], g = [];
const add = (...a) => { inputs.push(...a); return inputs.filter((x) => x === "-i").length - 1; };
const still = (f) => add("-loop", "1", "-framerate", String(FPS), "-i", f);
const seq = (p) => add("-framerate", String(FPS), "-i", p);

const sm = (u) => `(${u}*${u}*${u}*(${u}*(${u}*6-15)+10))`;
function push(z) {
  const u = `clip(((in/${FPS})-${fx(z.t0)})/${fx(z.t1 - z.t0)},0,1)`;
  const Z = `(1+${fx(z.z - 1)}*${sm(u)})`, hw = `(W/(2*${Z}))`, hh = `(H/(2*${Z}))`;
  const CX = `clip(${fx(z.x)},${hw},W-${hw})`, CY = `clip(${fx(z.y)},${hh},H-${hh})`;
  const L = `(${CX}-${hw})`, R = `(${CX}+${hw})`, Tp = `(${CY}-${hh})`, B = `(${CY}+${hh})`;
  return `perspective=x0='${L}':y0='${Tp}':x1='${R}':y1='${Tp}':x2='${L}':y2='${B}':x3='${R}':y3='${B}':interpolation=cubic:eval=frame`;
}
shots.forEach((s, i) => {
  const k = add("-ss", fx(s.in), "-t", fx(s.out - s.in + 0.25), "-i", media(CLIP));
  g.push(`[${k}:v]trim=duration=${fx(s.out - s.in)},setpts=PTS-STARTPTS,fps=${FPS},crop=1080:1080:${s.cropX}:0,scale=${BOX.w}:${BOX.h}:flags=lanczos,format=yuv420p,settb=1/${FPS},trim=end_frame=${s.frames}[r${i}]`);
  let cur = `r${i}`;
  if (s.callout) {
    const kc = seq(callout.pattern);
    g.push(`[${kc}:v]format=rgba,setpts=PTS+${fx(s.callout.atClip - s.in)}/TB[co${i}]`, `[${cur}][co${i}]overlay=0:0:eof_action=pass:format=auto[c${i}]`);
    cur = `c${i}`;
  }
  g.push(`[${cur}]${push(s.zoom)}[z${i}]`);
  cur = `z${i}`;
  if (s.kinetic) {
    const kk = seq(kin.pattern);
    g.push(`[${kk}:v]format=rgba,setpts=PTS+${fx(s.kinetic.at)}/TB[kn${i}]`, `[${cur}][kn${i}]overlay=0:0:eof_action=pass:format=auto[k${i}]`);
    cur = `k${i}`;
  }
  g.push(`[${cur}]format=yuv420p,setsar=1[s${i}]`);
});
g.push(`${shots.map((_, i) => `[s${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[vid0]`);
const kl = seq(leak.pattern);
g.push(`[${kl}:v]format=rgba,setpts=PTS+${fx(CUT - 0.55)}/TB[lk]`, `[vid0][lk]overlay=0:0:eof_action=pass:format=auto,fade=t=in:d=0.5:color=0xf4ecd8,fade=t=out:st=${fx(TOTAL - 0.7)}:d=0.7:color=0xf4ecd8[vid]`);

const kb = still(bg.first), kf = still(fg.first), kt = still(foot.first), kh = seq(hook.pattern), kc = seq(cap.pattern);
g.push(`[${kb}:v]format=yuv420p,settb=1/${FPS}[b]`);
g.push(`[b][vid]overlay=${BOX.x}:${BOX.y}:eof_action=repeat[v0]`, `[v0][${kf}:v]overlay=0:0[v1]`);
g.push(timedOverlay(kh, "hk", { start: 0, dur: TOTAL + 1, animFrames: hook.frames, fadeOut: 0 }), `[v1][hk]overlay=0:0:eof_action=pass[v2]`);
g.push(`[${kt}:v]format=rgba,fade=t=in:st=0.6:d=0.8:alpha=1[ft]`, `[v2][ft]overlay=0:0:shortest=0[v3]`);
g.push(`[v3][${kc}:v]overlay=0:${CAP.y}:eof_action=pass:format=auto,format=yuv420p[out]`);
const video = path.join(CACHE, "teaser-v2-video.mp4");
ff([...inputs, ...graphArgs("teaser-v2", g.join(";\n")), "-map", "[out]", "-frames:v", String(f0),
  "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60", "-an", video], "teaser v2 video");

// ------------------------------------------------------------------ audio
const SFX = path.join(CACHE, "sfx");
const py = (args, label) => { const r = spawnSync("python", [path.join(HERE, "make-audio.py"), ...args], { stdio: "inherit" }); if (r.status !== 0) throw new Error(`make-audio ${label} failed`); };
if (!fs.existsSync(path.join(SFX, "chime-e.wav"))) py(["sfx", SFX], "sfx");
const mspec = { total: TOTAL, endStart: CUT, fadeIn: 1.2, level: [[0, 0], [CUT - 0.5, 0], [CUT + 0.5, 3]], v: fs.statSync(path.join(HERE, "make-audio.py")).mtimeMs };
const mf = path.join(CACHE, `music-${hash(mspec)}.wav`);
if (!fs.existsSync(mf)) { fs.writeFileSync(path.join(CACHE, "music-spec-teaser.json"), JSON.stringify(mspec)); py(["music", path.join(CACHE, "music-spec-teaser.json"), mf], "music"); }
const extras = [
  { file: mf, at: 0, gainDb: -12, duckDb: -6 },
  { file: path.join(SFX, "air.wav"), at: CUT - 0.85, gainDb: -20 },
  { file: path.join(SFX, "chime-e.wav"), at: CUT + shots[1].kinetic.at + 0.05, gainDb: -25 },
];
const bedFile = media("audio-ride-bed.m4a");
const pieces = shots.map((s, i) => ({ id: `shot${i}`, start: s.start, dur: s.dur, bedIn: s.bedIn ?? s.bed.src - (s.bed.atClip - s.in), gainDb: i === 0 ? 1 : 0 }));
const accents = [{ t: shots[0].accent.atClip - shots[0].in, db: shots[0].accent.db, width: 0.9 }];
const A = T2.audio;
const voice = { ...A.voice, file: path.join(EDIT, A.voice.file), pieces: [{ at: VO_AT, from: VO.from, to: VO.to }] };
const wav = buildAudio("teaser-v2", { bed: bedFile, bedLength: Number(probe(bedFile).format.duration), pieces, total: TOTAL, handle: 0.3, baseGainDb: A.baseGainDb ?? 3.5, accents, voice,
  fadeInEnd: 0.5, fadeOutEnd: 1.2, targetLufs: -15, ceilingDb: -1.8, extras });

const OUT = path.join(EDIT, "TEASER-X-v2.mp4");
ff(["-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", OUT], "mux TEASER-X-v2.mp4");

if (argv.frames) {
  const dir = path.join(EDIT, "review", "v2");
  fs.mkdirSync(dir, { recursive: true });
  for (const t of [0.4, 2.6, 6.0, 12.2, CUT + 0.05, CUT + 2.0]) ff(["-ss", fx(t), "-i", OUT, "-frames:v", "1", "-vf", "scale=540:-1", "-q:v", "3", path.join(dir, `teaser-${t.toFixed(1)}.jpg`)], `still ${t}`);
}
const L = loudness(OUT), p = probe(OUT);
console.log(`${path.relative(REEL, OUT)}: ${Number(p.format.duration).toFixed(2)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${L.lufs} LUFS, true peak ${L.truePeak}`);
