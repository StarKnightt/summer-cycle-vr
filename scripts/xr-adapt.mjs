#!/usr/bin/env node
/**
 * Adaptive headset quality in the IWER emulator. Real-time frames (no virtual clock): the page's
 * ?xrslow / adaptive.slow busy-wait adds a frame cost that shrinks with the scene's triangles, so
 * lighter levels really run faster. Checks:
 *   1. no stall: L0 holds with no extra cost;
 *   2. a heavy cost steps down, then settles (no change for 10 s);
 *   3. removing the cost steps back up, never twice within 10 s;
 *   4. no shader programs are compiled by level changes;
 * and saves the headset view at L0 and L3 to shots/xr/adapt-*.jpg.
 * Needs `pnpm dev` (port 5421).  node scripts/xr-adapt.mjs [--slow=22]
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5421/");
const SLOW = Number(arg("slow", 22));
const OUT = path.join(ROOT, "shots", "xr");
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--hide-scrollbars", "--mute-audio"],
});
const errors = [];
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/warning X\d{4}/.test(m.text())) errors.push(m.text());
  });
  const R = (fn, a) => page.evaluate(fn, a);
  const wait = (ms) => page.waitForTimeout(ms);
  await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0&xrfps=1`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  await R(() => {
    const d = window.__xrdev;
    d.position.set(0, 1.2, 0);
    d.quaternion.set(-0.13, 0, 0, 0.99);
  });
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  await wait(500);
  await R(() => window.__ride.xr.mode.session.recenter());
  await wait(300);
  // Hands on the grips (feedback on the measured palm), so she rides and the proxies stream.
  for (let i = 0; i < 6; i++) {
    await R(() => {
      const m = window.__ride.xr.mode, T = window.__THREE, d = window.__xrdev;
      for (const [side, g] of [["left", [-0.29, 1.05, -0.17]], ["right", [0.29, 1.05, -0.17]]]) {
        const h = m.hands[side], hin = d.hands[side];
        if (!h.tracked) {
          hin.position.set(side === "left" ? -0.25 : 0.25, 0.8, -0.4);
          continue;
        }
        const e = window.__ride.xrRoot.localToWorld(new T.Vector3(...g)).sub(h.palm);
        e.applyQuaternion(m.session.offset.getWorldQuaternion(new T.Quaternion()).invert());
        hin.position.set(hin.position.x + e.x, hin.position.y + e.y, hin.position.z + e.z);
      }
    });
    await wait(150);
  }
  const st = () => R(() => ({ ...window.__ride.xr.state, log: window.__ride.xr.mode.adaptive.log.slice(), programs: window.__rideRenderer.info.programs.length }));
  const timeline = [];
  const sample = async (secs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      const s = await st();
      timeline.push([Math.round((Date.now() - T0) / 100) / 10, s.level, s.levelFps]);
      await wait(500);
    }
    return st();
  };
  const T0 = Date.now();

  // 1. No extra cost: stays at L0.
  const a = await sample(8);
  check("no extra cost: stays at L0", a.level === "L0", { level: a.level, fps: a.levelFps, target: a.target, speed: await R(() => window.__ride.ctl.speed) });
  await page.screenshot({ path: path.join(OUT, "adapt-L0.jpg"), type: "jpeg", quality: 90 });
  const prog0 = a.programs;

  // 2. Heavy frame cost: steps down, then settles.
  await R((ms) => (window.__ride.xr.mode.adaptive.slow = ms), SLOW);
  const b = await sample(22);
  const bLog = b.log.slice(a.log.length);
  const lastChange = timeline.filter((x) => x[0] > 8).reduce((acc, x, i, arr) => (i && x[1] !== arr[i - 1][1] ? x[0] : acc), 8);
  check("heavy cost steps down", b.level !== "L0", { level: b.level, fps: b.levelFps, log: bLog });
  check("then settles (no change in the last 10 s)", timeline[timeline.length - 1][0] - lastChange >= 10, { lastChange, now: timeline[timeline.length - 1][0] });

  // 3. Cost removed: steps back up, at most one step per 10 s.
  await R(() => (window.__ride.xr.mode.adaptive.slow = 0));
  const c = await sample(26);
  const cLog = c.log.slice(b.log.length);
  const ups = cLog.filter((l) => /headroom/.test(l)).map((l) => Number(l.split("s ")[0]));
  const gaps = ups.slice(1).map((u, i) => u - ups[i]);
  check("headroom steps back up", ups.length >= 1, { level: c.level, log: cLog });
  check("never twice within 10 s", gaps.every((g) => g >= 9.9), { ups, gaps });

  // 4. Level changes compile nothing.
  check("no shader compiles from level changes", c.programs === prog0, { before: prog0, after: c.programs });

  // Views at the extremes for the report.
  await R(() => window.__ride.xr.mode.adaptive.force(3));
  await wait(2500);
  await page.screenshot({ path: path.join(OUT, "adapt-L3.jpg"), type: "jpeg", quality: 90 });
  const d = await st();
  check("forced L3 still compiles nothing", d.programs === prog0, { programs: d.programs, calls: d.calls });
  await fs.writeFile(path.join(OUT, "adapt-report.json"), JSON.stringify({ slow: SLOW, checks, timeline, log: d.log, errors }, null, 1));
} catch (e) {
  errors.push(`script: ${e.stack || e}`);
} finally {
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log("  " + e);
  await browser.close();
}
