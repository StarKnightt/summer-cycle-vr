#!/usr/bin/env node
/**
 * Demo footage without a headset: the hands-only guided ride in Meta's IWER emulator (Quest tier,
 * one eye, 1920x1080, no dev UI, no fps readout), captured frame by frame at 30 fps and encoded
 * to H.264 MP4 clips in media/xr-reel/.
 *
 * Deterministic: requestAnimationFrame and performance.now are taken over once the world is
 * built, and every frame advances a virtual clock by exactly 1/30 s (IWER stamps its XR frames
 * with performance.now), so capture speed never shows in the footage.
 *
 * Hands follow eased keyframe paths with a slight arc and a few millimetres of organic drift; each
 * frame the hand root is corrected by the error between the tracked feature (palm, pinch point,
 * fingertip) and its target, in reference space, so hands never jump. The head sways gently.
 *
 *   pnpm dev                                  (http://localhost:5421/)
 *   node scripts/xr-reel.mjs [--only=ride|steer|desktop|stereo|audio|encode] [--keep]
 *
 * ride: the guided ride with each lesson's ghost hands on camera, from Enter VR to the end card
 * and Ride again; steer: a second session past the lessons (steering, hands lost mid-ride).
 *
 * Frames go to %TEMP%/summer-cycle-xr-reel/<clip>/ (kept with --keep; --only=encode re-encodes).
 * --only=audio records a real-time soundtrack bed (the game's Web Audio output) to
 * media/xr-reel/audio-*.m4a; the video clips themselves are silent (a virtual clock can't drive
 * the audio thread).
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5421/");
const ONLY = arg("only", "all");
const OUT = path.join(ROOT, "media", "xr-reel");
const FRAMES = arg("frames", path.join(os.tmpdir(), "summer-cycle-xr-reel"));
const FPS = 30, DT = 1 / FPS, W = 1920, H = 1080;
/** Gallery mode: no clip frames, single stills at chosen moments into shots/xr/gallery/. */
const GALLERY = ONLY === "gallery" || ONLY === "hero";
const GALLERY_DIR = path.join(ROOT, "shots", "xr", "gallery");
if (GALLERY) await fs.mkdir(GALLERY_DIR, { recursive: true });
let stillPage = null;
async function still(name) {
  if (!GALLERY || !stillPage) return;
  await stillPage.screenshot({ path: path.join(GALLERY_DIR, `${name}.jpg`), type: "jpeg", quality: 93 });
  console.log(`still ${name}`);
}
/** Capture only clips whose names sort within [--from, --to] (the rest still run, uncaptured). */
const FROM = arg("from", ""), TO = arg("to", "~");
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const durations = {};

// ------------------------------------------------------------------ page + manual clock

async function open(query) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/warning X\d{4}/.test(t)) errors.push(t);
  });
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const pnow = performance.now.bind(performance);
    let queue = [], vt = 0;
    window.__manual = false;
    window.requestAnimationFrame = (cb) => (window.__manual ? (queue.push(cb), queue.length) : raf(cb));
    performance.now = () => (window.__manual ? vt : pnow());
    window.__startManual = () => {
      vt = pnow();
      window.__manual = true;
    };
    window.__step = (ms) => {
      vt += ms;
      const q = queue;
      queue = [];
      for (const cb of q) cb(vt);
    };
  });
  await page.goto(`${URL}?${query}`);
  await page.waitForFunction(() => window.__ride?.waiting === true || window.__ride?.ready === true, null, { timeout: 240000 });
  // Page-side pose driver: head from yaw/pitch, hands from bike-space feature targets.
  await page.evaluate(() => {
    const THREE = window.__THREE;
    const v = new THREE.Vector3(), w = new THREE.Vector3(), inv = new THREE.Matrix4(), q = new THREE.Quaternion();
    const J = (h, n) => h.joints?.[n];
    const feature = (space, f) => {
      const j = (n) => J(space, n)?.position;
      if (!j("wrist")) return null;
      if (f === "index") return w.copy(j("index-finger-tip"));
      if (f === "thumb") return w.copy(j("thumb-tip"));
      if (f === "wrist") return w.copy(j("wrist"));
      if (f === "pinch") return w.copy(j("thumb-tip")).lerp(j("index-finger-tip"), 0.5);
      q.copy(J(space, "middle-finger-metacarpal").quaternion);
      return w.copy(j("wrist")).lerp(j("middle-finger-phalanx-proximal"), 0.55).add(v.set(0, -1, 0).applyQuaternion(q).multiplyScalar(0.025));
    };
    window.__reelPose = (p) => {
      const d = window.__xrdev, m = window.__ride.xr?.mode;
      if (!d) return;
      d.position.set(0, 1.2, 0);
      const a = p.pitch * (Math.PI / 360), b = p.yaw * (Math.PI / 360);
      const cy = Math.cos(b), sy = Math.sin(b), cp = Math.cos(a), sp = Math.sin(a);
      d.quaternion.set(sp * cy, cp * sy, -sp * sy, cp * cy);
      for (const side of ["left", "right"]) {
        const h = p[side], hin = d.hands[side];
        if (!h) continue;
        if (hin.poseId !== h.pose) hin.poseId = h.pose;
        hin.setPinchValueImmediate(h.pinch);
        hin.quaternion.set(...h.quat);
        if (!m || !m.presenting || h.raw) {
          hin.position.set(...h.pos);
          continue;
        }
        // Target: bike space = rig space; into reference space through the calibration offset.
        inv.copy(m.session.offset.matrix).invert();
        const target = new THREE.Vector3(...h.pos).applyMatrix4(inv);
        const sp = spaceOf(side);
        const f = sp ? feature(sp, h.feature) : null;
        if (!f) {
          hin.position.set(target.x, target.y - 0.05, target.z + 0.05);
          continue;
        }
        const e = target.sub(f);
        hin.position.set(hin.position.x + e.x, hin.position.y + e.y, hin.position.z + e.z);
      }
    };
    const spaceOf = (side) => [0, 1].map((i) => window.__rideRenderer.xr.getHand(i)).find((s) => s.__side === side) ?? null;
    // Bike-space position of a tracked feature, through the calibration offset (the joints are
    // reference-space poses; the bike's world matrix is already a frame ahead of them).
    window.__reelLocal = (side, f) => {
      const sp = spaceOf(side), p = sp && feature(sp, f);
      return p ? p.clone().applyMatrix4(window.__ride.xr.mode.session.offset.matrix).toArray() : null;
    };
    // Bike-space target on a wrist-menu row: the card's offset from the left wrist, both in the
    // same (last frame's) world pose, added to the wrist's bike-space position.
    window.__reelMenuRow = (i, z) => {
      const m = window.__ride.xr.mode;
      if (!m.menu.shown) return null;
      const d = m.menu.rowWorld(i, z, new THREE.Vector3()).sub(m.hands.left.wrist);
      d.applyQuaternion(m.session.rig.quaternion.clone().invert());
      const wr = window.__reelLocal("left", "wrist");
      return [wr[0] + d.x, wr[1] + d.y, wr[2] + d.z];
    };
    // Hand orientation (reference space) that turns this palm toward a bike-space direction.
    window.__reelPalmTo = (side, dir) => {
      const m = window.__ride.xr.mode, h = m.hands[side], hin = window.__xrdev.hands[side];
      const rq = m.session.rig.quaternion.clone().multiply(m.session.offset.quaternion);
      const want = new THREE.Vector3(...dir).normalize().applyQuaternion(m.session.rig.quaternion);
      const qw = new THREE.Quaternion().setFromUnitVectors(h.palmNormal.clone().normalize(), want);
      const qr = rq.clone().invert().multiply(qw).multiply(rq);
      const cur = new THREE.Quaternion(hin.quaternion.x, hin.quaternion.y, hin.quaternion.z, hin.quaternion.w);
      return qr.multiply(cur).toArray();
    };
    // Hand orientation (reference space) that turns this palm toward the eyes.
    window.__reelFacePalm = (side, tilt = 1) => {
      const m = window.__ride.xr.mode, h = m.hands[side], hin = window.__xrdev.hands[side];
      const dir = m.head.clone().sub(h.palm).normalize();
      const qw = new THREE.Quaternion().setFromUnitVectors(h.palmNormal.clone().normalize(), dir);
      const qi = new THREE.Quaternion().slerp(qw, tilt);
      const rq = m.session.rig.quaternion.clone().multiply(m.session.offset.quaternion);
      const qr = rq.clone().invert().multiply(qi).multiply(rq);
      const cur = new THREE.Quaternion(hin.quaternion.x, hin.quaternion.y, hin.quaternion.z, hin.quaternion.w);
      return qr.multiply(cur).toArray();
    };
    // Remember which three hand space is which side (connected event carries handedness).
    for (let i = 0; i < 2; i++) {
      const s = window.__rideRenderer.xr.getHand(i);
      s.addEventListener("connected", (ev) => (s.__side = ev.data.handedness));
    }
  });
  return page;
}

