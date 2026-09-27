/**
 * Headset graphics tier. Quest Browser gets a stripped render path: no MRT, ink, paint filter,
 * bloom or paddy mirror (see XRMode.render), a smaller shadow map, shorter detail distances and a
 * slightly reduced framebuffer, with fixed foveation. URL overrides for on-device tuning:
 * `xrscale=0.7…1`, `xrfov=0…1` (foveation), `xrfar=` (m), `xrlite=1` (no sun shadow), `xrfps=1`.
 */
const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? v : d;
};

/** Quest Browser (or `xrtier=quest` to try the headset tier in the emulator). */
export const QUEST = /OculusBrowser|Quest|Pacific/i.test(navigator.userAgent) || params.get("xrtier") === "quest";
const LITE = params.get("xrlite") === "1";

export const XR_TIER = {
  framebufferScale: num("xrscale", QUEST ? 0.85 : 1),
  foveation: num("xrfov", 1),
  frameRate: num("xrhz", 72),
  /** Sun shadow in the headset (desktop keeps its 2048 map). */
  shadow: !LITE,
  shadowSize: QUEST ? 1024 : 2048,
  shadowHalf: QUEST ? 38 : 55,
  /** Refresh the sun shadow every n-th headset frame. */
  shadowEvery: num("xrshadow", QUEST ? 2 : 1),
  /** Fine detail (grass, rice, flowers) drops out this much sooner; whole chunks past `far`. */
  cullK: LITE ? 0.28 : 0.35,
  far: num("xrfar", LITE ? 160 : 200),
  /** Hero leaf-card trees out to this distance; -1 = the lobed distant trees everywhere (Quest). */
  treeFar: params.get("xrtrees") === "hero" ? 70 : QUEST ? -1 : 70,
  showFps: params.get("xrfps") === "1",
  /** Headset instancing radii (m), see proxies.ts. */
  radii: LITE ? { hero: 10, trees: 60, fine: 12, other: 30 } : { hero: 16, trees: 72, fine: 17, other: 45 },
  /** Her shadow on the road (~60 small draws in the shadow pass). */
  riderShadow: !QUEST,
};
