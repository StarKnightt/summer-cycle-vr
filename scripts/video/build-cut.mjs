#!/usr/bin/env node
// Build the Summer Cycle cut from media/xr-reel/edit/timeline.json.
//
//   node scripts/video/build-cut.mjs                 # FINAL.mp4, subtitles.srt, FINAL-subtitled.mp4
//   node scripts/video/build-cut.mjs --timeline=edit/other.json
//   node scripts/video/build-cut.mjs --stills        # also save a frame from every section to edit/review/
//   node scripts/video/build-cut.mjs --no-voice      # ignore edit/voice.wav even if it exists
//   node scripts/video/build-cut.mjs --no-subtitled  # skip the burned-in subtitle version
//
// Sections render to edit/cache/ (keyed by their content, so only what changed re-renders), are
// joined without re-encoding, and the soundtrack bed plus the voice paragraphs are mixed on top.
import fs from "node:fs";
import path from "node:path";
import { EDIT, CACHE, FPS, PAPER, REEL, media, ff, fx, frames, hash, gfx, closeGfx, timedOverlay, graphArgs, buildAudio, srt, wrap, loudness, probe } from "./lib.mjs";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const TL = path.resolve(EDIT, argv.timeline || "timeline.json");
const T = JSON.parse(fs.readFileSync(TL, "utf8"));
const W = T.width || 1920, H = T.height || 1080, CRF = T.crf ?? 16;
const capDefaults = T.captionDefaults || {};

// ------------------------------------------------------------------ resolve the timeline

let f0 = 0;
for (const s of T.sections) {
  s.kind = s.card ? "card" : s.split ? "split" : "clip";
  if (s.kind === "clip") {
    s.ranges = (s.ranges || [[s.in ?? 0, s.out]]).map(([a, b, sp]) => [a, b, sp ?? s.speed ?? 1]);
    s.join = s.ranges.length > 1 ? s.join ?? 0 : 0;
    s.rdur = s.ranges.map(([a, b, sp]) => (b - a) / sp);
    s.rstart = [];
    s.rdur.forEach((d, i) => s.rstart.push(i === 0 ? 0 : s.rstart[i - 1] + s.rdur[i - 1] - s.join));
    s.dur = s.rstart.at(-1) + s.rdur.at(-1);
  }
  if (!(s.dur > 0)) throw new Error(`section ${s.id}: no duration`);
  s.frames = frames(s.dur);
  s.dur = s.frames / FPS;
  s.start = f0 / FPS;
  f0 += s.frames;
}
const TOTAL = f0 / FPS;

/** Section-relative seconds for an event given as { at } (section time) or { atClip } (source clip time). */
function secTime(s, e) {
  if (e.at != null) return e.at;
  if (e.atClip == null) return 0;
  if (s.kind !== "clip") throw new Error(`section ${s.id}: atClip only works on clip sections`);
  let best = null;
  s.ranges.forEach(([a, b, sp], i) => { if (e.atClip >= a - 1e-6 && e.atClip <= b + 1e-6 && best == null) best = s.rstart[i] + (e.atClip - a) / sp; });
  if (best == null) throw new Error(`section ${s.id}: clip time ${e.atClip} is not inside any range`);
  return best;
}

// ------------------------------------------------------------------ one section -> one mp4