// ------------------------------------------------------------------ motion helpers

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => {
  x = clamp01(x);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
function slerp(a, b, k) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((x) => -x) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r = a.map((x, i) => lerp(x, bb[i], k));
    const n = Math.hypot(...r);
    return r.map((x) => x / n);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s;
  return a.map((x, i) => x * wa + bb[i] * wb);
}

/** A value that eases from wherever it is to a target over a duration, with an optional arc. */
class Track {
  constructor(v) {
    this.from = this.to = v;
    this.t0 = 0;
    this.dur = 0;
    this.lift = 0;
    this.slerp = false;
  }
  go(to, dur, now, lift = 0) {
    this.from = this.at(now);
    this.to = to;
    this.t0 = now;
    this.dur = Math.max(dur, 1e-3);
    this.lift = lift;
  }
  at(now) {
    const k = ease((now - this.t0) / this.dur);
    if (typeof this.to === "number") return lerp(this.from, this.to, k);
    if (this.slerp) return slerp(this.from, this.to, k);
    const p = lerp3(this.from, this.to, k);
    if (this.lift) p[1] += this.lift * Math.sin(Math.PI * clamp01((now - this.t0) / this.dur));
    return p;
  }
}

// Hand orientations (reference space; the calibration keeps its axes aligned with the bike).
const Q = {
  gripL: [-0.5, 0.5, 0.5, 0.5],
  gripR: [-0.5, -0.5, -0.5, 0.5],
  palmUpL: [0, 0.707, -0.707, 0],
  reachR: [-0.3, -0.45, -0.6, 0.6],
  pokeR: [-0.35, -0.2, -0.3, 0.86],
};
const GRIP = { left: [-0.29, 1.05, -0.17], right: [0.29, 1.05, -0.17] };
const LAP = { left: [-0.22, 0.72, 0.17], right: [0.22, 0.72, 0.17] };
const EYE = [0, 1.44, 0.2];
/** Head yaw / pitch (degrees; yaw + = left) that look from her eye at a bike-space point. */
const aim = (p, dPitch = 0, dYaw = 0) => {
  const dx = p[0] - EYE[0], dy = p[1] - EYE[1], dz = p[2] - EYE[2];
  return [(Math.atan2(-dx, -dz) * 180) / Math.PI + dYaw, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI + dPitch];
};
/** Ease the head toward a look target over `dur`. */
const look = (R, p, dur, dPitch = 0, dYaw = 0) => {
  const [y, pt] = aim(p, dPitch, dYaw);
  R.yaw.go(y, dur, R.T);
  R.pitch.go(pt, dur, R.T);
};
/** Follow a moving look target with a little lag (per frame). */
const follow = (R, p, k, dPitch = 0, dYaw = 0) => {
  const [y, pt] = aim(p, dPitch, dYaw);
  R.yaw = new Track(lerp(R.yaw.at(R.T), y, k));
  R.pitch = new Track(lerp(R.pitch.at(R.T), pt, k));
};

function rig() {
  const hand = (side) => ({
    pos: new Track(LAP[side]),
    quat: Object.assign(new Track(side === "left" ? Q.gripL : Q.gripR), { slerp: true }),
    pinch: new Track(0),
    pose: "default",
    feature: "palm",
    phase: side === "left" ? 0.3 : 2.1,
  });
  return { T: 0, yaw: new Track(0), pitch: new Track(-15), left: hand("left"), right: hand("right"), sway: 1 };
}

