#!/usr/bin/env node
/**
 * Headset frame cost in the IWER emulator (Quest tier, stereo): per-frame draw calls and triangles
 * (both eyes), JavaScript time from the start of the simulation to the end of the render call, and
 * GPU time of the headset render (EXT_disjoint_timer_query_webgl2), at spots along the guided ride.
 * `--throttle=4` also repeats the CPU timing with Chrome's CPU throttling as a rough stand-in for a
 * mobile headset CPU. Desktop numbers are proxies, not Quest numbers. Needs `pnpm dev` (port 5421).
 *   node scripts/xr-cost.mjs [--url=http://localhost:5421/] [--level=0..3] [--throttle=4] [--q=extra&query]
 */
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5421/");
const LEVEL = arg("level", undefined);
const THROTTLE = Number(arg("throttle", 0));
const EXTRA = arg("q", "");
const ROUTE = [-54, -120, -200, -330, -520];
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--mute-audio"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0&stereo=1&xradapt=0${EXTRA ? `&${EXTRA}` : ""}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  if (LEVEL !== undefined) await page.evaluate((l) => window.__ride.xr.mode.adaptive.force(l), Number(LEVEL));
  // Hooks: preSim marks the frame start, render's end the frame end; GPU time around render.
  await page.evaluate(() => {
    const m = window.__ride.xr.mode, rd = window.__rideRenderer, gl = rd.getContext();
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const acc = (window.__cost = { js: [], render: [], gpu: [], calls: [], tris: [], pending: [] });
    const pre = m.preSim.bind(m), render = m.render.bind(m);
    let t0 = 0;
    m.preSim = (...a) => ((t0 = performance.now()), pre(...a));
    m.render = (...a) => {
      const r0 = performance.now();
      let q = null;
      if (ext && acc.pending.length < 8) {
        q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      }
      render(...a);
      if (q) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        acc.pending.push(q);
      }
      const t1 = performance.now();
      if (window.__costOn) {
        acc.js.push(t1 - t0);
        acc.render.push(t1 - r0);
        acc.calls.push(rd.info.render.calls);
        acc.tris.push(rd.info.render.triangles);
      }
      while (acc.pending.length) {
        const p = acc.pending[0];
        if (!gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(p, gl.QUERY_RESULT);
        if (window.__costOn && !gl.getParameter(ext.GPU_DISJOINT_EXT)) acc.gpu.push(ns / 1e6);
        gl.deleteQuery(p);
        acc.pending.shift();
      }
    };
  });
  const cdp = await page.context().newCDPSession(page);
  const sample = async () => {
    await page.evaluate(() => {
      const a = window.__cost;
      for (const k of ["js", "render", "gpu", "calls", "tris"]) a[k].length = 0;
      window.__costOn = true;
    });
    await page.waitForTimeout(2500);
    return page.evaluate(() => {
      window.__costOn = false;
      const a = window.__cost;
      const med = (v) => (v.length ? [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] : NaN);
      const p90 = (v) => (v.length ? [...v].sort((x, y) => x - y)[Math.floor(v.length * 0.9)] : NaN);
      return { n: a.js.length, js: med(a.js), js90: p90(a.js), render: med(a.render), gpu: med(a.gpu), calls: med(a.calls), tris: med(a.tris), level: window.__ride.xr.mode.adaptive.current.name };
    });
  };
  const rows = [];
  for (const z of ROUTE) {
    await page.evaluate((z) => window.__ride.place(-0.9, z, 0), z);
    await page.waitForTimeout(1500);
    const r = await sample();
    let thr = null;
    if (THROTTLE > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
      await page.waitForTimeout(800);
      thr = await sample();
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
    rows.push({ z, ...r, thr });
    console.log(
      `z ${z} ${r.level}: ${r.calls} calls, ${Math.round(r.tris / 1000)}k tris/frame; js ${r.js.toFixed(2)} ms (p90 ${r.js90.toFixed(2)}, render ${r.render.toFixed(2)}); gpu ${r.gpu.toFixed(2)} ms` +
        (thr ? `; js x${THROTTLE} ${thr.js.toFixed(2)} ms (p90 ${thr.js90.toFixed(2)}, render ${thr.render.toFixed(2)})` : ""),
    );
  }
  const mean = (k, f = (r) => r[k]) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  console.log(
    `mean: ${Math.round(mean("calls"))} calls, ${Math.round(mean("tris") / 1000)}k tris/frame, js ${mean("js").toFixed(2)} ms, gpu ${mean("gpu").toFixed(2)} ms` +
      (THROTTLE > 1 ? `, js x${THROTTLE} ${mean(null, (r) => r.thr.js).toFixed(2)} ms` : ""),
  );
  console.log(`errors: ${errors.length}${errors.length ? " " + errors.slice(0, 3).join(" | ") : ""}`);
} finally {
  await browser.close();
}
