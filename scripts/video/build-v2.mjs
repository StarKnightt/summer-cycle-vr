#!/usr/bin/env node
// Build FINAL-v2 (the polished cut) from media/xr-reel/edit/timeline-v2.json.
//
//   node scripts/video/build-v2.mjs            # FINAL-v2.mp4 (dynamic captions burned in), subtitles-v2.srt
//   node scripts/video/build-v2.mjs --clean    # also FINAL-v2-clean.mp4 without captions (for Vimeo + .srt)
//   node scripts/video/build-v2.mjs --sheet    # also a contact sheet every 3 s in edit/review/v2/
//
// On top of build-cut.mjs this adds: speed ramps, eased push / punch-in zooms, kinetic text layers,
// light-leak and warm-dip transitions over cuts, word-timed captions, generated music and sound
// effects. Sections are cached by content; the compose pass and the caption track are cached too.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EDIT, CACHE, FPS, PAPER, REEL, HERE, media, ff, fx, frames, hash, gfx, gfxSeq, captionPhrases, closeGfx, timedOverlay, graphArgs, buildAudio, srt, loudness, probe } from "./lib.mjs";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const TL = path.resolve(EDIT, argv.timeline || "timeline-v2.json");
const T = JSON.parse(fs.readFileSync(TL, "utf8"));
const W = T.width || 1920, H = T.height || 1080, CRF = T.crf ?? 18, SEG_CRF = T.sectionCrf ?? 13;

// ------------------------------------------------------------------ speed maps

/**
 * A clip range played with a (possibly ramped) speed. ramp: [[clipTime, speed], ...], speed linear
 * between keys and constant outside them. Returns { a, b, dur, map(clipT) -> range seconds, expr }
 * where expr is a setpts expression in T = seconds since the range start.
 */
function speedMap(r) {
  const a = r.in, b = r.out;
  const keys = (r.ramp || [[a, r.speed ?? 1]]).map(([t, s]) => [t, s]).sort((x, y) => x[0] - y[0]);
  const sAt = (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return keys[i - 1][1] + ((keys[i][1] - keys[i - 1][1]) * (t - keys[i - 1][0])) / (keys[i][0] - keys[i - 1][0]);
    return keys.at(-1)[1];
  };
  const pts = [a, ...keys.map((k) => k[0]).filter((t) => t > a && t < b), b];
  const segs = [];
  let O = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1], s0 = sAt(p0), s1 = sAt(p1), k = (s1 - s0) / (p1 - p0);
    const len = Math.abs(k) < 1e-9 ? (p1 - p0) / s0 : Math.log(s1 / s0) / k;
    segs.push({ p0, p1, s0, k, O });
    O += len;
  }
  const local = (sg, t) => (Math.abs(sg.k) < 1e-9 ? (t - sg.p0) / sg.s0 : Math.log(1 + (sg.k * (t - sg.p0)) / sg.s0) / sg.k);
  const map = (t) => { const sg = segs.find((g) => t <= g.p1 + 1e-9) || segs.at(-1); return sg.O + local(sg, Math.min(Math.max(t, a), b)); };
  const term = (sg) => {
    const L = `(T-${fx(sg.p0 - a)})`;
    return Math.abs(sg.k) < 1e-9 ? `(${fx(sg.O)}+${L}/${fx(sg.s0)})` : `(${fx(sg.O)}+log(1+${fx(sg.k)}*${L}/${fx(sg.s0)})/${fx(sg.k)})`;
  };
  let expr = term(segs.at(-1));
  for (let i = segs.length - 2; i >= 0; i--) expr = `if(lt(T,${fx(segs[i].p1 - a)}),${term(segs[i])},${expr})`;
  return { a, b, dur: O, map, expr, simple: keys.length === 1 ? keys[0][1] : null };
}

// ------------------------------------------------------------------ resolve the timeline

