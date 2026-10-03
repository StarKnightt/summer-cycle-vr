# Summer Cycle VR: Devpost submission draft

Meta VR Start Developer Competition 2026. Track: **Entertainment**. Division: **Adapted / Significantly Updated Experience**.

> Notes for Prasenjit (delete this block before pasting):
> - Everything below the line is ready to paste into the Devpost fields. Section headings match Devpost's standard ones.
> - The VR build lives on the `webxr-hands` branch. The judges' link must point at a deployed build that includes it (GitHub Pages from `master`, or a separate Pages/Vercel deploy), and it has to stay up until the winners are announced (around Dec 11, 2026).
> - Optional sentences are marked **[optional]**. Keep or cut them.
> - The screenshots in `shots/xr` show the `?xrfps=1` readout (for example "400 fps"). That number is the emulator on a desktop GPU, not a Quest. Either re-capture without the readout or crop it, so nobody reads it as a headset frame rate.
> - If you get time on a real Quest before the deadline, replace the "not yet measured on a headset" lines with real numbers.

---

## Name

**Summer Cycle VR**

## Tagline

Sit back, rest your hands on the handlebars, and ride a painted summer country road into dusk.

(Short alternative: *A seated, hands-only bike ride to the end of summer.*)

## Inspiration

Earlier this year I made Summer Cycle, a small desktop browser game: a bicycle ride down a Japanese country road on a late summer afternoon, drawn like a hand-painted animation background. There's no score and nothing to win. You ride past flooded rice paddies, a row of old wooden shops and power lines sagging over the road, and the sun goes down if you let it. Every tree, sign, cloud and sound is generated in code; the repo ships no image, model or audio files. I posted it on X and it reached around 66,000 views, and the replies kept saying the same thing: "I want to be there."

That's the part a flat screen can't give you. On a monitor you watch her ride. In a headset you could be the one sitting on the bike, with the bars in your hands and the cicadas all around you. So for this competition I set out to turn a game you watch into a place you sit in, for a few quiet minutes, on a sofa or in a plane seat.

## What it does

Summer Cycle VR is a seated, hands-only bike ride in Meta Quest Browser. One button on the start screen and you're on the saddle.

- **Rest your hands on the handlebars** and she rides. There is no gesture to learn: a hand near a grip holds it. Let go and the bike coasts gently to a stop.
- **Steer** by turning the bars, with one hand or both.
- **Pinch to brake**, thumb and index finger on the bars. It's analog, so a light pinch slows you a little.
- **Ring the bell** with your left thumb.
- **Pull the sun down.** A little sun sits on a faint arc just above you. Reach up, pinch it, and drag it toward the hills, and the whole valley follows your hand: the light goes gold, then pink, the lamps come on, stars appear and fireflies rise over the verges.
- **Wrist menu.** Turn your left palm toward your face and a small paper menu appears. Poke it with your right index finger: pause, comfort on or off, pace, recenter, restart, frame rate, leave VR. A pinch resumes.
- **A complete ride in about four minutes.** Paper cards over the basket teach each thing once, then a guided route takes you through the village and along the paddies to a little shrine with a red gate. You roll to a stop, dusk comes in, the stone lanterns light and a temple bell sounds somewhere far away. Then you can ride on freely for as long as you like.

It's lean-back entertainment: no fail state, no timer, gentle speed, a level horizon, and a soundscape of tyres, chain, cicadas, birds, water and wind chimes that follows what you do. Controllers work too, but you never need one.

## How we built it

It's plain three.js on WebXR (`immersive-vr`, `local` reference space, hand tracking), written in TypeScript and built with Vite. There's no engine and no asset pipeline; the only runtime dependency is `three`.

**The seated rig.** At the start of the session your head pose is calibrated onto the rider's eye point, so any chair height works. The rig follows the bike's position and heading only, so the horizon never tilts, bobs or leans. The handlebars, basket and bouquet stay fixed in the lower part of your view as a steady reference for your body.

