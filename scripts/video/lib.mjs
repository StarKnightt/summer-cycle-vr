// Shared helpers for the Summer Cycle video edit: paths, ffmpeg, the washi graphics renderer
// (scripts/video/gfx.html rendered frame by frame in headless Chromium), the soundtrack bed
// builder and the subtitle writer.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const REEL = path.join(ROOT, "media", "xr-reel");
export const EDIT = path.join(REEL, "edit");
export const GFX = path.join(EDIT, "gfx");
export const CACHE = path.join(EDIT, "cache");
export const FPS = 30;
export const PAPER = "0xf4ecd8";

for (const d of [EDIT, GFX, CACHE]) fs.mkdirSync(d, { recursive: true });

export const hash = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 12);
export const fx = (n) => Number(n).toFixed(4);
export const frames = (sec) => Math.round(sec * FPS);

/** Resolve a path from the timeline: bare clip names live in media/xr-reel, other relative paths are relative to edit/. */
export function media(p) {
  if (path.isAbsolute(p)) return p;
  if (fs.existsSync(path.join(REEL, p))) return path.join(REEL, p);
  if (/^\d\d$/.test(p)) {
    const hit = fs.readdirSync(REEL).find((f) => f.startsWith(p + "-") && f.endsWith(".mp4"));
    if (hit) return path.join(REEL, hit);
  }
  return path.resolve(EDIT, p);
}