let f0 = 0;
for (const s of T.sections) {
  s.kind = s.card ? "card" : s.split ? "split" : "clip";
  if (s.kind === "clip") {
    const rs = s.ranges || [[s.in ?? 0, s.out]];
    s.rmaps = rs.map((r) => speedMap(Array.isArray(r) ? { in: r[0], out: r[1], speed: r[2] ?? s.speed ?? 1 } : { speed: s.speed ?? 1, ...r }));
    s.join = s.rmaps.length > 1 ? s.join ?? 0 : 0;
    s.rstart = [];
    s.rmaps.forEach((m, i) => s.rstart.push(i === 0 ? 0 : s.rstart[i - 1] + s.rmaps[i - 1].dur - s.join));
    s.dur = s.rstart.at(-1) + s.rmaps.at(-1).dur;
  }
  if (!(s.dur > 0)) throw new Error(`section ${s.id}: no duration`);
  s.frames = frames(s.dur);
  s.dur = s.frames / FPS;
  s.start = f0 / FPS;
  f0 += s.frames;
}
const TOTAL = f0 / FPS;

function secTime(s, e) {
  if (e.at != null) return e.at;
  if (e.atClip == null) return 0;
  if (s.kind !== "clip") throw new Error(`section ${s.id}: atClip only works on clip sections`);
  for (const [i, m] of s.rmaps.entries()) if (e.atClip >= m.a - 1e-6 && e.atClip <= m.b + 1e-6) return s.rstart[i] + m.map(e.atClip);
  throw new Error(`section ${s.id}: clip time ${e.atClip} is not inside any range`);
}

/**
 * Zoom keys [{ at|atClip, z, x, y, step }] -> perspective filter (sub-pixel, eased). x, y is the
 * centre of the visible window in frame pixels; it is kept inside the frame. Between keys the move
 * is a smootherstep; a key with step: true jumps (a punch cut).
 */
function zoomFilter(s) {
  if (!s.zoom?.length) return null;
  const ks = s.zoom.map((k) => ({ t: secTime(s, k), z: k.z ?? 1, x: k.x ?? W / 2, y: k.y ?? H / 2, step: !!k.step })).sort((a, b) => a.t - b.t);
  const tt = `(in/${FPS})`;
  const ease = (a, b) => `(clip((${tt}-${fx(a)})/${fx(Math.max(1e-3, b - a))},0,1))`;
  const sm = (u) => `(${u}*${u}*${u}*(${u}*(${u}*6-15)+10))`;
  const prop = (p) => {
    let e = fx(ks.at(-1)[p]);
    for (let i = ks.length - 2; i >= 0; i--) {
      const A = ks[i], B = ks[i + 1];
      const seg = B.step ? fx(A[p]) : `(${fx(A[p])}+${fx(B[p] - A[p])}*${sm(ease(A.t, B.t))})`;
      e = `if(lt(${tt},${fx(B.t)}),${seg},${e})`;
    }
    return `if(lt(${tt},${fx(ks[0].t)}),${fx(ks[0][p])},${e})`;
  };
  const Z = prop("z"), hw = `(W/(2*${Z}))`, hh = `(H/(2*${Z}))`;
  const CX = `clip(${prop("x")},${hw},W-${hw})`, CY = `clip(${prop("y")},${hh},H-${hh})`;
  const L = `(${CX}-${hw})`, R = `(${CX}+${hw})`, Tp = `(${CY}-${hh})`, B = `(${CY}+${hh})`;
  return `perspective=x0='${L}':y0='${Tp}':x1='${R}':y1='${Tp}':x2='${L}':y2='${B}':x3='${R}':y3='${B}':interpolation=cubic:eval=frame`;
}

// ------------------------------------------------------------------ one section -> one mp4

