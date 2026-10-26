/**
 * Headset graphics tier. Quest Browser gets a stripped render path: no MRT, ink, paint filter,
 * bloom or paddy mirror (see XRMode.render), a smaller shadow map, shorter detail distances and a
 * reduced framebuffer, with fixed foveation and cheaper procedural shading (XR_CHEAP). URL overrides
 * for on-device tuning: `xrscale=0.5…1`, `xrfov=0…1` (foveation), `xrfar=` (m), `xrlite=1` (no sun
 * shadow), `xrfps=1`, `xrcheap=0` (full shading), `xrstart=0…4` (start level), `xrmem=0` (ignore
 * what earlier sessions on this headset learned, see adaptive.ts).
 */
const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? v : d;
};
const UA = navigator.userAgent;

/** Quest Browser (or `xrtier=quest` to try the headset tier in the emulator). */
export const QUEST = /OculusBrowser|Quest|Pacific/i.test(UA) || params.get("xrtier") === "quest";
/**
 * Quest 2 and older (Quest 1, Go): about half the GPU of a Quest 3 / 3S. Quest Browser names the
 * model in its user agent ("Quest 2"); `xrtier=quest2` tries this start in the emulator.
 */
export const QUEST_OLD = (QUEST && /Quest 2|Quest;|Quest\)|Pacific/i.test(UA)) || params.get("xrtier") === "quest2";
const LITE = params.get("xrlite") === "1";
/** Cheaper procedural shading in the Quest-tier shaders (compile time; `xrcheap=0` for the full look). */
export const XR_CHEAP = params.get("xrcheap") !== "0";

/**
 * Framebuffer scale steps for the next session on a headset that ran out of headroom even at the
 * lightest level (adaptive.ts remembers it). The scale is fixed for a session in three.js.
 */
export const SCALE_STEPS = [1, 0.88, 0.76];

export const XR_TIER = {
  framebufferScale: num("xrscale", LITE ? 0.7 : QUEST_OLD ? 0.72 : QUEST ? 0.8 : 1),
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
  /** Adaptive level the session starts on: Quest 2 starts without the sun shadow (L2). */
  startLevel: num("xrstart", QUEST_OLD ? 2 : 0),
  /** Remember a struggling headset across sessions (localStorage). */
  memory: params.get("xrmem") !== "0" && !params.has("xrscale"),
};