function pose(R) {
  const T = R.T;
  const out = {
    yaw: R.yaw.at(T) + R.sway * (0.9 * Math.sin(T * 0.23 + 0.4) + 0.4 * Math.sin(T * 0.61 + 1.1)),
    pitch: R.pitch.at(T) + R.sway * (0.7 * Math.sin(T * 0.31 + 1.0) + 0.3 * Math.sin(T * 0.83)),
  };
  for (const side of ["left", "right"]) {
    const h = R[side];
    const p = h.pos.at(T);
    // A few millimetres of breathing drift: hands are never perfectly still.
    const ph = h.phase;
    p[0] += 0.0025 * Math.sin(T * 1.1 + ph) + 0.0012 * Math.sin(T * 2.7 + ph * 2);
    p[1] += 0.002 * Math.sin(T * 0.9 + ph * 1.7) + 0.001 * Math.sin(T * 3.1 + ph);
    p[2] += 0.002 * Math.sin(T * 1.3 + ph * 0.6);
    out[side] = { pos: p, quat: h.quat.at(T), pinch: clamp01(h.pinch.at(T)), pose: h.pose, feature: h.feature, raw: !!h.raw };
  }
  return out;
}

/** The steering pivot at grip height (bike space, see src/xr/bars.ts). */
const PIVOT = [0, 1.05, -0.382];
/** Turn the bars about the stem: the grip targets rotated by `deg` about the pivot. */
const bars = (deg) => {
  const a = (deg * Math.PI) / 180, P = PIVOT;
  return ["left", "right"].map((s) => {
    const g = GRIP[s], x = g[0] - P[0], z = g[2] - P[2];
    return [P[0] + x * Math.cos(a) + z * Math.sin(a), g[1], P[2] - x * Math.sin(a) + z * Math.cos(a)];
  });
};
/** Hands resting in the lap, in reference space (raw device positions, below the view). */
const RAW_LAP = { left: [-0.2, 0.5, 0.1], right: [0.2, 0.5, 0.1] };

/**
 * Ghost-hand lessons loop with a fixed period from when their lesson began. Seconds until the
 * next pass starts, read from the page (the virtual clock steps them exactly 1/30 s a frame).
 */
const ghostLeft = async (page, period) => {
  const t = await page.evaluate(() => window.__ride.xr.mode.ghost.t);
  return (period - (t % period)) % period;
};
/** Ride on until `lead` seconds before the ghost hands' next pass. */
async function ghostSync(page, R, period, lead = 0) {
  let w = (await ghostLeft(page, period)) - lead;
  while (w < 0) w += period;
  await frames(page, R, w);
}
/** Bike-space point far out toward the sky's sun (for aiming the head at a low sun). */
const skySun = (page) =>
  page.evaluate(() => {
    const T = window.__THREE, m = window.__ride.xr.mode;
    const d = m.glow.mesh.material.uniforms.uSkySun.value.clone().applyQuaternion(m.session.rig.getWorldQuaternion(new T.Quaternion()).invert());
    return [d.x * 100, 1.44 + d.y * 100, 0.2 + d.z * 100];
  });

let clipDir = null, clipFrames = 0;
async function frames(page, R, secs, each) {
  const n = Math.round(secs * FPS);
  for (let i = 0; i < n; i++) {
    if (each) each(R.T, i / FPS);
    await page.evaluate(([p, ms]) => {
      window.__reelPose(p);
      window.__step(ms);
    }, [pose(R), 1000 * DT]);
    R.T += DT;
    if (clipDir) await page.screenshot({ path: path.join(clipDir, `f${String(clipFrames++).padStart(5, "0")}.jpg`), type: "jpeg", quality: 94 });
  }
}
async function clip(name, fn) {
  if (GALLERY) return fn();
  if (name < FROM || name.slice(0, TO.length) > TO) return fn();
  clipDir = path.join(FRAMES, name);
  clipFrames = 0;
  await fs.rm(clipDir, { recursive: true, force: true });
  await fs.mkdir(clipDir, { recursive: true });
  await fn();
  durations[name] = clipFrames / FPS;
  console.log(`${name}: ${clipFrames} frames (${(clipFrames / FPS).toFixed(1)} s)`);
  clipDir = null;
}
const state = (page) => page.evaluate(() => ({ ...window.__ride.xr.state, speed: window.__ride.ctl.speed }));

// ------------------------------------------------------------------ the guided ride