async function renderSection(s, idx) {
  const inputs = [], g = [], deps = [];
  let n = 0, cur;
  const add = (...a) => { inputs.push(...a); return n++; };

  if (s.kind === "clip") {
    const file = media(s.clip);
    deps.push(fs.statSync(file).mtimeMs);
    s.rmaps.forEach((m, j) => {
      const k = add("-ss", fx(m.a), "-t", fx(m.b - m.a + 0.25), "-i", file);
      g.push(`[${k}:v]trim=duration=${fx(m.b - m.a)},setpts=PTS-STARTPTS,setpts='(${m.expr})/TB',fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p,settb=1/${FPS}[r${j}]`);
    });
    cur = "r0";
    for (let j = 1; j < s.rmaps.length; j++) {
      const o = `j${j}`;
      g.push(s.join > 0
        ? `[${cur}][r${j}]xfade=transition=fade:duration=${fx(s.join)}:offset=${fx(s.rstart[j])}[${o}]`
        : `[${cur}][r${j}]concat=n=2:v=1:a=0[${o}]`);
      cur = o;
    }
  } else if (s.kind === "card") {
    const c = await gfx(`v2card-${s.id}`, { ...s.card, w: W, h: H }, { seconds: s.dur, alpha: false, html: s.card.html || "kinetic.html" });
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

  // Hand rings sit on the footage, so they zoom with it.
  for (const [j, c] of (s.callouts || []).entries()) {
    const a = await gfx(`callout-${s.id}-${j}`, { type: "callout", w: W, h: H, x: c.x, y: c.y, r: c.r, label: c.label, labelSide: c.labelSide }, { seconds: 1.3 });
    deps.push(a.dir);
    const k = add("-framerate", String(FPS), "-i", a.pattern);
    g.push(timedOverlay(k, `co${j}`, { start: secTime(s, c), dur: c.dur || 1.6, animFrames: a.frames, fadeOut: 0.35 }));
    g.push(`[${cur}][co${j}]overlay=0:0:eof_action=pass:format=auto[vco${j}]`);
    cur = `vco${j}`;
  }
  const z = zoomFilter(s);
  if (z) { g.push(`[${cur}]${z}[vz]`); cur = "vz"; }

  // Kinetic text and other full-animation layers ride above the zoom.
  for (const [j, l] of (s.layers || []).entries()) {
    const a = await gfx(`layer-${s.id}-${j}`, { ...l.spec, w: W, h: H }, { seconds: l.dur, html: l.spec.html || "kinetic.html" });
    deps.push(a.dir);
    const k = add("-framerate", String(FPS), "-i", a.pattern);
    g.push(`[${k}:v]format=rgba,setpts=PTS+${fx(secTime(s, l))}/TB[ly${j}]`);
    g.push(`[${cur}][ly${j}]overlay=0:0:eof_action=pass:format=auto[vly${j}]`);
    cur = `vly${j}`;
  }

  const fades = [];
  if (s.fadeIn) fades.push(`fade=t=in:st=0:d=${fx(s.fadeIn)}:color=${s.fadeColor || PAPER}`);
  if (s.fadeOut) fades.push(`fade=t=out:st=${fx(s.dur - s.fadeOut)}:d=${fx(s.fadeOut)}:color=${s.fadeColor || PAPER}`);
  g.push(`[${cur}]${[...fades, "tpad=stop_mode=clone:stop_duration=1", "format=yuv420p"].join(",")}[out]`);

  const { vo, start, sfx, tin, bed, accents, gainDb, ...visual } = s;
  const key = hash({ visual, deps, W, H, SEG_CRF, v: 2 });
  const out = path.join(CACHE, `v2seg-${String(idx).padStart(2, "0")}-${s.id}-${key}.mp4`);
  if (!fs.existsSync(out)) {
    for (const f of fs.readdirSync(CACHE)) if (f.startsWith(`v2seg-${String(idx).padStart(2, "0")}-`)) fs.rmSync(path.join(CACHE, f));
    ff([...inputs, ...graphArgs(`v2seg-${s.id}`, g.join(";\n")), "-map", "[out]", "-frames:v", String(s.frames),
      "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-crf", String(SEG_CRF), "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "30",
      "-video_track_timescale", "15360", "-an", out], `section ${s.id} (${s.dur.toFixed(2)} s)`);
  } else console.log(`  section ${s.id}: cached`);
  return out;
}

// ------------------------------------------------------------------ voice, words, captions

const A = T.audio || {};
const cues = JSON.parse(fs.readFileSync(path.resolve(EDIT, A.voice.cues), "utf8"));
const WORDS = JSON.parse(fs.readFileSync(path.resolve(EDIT, A.voice.words || "voice-words.json"), "utf8"));
const voPieces = T.sections.flatMap((s) => [].concat(s.vo || []).map((v) => {
  const [from, to] = v.p ? cues.paragraphs[v.p] : [v.from, v.to];
  return { section: s.id, p: v.p, at: s.start + secTime(s, v), from, to };
}));
for (let i = 1; i < voPieces.length; i++) {
  const a = voPieces[i - 1], b = voPieces[i];
  if (a.at + a.to - a.from > b.at - 0.2) console.warn(`  ! voice ${a.p} runs into ${b.p} (${(a.at + a.to - a.from - b.at).toFixed(2)} s)`);
}
const toOut = (t) => { const v = voPieces.find((p) => t >= p.from - 0.06 && t <= p.to + 0.06); return v ? v.at + t - v.from : null; };

const words = WORDS.map((w) => ({ w: w.w, s: toOut(w.s), e: toOut(w.e) ?? toOut(w.s) + (w.e - w.s) })).filter((w) => w.s != null);
const PH = captionPhrases(words, { keywords: T.captions?.keywords, keyPhrases: T.captions?.keyPhrases, total: TOTAL });

if (argv.plan) {
  console.log(`total ${TOTAL.toFixed(2)} s`);
  console.table(T.sections.map((s) => ({ id: s.id, start: s.start.toFixed(2), end: (s.start + s.dur).toFixed(2), dur: s.dur.toFixed(2),
    vo: voPieces.filter((v) => v.section === s.id).map((v) => `${v.p} ${v.at.toFixed(2)}-${(v.at + v.to - v.from).toFixed(2)}`).join(", ") })));
  for (const e of [].concat(argv.plan === true ? [] : String(argv.plan).split(","))) {
    const [sid, clipT] = e.split("@");
    const s = T.sections.find((x) => x.id === sid);
    console.log(`  ${sid} clip ${clipT} -> ${(s.start + secTime(s, { atClip: Number(clipT) })).toFixed(2)}`);
  }
  for (const p of PH) console.log(`  ${p.t0.toFixed(2)}-${p.t1.toFixed(2)}  ${p.words.map((w) => (w.key ? `*${w.w}*` : w.w)).join(" ")}`);
  process.exit(0);
}

// ------------------------------------------------------------------ main

console.log(`Timeline ${path.relative(REEL, TL)}: ${T.sections.length} sections, ${TOTAL.toFixed(2)} s, ${PH.length} caption phrases`);
const segs = [];
for (const [i, s] of T.sections.entries()) segs.push(await renderSection(s, i));

const list = path.join(CACHE, "v2concat.txt");
fs.writeFileSync(list, segs.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
const video = path.join(CACHE, "v2video.mp4");
ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video], "join sections");

