# Changelog

Summer Cycle existed before the Meta VR Start Developer Competition 2026 as a desktop browser game
(first public release on GitHub Pages, `master` up to commit `8b977ba`). Everything below was added
during the competition window, from 27 September 2026, on the `webxr-hands` branch. It is the
"significant update" for the Adapted / Significantly Updated Experience division.

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