async function ride() {
  const page = await open("xremu=hands&xrtier=quest&xradapt=0&fs=0");
  stillPage = page;
  const R = rig();
  await page.evaluate((p) => {
    // Hands rest in the lap before the session (raw reference-space positions, out of view).
    for (const s of ["left", "right"]) window.__xrdev.hands[s].position.set(p[s][0], 0.5, 0.1);
  }, { left: [-0.2], right: [0.2] });
  await page.evaluate(() => window.__startManual());

  await clip("01-enter-vr", async () => {
    await frames(page, R, 2.2);
    await page.hover("#xr-enter");
    await frames(page, R, 0.9);
    await page.click("#xr-enter");
    for (let i = 0; i < 90; i++) {
      await frames(page, R, DT);
      if (await page.evaluate(() => window.__ride.xr.state.presenting)) break;
    }
    // Calibrate on the scripted seated head (as the player would with a quick recenter).
    await frames(page, R, 0.2);
    await page.evaluate(() => window.__ride.xr.mode.session.recenter());
    // First moments in the headset: the start card over the basket and ghost hands settling onto
    // the grips (the hold lesson), her own hands still in the lap. Ends as the ghosts' next pass begins.
    R.pitch.go(-21, 1.6, R.T);
    await ghostSync(page, R, 2.8);
  });

  // Palms down onto the grips (a little forward), measured from the live hands.
  for (const s of ["left", "right"]) {
    Q[s === "left" ? "gripL" : "gripR"] = await page.evaluate((s) => window.__reelPalmTo(s, [s === "left" ? 0.15 : -0.15, -1, -0.35]), s);
    R[s].quat.go(Q[s === "left" ? "gripL" : "gripR"], 0.01, R.T);
  }
  await clip("02-grab-bars-ride-off", async () => {
    // Her hands come up and follow the ghost hands' next pass down onto the grips.
    R.pitch.go(-24, 1.4, R.T);
    await frames(page, R, 0.3);
    R.left.pos.go(GRIP.left, 1.5, R.T, 0.05);
    await frames(page, R, 0.25);
    R.right.pos.go(GRIP.right, 1.45, R.T, 0.05);
    await frames(page, R, 1.8);
    R.pitch.go(-14, 2.4, R.T);
    await frames(page, R, 4.2);
    await still("02-hands-on-bars");
  });
  const sGrab = await state(page);

  await clip("04-brake-pinch", async () => {
    // The brake lesson: one ghost pinch just above the right grip, then she pinches on the bars.
    R.pitch.go(-22, 0.9, R.T);
    R.yaw.go(-3, 0.9, R.T);
    await frames(page, R, 0.5);
    await ghostSync(page, R, 2.0, 0.15);
    await frames(page, R, 1.6);
    R.right.pinch.go(1, 0.6, R.T);
    R.left.pinch.go(0.85, 0.7, R.T);
    await frames(page, R, 2.4);
    R.right.pinch.go(0, 0.6, R.T);
    R.left.pinch.go(0, 0.6, R.T);
    R.pitch.go(-13, 1.8, R.T);
    R.yaw.go(0, 1.8, R.T);
    await frames(page, R, 2.2);
  });
  const sBrake = await state(page);

  // Ride on a moment (not captured), then the bell lesson.
  await frames(page, R, 0.6);
  await clip("05-bell-ring", async () => {
    const bell = await page.evaluate(() => {
      const THREE = window.__THREE, v = window.__ride.bike.bellWorld(new THREE.Vector3());
      return window.__ride.xrRoot.worldToLocal(v).toArray();
    });
    R.pitch.go(-26, 1.0, R.T);
    R.yaw.go(-6, 1.0, R.T);
    await frames(page, R, 1.0);
    // A ghost thumb taps the dome; hers follows as it lifts away.
    await ghostSync(page, R, 2.2, 0.1);
    await frames(page, R, 1.35);
    R.left.feature = "thumb";
    const start = await page.evaluate(() => window.__reelLocal("left", "thumb"));
    const palm0 = await page.evaluate(() => window.__reelLocal("left", "palm"));
    // The scripted hand is rigid, so its palm travels with the thumb, and a held palm turned about
    // the stem steers. A real thumb flick leaves the palm put: turn the right hand the other way
    // so the bars stay straight.
    const stem = (p) => Math.atan2(-(p[2] - PIVOT[2]), p[0] - PIVOT[0]);
    const flick = () => {
      const p = R.left.pos.at(R.T).map((v, i) => v + palm0[i] - start[i]);
      const g = GRIP.right, r = Math.hypot(g[0] - PIVOT[0], g[2] - PIVOT[2]), a = stem(g) - (stem(p) - stem(palm0));
      R.right.pos = new Track([PIVOT[0] + r * Math.cos(a), g[1], PIVOT[2] - r * Math.sin(a)]);
    };
    R.left.pos = new Track(start);
    R.left.pos.go([bell[0] + 0.005, bell[1] + 0.012, bell[2] + 0.02], 0.5, R.T, 0.015);
    await frames(page, R, 0.6, flick);
    R.left.pos.go([bell[0], bell[1] + 0.005, bell[2] + 0.004], 0.18, R.T);
    await frames(page, R, 0.35, flick);
    R.left.pos.go(start, 0.5, R.T, 0.01);
    await frames(page, R, 0.7, flick);
    R.left.feature = "palm";
    R.left.pos = new Track(GRIP.left);
    R.right.pos = new Track(GRIP.right);
    R.pitch.go(-15, 1.6, R.T);
    R.yaw.go(0, 1.6, R.T);
    await frames(page, R, 1.6);
  });
  const sBell = await state(page);

  // The drag ends at 2.2 (between sunset and dusk): the little sun rests just above the real one
  // as it sets, and the glow around a low sun is at its strongest.
  const SUN_END = 2.2;
  await clip("06-reach-and-drag-sun", async () => {
    const arc = (s) => page.evaluate((s) => window.__ride.xrArc(s), s);
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push(await arc((i / 60) * SUN_END));
    // Ride a moment in the afternoon, then glance up at the little sun (its arc shows while the
    // lesson points at it), timed so the ghost hand's next pass starts as the eyes settle on it.
    R.pitch.go(-4, 2.0, R.T);
    const LOOK = 2.6;
    let w = await ghostLeft(page, 4.4);
    if (w < 1.0 + LOOK) w += 4.4;
    await frames(page, R, w - LOOK);
    look(R, pts[0], 2.2, -14, -6);
    await frames(page, R, LOOK);
    // The ghost hand reaches up, pinches the sun and pulls it a little way down its arc.
    await frames(page, R, 2.5);
    // Her right hand leaves the bar and reaches up from below as the ghost lets go.
    const here = await page.evaluate(() => window.__reelLocal("right", "pinch"));
    R.right.feature = "pinch";
    R.right.pos = new Track(here);
    R.right.quat.go(Q.reachR, 1.5, R.T);
    const near = pts[0].map((v, i) => v + [0.035, -0.06, 0.06][i]);
    R.right.pos.go(near, 1.5, R.T, 0.07);
    await frames(page, R, 1.6);
    R.right.pos.go(pts[0], 0.35, R.T);
    await frames(page, R, 0.35);
    R.right.pinch.go(1, 0.35, R.T);
    await frames(page, R, 0.7);
    // Drag it slowly down the arc; the head follows the sun toward the hills, a beat behind.
    const DRAG = 10.5;
    const t0 = R.T;
    const dragEach = (T) => {
      const u = (T - t0) / DRAG;
      const k = ease(u) * 0.85 + u * 0.15;
      const f = k * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f));
      const p = lerp3(pts[i], pts[i + 1], f - i);
      R.right.pos = new Track(p);
      follow(R, p, 0.05, lerp(-14, -1, u), -6);
    };
    await frames(page, R, DRAG * 0.42, dragEach);
    await still("08-drag-sun-golden");
    await frames(page, R, DRAG * 0.58, dragEach);
    // Holding the light: the hand rests with the little sun over the hills while the real one sets
    // (eyes a little high: the menu lesson's ghost palm rises in front of the basket meanwhile).
    const end = pts.at(-1);
    await frames(page, R, 2.0, () => follow(R, end, 0.05, 0, -6));
    R.right.pinch.go(0, 0.4, R.T);
    await frames(page, R, 0.5);
    // Let go and bring the hand home; the eyes stay on the low sun a moment (the menu lesson is up).
    const palmNow = await page.evaluate(() => window.__reelLocal("right", "palm"));
    R.right.feature = "palm";
    R.right.pos = new Track(palmNow);
    R.right.pos.go(GRIP.right, 1.6, R.T, 0.03);
    R.right.quat.go(Q.gripR, 1.5, R.T);
    look(R, await skySun(page), 2.0, -2, -4);
    await frames(page, R, 1.8);
    await still("09-sunset-after-drag");
  });
  const sSun = await state(page);
  // At 30 fps the bike moves 14 cm a frame: a hand read a frame behind the rig misses the sun.
  if (!(sSun.sun > 1.5)) errors.push(`the sun drag did not take (time of day ${sSun.sun}, step ${sSun.step})`);
  if (sSun.step !== "menu") errors.push(`the menu lesson is not up after the sun (step ${sSun.step})`);

  // Wrist menu: palm up, poke Pause, resume with a pinch.
  const openMenu = async () => {
    const palm = await page.evaluate(() => window.__reelLocal("left", "palm"));
    R.left.pos = new Track(palm);
    const at = [-0.07, 1.23, -0.07];
    R.left.quat.go(Q.palmUpL, 1.2, R.T);
    R.left.pos.go(at, 1.3, R.T, 0.03);
    look(R, [at[0] + 0.02, at[1] + 0.1, at[2]], 1.3, -4);
    await frames(page, R, 1.0);
    // Settle the wrist so the palm really faces the eyes (as a person naturally would).
    R.left.quat.go(await page.evaluate(() => window.__reelFacePalm("left", 0.9)), 0.5, R.T);
    await frames(page, R, 0.8);
    const st = await page.evaluate(() => window.__ride.xr.state.menu);
    if (process.env.REEL_DEBUG)
      console.log("  menu open", st, JSON.stringify(R.pitch.at(R.T)), JSON.stringify(R.yaw.at(R.T)), await page.evaluate(() => {
        const m = window.__ride.xr.mode, T = window.__THREE;
        const f = new T.Vector3(0, 0, -1).applyQuaternion(m.session.cam.getWorldQuaternion(new T.Quaternion()));
        return JSON.stringify({ camPitch: ((Math.asin(f.y) * 180) / Math.PI).toFixed(1), camLocal: m.session.cam.position.toArray().map((x) => x.toFixed(2)), offset: m.session.offset.position.toArray().map((x) => x.toFixed(2)) });
      }));
    if (!st)
      console.log(
        "  menu did not open",
        await page.evaluate(() => {
          const m = window.__ride.xr.mode, L = m.hands.left;
          const d = m.head.clone().sub(L.palm);
          return JSON.stringify({ tracked: L.tracked, onBar: m.bars.held[0], dist: d.length().toFixed(2), dot: L.palmNormal.dot(d.normalize()).toFixed(2), n: L.palmNormal.toArray().map((x) => x.toFixed(2)), palm: window.__reelLocal("left", "palm")?.map((x) => x.toFixed(2)) });
        }),
      );
  };
  const poke = async (row) => {
    const r = await page.evaluate((i) => ({ front: window.__reelMenuRow(i, 0.04), through: window.__reelMenuRow(i, -0.006) }), row);
    if (!r.front) {
      console.log("  menu not shown for poke");
      return false;
    }
    const here = await page.evaluate(() => window.__reelLocal("right", "index"));
    R.right.feature = "index";
    R.right.pose = "point";
    R.right.pos = new Track(here);
    R.right.quat.go(Q.pokeR, 0.9, R.T);
    R.right.pos.go(r.front, 1.0, R.T, 0.03);
    await frames(page, R, 1.1);
    R.right.pos.go(r.through, 0.22, R.T);
    await frames(page, R, 0.35);
    R.right.pos.go(r.front, 0.3, R.T);
    await frames(page, R, 0.45);
    return true;
  };
  const handsHome = async (dur = 1.4) => {
    for (const s of ["left", "right"]) {
      const palm = await page.evaluate((s) => window.__reelLocal(s, "palm"), s);
      R[s].feature = "palm";
      R[s].pose = "default";
      R[s].pos = new Track(palm);
      R[s].pos.go(GRIP[s], dur, R.T, 0.03);
      R[s].quat.go(s === "left" ? Q.gripL : Q.gripR, dur, R.T);
    }
    R.pitch.go(-14, dur, R.T);
    R.yaw.go(0, dur, R.T);
  };

  let menuLesson = null;
  await clip("07-wrist-menu-pause-resume", async () => {
    // The menu lesson (a ghost palm turning up) has been up since the sun passed sunset: do it.
    await frames(page, R, 0.3);
    // The lesson gives up after 12 s; the palm needs about 1.5 s to open the menu.
    menuLesson = await page.evaluate(() => ({ step: window.__ride.xr.state.step, t: +window.__ride.xr.mode.guide.t.toFixed(2) }));
    await openMenu();
    await frames(page, R, 0.3);
    await still("10-wrist-menu");
    await poke(0);
    R.right.quat.go(Q.gripR, 0.6, R.T);
    await frames(page, R, 0.6);
    await handsHome(1.3);
    await frames(page, R, 2.4);
    // Resume: a light pinch.
    R.right.pinch.go(1, 0.35, R.T);
    await frames(page, R, 0.5);
    R.right.pinch.go(0, 0.4, R.T);
    await frames(page, R, 2.2);
  });
  const sMenu = await state(page);

  await clip("08-comfort-toggle-vignette", async () => {
    // Comfort on: a turn pulls the soft vignette in.
    const turn = async (deg, dur, hold) => {
      const [l, r] = bars(deg);
      R.left.pos.go(l, dur, R.T);
      R.right.pos.go(r, dur, R.T);
      await frames(page, R, hold);
    };
    await turn(-12, 1.2, 1.3);
    await still("04-turning-vignette");
    await frames(page, R, 0.9);
    await turn(0, 1.2, 1.6);
    await openMenu();
    await poke(1);
    await frames(page, R, 0.5);
    await handsHome(1.2);
    await frames(page, R, 1.2);
    await turn(-12, 1.2, 2.2);
    await turn(0, 1.2, 1.4);
    // Back on.
    await openMenu();
    await poke(1);
    await handsHome(1.2);
    await frames(page, R, 1.4);
  });
  const sComfort = await state(page);

  // Riding on at sunset, eyes on the low sun and its glow (the "after" of the before / after).
  await frames(page, R, 1.0);
  await clip("06b-sunset-ride", async () => {
    const sun = await skySun(page);
    const [y] = aim(sun);
    look(R, sun, 2.4, -6, Math.max(-28, Math.min(28, y)) - y);
    await frames(page, R, 3.2);
    R.yaw.go(R.yaw.at(R.T) * 0.6, 4, R.T);
    await frames(page, R, 4.0);
    R.pitch.go(-10, 2.5, R.T);
    await frames(page, R, 2.0);
  });

  // Jump ahead to the shrine approach (not captured) and ride into the ending.
  await page.evaluate(() => {
    const r = window.__ride, m = r.xr.mode;
    m.guide.step = "ride";
    r.place(-0.9, -158, 4.1);
    // The skipped stretch counts as ridden at the gentle cruise, so the end card reads as a whole ride.
    m.rideT += Math.max(0, 772 - 26 - m.dist) / 4.2;
    r.xr.skip(772 - 26);
  });
  await frames(page, R, 1.0);
  await clip("09-arrival-at-shrine-dusk", async () => {
    const torii = await page.evaluate(() => {
      const r = window.__ride, THREE = window.__THREE;
      return r.xrRoot.worldToLocal(new THREE.Vector3(r.roadX(-200) + 5.6, 2.2, -200)).toArray();
    });
    R.pitch.go(-8, 2, R.T);
    await frames(page, R, 4.6);
    // She rolls to a stop at the torii: hands come off the bars and rest.
    for (const s of ["left", "right"]) R[s].pos.go(LAP[s], 1.8, R.T, 0.02);
    look(R, torii, 3.5, -2, 6);
    await frames(page, R, 4.4);
    await still("12-arrival-dusk");
    // Stone lanterns and the jizo by the steps, then up at the first stars and fireflies.
    look(R, [torii[0] - 0.8, 0.9, torii[2] + 3], 3.2);
    await frames(page, R, 3.4);
    R.pitch.go(14, 3.2, R.T);
    R.yaw.go(8, 3.2, R.T);
    await frames(page, R, 3.4);
    // Back to the card over the basket: the end card by now (what she rode, Ride again, Ride on).
    R.pitch.go(-17, 3.0, R.T);
    R.yaw.go(2, 3.0, R.T);
    await frames(page, R, 3.6);
    await still("13-end-card");
  });
  const sEnd = await state(page);
  if (!sEnd.end) errors.push(`the end card is not showing at the end of the shrine clip (${JSON.stringify(sEnd)})`);

  // Ride again: the right index pokes the left tag, the view fades to a warm dark and back to the
  // afternoon at the start (start card, ghost hands on the grips).
  await clip("13-end-card-ride-again", async () => {
    await frames(page, R, 1.0);
    const tag = await page.evaluate(() => window.__ride.xrEndButton("again"));
    if (!tag) return void errors.push("no Ride again tag to poke");
    const here = await page.evaluate(() => window.__reelLocal("right", "index"));
    R.right.feature = "index";
    R.right.pose = "point";
    R.right.pos = new Track(here);
    R.right.quat.go(Q.pokeR, 0.9, R.T);
    R.right.pos.go(tag.front, 1.1, R.T, 0.04);
    look(R, [tag.front[0], tag.front[1] + 0.05, tag.front[2]], 1.1, 0, 0);
    await frames(page, R, 1.2);
    R.right.pos.go(tag.through, 0.22, R.T);
    await frames(page, R, 0.3);
    R.right.pos.go(tag.front, 0.25, R.T);
    await frames(page, R, 0.25);
    // While it is dark, the hand goes back to the lap and the head faces ahead (Ride again
    // recentres on the head as it restarts).
    const palm = await page.evaluate(() => window.__reelLocal("right", "palm"));
    R.right.feature = "palm";
    R.right.pose = "default";
    R.right.pos = new Track(palm);
    R.right.pos.go(LAP.right, 0.7, R.T, 0.02);
    R.right.quat.go(Q.gripR, 0.7, R.T);
    R.yaw.go(0, 0.45, R.T);
    R.pitch.go(-20, 0.9, R.T);
    for (let i = 0; i < 90; i++) {
      await frames(page, R, DT);
      const s = await page.evaluate(() => window.__ride.xr.state);
      if (s.ridesAgain > 0 && s.fade < 0.01) break;
    }
    // Back at the start: the afternoon, "Summer Cycle", ghost hands settling onto the grips.
    await frames(page, R, 3.6);
  });
  const sAgain = await state(page);
  if (!(sAgain.ridesAgain === 1 && sAgain.step === "hold" && sAgain.sun < 0.05)) errors.push(`Ride again did not restart the ride (${JSON.stringify(sAgain)})`);
  console.log("states", JSON.stringify({ sGrab: sGrab.step, sBrake: sBrake.step, sBell: sBell.step, sSun: [sSun.step, sSun.sun], menuLesson, sMenu: [sMenu.step, sMenu.paused], sComfort: sComfort.step, end: [sEnd.step, sEnd.end], again: [sAgain.step, sAgain.ridesAgain, sAgain.hint] }));
  if (menuLesson?.step !== "menu" || menuLesson.t > 10) errors.push(`the menu lesson was not up for the palm (${JSON.stringify(menuLesson)})`);
  await page.close();
}