async function renderSection(s, idx) {
  const inputs = [], g = [], deps = [];
  let n = 0, cur;
  const add = (...a) => { inputs.push(...a); return n++; };

  if (s.kind === "clip") {
    const file = media(s.clip);
    deps.push(fs.statSync(file).mtimeMs);
    s.ranges.forEach(([a, b, sp], j) => {
      const k = add("-ss", fx(a), "-t", fx(b - a + 0.25), "-i", file);
      g.push(`[${k}:v]trim=duration=${fx(b - a)},setpts=(PTS-STARTPTS)/${sp},fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p,settb=1/${FPS}[r${j}]`);
    });
    cur = "r0";
    for (let j = 1; j < s.ranges.length; j++) {
      const o = `j${j}`;
      g.push(s.join > 0
        ? `[${cur}][r${j}]xfade=transition=fade:duration=${fx(s.join)}:offset=${fx(s.rstart[j])}[${o}]`
        : `[${cur}][r${j}]concat=n=2:v=1:a=0[${o}]`);
      cur = o;
    }
  } else if (s.kind === "card") {
    const c = await gfx(`card-${s.id}`, { ...s.card, w: W, h: H }, { seconds: s.dur, alpha: false });
    deps.push(c.dir);
    const k = add("-framerate", String(FPS), "-i", c.pattern);
    g.push(`[${k}:v]format=yuv420p[card]`);
    cur = "card";
  } else {
    const bw = Math.round(W * 0.4583), bh = Math.round((bw * 9) / 16), gap = Math.round(W * 0.03);
    const x0 = Math.round((W - 2 * bw - gap) / 2), y0 = Math.round((H - bh) / 2) - 10;
    const L = s.split.left, R = s.split.right;
    const boxes = [{ x: x0, y: y0, w: bw, h: bh, kicker: L.kicker, label: L.label }, { x: x0 + bw + gap, y: y0, w: bw, h: bh, kicker: R.kicker, label: R.label }];
    const bg = await gfx(`split-bg-${s.id}`, { type: "splitbg", w: W, h: H, boxes });
    const fg = await gfx(`split-fg-${s.id}`, { type: "splitfg", w: W, h: H, boxes });
    deps.push(bg.dir, fg.dir);
    const kb = add("-loop", "1", "-framerate", String(FPS), "-i", bg.first);
    const kf = add("-loop", "1", "-framerate", String(FPS), "-i", fg.first);
    const kl = add("-ss", fx(L.in), "-t", fx(s.dur * (L.speed || 1) + 0.25), "-i", media(L.clip));
    const kr = add("-ss", fx(R.in), "-t", fx(s.dur * (R.speed || 1) + 0.25), "-i", media(R.clip));
    g.push(`[${kl}:v]setpts=(PTS-STARTPTS)/${L.speed || 1},fps=${FPS},scale=${bw}:${bh}:flags=lanczos,format=yuv420p[sl]`);
    g.push(`[${kr}:v]setpts=(PTS-STARTPTS)/${R.speed || 1},fps=${FPS},scale=${bw}:${bh}:flags=lanczos,format=yuv420p[sr]`);
    g.push(`[${kb}:v]format=yuv420p,settb=1/${FPS}[sb]`);
    g.push(`[sb][sl]overlay=${boxes[0].x}:${boxes[0].y}:eof_action=repeat[s1]`);
    g.push(`[s1][sr]overlay=${boxes[1].x}:${boxes[1].y}:eof_action=repeat[s2]`);
    g.push(`[s2][${kf}:v]overlay=0:0:format=auto[split]`);
    cur = "split";
  }

  // Callouts (hand rings) and lower-third captions, each an animated PNG sequence held and faded.
  for (const [j, c] of (s.callouts || []).entries()) {
    const a = await gfx(`callout-${s.id}-${j}`, { type: "callout", w: W, h: H, x: c.x, y: c.y, r: c.r, label: c.label, labelSide: c.labelSide }, { seconds: 1.3 });
    deps.push(a.dir);
    const k = add("-framerate", String(FPS), "-i", a.pattern);
    g.push(timedOverlay(k, `co${j}`, { start: secTime(s, c), dur: c.dur || 1.6, animFrames: a.frames, fadeOut: 0.35 }));
    g.push(`[${cur}][co${j}]overlay=0:0:eof_action=pass:format=auto[vco${j}]`);
    cur = `vco${j}`;
  }
  for (const [j, c] of (s.captions || []).entries()) {
    const spec = { type: "caption", w: W, h: H, pos: c.pos ?? capDefaults.pos, x: c.x ?? capDefaults.x, y: c.y ?? capDefaults.y, kicker: c.kicker, text: c.text };
    const a = await gfx(`cap-${s.id}-${j}`, spec, { seconds: 0.7 });
    deps.push(a.dir);
    const k = add("-framerate", String(FPS), "-i", a.pattern);
    g.push(timedOverlay(k, `cp${j}`, { start: secTime(s, c), dur: c.dur || 3, animFrames: a.frames, fadeOut: 0.4 }));
    g.push(`[${cur}][cp${j}]overlay=0:0:eof_action=pass:format=auto[vcp${j}]`);
    cur = `vcp${j}`;
  }

  const fades = [];
  if (s.fadeIn) fades.push(`fade=t=in:st=0:d=${fx(s.fadeIn)}:color=${s.fadeColor || PAPER}`);
  if (s.fadeOut) fades.push(`fade=t=out:st=${fx(s.dur - s.fadeOut)}:d=${fx(s.fadeOut)}:color=${s.fadeColor || PAPER}`);
  g.push(`[${cur}]${[...fades, "tpad=stop_mode=clone:stop_duration=1", "format=yuv420p"].join(",")}[out]`);

  const { vo, start, ...visual } = s;
  const key = hash({ visual, deps, W, H, CRF, profile: "high" });
  const out = path.join(CACHE, `seg-${String(idx).padStart(2, "0")}-${s.id}-${key}.mp4`);
  if (!fs.existsSync(out)) {
    for (const f of fs.readdirSync(CACHE)) if (f.startsWith(`seg-${String(idx).padStart(2, "0")}-${s.id}-`)) fs.rmSync(path.join(CACHE, f));
    ff([...inputs, ...graphArgs(`seg-${s.id}`, g.join(";\n")), "-map", "[out]", "-frames:v", String(s.frames),
      "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-crf", String(CRF), "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60",
      "-video_track_timescale", "15360", "-an", out], `section ${s.id} (${s.dur.toFixed(2)} s)`);
  } else console.log(`  section ${s.id}: cached`);
  return out;
}