**Hands.** Each frame I read the 25 tracked joints per hand and derive a few simple features: a palm point where a grip would sit, a pinch amount with hysteresis (on under 2 cm, off over 3.5 cm), and palm direction for the wrist menu. The hands are drawn cel-shaded from those joints in four instanced draws, ink outline included, so they match the painted world. Every interaction sits within about 60 cm of a seated player, and the prompts sit in a narrow cone above the basket, so nothing needs a wide field of view or a stretch.

**The sun dial.** The sun lives on an arc 46 cm from your eye. A pinch near it takes hold; the nearest point on the arc to your fingers sets a continuous time of day between four hand-tuned presets (about forty parameters each: sun angle, sky gradient, fog, shadow colour, grade, how many birds are in the air). The drag is eased so small tremors don't flicker the sky.

**A headset render path.** The desktop game gets its look from a heavy post chain: ink outlines, a paint filter, bloom, a colour grade, and a mirrored paddy reflection. None of that fits in a Quest's frame budget at stereo resolution. In the headset the scene draws straight into the XR framebuffer instead, and I wrapped every scene shader once so it applies the warm grade and sRGB encoding itself. Because the XR target uses a linear colour space, the headset reuses every compiled desktop shader: entering VR compiles only a handful of small UI materials.

**Performance on a mobile GPU.** The desktop game drew about 540 calls a frame. For Quest I rebuilt how the scenery is submitted: every kind of plant, grass, tree and rock becomes one world-space instanced mesh filled only with the instances near the rider, refilled as you move, with per-instance level of detail. Grass and flowers shrink into the ground at the edge of the radius instead of popping. The bike and basket merge from about 130 meshes into a handful. Measured in the emulator at the shop row, per eye, scene draw calls went from 307 to 114 and triangles from 1.34 million to 325,000; the sun shadow went from 316 draws to 56, every other frame. On top of that, adaptive quality watches real frame intervals and steps through four levels (smaller detail radii, less frequent or no shadow, shorter view distance, more foveation) and back up when there's headroom, without ever recompiling a shader. Detail eases in and out over about a second, so a change of level is hard to notice.

**Pause and resume.** The wrist menu pauses; a pinch resumes. When the Quest system menu covers the session (a WebXR visibility change), the ride pauses too and waits for a pinch, so it never moves off without you.

**Building without a headset.** I don't own a Quest, so I built all of it in Meta's IWER emulator, which runs a simulated Quest 3 with tracked hands in a desktop browser. That forced a useful discipline: Playwright scripts walk the whole guided ride with scripted hands, check every step, save the headset view, count draw calls and triangles per eye, and test the adaptive quality by injecting artificial frame cost. The demo video was captured the same way, frame by frame, with hands driven through the real hand-tracking path.

**[optional]** I built this with AI coding agents in Cursor (Claude Opus did much of the implementation), working in a builder and critic loop against rendered frames. I steered the design, the interactions and every trade-off.

## Challenges we ran into

- **No headset.** Every grab distance, every prompt position and every performance number came from the emulator. I leaned on automated checks and conservative choices (generous grab radii, a 72 Hz target, adaptive quality as a safety net) because I couldn't just put it on and look.
- **Losing the post chain without losing the look.** The painted feel of the desktop game comes mostly from post-processing, which the headset can't afford. Moving the grade into every shader kept the colour, but the ink outlines and paint filter are gone in VR for now, and I miss them.
- **Stereo in WebGL.** three.js only implements the multiview extension in its WebGPU renderer, and this game's custom GLSL materials need the WebGL renderer. So both eyes render the full scene, which is why the draw call work mattered so much.
- **Small WebXR surprises.** three.js uses render layers 1 and 2 for the left and right eyes, and my shadow and reflection layers were using the same numbers, so shadow-only meshes showed up in one eye. The first frames of a session can arrive without a viewer pose, which broke calibration until I waited for a real one.
- **Comfort.** Riding a bike in VR is forward motion you don't physically feel. I kept the speed rider-controlled with gentle ramps, never backward, the horizon level and the bars fixed in view, and added a turn vignette that darkens the edges while turning or changing speed.