// ------------------------------------------------------------------ a clean ride: steering, hands lost

/**
 * The ride once the lessons are done (no lesson cards or ghost hands): steering gently through the
 * village and the shop row, then both hands dropping into the lap mid-ride, out of view: the bike
 * coasts and a card at eye height says so, until the hands come back.
 */
async function steer() {
  const page = await open("xremu=hands&xrtier=quest&xradapt=0&fs=0");
  const R = rig();
  await page.evaluate((p) => {
    for (const s of ["left", "right"]) window.__xrdev.hands[s].position.set(...p[s]);
    window.__startManual();
  }, RAW_LAP);
  await frames(page, R, 1.0);
  await page.click("#xr-enter");
  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__ride.xr.state.presenting)); i++) await frames(page, R, DT);
  await frames(page, R, 0.2);
  await page.evaluate(() => window.__ride.xr.mode.session.recenter());
  await frames(page, R, 0.3);
  for (const s of ["left", "right"]) {
    Q[s === "left" ? "gripL" : "gripR"] = await page.evaluate((s) => window.__reelPalmTo(s, [s === "left" ? 0.15 : -0.15, -1, -0.35]), s);
    R[s].quat.go(Q[s === "left" ? "gripL" : "gripR"], 0.01, R.T);
  }
  R.left.pos.go(GRIP.left, 1.2, R.T, 0.04);
  R.right.pos.go(GRIP.right, 1.2, R.T, 0.04);
  await frames(page, R, 2.0);
  // Past the lessons: riding on to the shrine, its card already read (it fades out).
  await page.evaluate(() => {
    const g = window.__ride.xr.mode.guide;
    g.step = "ride";
    g.t = 6.2;
  });
  await frames(page, R, 2.4);

  await clip("03-steering-through-village", async () => {
    const steer = async (deg, dur, hold) => {
      const [l, r] = bars(deg);
      R.left.pos.go(l, dur, R.T);
      R.right.pos.go(r, dur, R.T);
      await frames(page, R, hold);
    };
    R.yaw.go(-12, 3.5, R.T);
    await steer(-5, 1.6, 2.6);
    await steer(4, 2.0, 2.4);
    R.yaw.go(10, 4, R.T);
    await steer(7, 1.8, 2.6);
    R.yaw.go(-8, 3, R.T);
    await steer(-3, 1.8, 2.4);
    R.yaw.go(0, 2.4, R.T);
    await steer(0, 1.4, 2.2);
  });

  await frames(page, R, 0.6);
  let lost = null;
  await clip("12-hands-lost-coast", async () => {
    await frames(page, R, 0.8);
    // Both hands let go of the bars and drop into the lap, out of view.
    R.pitch.go(-11, 1.2, R.T);
    for (const s of ["left", "right"]) R[s].pos.go(LAP[s], 0.9, R.T, 0.01);
    await frames(page, R, 0.9);
    // Out of the cameras' sight, tracking drops them (as it does on a Quest with hands in the lap).
    await page.evaluate(() => {
      for (const s of ["left", "right"]) window.__xrdev.hands[s].connected = false;
    });
    for (const s of ["left", "right"]) {
      R[s].raw = true;
      R[s].pos = new Track(RAW_LAP[s]);
    }
    await frames(page, R, 3.4);
    lost = await state(page);
    // Hands back up in front: found again (the card clears, the grip rings invite them back).
    await page.evaluate(() => {
      for (const s of ["left", "right"]) window.__xrdev.hands[s].connected = true;
    });
    await frames(page, R, 0.2);
    for (const s of ["left", "right"]) {
      R[s].raw = false;
      R[s].pos = new Track((await page.evaluate((s) => window.__reelLocal(s, "palm"), s)) ?? LAP[s]);
      R[s].pos.go(GRIP[s], 1.2, R.T, 0.04);
    }
    R.pitch.go(-15, 1.2, R.T);
    await frames(page, R, 2.4);
  });
  const back = await state(page);
  console.log("steer states", JSON.stringify({ lost: [lost?.notice, lost?.speed], back: [back.notice, back.held] }));
  if (lost?.notice !== "lost") errors.push(`the hands-lost card did not show (${JSON.stringify(lost)})`);
  await page.close();
}

