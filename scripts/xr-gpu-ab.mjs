#!/usr/bin/env node
/**
 * What the headset frame's GPU time is made of, in the IWER emulator (Quest tier, stereo, a large
 * window so pixel cost shows): the headset render's GPU time (timer query) with one part of the
 * scene hidden at a time. Desktop GPU proportions, not Quest numbers. Needs `pnpm dev` (port 5421).
 *   node scripts/xr-gpu-ab.mjs [--url=http://localhost:5421/] [--level=0..3] [--q=extra&query]
 */
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5421/");
const LEVEL = Number(arg("level", 0));
const EXTRA = arg("q", "");
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--mute-audio"],
});
try {
  const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
  await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0&stereo=1&xradapt=0${EXTRA ? `&${EXTRA}` : ""}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  await page.evaluate((l) => window.__ride.xr.mode.adaptive.force(l), LEVEL);
  await page.evaluate(() => window.__ride.place(-0.9, -120, 0));
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const m = window.__ride.xr.mode, rd = window.__rideRenderer, gl = rd.getContext();
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const acc = (window.__gpu = { v: [], pending: [] });
    const render = m.render.bind(m);
    m.render = (...a) => {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render(...a);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      acc.pending.push(q);
      while (acc.pending.length) {
        const p = acc.pending[0];
        if (!gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) acc.v.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(p);
        acc.pending.shift();
      }
    };
    const s = window.__ride.scene, find = (n) => s.getObjectByName(n);
    const sky = s.children.find((c) => c.children.some((d) => d.geometry?.type === "SphereGeometry"));
    const chunks = window.__ride.world.root;
    const bike = window.__ride.bike.group;
    const proxies = find("xr-proxies");
    const basic = new window.__THREE.MeshBasicMaterial({ color: 0x888888 });
    window.__ab = {
      base: [() => {}, () => {}],
      "no sky/clouds/hills": [() => (sky.visible = false), () => (sky.visible = true)],
      "no chunks (ground, houses, poles)": [() => (chunks.visible = false), () => (chunks.visible = true)],
      "no proxies (trees, grass, flowers)": [() => (proxies.visible = false), () => (proxies.visible = true)],
      "no bike": [() => (bike.visible = false), () => (bike.visible = true)],
      "flat material everywhere": [() => (s.overrideMaterial = basic), () => (s.overrideMaterial = null)],
    };
    const fb = rd.xr.getRenderTarget?.() ?? null;
    window.__fb = fb ? [fb.width, fb.height, fb.samples] : null;
  });
  console.log("xr target", JSON.stringify(await page.evaluate(() => window.__fb)));
  const names = await page.evaluate(() => Object.keys(window.__ab));
  // Each variant against a base measured right before it (GPU clocks drift), median of 3 rounds.
  const measure = async (n) => {
    await page.evaluate((n) => window.__ab[n][0](), n);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window.__gpu.v.length = 0));
    await page.waitForTimeout(1500);
    const v = await page.evaluate(() => [...window.__gpu.v].sort((a, b) => a - b)[Math.floor(window.__gpu.v.length / 2)]);
    await page.evaluate((n) => window.__ab[n][1](), n);
    return v;
  };
  const res = {};
  for (let round = 0; round < 3; round++)
    for (const n of names.slice(1)) {
      const b = await measure("base");
      const v = await measure(n);
      (res[n] ??= []).push([b, v]);
    }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (const n of names.slice(1)) {
    const b = med(res[n].map((r) => r[0])), v = med(res[n].map((r) => r[1]));
    console.log(`${n.padEnd(38)} base ${b.toFixed(2)} ms -> ${v.toFixed(2)} ms (${(((v - b) / b) * 100).toFixed(0)}%)`);
  }
} finally {
  await browser.close();
}
