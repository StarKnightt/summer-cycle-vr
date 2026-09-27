# Summer Cycle VR: demo footage and a two-minute cut

All headset footage was captured in Meta's IWER emulator (Quest 3 profile, Quest graphics tier,
one eye, 1920x1080, no dev UI, no frame rate readout) by `scripts/xr-reel.mjs`, one simulated
frame at a time at 30 fps. Hands are scripted but tracked through the real hand-tracking path:
the game sees 25 joints per hand exactly as it would on a Quest. Nothing is composited.

Re-capture: `pnpm dev`, then `node scripts/xr-reel.mjs` (all clips, then the soundtrack), or
`--only=ride|desktop|stereo|audio`, `--from=06 --to=06` for one clip. Clips are H.264, yuv420p,
30 fps, CRF 17 (edit masters; they are gitignored).

## Clips

| # | File | Length | What happens |
|---|---|---|---|
| 1 | `01-enter-vr.mp4` | 5.7 s | The washi start screen, the Enter VR button is pressed, the ride opens in the headset with the first card: "Rest both hands on the handlebars to ride". |
| 2 | `02-grab-bars-ride-off.mp4` | 6.9 s | Looking down at the bars; both hands come up from the lap and settle on the grips, the rings glow, she rolls off. The card changes to the brake tip. |
| 3 | `03-steering-through-village.mp4` | 12.2 s | Gentle steering through the row of old wooden shops, head glancing at the houses and the paddies. |
| 4 | `04-brake-pinch.mp4` | 6.0 s | Thumb and finger pinch on the bars, the bike slows, the pinch opens, she rides on. |
| 5 | `05-bell-ring.mp4` | 5.2 s | The left thumb flicks the bell dome; the striker flicks and the guide moves on. |
| 6 | `06-reach-and-drag-sun.mp4` | 29.0 s | Hero shot. Afternoon light, a glance up, the right hand leaves the bar, reaches up and pinches the little sun, then pulls it slowly down its arc toward the hills while the sky goes gold, then pink; the hand comes home and we watch the sunset. |
| 7 | `07-wrist-menu-pause-resume.mp4` | 10.0 s | The left palm turns toward the face, the washi menu opens, the right index pokes Pause, the Paused card appears, hands back on the bars, a light pinch resumes. |
| 8 | `08-comfort-toggle-vignette.mp4` | 18.0 s | A turn with Comfort on (the soft vignette closes in at the edges), the menu toggles Comfort off, the same turn with a lighter vignette, and Comfort back on. |
| 9 | `09-arrival-at-shrine-dusk.mp4` | 22.0 s | The last stretch at dusk: "Nearly there", she rolls to a stop at the red torii, hands come off the bars, a look at the torii, the stone lanterns and jizo, up at the first stars, back to "The end of summer". |
| 10 | `10-desktop-before.mp4` | 7.0 s | The original desktop game (chase camera, autoplay) for a "before" shot. |
| 11 | `11-stereo-both-eyes.mp4` | 3.2 s | Both eyes side by side, hands on the bars, riding. |

Soundtrack: `audio-ride-bed.m4a` (95 s, AAC 192k) is the game's own real-time Web Audio output
from a desktop ride: tyres, chain, cicadas, birds, water, with cues in `audio-ride-bed.cues.json`:
bike bell 0:06, bars rattle (the sound when a hand takes the bars) 0:14, glass furin chime (taking
the sun, poking the menu) 0:20, the light turns golden 0:30, sunset 0:45, dusk 0:60 (evening
cicadas), temple bell 1:08. The video clips are silent: the virtual clock that makes them smooth
can't drive the audio thread, so lay this bed under the cut and nudge the bell and furin cues onto
the matching frames.

## Proposed cut (about 2:00)