// ------------------------------------------------------------------ desktop "before" and stereo

async function desktop() {
  const page = await open("autoplay=1&skipintro=1&nohud=1&fs=0");
  await page.waitForFunction(() => window.__ride.ready, null, { timeout: 120000 });
  await page.evaluate(() => window.__startManual());
  const R = rig();
  for (let i = 0; i < FPS; i++) await page.evaluate((ms) => window.__step(ms), 1000 * DT);
  await clip("10-desktop-before", async () => {
    for (let i = 0; i < FPS * 7; i++) {
      await page.evaluate((ms) => window.__step(ms), 1000 * DT);
      await page.screenshot({ path: path.join(clipDir, `f${String(clipFrames++).padStart(5, "0")}.jpg`), type: "jpeg", quality: 94 });
    }
  });
  void R;
  await page.close();
}

async function stereo() {
  const page = await open("xremu=hands&xrtier=quest&xradapt=0&fs=0&stereo=1");
  const R = rig();
  await page.evaluate(() => {
    for (const s of ["left", "right"]) window.__xrdev.hands[s].position.set(s === "left" ? -0.2 : 0.2, 0.5, 0.1);
    window.__startManual();
  });
  await frames(page, R, 1.0);
  await page.click("#xr-enter");
  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__ride.xr.state.presenting)); i++) await frames(page, R, DT);
  console.log("stereo presenting", await page.evaluate(() => window.__ride.xr.state.presenting));
  await frames(page, R, 0.2);
  await page.evaluate(() => window.__ride.xr.mode.session.recenter());
  await frames(page, R, 0.3);
  for (const s of ["left", "right"]) {
    Q[s === "left" ? "gripL" : "gripR"] = await page.evaluate((s) => window.__reelPalmTo(s, [s === "left" ? 0.15 : -0.15, -1, -0.35]), s);
    R[s].quat.go(Q[s === "left" ? "gripL" : "gripR"], 0.01, R.T);
  }
  R.left.pos.go(GRIP.left, 1.2, R.T, 0.04);
  R.right.pos.go(GRIP.right, 1.2, R.T, 0.04);
  await frames(page, R, 6);
  stillPage = page;
  await clip("11-stereo-both-eyes", async () => frames(page, R, 3.2));
  await still("15-stereo-both-eyes");
  await page.close();
}

