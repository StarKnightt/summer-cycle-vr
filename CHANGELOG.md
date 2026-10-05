# Changelog

Summer Cycle existed before the Meta VR Start Developer Competition 2026 as a desktop browser game
(first public release on GitHub Pages, `master` up to commit `8b977ba`). Everything below was added
during the competition window, from 27 September 2026, on the `webxr-hands` branch. It is the
"significant update" for the Adapted / Significantly Updated Experience division.

## 2026-10-06: The headset look, hands-only lessons and an ending

### A drawn look without the post chain
- **Ink**: outlined surfaces darken where they turn away from the eye, measured against the
  screen-space rate of change so the line stays about 1.5 px wide at any distance (no line on flat
  faces). On the Quest tier the houses, street furniture, the torii and the fences also carry their
  hard edges per triangle corner (`src/render/edges.ts`), so creases and silhouettes get crease
  lines. Both fade with distance, skip triangles a few pixels across, and use the desktop's outline
  weights. No extra draws or triangles.
- **Sun glow**: an additive glow at infinity around a low sun stands in for bloom (one draw, only
  while the sun is low and up).
- **Sky and output**: a lighter haze band on the horizon and a faint watercolour wash in the sky; a
  one-step dither in the headset output so dusk gradients don't band.
- **Sun dial**: a small shaded sun in a halo instead of a flat disc; the arc and its four stops show
  only while a hand is near or the guide points at the sun.
- `?xrlook=0` keeps the previous headset render for comparison.