// Transitions over cuts (section `tin`), each centred on the cut.
const trans = [];
for (const s of T.sections) {
  if (!s.tin) continue;
  const d = s.tin.dur || 0.8;
  const t = s.start + (s.tin.offset || 0);
  if (s.tin.kind === "cut") { trans.push({ t, d, kind: "cut", sound: s.tin.sound }); continue; }
  const a = await gfx(`trans-${s.tin.kind}-${Math.round(d * 100)}`, { type: "leak", kind: s.tin.kind, dur: d, w: W, h: H }, { seconds: d, html: "kinetic.html" });
  trans.push({ t, d, kind: s.tin.kind, pattern: a.pattern, sound: s.tin.sound });
}

// Caption track: a strip along the bottom of the frame.
const CAP = { h: T.captions?.stripH || 260, size: T.captions?.size || 50, bottom: T.captions?.bottom || 62 };
const capVisible = (t) => PH.some((p) => t >= p.t0 && t < p.t1 + 0.2);
const capTrack = await gfxSeq("captrack", { w: W, h: CAP.h, size: CAP.size, bottom: CAP.bottom, phrases: PH }, { n: f0, html: "captions.html", visible: capVisible });
const wide = (capTrack.info || []).map((w, i) => [w, i]).filter(([w]) => w > W - 160);
if (wide.length) console.warn(`  ! ${wide.length} caption phrases wider than the frame margin`, wide.map(([w, i]) => PH[i].words.map((x) => x.w).join(" ")));
await closeGfx();