## Accomplishments that we're proud of

- Pulling the sun down with your fingers. It's the moment I made this for, and it works exactly as I hoped: you hold the light in your hand and the whole valley answers.
- The whole experience, from the start screen to the shrine at dusk, works with hands alone, seated, inside a small radius.
- Cutting the headset scene to about a quarter of its original triangles and just over a third of its draw calls without it looking cut.
- Entering VR recompiles no scene shaders, so the ride opens without a hitch.
- It's still one self-contained web page with no downloaded assets. Everything you see and hear is made in code.

## What we learned

- Seated VR is mostly about what you take away. The bike doesn't lean, the camera doesn't bob, and the calm makes it better.
- Hands-first works best when there's nothing to learn: holding the bars is the control, not a gesture that stands for it.
- An emulator plus scripted checks gets you remarkably far, and it makes you measure things instead of guessing. It still isn't a headset, and I know the real test is on a Quest.
- On a mobile GPU in stereo, draw calls are the budget. Instancing and distance-based detail mattered far more than shader tweaks.

## What's next for Summer Cycle VR

- **Test on a real Quest 3 and 3S** and tune frame rate, grab distances and pinch sensitivity from real hands.
- **Bring the ink back** cheaply in the headset (outline hulls on houses and poles) and add a glow around the sun to replace the lost bloom.
- **More rides:** a morning ride with mist on the paddies, a rain ride, and a seaside road, each a few minutes long.
- **Target launch date:** the judges' build is live now. I plan a public web launch on **December 11, 2026**, the day winners are announced, as a free link that opens in Quest Browser. After that, an installable PWA listed on the Meta Horizon Store in **Q1 2027**.

## What's new in this update (Adapted division)

**Before September 24, 2026 (already existed):** Summer Cycle was a desktop browser game, publicly released on GitHub Pages. It had the painted world (one cel-shaded material specialised for 31 kinds of surface, ink outlines, a paint filter, mirror paddies), a 640 m looping road, four time-of-day presets on the T key, a fully synthesized soundscape, an on-foot mode, a pause menu, and keyboard and mouse controls. It ran at about 118 fps on a desktop GPU. It had no VR, no hand input and no guided ride. The last pre-competition commit is dated September 23, 2026.

**Added during the competition window** (full list in `CHANGELOG.md`, branch `webxr-hands`):

*September 27, 2026: VR, phase 1*
- A seated WebXR mode in Meta Quest Browser: Enter VR from the start screen, a calibrated seated rig with a level horizon and fixed handlebars in view.
- Hand interactions as a new feature: hold the bars to ride, turn them to steer, pinch to brake (analog), touch the bell, pinch and drag the sun to set the time of day continuously.
- A palm-up wrist menu (pause, comfort, pace, recenter, restart, frame rate, leave VR), and pause and resume by hand, including when the Quest system menu opens.
- Cel-shaded hands drawn from the 25 tracked joints. Optional controller support.
- Comfort: rider-controlled speed with two paces, a turn vignette, and a Comfort mode on by default.
- A guided four-minute ride with paper prompt cards, ending at the shrine at dusk with lanterns, fireflies and a temple bell.
- A Quest render path: the grade moved into the scene shaders, no post chain, a smaller shadow map every other frame, fixed foveation, a 72 Hz target, and no scene shader recompiles on entry.
- Emulator tooling: IWER in dev builds, a scripted walkthrough of the whole ride with 14 checks and screenshots, and a draw call and triangle probe.

*September 27, 2026: VR, phase 2 (Quest performance)*
- World-space instancing for all scenery with per-instance level of detail and fading edges, merged bike and basket meshes, lighter clouds and ridges. Per eye, in the emulator: 307 to 114 draw calls, 1.34M to 325k triangles; sun shadow 316 to 56 draws, every other frame. A lighter fallback (`?xrlite=1`) at 52 calls and 143k triangles.
- Sound feedback: a soft rattle when a hand takes the bars, a glass wind-chime note when you take the sun or poke the menu.
- A demo capture tool that records the hands-only ride in the emulator frame by frame.

