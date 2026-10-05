#!/usr/bin/env node
/**
 * Cold start to the first headset frame, in a fresh browser profile each run (empty HTTP and shader
 * caches): page load, world build (the game's own boot log), the loader's "ready" moment, Enter VR
 * to presenting, and to the first rendered headset frame. Works on dev, preview and the live site
 * (only the production-safe `window.__ride` hooks are used); IWER stands in for the headset.
 *   node scripts/xr-coldstart.mjs [--url=http://localhost:5420/] [--runs=3]
 * Desktop GPU numbers: a Quest's CPU and GPU are several times slower.
 */
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = arg("url", "http://localhost:5420/");
const RUNS = Number(arg("runs", 3));
const ms = (v) => Math.round(v);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const rows = [];
const errors = [];
for (let r = 0; r < RUNS; r++) {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--mute-audio"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/warning X\d{4}/.test(m.text())) errors.push(m.text());
    });
    const t0 = Date.now();
    await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0`, { waitUntil: "domcontentloaded" });
    const dom = Date.now() - t0;
    await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 240000, polling: 50 });
    const ready = Date.now() - t0;
    const boot = await page.evaluate(() => {
      const log = window.__ride.bootLog;
      const sum = (re) => log.filter((b) => re.test(b[0])).reduce((s, b) => s + b[1], 0);
      return { total: log.find((b) => b[0] === "total")?.[1] ?? 0, chunks: sum(/^chunk/), protos: sum(/^proto/), compile: sum(/^compile$/), draws: sum(/^draw/), warm: sum(/^warm/) };
    });
    const c0 = Date.now();
    await page.click("#xr-enter");
    await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 30000, polling: 16 });
    const presenting = Date.now() - c0;
    // Builds before the `drawn` counter only update `calls` twice a second (up to 0.5 s late).
    const coarse = await page.evaluate(() => window.__ride.xr.state.drawn === undefined);
    await page.waitForFunction(() => {
      const s = window.__ride.xr.state;
      return (s.drawn ?? (s.calls > 0 ? 1 : 0)) > 0;
    }, null, { timeout: 30000, polling: 16 });
    const firstFrame = Date.now() - c0;
    if (coarse && r === 0) console.log("(old build: first frame read from the twice-a-second readout)");
    const row = { dom, ready, bootTotal: boot.total, chunks: boot.chunks, protos: boot.protos, compile: boot.compile, draws: boot.draws, warm: boot.warm, enterToPresenting: presenting, enterToFrame: firstFrame };
    rows.push(row);
    console.log(`run ${r + 1}: ${JSON.stringify(row)}`);
  } catch (e) {
    errors.push(`script: ${e.stack || e}`);
  } finally {
    await browser.close();
  }
}
if (rows.length) {
  const keys = Object.keys(rows[0]);
  const med = Object.fromEntries(keys.map((k) => [k, ms(median(rows.map((x) => x[k])))]));
  console.log(`median of ${rows.length} (ms): ${JSON.stringify(med)}`);
}
console.log(`errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log("  " + e);