// ------------------------------------------------------------------ audio

const pieces = T.sections.map((s) => {
  const b = s.bed || {};
  const bedIn = b.in != null ? b.in : b.cue ? b.cue.src - secTime(s, b.cue) : 0;
  return { id: s.id, start: s.start, dur: s.dur, bedIn, gainDb: s.gainDb || 0 };
});
const accents = T.sections.flatMap((s) => (s.accents || []).map((a) => ({ t: s.start + secTime(s, a), db: a.db, width: a.width })));
const SFX = path.join(CACHE, "sfx");
const py = (args, label) => { const r = spawnSync("python", [path.join(HERE, "make-audio.py"), ...args], { stdio: "inherit" }); if (r.status !== 0) throw new Error(`make-audio ${label} failed`); };
if (!fs.existsSync(path.join(SFX, "chime-e.wav")) || fs.statSync(path.join(SFX, "chime-e.wav")).mtimeMs < fs.statSync(path.join(HERE, "make-audio.py")).mtimeMs) py(["sfx", SFX], "sfx");
const extras = [];
const M = T.music;
if (M) {
  const endS = T.sections.find((s) => s.id === M.endSection);
  const spec = { total: TOTAL, endStart: endS ? endS.start : TOTAL - 6, fadeIn: M.fadeIn ?? 2, level: M.level || [[0, 0]], v: fs.statSync(path.join(HERE, "make-audio.py")).mtimeMs };
  const mf = path.join(CACHE, `music-${hash(spec)}.wav`);
  if (!fs.existsSync(mf)) { fs.writeFileSync(path.join(CACHE, "music-spec.json"), JSON.stringify(spec)); py(["music", path.join(CACHE, "music-spec.json"), mf], "music"); }
  extras.push({ file: mf, at: 0, gainDb: M.gainDb ?? -12, duckDb: M.duckDb ?? -7 });
}
for (const tr of trans) {
  const snd = tr.sound ?? { leak: "air", dip: "whoosh", cut: "whoosh" }[tr.kind];
  if (!snd) continue;
  const lead = { air: 0.85, whoosh: 0.48, swell: 1.95 }[snd] ?? 0.4;
  extras.push({ file: path.join(SFX, `${snd}.wav`), at: tr.t - lead, gainDb: { air: -21, whoosh: -24, swell: -19 }[snd] ?? -22 });
}
for (const s of T.sections) for (const x of s.sfx || []) extras.push({ file: path.join(SFX, `${x.file}.wav`), at: s.start + secTime(s, x), gainDb: x.gainDb ?? -22 });

const bedFile = media(A.bed || "audio-ride-bed.m4a");
const voice = { ...A.voice, file: path.resolve(EDIT, A.voice.file), pieces: voPieces };
const wav = buildAudio("v2", { bed: bedFile, bedLength: Number(probe(bedFile).format.duration), pieces, total: TOTAL, handle: A.handle ?? 0.35, baseGainDb: A.baseGainDb ?? 0, accents, voice, targetLufs: A.targetLufs, ceilingDb: A.ceilingDb, extras });

