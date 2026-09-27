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
  await page.goto(`${URL}?xremu=hands&xrtier=quest&fs=0&stereo=1`);
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