| Time | Clip (in / out) | Beat | Judging criteria |
|---|---|---|---|
| 0:00 to 0:06 | 10, 0:00 to 0:06 | Where it started: the desktop game. | Adapted experience (context) |
| 0:06 to 0:12 | 1, whole | Enter VR from the start screen. | Polish (fast start, one button) |
| 0:12 to 0:19 | 2, whole | Hands onto the bars, ride off. No controllers. | Experience design (hands first, seated); Technical (hand tracking) |
| 0:19 to 0:29 | 3, 0:01 to 0:11 | Steering through the shop row. | Experience design (comfort: level horizon, gentle speed, bars as a fixed reference) |
| 0:29 to 0:34 | 4, 0:00.5 to 0:05.5 | Pinch to brake. | Technical (gesture detection) |
| 0:34 to 0:39 | 5, whole | The bell. | Polish (sound, small delight) |
| 0:39 to 1:06 | 6, 0:01.5 to 0:28.5 | Reach up and pull the sun down: afternoon to sunset. | Innovation (the headline interaction); Polish (art direction) |
| 1:06 to 1:14 | 7, 0:01 to 0:09 | Wrist menu, pause and resume with hands only. | Experience design (every step hands only) |
| 1:14 to 1:24 | 8, 0:00 to 0:10 | Comfort mode and the turn vignette. | Experience design (comfort) |
| 1:24 to 1:27 | 11, whole | Both eyes, running on the Quest tier. | Technical (the 60 to 72 fps work) |
| 1:27 to 1:50 | 9, 0:00 to 0:23 | The shrine at dusk, the end of summer. | Polish (a complete moment in a few minutes) |
| 1:50 to 2:00 | title card (make in the editor) | "Summer Cycle. Seated, hands only, in Quest Browser." and the URL. | |

If a shorter cut is needed (about 1:30), drop the comfort clip to 5 s, the steering clip to 6 s
and the stereo beat.

## Voiceover (Prasenjit, about 2:00, calm and unhurried)

**0:00** I made Summer Cycle earlier this year as a small browser game. A bike ride down a
Japanese country road at the end of summer. Everything in it is made in code: the trees, the
signs, the sounds.

**0:07** For this competition I wanted to see if it could be a place you sit in, not a game you
watch. So it opens in Quest Browser. One button, and you're on the bike.

**0:13** There are no controllers. You just rest your hands on the handlebars and she starts to
ride.

**0:20** You steer by turning the bars. The horizon never tilts, the speed stays gentle, and the
bike stays in view the whole time, so your body has something steady to hold on to.

**0:29** Pinch your fingers to brake. Let go of the bars and you coast to a stop.

**0:34** And of course there's a bell.

**0:39** This is the part I'm happiest with. The sun sits on a little arc just above you. You reach
up, pinch it, and pull it down toward the hills, and the whole valley follows you from afternoon
into sunset. I wanted it to feel like you're holding the light.

**1:06** Everything else is hands too. Turn your palm toward your face for a small menu. Pause,
comfort settings, recenter. A pinch to carry on.

**1:14** Comfort mode is on by default. It slows things down and softens the edges of your view
when you turn.

**1:24** I don't own a headset, so I built all of this in Meta's emulator and spent a lot of time
on the numbers, cutting the headset version down to around a hundred draw calls per eye so it
has a real chance of holding frame rate on a Quest.

**1:28** The ride ends at a little shrine at dusk. The lanterns come on, fireflies drift over the
grass, and a temple bell rings somewhere far away. That's the whole thing. About four minutes, and
you never have to stand up.

**1:50** Summer Cycle. Thanks for riding.

## Known footage quirks

- The emulator's hand model: IWER's "relaxed" pose has fairly straight, spread fingers, so hands
  resting on the grips lie flat rather than curling around them. On a Quest, real hands will look
  like real hands.
- In `07`, the right hand passes close to the camera on its way to the menu and briefly fills the
  upper frame (about 0.5 s around 0:03); trim or speed-ramp it if it distracts.
- In `06`, the first second rides along the tall verge plants on the left; start the cut at
  0:01.5 as proposed.
- The frame rate readout is off in all clips; the Quest numbers in the voiceover come from
  `scripts/xr-probe.mjs` in the emulator, not from a device.