// ------------------------------------------------------------------ compose + mux

async function compose(out, withCaptions) {
  const inputs = ["-i", video, "-i", wav], g = [];
  let cur = "0:v", k = 2;
  for (const [i, tr] of trans.entries()) {
    if (!tr.pattern) continue;
    inputs.push("-framerate", String(FPS), "-i", tr.pattern);
    g.push(`[${k++}:v]format=rgba,setpts=PTS+${fx(tr.t - tr.d / 2)}/TB[tr${i}]`);
    g.push(`[${cur}][tr${i}]overlay=0:0:eof_action=pass:format=auto[vt${i}]`);
    cur = `vt${i}`;
  }
  if (withCaptions) {
    inputs.push("-framerate", String(FPS), "-i", capTrack.pattern);
    g.push(`[${cur}][${k++}:v]overlay=0:${H - CAP.h}:eof_action=pass:format=auto[vc]`);
    cur = "vc";
  }
  g.push(`[${cur}]format=yuv420p[vout]`);
  ff([...inputs, ...graphArgs(`v2compose-${withCaptions ? "cap" : "clean"}`, g.join(";\n")), "-map", "[vout]", "-map", "1:a", "-frames:v", String(f0),
    "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-crf", String(CRF), "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out], `compose ${path.basename(out)}`);
}
const OUT = path.join(EDIT, T.output || "FINAL-v2.mp4");
await compose(OUT, true);
if (argv.clean) await compose(path.join(EDIT, T.cleanOutput || "FINAL-v2-clean.mp4"), false);

// Plain subtitles for Vimeo, from the exact lines, moved with their paragraph.
const subs = [];
for (const v of voPieces) for (const c of cues.subtitles) if (c.start >= v.from - 0.05 && c.end <= v.to + 0.05) subs.push({ start: v.at + c.start - v.from, end: v.at + c.end - v.from, text: c.text });
subs.sort((a, b) => a.start - b.start);
subs.forEach((c, i) => { const nx = subs[i + 1]?.start ?? TOTAL - 0.2; c.start = Math.max(0, c.start - 0.08); c.end = Math.min(Math.max(c.end + 0.35, c.start + 1.3), nx - 0.12); });
fs.writeFileSync(path.join(EDIT, T.subtitles || "subtitles-v2.srt"), srt(subs));

const resolved = T.sections.map((s) => ({ id: s.id, start: +s.start.toFixed(3), end: +(s.start + s.dur).toFixed(3), dur: +s.dur.toFixed(3),
  vo: voPieces.filter((v) => v.section === s.id).map((v) => `${v.p} ${v.at.toFixed(2)}-${(v.at + v.to - v.from).toFixed(2)}`).join(", ") || undefined }));
fs.writeFileSync(path.join(EDIT, "timeline-v2.resolved.json"), JSON.stringify({ total: +TOTAL.toFixed(3), sections: resolved, phrases: PH }, null, 1));

if (argv.sheet) {
  const dir = path.join(EDIT, "review", "v2");
  fs.mkdirSync(dir, { recursive: true });
  const step = Number(argv.step || 3);
  const n = Math.ceil(TOTAL / step);
  ff(["-i", OUT, "-vf", `fps=1/${step},scale=384:-1,tile=5x${Math.ceil(n / 5)}:padding=4:color=white`, "-frames:v", "1", "-q:v", "3", path.join(dir, "sheet.jpg")], "contact sheet");
}

const L = loudness(OUT), p = probe(OUT);
console.log(`\n${path.relative(REEL, OUT)}: ${Number(p.format.duration).toFixed(2)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${L.lufs} LUFS integrated, true peak ${L.truePeak} dBFS`);
console.table(resolved.map((r) => ({ ...r, start: fmt(r.start), end: fmt(r.end) })));
function fmt(s) { return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`; }