// ------------------------------------------------------------------ main

console.log(`Timeline ${path.relative(REEL, TL)}: ${T.sections.length} sections, ${TOTAL.toFixed(2)} s`);
const segs = [];
for (const [i, s] of T.sections.entries()) segs.push(await renderSection(s, i));
await closeGfx();

const list = path.join(CACHE, "concat.txt");
fs.writeFileSync(list, segs.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
const video = path.join(CACHE, "video.mp4");
ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video], "join sections");

// Soundtrack: one piece of the bed per section, aligned so cues land on their frames.
const A = T.audio || {};
const pieces = T.sections.map((s) => {
  const b = s.bed || {};
  const bedIn = b.in != null ? b.in : b.cue ? b.cue.src - secTime(s, b.cue) : 0;
  return { id: s.id, start: s.start, dur: s.dur, bedIn, gainDb: s.gainDb || 0 };
});
const accents = T.sections.flatMap((s) => (s.accents || []).map((a) => ({ t: s.start + secTime(s, a), db: a.db, width: a.width })));
// Voice: each section's `vo` places one or more paragraphs of voice.wav (named in voice-cues.json,
// or given as { from, to } in voice.wav seconds) at section time `at`.
const cues = A.voice?.cues && fs.existsSync(path.resolve(EDIT, A.voice.cues)) ? JSON.parse(fs.readFileSync(path.resolve(EDIT, A.voice.cues), "utf8")) : null;
const voPieces = T.sections.flatMap((s) => [].concat(s.vo || []).map((v) => {
  const [from, to] = v.p ? cues?.paragraphs[v.p] ?? (() => { throw new Error(`section ${s.id}: unknown voice paragraph ${v.p}`); })() : [v.from, v.to];
  return { section: s.id, p: v.p, at: s.start + secTime(s, v), from, to };
}));
for (let i = 1; i < voPieces.length; i++) {
  const a = voPieces[i - 1], b = voPieces[i];
  if (a.at + a.to - a.from > b.at - 0.15) console.warn(`  ! voice ${a.p || a.section} runs into ${b.p || b.section} (${(a.at + a.to - a.from - b.at).toFixed(2)} s overlap)`);
}
const voice = A.voice && !argv["no-voice"] ? { ...A.voice, file: path.resolve(EDIT, A.voice.file), pieces: voPieces } : null;
if (voice && !fs.existsSync(voice.file)) console.log(`  (no ${path.relative(EDIT, voice.file)} yet: building without voice)`);
const bedFile = media(A.bed || "audio-ride-bed.m4a");
const bedLength = Number(probe(bedFile).format.duration);
const wav = buildAudio("cut", { bed: bedFile, bedLength, pieces, total: TOTAL, handle: A.handle ?? 0.35, baseGainDb: A.baseGainDb ?? 0, accents, voice, targetLufs: A.targetLufs, ceilingDb: A.ceilingDb });

