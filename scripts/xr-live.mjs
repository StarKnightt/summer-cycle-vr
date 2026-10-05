#!/usr/bin/env node
/**
 * Smoke check of a deployed build (production bundle: only `window.__ride` and, with ?xremu,
 * `window.__xrdev` are exposed). Desktop: the loader finishes, a click starts the ride, frames run.
 * Headset (IWER, hands): Enter VR, the first lesson with its ghost hands, both hands onto the grips,
 * she rides into the brake lesson, Leave VR. Fails on any console error.
 *   node scripts/xr-live.mjs [--url=https://starknightt.github.io/summer-cycle-vr/] [--shot=file.jpg]
 */
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "https://starknightt.github.io/summer-cycle-vr/");
const SHOT = arg("shot", "");
const checks = [];
const errors = [];
const check = (name, pass, detail) => {
  checks.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--mute-audio"],
});
const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/warning X\d{4}/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${URL}${query}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 240000 });
  return page;
};
try {
  // Desktop: the original game.
  const desk = await open("?fs=0");
  await desk.mouse.click(800, 500);
  await desk.waitForTimeout(2500);
  const d = await desk.evaluate(() => ({ waiting: window.__ride.waiting, time: window.__ride.time, speed: window.__ride.ctl.speed }));
  check("desktop: the loader's click starts the ride", !d.waiting && d.time > 1 && d.speed > 0, d);
  await desk.close();

  // Headset in the emulator, hands only.
  const page = await open("?xremu=hands&xrtier=quest&fs=0");
  await page.evaluate(() => {
    const dev = window.__xrdev;
    dev.position.set(0, 1.2, 0);
    dev.quaternion.set(-0.13, 0, 0, 0.99);
  });
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__ride.xr.mode.session.recenter());
  await page.waitForTimeout(400);
  const s0 = await page.evaluate(() => window.__ride.xr.state);
  check("Enter VR: the first lesson, with its ghost hands", s0.presenting && s0.step === "hold" && s0.hint === "hold" && s0.drawn > 0, { step: s0.step, hint: s0.hint, drawn: s0.drawn });
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      const m = window.__ride.xr.mode, dev = window.__xrdev, root = window.__ride.xrRoot;
      dev.hands.left.quaternion.set(-0.5, 0.5, 0.5, 0.5);
      dev.hands.right.quaternion.set(-0.5, -0.5, -0.5, 0.5);
      for (const [side, g] of [["left", [-0.29, 1.05, -0.17]], ["right", [0.29, 1.05, -0.17]]]) {
        const h = m.hands[side], hin = dev.hands[side];
        if (!h.tracked) {
          hin.position.set(side === "left" ? -0.25 : 0.25, 0.8, -0.4);
          continue;
        }
        // No THREE in the bundle: borrow vector and quaternion instances from the rider.
        const e = root.localToWorld(root.position.clone().set(...g)).sub(h.palm);
        e.applyQuaternion(m.session.offset.getWorldQuaternion(root.quaternion.clone()).invert());
        hin.position.set(hin.position.x + e.x, hin.position.y + e.y, hin.position.z + e.z);
      }
    });
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(3000);
  const s1 = await page.evaluate(() => ({ ...window.__ride.xr.state, speed: window.__ride.ctl.speed }));
  check("hands on the grips: she rides into the brake lesson", s1.held[0] && s1.held[1] && s1.speed > 1 && s1.step === "brake", { held: s1.held, speed: s1.speed, step: s1.step, hint: s1.hint, level: s1.level });
  if (SHOT) await page.screenshot({ path: SHOT, type: "jpeg", quality: 88 });
  await page.evaluate(() => window.__ride.xr.mode.session.exit());
  await page.waitForTimeout(1500);
  const s2 = await page.evaluate(() => ({ presenting: window.__ride.xr.state.presenting, time: window.__ride.time }));
  check("Leave VR: back to the desktop ride", !s2.presenting, s2);
} catch (e) {
  errors.push(`script: ${e.stack || e}`);
} finally {
  check("no console errors", errors.length === 0, errors.slice(0, 5));
  console.log(`${checks.filter(Boolean).length}/${checks.length} on ${URL}`);
  await browser.close();
}