*September 28, 2026: adaptive quality*
- Four quality levels chosen from measured frame times, with hysteresis, eased so detail fades rather than pops, and no shader recompiles. The current level shows in the wrist menu.
- Fixes: scenery now fills in before the bike first moves; calibration waits for a real head pose.

## How it maps to the judging criteria

**Innovation & Creativity.** The desktop game let you press T to change the time of day. In VR you reach up and pull the sun down yourself, and that only makes sense with hands in space: it's a physical gesture with a whole sky attached to it. The handlebars work the same way. They aren't a menu or a button, they're the thing you hold, so the controls are just riding a bike. And it's a world with no downloaded assets at all, painted entirely in code.

**Experience Design.** It's designed around a person sitting still. Everything is within about 60 cm of you and inside a narrow cone in front, so it fits an airplane seat and a narrower field of view. The first card asks you to rest your hands on the bars, and the ride teaches braking, the bell and the sun one at a time, right when you need them. It's a complete moment in about four minutes, it pauses cleanly by hand or from the system menu, and comfort mode is on by default. I didn't use passthrough on purpose: this is about being somewhere else for a few minutes, and your room wouldn't add to it.

**Technical Implementation.** Hand tracking is the only input the ride needs, read straight from the WebXR joints with hysteresis so a relaxed hand doesn't brake by accident. The render path was rebuilt for a mobile GPU in stereo: world-space instancing with per-instance detail, merged meshes, a half-rate shadow, the colour grade folded into the scene shaders, zero shader recompiles on entering VR, and four levels of adaptive quality as a safety net for the 72 Hz target. The numbers above were measured in the emulator; I haven't been able to measure them on a Quest yet, and I've tried to build enough headroom and fallback that it holds up when I do.

**Polish & Presentation.** The art direction carries over from the desktop game that people responded to: cel shading, hand-tuned light presets, fireflies at dusk. The hands are drawn in the same style as the world, the prompts are soft paper cards, and every sound, from the bell to the cicadas to the temple bell at the end, is synthesized and reacts to how you ride. The video is real footage from the emulator with nothing composited.

## Built with

`three.js` · `webxr` · `webxr-hand-input` · `typescript` · `glsl` · `web-audio-api` · `vite` · `iwer` (Immersive Web Emulation Runtime) · `playwright` · `ffmpeg` · `meta-quest-browser` · `github-pages` · `pnpm` · `cursor`

## Gallery captions

- **02-hands-on-bars.jpg**: Hands on the grips and she's riding. No controllers, no gesture to learn: resting a hand near a grip is enough.
- **08-drag-sun-golden.jpg**: Reach up, pinch the little sun and pull it down its arc. The light turns golden as your hand moves.
- **09-sunset-after-drag.jpg**: A little further down the arc and it's sunset. The sky, the paddies and the lamps all follow the sun in your fingers.
- **10-wrist-menu.jpg**: Turn your left palm toward you for the wrist menu: pause, comfort, pace, recenter, restart. A poke with the other hand chooses.
- **12-arrival-dusk.jpg**: The end of the guided ride: the shrine at dusk, the lanterns coming on and the first stars out.
- **15-stereo-both-eyes.jpg**: Both eyes on the Quest render tier, captured in Meta's IWER emulator.
- **04-turning-vignette.jpg**: The comfort vignette softly darkens the edges of your view while you turn, and the horizon stays level.

## Links

- Play (Quest Browser): *[judges' URL here]*
- Demo video (under 3 minutes): *[YouTube or Vimeo URL here]*
- Source: https://github.com/StarKnightt/summer-cycle
- Original desktop game: https://starknightt.github.io/summer-cycle/
- Me: Prasenjit Nayak, solo developer. X [@prasenx](https://x.com/prasenx), [prasen.dev](https://prasen.dev), GitHub [StarKnightt](https://github.com/StarKnightt)