export function ff(args, label = "") {
  const t = Date.now();
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", "-loglevel", "error", "-nostdin", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`ffmpeg failed${label ? ` (${label})` : ""}:\nffmpeg ${args.join(" ")}`);
  if (label) console.log(`  ${label} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}

export function probe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(r.stdout);
}

export function loudness(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const s = r.stderr;
  const I = /I:\s+(-?[\d.]+) LUFS/g, P = /Peak:\s+(-?[\d.]+) dBFS/g;
  let m, i = null, p = null;
  while ((m = I.exec(s))) i = Number(m[1]);
  while ((m = P.exec(s))) p = Number(m[1]);
  return { lufs: i, truePeak: p };
}

/** Write a filter graph to a file (keeps Windows command lines short) and return the ffmpeg args for it. */
export function graphArgs(name, graph) {
  const f = path.join(CACHE, `${name}.graph.txt`);
  fs.writeFileSync(f, graph);
  return ["-/filter_complex", f];
}

// ------------------------------------------------------------------ graphics (Playwright)

const htmlKeys = {};
const htmlKey = (html) => (htmlKeys[html] ??= hash(fs.readFileSync(path.join(HERE, html), "utf8")));
let browser = null;
const pages = {};

async function ensurePage(html) {
  if (pages[html]) return pages[html];
  browser ??= await chromium.launch({ channel: "chromium", headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"] });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(HERE, html)).href);
  return (pages[html] = page);
}
export async function closeGfx() {
  if (browser) await browser.close();
  browser = null;
  for (const k of Object.keys(pages)) delete pages[k];
}

/**
 * Render a graphic to a PNG sequence (cached by content). `seconds` of animation are rendered;
 * 0 renders one still frame. Returns { dir, pattern, first, frames, bounds }.
 */
export async function gfx(id, spec, { seconds = 0, alpha = true, html = "gfx.html" } = {}) {
  const n = Math.max(1, frames(seconds));
  const key = html === "gfx.html" ? hash({ spec, n, alpha, HTML_KEY: htmlKey(html) }) : hash({ spec, n, alpha, html, k: htmlKey(html) });
  const dir = path.join(GFX, `${id}-${key}`);
  const out = { dir, pattern: path.join(dir, "%04d.png"), first: path.join(dir, "0000.png"), frames: n };
  if (fs.existsSync(path.join(dir, "done.json"))) return { ...out, ...JSON.parse(fs.readFileSync(path.join(dir, "done.json"), "utf8")) };
  for (const d of fs.readdirSync(GFX)) if (d.startsWith(id + "-") && d.length === id.length + 13) fs.rmSync(path.join(GFX, d), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const p = await ensurePage(html);
  await p.setViewportSize({ width: spec.w, height: spec.h });
  await p.evaluate((s) => window.render(s), spec);
  for (let i = 0; i < n; i++) {
    await p.evaluate((t) => window.seek(t), seconds === 0 ? 1e3 : i / FPS);
    await p.screenshot({ path: path.join(dir, `${String(i).padStart(4, "0")}.png`), omitBackground: alpha, clip: { x: 0, y: 0, width: spec.w, height: spec.h } });
  }
  const bounds = await p.evaluate(() => window.bounds());
  const off = bounds.filter((b) => b.l < 0 || b.t < 0 || b.r > spec.w || b.b > spec.h);
  if (off.length) console.warn(`  ! ${id}: element outside the frame`, off);
  fs.writeFileSync(path.join(dir, "done.json"), JSON.stringify({ bounds }));
  console.log(`  gfx ${id}: ${n} frame${n > 1 ? "s" : ""}`);
  return { ...out, bounds };
}

/**
 * Render a long overlay track (e.g. the caption strip) frame by frame: `n` frames of spec from
 * `html`, posed at i / FPS. Frames where visible(t) is false are copies of one blank PNG, so a
 * mostly-empty track renders fast. Cached by content. Returns { dir, pattern }.
 */
export async function gfxSeq(id, spec, { n, html, visible = () => true }) {
  const key = hash({ spec, n, html, k: htmlKey(html) });
  const dir = path.join(GFX, `${id}-${key}`);
  const out = { dir, pattern: path.join(dir, "%05d.png") };
  if (fs.existsSync(path.join(dir, "done.json"))) return { ...out, ...JSON.parse(fs.readFileSync(path.join(dir, "done.json"), "utf8")) };
  for (const d of fs.readdirSync(GFX)) if (d.startsWith(id + "-") && d.length === id.length + 13) fs.rmSync(path.join(GFX, d), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const p = await ensurePage(html);
  await p.setViewportSize({ width: spec.w, height: spec.h });
  const info = await p.evaluate((s) => window.render(s), spec);
  const blank = path.join(dir, "blank.png");
  await p.evaluate(() => window.seek(-1e3));
  await p.screenshot({ path: blank, omitBackground: true, clip: { x: 0, y: 0, width: spec.w, height: spec.h } });
  const t0 = Date.now();
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `${String(i).padStart(5, "0")}.png`);
    if (!visible(i / FPS)) { fs.copyFileSync(blank, f); continue; }
    await p.evaluate((t) => window.seek(t), i / FPS);
    await p.screenshot({ path: f, omitBackground: true, clip: { x: 0, y: 0, width: spec.w, height: spec.h } });
    drawn++;
  }
  fs.writeFileSync(path.join(dir, "done.json"), JSON.stringify({ info }));
  console.log(`  gfx ${id}: ${n} frames (${drawn} drawn, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return { ...out, info };
}

// ------------------------------------------------------------------ dynamic caption phrases

const WEAK = new Set("the a an at of to in on and or but so she your you is are it for with by as from that this into toward over i my all its".split(" "));
const normWord = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/**
 * Group timed words [{ w, s, e }] (output seconds) into caption phrases of 2 to 5 words for
 * captions.html. Sentences and long pauses always break; inside a sentence the split keeps phrases
 * near `target` characters, prefers commas, avoids hanging on "the", "a", "and"... keywords /
 * keyPhrases mark words for emphasis. Returns [{ t0, t1, words: [{ w, s, e, key }] }].
 */
export function captionPhrases(words, { keywords = [], keyPhrases = [], target = 22, max = 32, total = Infinity } = {}) {
  words = words.map((w) => ({ ...w }));
  const KEY = new Set(keywords.map((w) => w.toLowerCase()));
  for (const ph of keyPhrases) {
    const ts = ph.toLowerCase().split(" ");
    for (let i = 0; i + ts.length <= words.length; i++) if (ts.every((t, k) => normWord(words[i + k].w) === t)) for (let k = 0; k < ts.length; k++) words[i + k].key = true;
  }
  for (const w of words) if (KEY.has(normWord(w.w))) w.key = true;
  const runs = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nx = words[i + 1];
    if (!nx || /[.!?:]$/.test(w.w) || nx.s - w.e > 0.9) { runs.push(cur); cur = []; }
  });
  const phrases = [];
  for (const run of runs) {
    const n = run.length, best = Array(n + 1).fill(Infinity), from = Array(n + 1).fill(0);
    best[0] = 0;
    const cost = (i, j) => {
      const ws = run.slice(i, j), chars = ws.map((x) => x.w).join(" ").length, last = ws.at(-1).w;
      let c = Math.pow(Math.max(0, chars - target), 2) * 0.5 + Math.pow(Math.max(0, 14 - chars), 2) * 0.3;
      if (chars > max) c += 400;
      if (ws.length === 1 && n > 1) c += 120;
      if (j < n && WEAK.has(normWord(last)) && !/[,;]$/.test(last)) c += 60;
      if (j < n && /,$/.test(last)) c -= 18;
      c += 28 * ws.slice(0, -1).filter((x) => /,$/.test(x.w)).length;
      c += 14 * ws.slice(1).filter((x) => x.w === "and").length;
      return c + 10;
    };
    for (let j = 1; j <= n; j++) for (let i = Math.max(0, j - 6); i < j; i++) {
      const c = best[i] + cost(i, j);
      if (c < best[j]) { best[j] = c; from[j] = i; }
    }
    const cuts = [];
    for (let j = n; j > 0; j = from[j]) cuts.unshift([from[j], j]);
    for (const [i, j] of cuts) phrases.push(run.slice(i, j));
  }
  const PH = phrases.map((ws) => ({ words: ws.map((w) => ({ w: w.w, s: +w.s.toFixed(3), e: +w.e.toFixed(3), key: !!w.key })), t0: ws[0].s - 0.14 }));
  PH.forEach((p, i) => {
    const last = p.words.at(-1), nx = PH[i + 1];
    p.t1 = nx && nx.t0 - last.e < 0.75 ? nx.t0 : Math.min(last.e + 0.55, nx ? nx.t0 - 0.05 : total);
    p.t0 = +p.t0.toFixed(3); p.t1 = +p.t1.toFixed(3);
  });
  return PH;
}

