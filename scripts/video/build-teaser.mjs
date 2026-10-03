#!/usr/bin/env node
// Vertical (1080x1920) and square (1080x1080) teasers for X from media/xr-reel/edit/teaser.json.
//
//   node scripts/video/build-teaser.mjs
//
// Each shot is a square crop of a 1080p clip (cropX = left edge of the 1080 px window), optionally
// sped up. The vertical version sits the video on washi paper under the hook; the square one lays a
// hook card over the video. Both share one soundtrack made from the game's bed.
import fs from "node:fs";
import path from "node:path";
import { EDIT, FPS, REEL, media, ff, fx, frames, gfx, closeGfx, timedOverlay, graphArgs, buildAudio, loudness, probe } from "./lib.mjs";

const T = JSON.parse(fs.readFileSync(path.join(EDIT, "teaser.json"), "utf8"));
const CRF = T.crf ?? 17;

let f0 = 0;
for (const s of T.shots) {
  s.speed = s.speed || 1;
  s.frames = frames((s.out - s.in) / s.speed);
  s.dur = s.frames / FPS;
  s.start = f0 / FPS;
  f0 += s.frames;
}
const TOTAL = f0 / FPS;
const secTime = (s, e) => (e.at != null ? e.at : (e.atClip - s.in) / s.speed);
console.log(`Teaser: ${T.shots.length} shots, ${TOTAL.toFixed(2)} s`);

/** Inputs + graph for the concatenated square video scaled to `size`, ending in [vid]. */
function shotsGraph(size, first) {
  const inputs = [], g = [];
  T.shots.forEach((s, i) => {
    inputs.push("-ss", fx(s.in), "-t", fx(s.out - s.in + 0.25), "-i", media(s.clip));
    g.push(`[${first + i}:v]trim=duration=${fx(s.out - s.in)},setpts=(PTS-STARTPTS)/${s.speed},fps=${FPS},crop=1080:1080:${s.cropX ?? 420}:0,scale=${size}:${size}:flags=lanczos,format=yuv420p,settb=1/${FPS},trim=end_frame=${s.frames}[s${i}]`);
  });
  g.push(`${T.shots.map((_, i) => `[s${i}]`).join("")}concat=n=${T.shots.length}:v=1:a=0[vid]`);
  return { inputs, g };
}

let vertVideo, squareVideo;
const encode = ["-c:v", "libx264", "-preset", "slow", "-crf", String(CRF), "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60", "-an"];

// ------------------------------------------------------------------ vertical
const VW = 1080, VH = 1920, BOX = { x: 40, y: 500, w: 1000, h: 1000 };
{
  const bg = await gfx("teaser-bg", { type: "teaserbg", w: VW, h: VH, box: BOX }, { alpha: false });
  const fg = await gfx("teaser-frame", { type: "splitfg", w: VW, h: VH, boxes: [{ ...BOX, label: "" }] });
  const hook = await gfx("teaser-hook", { type: "teaserhook", w: VW, h: VH, top: 150, size: 84, lines: T.hook });
  const foot = await gfx("teaser-foot", { type: "teaserfoot", w: VW, h: VH, top: 1575, ...T.footer });
  const subs = [];
  for (const [i, s] of T.subs.entries()) subs.push(await gfx(`teaser-sub-${i}`, { type: "teasersub", w: VW, h: VH, top: 380, size: 46, text: s.text }, { seconds: 0.6 }));

  const inputs = [], g = [];
  const still = (f) => { inputs.push("-loop", "1", "-framerate", String(FPS), "-i", f); return inputs.filter((a) => a === "-i").length - 1; };
  const kb = still(bg.first), kf = still(fg.first), kh = still(hook.first), kt = still(foot.first);
  const ks = subs.map((s) => { inputs.push("-framerate", String(FPS), "-i", s.pattern); return inputs.filter((a) => a === "-i").length - 1; });
  const sh = shotsGraph(BOX.w, inputs.filter((a) => a === "-i").length);
  inputs.push(...sh.inputs);
  g.push(...sh.g);
  g.push(`[${kb}:v]format=yuv420p,settb=1/${FPS}[b]`);
  g.push(`[b][vid]overlay=${BOX.x}:${BOX.y}:eof_action=repeat[v0]`);
  g.push(`[v0][${kf}:v]overlay=0:0[v1]`, `[v1][${kh}:v]overlay=0:0[v2]`, `[v2][${kt}:v]overlay=0:0[v3]`);
  let cur = "v3";
  T.subs.forEach((s, i) => {
    g.push(timedOverlay(ks[i], `sb${i}`, { start: s.at, dur: s.dur, animFrames: subs[i].frames, fadeOut: 0.35 }));
    g.push(`[${cur}][sb${i}]overlay=0:0:eof_action=pass[w${i}]`);
    cur = `w${i}`;
  });
  g.push(`[${cur}]format=yuv420p[out]`);
  vertVideo = path.join(EDIT, "cache", "teaser-vertical.mp4");
  ff([...inputs, ...graphArgs("teaser-vertical", g.join(";\n")), "-map", "[out]", "-frames:v", String(f0), ...encode, vertVideo], "teaser vertical video");
}

// ------------------------------------------------------------------ square
{
  const pill = await gfx("teaser-pill", { type: "hookpill", w: 1080, h: 1080, top: 44, size: 46, ...T.squareHook });
  const sh = shotsGraph(1080, 1);
  const g = [...sh.g, `[vid][0:v]overlay=0:0,format=yuv420p[out]`];
  squareVideo = path.join(EDIT, "cache", "teaser-square.mp4");
  ff(["-loop", "1", "-framerate", String(FPS), "-i", pill.first, ...sh.inputs, ...graphArgs("teaser-square", g.join(";\n")), "-map", "[out]", "-frames:v", String(f0), ...encode, squareVideo], "teaser square video");
}
await closeGfx();

// ------------------------------------------------------------------ audio + mux
const A = T.audio || {};
const bedFile = media(A.bed || "audio-ride-bed.m4a");
const pieces = T.shots.map((s, i) => {
  const b = s.bed || {};
  return { id: `shot${i}`, start: s.start, dur: s.dur, bedIn: b.in != null ? b.in : b.cue.src - secTime(s, b.cue), gainDb: s.gainDb || 0 };
});
const accents = T.shots.flatMap((s) => (s.accents || []).map((a) => ({ t: s.start + secTime(s, a), db: a.db, width: a.width })));
const wav = buildAudio("teaser", { bed: bedFile, bedLength: Number(probe(bedFile).format.duration), pieces, total: TOTAL, handle: A.handle ?? 0.3, baseGainDb: A.baseGainDb ?? 5, accents, fadeInEnd: 0.3, fadeOutEnd: 1.2 });

for (const [video, name] of [[vertVideo, T.vertical], [squareVideo, T.square]]) {
  if (!name) continue;
  const out = path.join(EDIT, name);
  ff(["-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], `mux ${name}`);
  const L = loudness(out), p = probe(out);
  const v = p.streams.find((s) => s.codec_type === "video");
  console.log(`${path.relative(REEL, out)}: ${v.width}x${v.height}, ${Number(p.format.duration).toFixed(2)} s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${L.lufs} LUFS`);
}