const OUT = path.join(EDIT, T.output || "ROUGH-CUT.mp4");
ff(["-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", OUT], "mux");

// Subtitles: the exact spoken lines from voice-cues.json, moved with their paragraph. Each stays up
// a little after the words end (never into the next line) so short lines can be read.
const subs = [];
if (cues) {
  for (const v of voPieces)
    for (const c of cues.subtitles) if (c.start >= v.from - 0.05 && c.end <= v.to + 0.05) subs.push({ start: v.at + c.start - v.from, end: v.at + c.end - v.from, text: c.text });
  subs.sort((a, b) => a.start - b.start);
  subs.forEach((c, i) => {
    const next = subs[i + 1]?.start ?? TOTAL - 0.2;
    c.start = Math.max(0, c.start - 0.08);
    c.end = Math.min(Math.max(c.end + 0.35, c.start + 1.3), next - 0.12);
  });
  fs.writeFileSync(path.join(EDIT, T.subtitles || "subtitles.srt"), srt(subs));
}

// Burned-in version: each line as a paper pill (subs.html) faded in over the finished cut.
if (T.subtitledOutput && subs.length && !argv["no-subtitled"]) {
  const SH = 240, inputs = ["-i", OUT], g = [];
  let cur = "0:v";
  for (const [i, c] of subs.entries()) {
    const a = await gfx(`sub-${String(i).padStart(2, "0")}`, { w: W, h: SH, text: wrap(c.text), size: 40 }, { html: "subs.html" });
    const d = c.end - c.start;
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fx(d), "-i", a.first);
    g.push(`[${i + 1}:v]format=rgba,fade=t=in:st=0:d=0.12:alpha=1,fade=t=out:st=${fx(d - 0.12)}:d=0.12:alpha=1,setpts=PTS+${fx(c.start)}/TB[s${i}]`);
    g.push(`[${cur}][s${i}]overlay=0:${H - SH}:eof_action=pass:format=auto[v${i}]`);
    cur = `v${i}`;
  }
  await closeGfx();
  g.push(`[${cur}]format=yuv420p[vout]`);
  ff([...inputs, ...graphArgs("subtitled", g.join(";\n")), "-map", "[vout]", "-map", "0:a", "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-crf", String(CRF),
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60", "-c:a", "copy", "-movflags", "+faststart", path.join(EDIT, T.subtitledOutput)], `burn subtitles (${subs.length} lines)`);
}

// A resolved copy of the timeline (absolute times).
const resolved = T.sections.map((s) => ({ id: s.id, start: +s.start.toFixed(3), end: +(s.start + s.dur).toFixed(3), dur: +s.dur.toFixed(3),
  bedIn: +pieces.find((p) => p.id === s.id).bedIn.toFixed(3), vo: voPieces.filter((v) => v.section === s.id).map((v) => `${v.p} ${v.at.toFixed(2)}-${(v.at + v.to - v.from).toFixed(2)}`).join(", ") || undefined }));
fs.writeFileSync(path.join(EDIT, "timeline.resolved.json"), JSON.stringify({ total: +TOTAL.toFixed(3), sections: resolved }, null, 1));

if (argv.stills) {
  fs.mkdirSync(path.join(EDIT, "review"), { recursive: true });
  for (const s of T.sections) {
    const c = (s.captions || [])[0];
    const t = s.start + (c ? secTime(s, c) + 1.0 : s.dur * 0.6);
    ff(["-ss", fx(t), "-i", OUT, "-frames:v", "1", "-q:v", "3", path.join(EDIT, "review", `cut-${s.id}.jpg`)]);
  }
}

const L = loudness(OUT);
const p = probe(OUT);
console.log(`\n${path.relative(REEL, OUT)}: ${Number(p.format.duration).toFixed(2)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${L.lufs} LUFS integrated, true peak ${L.truePeak} dBFS`);
console.table(resolved.map((r) => ({ ...r, start: fmt(r.start), end: fmt(r.end) })));
function fmt(s) { return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`; }