// ------------------------------------------------------------------ gallery hero (thumbnail)

async function hero() {
  const page = await open("xremu=hands&xrtier=quest&xradapt=0&fs=0");
  stillPage = page;
  const R = rig();
  await page.evaluate(() => {
    for (const s of ["left", "right"]) window.__xrdev.hands[s].position.set(s === "left" ? -0.2 : 0.2, 0.5, 0.1);
    window.__startManual();
  });
  await frames(page, R, 1.0);
  await page.click("#xr-enter");
  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__ride.xr.state.presenting)); i++) await frames(page, R, DT);
  await frames(page, R, 0.2);
  await page.evaluate(() => window.__ride.xr.mode.session.recenter());
  await frames(page, R, 0.3);
  for (const s of ["left", "right"]) {
    Q[s === "left" ? "gripL" : "gripR"] = await page.evaluate((s) => window.__reelPalmTo(s, [s === "left" ? 0.15 : -0.15, -1, -0.35]), s);
    R[s].quat.go(Q[s === "left" ? "gripL" : "gripR"], 0.01, R.T);
  }
  R.left.pos.go(GRIP.left, 1.2, R.T, 0.04);
  R.right.pos.go(GRIP.right, 1.2, R.T, 0.04);
  // Golden hour at the opening composition, UI cards and the sun dial out of the picture.
  await page.evaluate(() => {
    const r = window.__ride, m = r.xr.mode;
    r.setTime("golden", true);
    r.place(-0.9, -40, 4.2);
    m.guide.group.visible = false;
    m.sun.group.visible = false;
  });
  // Out over the paddies toward the low sun, the bars just under the frame.
  R.sway = 0;
  R.pitch.go(-1, 2, R.T);
  R.yaw.go(24, 2, R.T);
  await frames(page, R, 5.0);
  await still("hero-golden-hour");
  await page.close();
}

