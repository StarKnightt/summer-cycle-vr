#!/usr/bin/env node
/**
 * Where the headset frame's JavaScript goes: a V8 CPU profile of a few seconds in the IWER emulator
 * (Quest tier, stereo, riding at the shop row), self time by function, heaviest first, plus a
 * count of the scene graph. Needs `pnpm dev` (port 5421).
 *   node scripts/xr-cpuprof.mjs [--url=http://localhost:5421/] [--level=0..3] [--q=extra&query]
 */
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5421/");
const LEVEL = arg("level", undefined);
const EXTRA = arg("q", "");
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--mute-audio"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0&stereo=1&xradapt=0${EXTRA ? `&${EXTRA}` : ""}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  if (LEVEL !== undefined) await page.evaluate((l) => window.__ride.xr.mode.adaptive.force(l), Number(LEVEL));
  await page.evaluate(() => window.__ride.place(-0.9, -120, 0));
  await page.waitForTimeout(2000);
  console.log(
    "scene",
    JSON.stringify(
      await page.evaluate(() => {
        let all = 0, auto = 0, meshes = 0, visMeshes = 0, lights = 0;
        window.__ride.scene.traverse((o) => {
          all++;
          if (o.matrixAutoUpdate) auto++;
          if (o.isMesh || o.isLine || o.isPoints) meshes++;
          if (o.isLight) lights++;
        });
        window.__ride.scene.traverseVisible((o) => (o.isMesh || o.isLine || o.isPoints) && visMeshes++);
        return { all, auto, meshes, visMeshes, lights, programs: window.__rideRenderer.info.programs.length };
      }),
    ),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await page.waitForTimeout(4000);
  const { profile } = await cdp.send("Profiler.stop");
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const cf = n.callFrame;
    const file = cf.url.split("/").pop().split("?")[0];
    const k = `${cf.functionName || "(anon)"} ${file}:${cf.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const idle = (self.get("(idle) :0") ?? 0) + (self.get("(program) :0") ?? 0);
  console.log(`profile ${total.toFixed(0)} ms, idle/program ${idle.toFixed(0)} ms`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${v.toFixed(1).padStart(8)} ms  ${k}`);
  // Callers of the native GL getters (synchronous round trips to the GPU process).
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n);
  const hits = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    let n = byId.get(profile.samples[i]);
    if (!/^(getParameter|getContextAttributes|getError|checkFramebufferStatus|readPixels)$/.test(n.callFrame.functionName)) continue;
    const chain = [];
    for (let p = parent.get(n.id), d = 0; p && d < 4; p = parent.get(p.id), d++) chain.push(`${p.callFrame.functionName || "(anon)"}:${p.callFrame.url.split("/").pop().split("?")[0]}:${p.callFrame.lineNumber + 1}`);
    const k = `${n.callFrame.functionName} <- ${chain.join(" <- ")}`;
    hits.set(k, (hits.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  for (const [k, v] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${v.toFixed(1).padStart(8)} ms  ${k}`);
} finally {
  await browser.close();
}
