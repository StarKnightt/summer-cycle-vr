#!/usr/bin/env node
/**
 * Headset look comparison in the IWER emulator (Quest tier, L0 pinned, hands on the bars): the
 * same handful of views at each time of day, for before / after checks of the headset render
 * path. Needs `pnpm dev` (port 5421).
 *   node scripts/xr-look.mjs [--tag=after] [--q=xrlook=0] [--out=dir] [--only=open,sun]
 * Writes <out>/<view>-<tag>.jpg (default out: the system temp folder, not the repo).
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5421/");
const TAG = arg("tag", "now");
const Q = arg("q", "");
const OUT = arg("out", path.join(os.tmpdir(), "summer-cycle-look"));
const ONLY = arg("only", "");
await fs.mkdir(OUT, { recursive: true });

/** name, road z, time of day, head yaw / pitch (deg, yaw + = left), hide the guide card. */
const VIEWS = [
  ["open", -54, "afternoon", 0, -12, false],
  ["shops", -100, "afternoon", -18, -6, true],
  ["golden", -40, "golden", 26, -2, true],
  ["sunset", -150, "sunset", 18, 0, true],
  ["shrine", -186, "dusk", -14, -6, true],
  ["bars", -70, "golden", 0, -34, true],
].filter((v) => !ONLY || ONLY.split(",").includes(v[0]));

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--hide-scrollbars", "--mute-audio"],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/warning X\d{4}/.test(m.text())) errors.push(m.text());
  });
  const R = (fn, a) => page.evaluate(fn, a);
  const wait = (ms) => page.waitForTimeout(ms);
  await page.goto(`${URL}?xremu=hands&xrtier=quest&xradapt=0&fs=0${Q ? `&${Q}` : ""}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  const head = (pitchDeg, yawDeg = 0) =>
    R(([p, y]) => {
      const d = window.__xrdev;
      d.position.set(0, 1.2, 0);
      const a = (p * Math.PI) / 360, b = (y * Math.PI) / 360;
      const cy = Math.cos(b), sy = Math.sin(b), cp = Math.cos(a), sp = Math.sin(a);
      d.quaternion.set(sp * cy, cp * sy, -sp * sy, cp * cy);
    }, [pitchDeg, yawDeg]);
  await head(-18);
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  await wait(500);
  await R(() => window.__ride.xr.mode.session.recenter());
  await wait(300);
  const grips = async () => {
    for (let i = 0; i < 6; i++) {
      await R(() => {
        const m = window.__ride.xr.mode, T = window.__THREE, d = window.__xrdev;
        d.hands.left.quaternion.set(-0.5, 0.5, 0.5, 0.5);
        d.hands.right.quaternion.set(-0.5, -0.5, -0.5, 0.5);
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
      await wait(120);
    }
  };
  await grips();
  for (const [name, z, time, yaw, pitch, hide] of VIEWS) {
    await R(([z, time, hide]) => {
      const r = window.__ride, m = r.xr.mode;
      r.setTime(time, true);
      r.place(-0.9, z, 0);
      m.guide.group.visible = !hide;
    }, [z, time, hide]);
    await head(pitch, yaw);
    await grips();
    await wait(1400);
    await page.screenshot({ path: path.join(OUT, `${name}-${TAG}.jpg`), type: "jpeg", quality: 90 });
    console.log(`${name}-${TAG}.jpg`);
  }
  const info = await R(() => ({ programs: window.__rideRenderer.info.programs.length, state: window.__ride.xr.state }));
  console.log(`programs ${info.programs}, level ${info.state.level}, calls ${info.state.calls}`);
} catch (e) {
  errors.push(`script: ${e.stack || e}`);
} finally {
  console.log(`out: ${OUT}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log("  " + e);
  await browser.close();
}