// ------------------------------------------------------------------ real-time soundtrack bed

async function audio() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    // Tee everything that reaches the speakers into a recorder.
    const orig = AudioNode.prototype.connect;
    window.__rec = null;
    AudioNode.prototype.connect = function (dst, ...rest) {
      const r = orig.call(this, dst, ...rest);
      if (dst instanceof AudioDestinationNode) {
        const ctx = dst.context;
        if (!ctx.__tap) {
          ctx.__tap = ctx.createMediaStreamDestination();
          const mr = new MediaRecorder(ctx.__tap.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 192000 });
          const chunks = [];
          mr.ondataavailable = (e) => chunks.push(e.data);
          window.__rec = { mr, chunks };
        }
        orig.call(this, ctx.__tap);
      }
      return r;
    };
    window.__recStop = () =>
      new Promise((res) => {
        const { mr, chunks } = window.__rec;
        mr.onstop = async () => {
          const buf = await new Blob(chunks, { type: "audio/webm" }).arrayBuffer();
          let s = "";
          const u = new Uint8Array(buf);
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          res(btoa(s));
        };
        mr.stop();
      });
  });
  await page.goto(`${URL}?autoplay=1&skipintro=1&nohud=1&fs=0`);
  await page.waitForFunction(() => window.__ride?.ready, null, { timeout: 240000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__ride.audio === "running" && window.__rec, null, { timeout: 20000 });
  await page.evaluate(() => window.__rec.mr.start(1000));
  const t0 = Date.now();
  const at = async (s, fn) => {
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await page.evaluate(fn);
  };
  const cues = [];
  const cue = async (s, name, fn) => {
    await at(s, fn);
    cues.push([s, name]);
  };
  // Afternoon riding bed with a bell, the XR feedback sounds, then evening and the temple bell.
  await cue(6, "bike bell", () => window.__ride.bike.ringBell() || window.__ride.xr.mode.d.audio.ringBell());
  await cue(14, "bars rattle (grab)", () => window.__ride.xr.mode.d.audio.bump(0.14));
  await cue(20, "furin chime (sun grab / menu poke)", () => window.__ride.xr.mode.d.audio.trigger("furin"));
  await cue(30, "light: golden", () => window.__ride.setTime("golden"));
  await cue(45, "light: sunset", () => window.__ride.setTime("sunset"));
  await cue(60, "light: dusk", () => window.__ride.setTime("dusk"));
  await cue(68, "temple bell (arrival)", () => window.__ride.xr.mode.d.audio.trigger("temple"));
  await at(95, () => {});
  const b64 = await page.evaluate(() => window.__recStop());
  const webm = path.join(OUT, "audio-ride-bed.webm");
  await fs.writeFile(webm, Buffer.from(b64, "base64"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:a", "aac", "-b:a", "192k", path.join(OUT, "audio-ride-bed.m4a")]);
  await fs.rm(webm);
  await fs.writeFile(path.join(OUT, "audio-ride-bed.cues.json"), JSON.stringify(cues, null, 1));
  console.log("audio: audio-ride-bed.m4a", cues);
  await page.close();
}

// ------------------------------------------------------------------ encode

async function encodeAll() {
  const dirs = (await fs.readdir(FRAMES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const name of dirs) {
    const src = path.join(FRAMES, name, "f%05d.jpg");
    const dst = path.join(OUT, `${name}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", src, "-vf", "scale=in_range=pc:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", dst]);
    const st = await fs.stat(dst);
    console.log(`encoded ${name}.mp4 ${(st.size / 1e6).toFixed(1)} MB`);
  }
}

if (!["all", "ride", "steer", "desktop", "stereo", "audio", "encode", "gallery", "hero"].includes(ONLY)) throw new Error(`--only=${ONLY}?`);
try {
  if (ONLY === "gallery") {
    await ride();
    await stereo();
  }
  if (GALLERY) await hero();
  if (ONLY === "all" || ONLY === "ride") await ride();
  if (ONLY === "all" || ONLY === "steer") await steer();
  if (ONLY === "all" || ONLY === "desktop") await desktop();
  if (ONLY === "all" || ONLY === "stereo") await stereo();
  if (ONLY !== "audio" && !GALLERY) await encodeAll();
  if (ONLY === "all" || ONLY === "audio") await audio();
} catch (e) {
  errors.push(`script: ${e.stack || e}`);
} finally {
  if (Object.keys(durations).length) {
    const f = path.join(OUT, "durations.json");
    const prev = JSON.parse(await fs.readFile(f, "utf8").catch(() => "{}"));
    await fs.writeFile(f, JSON.stringify({ ...prev, ...durations }, null, 1));
  }
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 15)) console.log("  " + e);
  await browser.close();
  if (!argv.includes("--keep") && ONLY !== "encode") await fs.rm(FRAMES, { recursive: true, force: true }).catch(() => {});
}