// ------------------------------------------------------------------ overlays

/**
 * Filter snippet that turns an animated gfx input (its in-animation) into a timed overlay:
 * hold the last frame, fade out, shift to `start` (section seconds). Returns the label.
 */
export function timedOverlay(inputIdx, label, { start, dur, animFrames, fadeOut = 0.4 }) {
  const anim = animFrames / FPS;
  const hold = Math.max(0, dur - anim);
  return `[${inputIdx}:v]format=rgba,tpad=stop_mode=clone:stop_duration=${fx(hold)},fade=t=out:st=${fx(Math.max(0, dur - fadeOut))}:d=${fx(fadeOut)}:alpha=1,setpts=PTS+${fx(start)}/TB[${label}]`;
}

// ------------------------------------------------------------------ soundtrack bed

/**
 * Build the soundtrack from pieces of the game's bed. Each piece: { start, dur, bedIn, gainDb }.
 * Adjacent pieces overlap by 2*handle with an equal-power crossfade (a linear one when the bed
 * simply continues). accents: [{ t, db, width }] raise the bed briefly around a cue (bell, chime).
 * voice: optional { file, gainDb, duck: { db, attack, release }, pieces: [{ at, from, to }] }: each
 * piece is voice-file seconds from..to placed at output second `at`, with the bed ducked under it.
 * targetLufs: master the mix to this integrated loudness (two-pass static gain + limiter at ceilingDb).
 */