### Hands-only lessons and feedback
- **Ghost hands** (recorded hand poses from Meta's IWER, baked by `scripts/xr-handposes.mjs`) show
  each gesture where it is done: settling onto the grips, a pinch above the right grip, the left
  thumb to the bell, reaching up to pinch and pull the sun, turning the left palm up. Light, not
  skin: additive with a bright rim, so they never hide the real hands. Two draws while showing.
- A short **menu lesson** after the sun ("Turn your left palm toward you"); the brake lesson ends
  soon after you brake instead of on a timer.
- **Hands lost and found**: if neither hand nor controller has been seen for most of a second, a
  card at eye height says so while the bike coasts; a soft cue sounds each way and the grip rings
  invite the hands back. With no hands at all after two seconds, it asks for them.
- **Sound cues**: a soft glass chime as each lesson is done, a rising or falling pair for a hand
  found or lost, a short phrase for the end card (synthesized, like everything else).

### An ending
- A few seconds after she stops at the torii, an **end card** shows what she rode (distance, time,
  how often the bell rang) and two tags within reach, about 55 cm from the eyes: **Ride again**
  (fades out and back into the afternoon at the start) and **Ride on** (free riding at dusk). Poke
  a tag or pinch on it; taking the bars and riding off also counts as Ride on.

### Fixes
- **Every headset frame ran twice.** Starting the XR loop with `renderer.setAnimationLoop` after the
  session had begun also restarted three.js's window loop, so the frame ran from both loops with
  interleaved timestamps (alternating negative time steps, a second render per frame in the
  emulator). The session's own loop drives the headset now, and time steps are clamped at zero.
  The emulator's frame rate readout had been counting both (its "400 fps" was 200).
- **The hands trailed the bike by a frame.** Hands are read before the ride steps and the rig then
  moves with the bike, so the drawn hands and grip rings sat one frame of travel behind (about 6 cm
  at 4.2 m/s and 72 Hz), and the sun, the wrist menu and the end card compared hands against a moved
  rig. What was read now rides along with the rig.
- Nothing compiles in the session any more: the headset materials (prompts, ghost hands, the end
  card, the glow) compile behind the loader. Shader programs: 90 before entering, 90 at the end of
  the guided ride (previously 79, then 86 after entering).

### Measured (IWER emulator, Quest tier, desktop GPU)
Per eye at the worst spot of ten along the guided ride (`scripts/xr-probe.mjs --route`):

| | Before | After |
|---|---|---|
| L0, afternoon (first lesson, ghost hands showing) | 123 calls, 382k tris | 124 calls, 388k tris |
| L0, sunset (sun glow) | | 126 calls, 388k tris |
| L0, mean of the ten spots | 112 calls, 330k tris | 113 calls, 336k tris |
| L1 / L2 / L3 | | 116 / 113 / 108 calls, 356k / 324k / 298k tris |

- The hands-only walkthrough (`scripts/xr-shots.mjs`) passes its 14 checks plus 9 new ones (ghost
  hints for every lesson, the menu lesson, hands lost and found mid-ride, the end card, Ride again,
  no compiles over the session) at every adaptive level pinned (`--level=0..3`), with no console
  errors. `scripts/xr-adapt.mjs` passes all 9 checks.
- Cold start (`scripts/xr-coldstart.mjs`, fresh browser profile, median of 3): the loader is ready
  at about 19 s on this machine before and after (runs vary 17 to 21 s; warm-up draws are 12 to 14 s
  of it), the hard-edge pass adds about 60 ms to the world build, and Enter VR reaches the first
  headset frame in 0.42 s (previously about 0.8 s, read from a coarser readout). Not Quest numbers.

### Tooling
- `scripts/xr-look.mjs`: the same headset views at each time of day for look comparisons.
- `scripts/xr-probe.mjs --route [--level] [--time]`, `scripts/xr-coldstart.mjs`.
- `scripts/xr-adapt.mjs` watches the heavy phase for 32 s (each level step takes its full 5.5 s now
  that one loop drives the frames); `scripts/xr-reel.mjs` reports an error if the sun drag misses.

## 2026-09-28: Adaptive quality in the headset

- `src/xr/adaptive.ts`: the XR frame loop measures real frame intervals. When 1.5 s of frames
  average under 90% of the display rate (the session's `frameRate`, else 72; Quest Browser is asked
  for 72 Hz), it steps one level lighter:
  - **L0**: the tier the session starts on (Quest default, or `xrlite`).
  - **L1**: smaller detail radii, the sun shadow every third frame, 180 m view, full foveation.
  - **L2**: lite radii, no sun shadow, 140 m view.
  - **L3** (emergency): shortest radii, half the grass and flowers, no shadow, 100 m view.
- Steps back up need 4 s of clear headroom (average at the target, no slow frame) and at least
  10 s at the level; a level left again soon after climbing into it waits twice as long. Frames
  are ignored for 2 s after entering, resuming or changing level.
- Nothing recompiles: levels change instance radii, grass thinning, chunk visibility, a shadow
  uniform and foveation only. Radii and thinning ease in over about a second, so detail fades at
  the edges instead of popping.
- The level shows in the `?xrfps=1` readout and the wrist menu's frame rate row.
- `?xrslow=ms` (emulator test) adds a frame cost that shrinks with the scene's triangles;
  `scripts/xr-adapt.mjs` checks step down, settle, step up and no shader compiles.
- Fixed: the headset scenery proxies only refilled while detail was easing (a `NaN` distance
  check), so a stationary start could show no grass or trees until the bike moved.
- The audio settings key no longer carries the old project name (`summer-cycle:audio`; the old
  key is copied over once and left in place, since the desktop game on the same origin still
  uses it).

## 2026-09-27: Summer Cycle VR, phase 2 (Quest performance)

Measured with `scripts/xr-probe.mjs` in the emulator at the shop row, Quest tier, per eye:

| | Before | After (default) | After (`xrlite=1`) |
|---|---|---|---|
| Scene draw calls | 307 | 114 | 52 |
| Sun shadow draw calls | 316 every other frame | 56 every other frame | none |
| Triangles | 1.34M | 325k | 143k |

- **Instancing proxies** (`src/xr/proxies.ts`): in the headset, every distinct plant, grass, tree
  and rock instancing is one world-space InstancedMesh filled with only the instances around the
  rider (z-sorted, range-searched, refilled every 0.75 m). That gives per-instance tree LOD
  (leaf-card heroes within 16 m, lobed trees to 72 m), and grass and flowers within 17 m that
  shrink into the ground at the edge instead of popping. Trees fade the same way at their edge.
- The bike, basket load and bouquet (about 130 small meshes) merge into a handful on the Quest
  tier; her shadow is dropped there (about 60 small shadow draws).
- Lighter cumulus lobes and distant ridges on the Quest tier (they are 400 m to 2 km away).
- No scene shader recompiles on entering VR in any tier: headset frames before the XR target is
  bound are skipped (the lite tier was compiling 29 sRGB variants on its first frame).
- `xrlite=1` is now a much lighter fallback: no sun shadow, smaller radii, 160 m view distance,
  0.75 framebuffer scale.
- Sound feedback: a soft rattle when a hand takes the bars, a glass furin chime when you take the
  sun or poke the wrist menu.
- Seated calibration waits for frames with a real viewer pose (the first frames of a session may
  have none), and the wrist menu knows a hand is on the bars while paused.
- `scripts/xr-reel.mjs`: demo footage without a headset. The guided ride in the emulator with
  scripted, eased hands, captured frame by frame at 30 fps into H.264 clips, plus the game's own
  soundtrack recorded in real time; shot list, cut and voiceover in `media/xr-reel/SHOTLIST.md`.
- Multiview (OVR_multiview2) is not available: three.js only implements it in its WebGPU renderer,
  and this game's GLSL shader materials need the WebGL renderer.

## 2026-09-27: Summer Cycle VR, phase 1

### A seated ride in the headset
- **Enter VR** from the start screen or the corner button (Quest Browser, WebXR `immersive-vr`,
  `local` reference space). The player sits on the bike in first person; her body leaves the view,
  her shadow stays on the road.
- **Seated rig**: the head pose is calibrated onto the rider's eye point, so any chair height works.
  The rig follows the bike's position and heading only: the horizon never tilts or bobs, and the
  bike stays upright under you (no lean). The handlebars, basket and bouquet are a fixed reference
  in the lower view. Quest recenter and the menu's **Recenter view** both recalibrate.

### Hands first (no controllers needed)
- **Hold the bars**: rest a hand near a grip and it holds it (no gesture to learn). Holding rides;
  letting go coasts gently to a stop.
- **Steer** by turning the bars about the stem, with either or both hands.
- **Brake** by pinching thumb and index finger on the bars (analog).
- **Ring the bell** by touching it with the left thumb or a fingertip.
- **Drag the sun**: reach up, pinch the little sun on its arc and pull it down toward the hills. The
  light, sky, lamps and fireflies follow continuously from afternoon through golden hour and
  sunset to dusk.
- **Wrist menu**: turn the left palm toward your face; poke with the right index finger. Pause or
  resume, Comfort on or off, Pace, Recenter view, Restart the ride, Frame rate readout, Leave VR.
- **Pause and resume with hands only**: the menu pauses; a pinch resumes. The Quest system menu
  (session visibility) pauses too and waits for a pinch, so the ride never moves off on its own.
- Cel-shaded hands drawn from the 25 tracked joints (four instanced draws, ink hull included).
- Optional controllers: hold the grip button to ride, stick steers, trigger brakes and grabs the
  sun, A or X rings the bell.

### Comfort
- Rider-controlled speed with gentle ramps (Pace: gentle 4.2 m/s, breezy 6 m/s), never backward.
- Turn vignette: a head-locked darkening at the edge of view while turning or changing speed.
- **Comfort mode** (on by default): gentle pace only, softer steering, stronger lane keeping and a
  stronger vignette.
- Every interaction sits within about 60 cm of the seated player; prompts sit in a narrow cone
  above the basket.

### A complete ride in about four minutes
- A guided ride from the opening spot, one lap of the valley and on to the red torii of the little
  shrine (about 770 m): hold the bars, brake, bell, drag the sun, then ride. Washi cards float over
  the basket with each prompt.
- The ending: she rolls to a stop at the torii, dusk comes in, the lanterns light, fireflies rise and
  the temple bell sounds. Then ride on freely, or restart from the menu.

### Headset render path (Quest tier)
- No MRT, ink, paint filter, bloom, grade pass or paddy mirror in the headset: the scene draws
  straight into the XR framebuffer. Every scene shader was wrapped once so it can apply the warm
  grade (tint, saturation, split tone, shoulder) and the sRGB encode itself; the desktop path is
  unchanged.
- The XR render target is created with a linear colour space, so the headset reuses every desktop
  shader program: entering VR compiles only the handful of new XR UI materials.
- Quest: 1024 shadow map over a smaller area, refreshed every other frame with the lobed distant
  trees as casters; fine detail drops out sooner; chunks beyond 240 m are hidden; lobed trees
  everywhere; framebuffer scale 0.85; fixed foveation; 72 Hz target; 4x MSAA on the XR layer.
  URL overrides for on-device tuning: `xrscale`, `xrfov`, `xrfar`, `xrshadow`, `xrtrees=hero`,
  `xrlite=1`, `xrfps=1` (head-locked frame rate and draw call readout, also in the wrist menu).

### Fixes needed for WebXR
- Render layers 1 and 2 are used by three.js for the left and right eye: the shadow and reflection
  layers moved to 3 and 4, so shadow-only meshes no longer appear in one eye.

### Tooling
- `pnpm dev` + `?xremu=1`: Meta's IWER emulates a Quest 3 with tracked hands in a desktop browser
  (`&devui=1` for the IWER panel, `&stereo=1` for both eyes, `&xrtier=quest` for the Quest tier).
  Dev only; not in the production build.
- `scripts/xr-shots.mjs`: walks the whole guided ride with scripted hands in the emulator, checks
  each step, and saves the headset view to `shots/xr/` with a JSON report.
- `scripts/xr-probe.mjs`: draw call and triangle budget probe for the headset tier.

### Copy
- Page description and README describe the look without naming any studio.
