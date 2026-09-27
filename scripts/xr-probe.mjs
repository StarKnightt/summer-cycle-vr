#!/usr/bin/env node
/**
 * Headset draw-call probe in the IWER emulator: enters VR, then reports views per frame, sun
 * shadow calls and total calls for a few detail settings. Needs `pnpm dev` (port 5421).
 *   node scripts/xr-probe.mjs [--url=http://localhost:5421/]
 */
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const URL = argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "http://localhost:5421/";
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--mute-audio"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0&stereo=1${argv.includes("--lite") ? "&xrlite=1" : ""}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  await page.evaluate(() => window.__ride.place(-0.9, -120, 0));
  await page.waitForTimeout(1500);
  const read = () =>
    page.evaluate(() => ({
      views: window.__rideRenderer.xr.getCamera().cameras.length,
      calls: window.__ride.xr.state.calls,
      shadow: window.__ride.xr.state.shadowCalls,
      tris: window.__rideRenderer.info.render.triangles,
    }));
  const cfgs = [
    ["tier default (cull 0.35, far 240)", 0.35, 240, 70],
    ["lite (cull 0.28, far 180)", 0.28, 180, 45],
  ];
  // Exact per-draw accounting for one headset frame: every draw call counted in onBeforeRender,
  // split into eye draws and sun-shadow draws, grouped by surface family (outline id).
  const exact = await page.evaluate(async () => {
    const r = window.__ride, acc = { eye: {}, shadow: {} }, tot = { eye: [0, 0], shadow: [0, 0] };
    let on = false;
    const names = ["sky", "ground", "water", "berm", "grass", "rice", "tree", "house", "pole", "wire", "fence", "sign", "bike", "rider", "hair", "hills", "flower", "butterfly", "skin", "eye"];
    r.scene.traverse((o) => {
      if (!o.isMesh) return;
      const prev = o.onBeforeRender;
      o.onBeforeRender = function (rd, sc, cam, geo, mat, grp) {
        prev.call(this, rd, sc, cam, geo, mat, grp);
        if (!on) return;
        const k = cam.isOrthographicCamera ? "shadow" : "eye";
        const id = mat.uniforms?.uId?.value;
        const key = (id !== undefined ? names[id] ?? id : mat.type) + (this.isInstancedMesh ? "*" : "");
        const n = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) * (this.isInstancedMesh ? this.count : 1);
        const a = (acc[k][key] ??= [0, 0]);
        a[0]++, (a[1] += n), tot[k][0]++, (tot[k][1] += n);
      };
    });
    // Two consecutive headset frames (the Quest tier draws the shadow every other frame), averaged.
    const m = r.xr.mode, orig = m.render.bind(m);
    let left = 2;
    await new Promise((res) => {
      m.render = (...a) => {
        on = left > 0;
        orig(...a);
        on = false;
        if (--left === 0) res();
      };
    });
    m.render = orig;
    const frames = 2;
    for (const k of ["eye", "shadow"]) tot[k] = tot[k].map((v) => Math.round(v / frames));
    const fmt = (o) => Object.entries(o).sort((a, b) => b[1][1] - a[1][1]).map(([k, [c, t]]) => `${k}:${c / frames}/${Math.round(t / frames / 1000)}k`).join(" ");
    return { eye: fmt(acc.eye), shadow: fmt(acc.shadow), tot, frames };
  });
  console.log("per frame (both eyes; divide eye by 2 for per eye), calls/tris by family");
  console.log("  eye   ", exact.eye);
  console.log("  shadow", exact.shadow);
  console.log("  totals", JSON.stringify(exact.tot));
  console.log(
    "load",
    JSON.stringify(await page.evaluate(() => ({ bootMs: window.__ride.bootLog.find((b) => b[0] === "total")?.[1], programs: window.__rideRenderer.info.programs.length, slowest: [...window.__ride.bootLog].filter((b) => b[0] !== "total").sort((a, b) => b[1] - a[1]).slice(0, 10), drawSum: window.__ride.bootLog.filter((b) => /^draw/.test(b[0])).reduce((s, b) => s + b[1], 0) }))),
  );
  // Triangle budget by outline id (surface family) for visible meshes within 120 m, drawn per eye.
  const byId = await page.evaluate(() => {
    const r = window.__ride, out = {};
    const cam = r.xrRoot.position;
    r.scene.traverseVisible((o) => {
      if (!o.isMesh || !o.layers.test({ mask: 1 })) return;
      const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3;
      const inst = o.isInstancedMesh ? o.count : 1;
      o.geometry.computeBoundingSphere?.();
      const c = o.geometry.boundingSphere ? o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld) : o.position;
      if (c.distanceTo(cam) - (o.geometry.boundingSphere?.radius ?? 0) * 1.5 > 120) return;
      const id = o.material?.uniforms?.uId?.value ?? o.material?.type ?? "?";
      const k = `${id}${o.isInstancedMesh ? "i" : ""}`;
      out[k] = (out[k] ?? 0) + n * inst;
    });
    return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${Math.round(v / 1000)}k`);
  });
  console.log("tris by id (near)", byId.join(" "));
  for (const [name, c, f, tf] of cfgs) {
    await page.evaluate(([c, f, tf]) => window.__ride.world.setDetail(c, f, tf), [c, f, tf]);
    await page.waitForTimeout(1200);
    const a = await read();
    await page.waitForTimeout(16);
    const b = await read();
    console.log(name, JSON.stringify(a), JSON.stringify(b));
  }
  if (argv.includes("--trees")) {
    await page.evaluate(() => window.__xrdev.quaternion.set(-0.1, 0.1, 0, 0.99));
    for (const tf of [70, -1]) {
      await page.evaluate((tf) => window.__ride.world.setDetail(0.35, 240, tf), tf);
      await page.waitForTimeout(800);
      console.log(`trees ${tf}`, JSON.stringify(await read()));
      await page.screenshot({ path: `shots/xr/probe-trees-${tf < 0 ? "lobed" : "hero"}.png` });
    }
  }
} finally {
  await browser.close();
}