export function buildAudio(name, { bed, bedLength, pieces, total, handle = 0.35, baseGainDb = 0, accents = [], voice = null, fadeInEnd = 0.8, fadeOutEnd = 2.0, targetLufs = null, ceilingDb = null, extras = [] }) {
  const args = [];
  const parts = [];
  const labels = [];
  pieces.forEach((pc, i) => {
    const prev = pieces[i - 1], next = pieces[i + 1];
    const contPrev = prev && Math.abs(prev.bedIn + prev.dur - pc.bedIn) < 0.05;
    const contNext = next && Math.abs(pc.bedIn + pc.dur - next.bedIn) < 0.05;
    const hIn = prev ? handle : 0, hOut = next ? handle : 0;
    let a = pc.bedIn - hIn, b = pc.bedIn + pc.dur + hOut;
    if (a < 0 || b > bedLength - 0.05) {
      const shift = a < 0 ? -a : bedLength - 0.05 - b;
      console.warn(`  ! audio piece ${i} (${pc.id || ""}) bed range ${a.toFixed(2)}..${b.toFixed(2)} is outside the bed; shifted by ${shift.toFixed(2)} s`);
      a += shift; b += shift;
    }
    const len = b - a;
    const fin = prev ? `afade=t=in:d=${fx(2 * hIn)}:curve=${contPrev ? "tri" : "qsin"}` : `afade=t=in:d=${fx(fadeInEnd)}`;
    const fout = next ? `afade=t=out:st=${fx(len - 2 * hOut)}:d=${fx(2 * hOut)}:curve=${contNext ? "tri" : "qsin"}` : `afade=t=out:st=${fx(Math.max(0, len - fadeOutEnd))}:d=${fx(fadeOutEnd)}`;
    const delay = Math.max(0, Math.round((pc.start - hIn) * 1000));
    args.push("-i", bed);
    parts.push(`[${i}:a]aresample=48000,atrim=start=${fx(a)}:end=${fx(b)},asetpts=PTS-STARTPTS,${fin},${fout},volume=${fx(pc.gainDb || 0)}dB,adelay=${delay}:all=1[p${i}]`);
    labels.push(`[p${i}]`);
  });
  const acc = accents.map((c) => `${fx(c.db)}*exp(-pow((t-${fx(c.t)})/${fx(c.width || 0.7)},2))`).join("+") || "0";
  // Ducking: the bed dips by duck.db wherever a voice piece plays, ramping down over duck.attack
  // before the piece and back up over duck.release after it. 1 - prod(1 - w) keeps overlapping
  // pieces from ducking twice.
  const vp = voice && fs.existsSync(voice.file) ? voice.pieces || [] : [];
  const dk = { db: -10, attack: 0.25, release: 0.5, ...(voice?.duck || {}) };
  const duckExpr = (db) => vp.length
    ? `${fx(db)}*(1-${vp.map((p) => `(1-clip((t-${fx(p.at - dk.attack)})/${fx(dk.attack)},0,1)*clip((${fx(p.at + p.to - p.from + dk.release)}-t)/${fx(dk.release)},0,1))`).join("*")})`
    : "0";
  const duck = duckExpr(dk.db);
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,volume='pow(10,(${fx(baseGainDb)}+${acc}+${duck})/20)':eval=frame,apad,atrim=0:${fx(total)}[bed]`);
  let out = "[bed]";
  if (vp.length) {
    const vl = [];
    for (const [j, p] of vp.entries()) {
      args.push("-i", voice.file);
      const len = p.to - p.from;
      parts.push(`[${pieces.length + j}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=start=${fx(p.from)}:end=${fx(p.to)},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st=${fx(len - 0.015)}:d=0.015,volume=${fx(voice.gainDb || 0)}dB,adelay=${Math.round(p.at * 1000)}:all=1[vo${j}]`);
      vl.push(`[vo${j}]`);
    }
    parts.push(`[bed]${vl.join("")}amix=inputs=${vl.length + 1}:normalize=0:duration=first[mx]`);
    out = "[mx]";
    console.log(`  voice: ${vp.length} pieces of ${path.relative(EDIT, voice.file)}`);
  }
  // Extra layers (music, sound effects): { file, at, gainDb, duckDb } mixed on top. duckDb ducks
  // the layer under the voice with the same envelope as the bed.
  if (extras.length) {
    const el = [];
    const base = args.filter((a) => a === "-i").length;
    for (const [j, x] of extras.entries()) {
      args.push("-i", x.file);
      const dv = x.duckDb ? `,volume='pow(10,(${duckExpr(x.duckDb)})/20)':eval=frame` : "";
      parts.push(`[${base + j}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${fx(x.gainDb || 0)}dB,adelay=${Math.max(0, Math.round(x.at * 1000))}:all=1,apad,atrim=0:${fx(total)}${dv}[x${j}]`);
      el.push(`[x${j}]`);
    }
    parts.push(`${out}${el.join("")}amix=inputs=${el.length + 1}:normalize=0:duration=first[mxx]`);
    out = "[mxx]";
  }
  const wav = path.join(CACHE, `${name}.wav`);
  if (targetLufs == null) {
    parts.push(`${out}alimiter=limit=0.84:attack=5:release=80:level=false[aout]`);
    ff([...args, ...graphArgs(`${name}-audio`, parts.join(";\n")), "-map", "[aout]", "-t", fx(total), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", wav], `audio ${name}`);
    return wav;
  }
  // Two passes: mix unlimited at float, measure, then one static gain to the target and a limiter
  // a little under the true-peak ceiling (AAC encoding adds a few tenths of a dB).
  const pre = path.join(CACHE, `${name}-pre.wav`);
  parts.push(`${out}anull[aout]`);
  ff([...args, ...graphArgs(`${name}-audio`, parts.join(";\n")), "-map", "[aout]", "-t", fx(total), "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", pre], `audio ${name}`);
  const m = loudness(pre);
  const gain = targetLufs - m.lufs;
  ff(["-i", pre, "-af", `volume=${fx(gain)}dB,alimiter=limit=${fx(Math.pow(10, (ceilingDb ?? -2) / 20))}:attack=2:release=60:level=false`, "-ar", "48000", "-c:a", "pcm_s24le", wav], `master (${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB)`);
  return wav;
}

// ------------------------------------------------------------------ subtitles

const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
const LINE = 42;
/** Best place to break `text` into two lines: both fit, balanced, preferably after punctuation. */
function breakAt(text) {
  let best = -1, score = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") continue;
    const fits = i <= LINE && text.length - i - 1 <= LINE;
    const sc = (fits ? 0 : 1000) + Math.abs(i - text.length / 2) - (/[.,:;!?]/.test(text[i - 1]) ? 10 : 0);
    if (sc < score) { score = sc; best = i; }
  }
  return { at: best, fits: score < 1000 };
}
export function wrap(text) {
  if (text.length <= LINE) return text;
  const { at } = breakAt(text);
  return at < 0 ? text : text.slice(0, at) + "\n" + text.slice(at + 1);
}
function chunks(text, max = 2 * LINE) {
  // Sentences, long ones broken at commas; then pack neighbours together up to `max` characters
  // so no cue is a flash of three words. Anything that still can't sit on two lines is halved.
  const pieces = text.split(/(?<=[.!?])\s+/).flatMap((s) => (s.length <= max ? [s] : s.split(/(?<=,)\s+/)));
  const packed = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && (cur + " " + p).length > max) { packed.push(cur); cur = p; } else cur = cur ? cur + " " + p : p;
  }
  if (cur) packed.push(cur);
  const halve = (s) => {
    if (s.length <= LINE || breakAt(s).fits) return [s];
    const words = s.split(" ");
    let i = 0, n = 0;
    while (i < words.length - 1 && n + words[i].length < s.length / 2) n += words[i++].length + 1;
    return [...halve(words.slice(0, i).join(" ")), ...halve(words.slice(i).join(" "))];
  };
  return packed.flatMap(halve);
}
/** blocks: [{ start, end, text }] -> SRT text, each block split into readable cues by length. */
export function srt(blocks) {
  let n = 0, s = "";
  for (const b of blocks) {
    const cs = chunks(b.text.trim());
    const total = cs.reduce((a, c) => a + c.length, 0);
    let t = b.start;
    for (const c of cs) {
      const d = ((b.end - b.start) * c.length) / total;
      s += `${++n}\n${srtTime(t)} --> ${srtTime(t + d - 0.04)}\n${wrap(c)}\n\n`;
      t += d;
    }
  }
  return s;
}
