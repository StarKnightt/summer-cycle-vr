# Summer Cycle VR: voiceover v4 (hands first, about 1:55)

Why a new cut: Meta's tip is to show hands-first gameplay in the first 30 seconds. The v3 video
opened on the desktop game and had a voice slip at 0:19. This order puts the hands, steering,
brake, bell and the sun pull in the first 50 seconds, then gives the context.

## How to record

- Read calmly and unhurried, like you're showing a friend. Leave about 2 seconds of silence
  between lines so they're easy to cut.
- Quiet room, phone or mic about a hand's width from your mouth, no music or fan.
- One file is fine (WAV or M4A). If a line goes wrong, just say it again; I keep the best take.
- Put the file in `F:\ghibli-ride-xr\media\xr-reel\voice\` (any name).

## Lines (the clip each one plays over)

**1. (0:00, hands come up onto the bars)**
No controllers. You just rest your hands on the handlebars, and she starts to ride.

**2. (0:07, steering through the village)**
You steer by turning the bars. The horizon stays level and the speed stays gentle, so your body
always has something steady to hold on to.

**3. (0:16, pinch on the bars)**
Pinch your fingers to brake.

**4. (0:21, thumb on the bell)**
And of course, there's a bell.

**5. (0:26, reaching up to the sun)**
This is the part I'm happiest with. The sun sits on a little arc just above you. You reach up,
pinch it, and pull it down toward the hills, and the whole valley follows you from afternoon into
sunset.

**6. (0:50, the desktop game, then Enter VR)**
This is Summer Cycle. I made it earlier this year as a desktop browser game. For this competition
I turned it into a place you can sit in. It opens in Quest Browser. One button, and you're on the
bike.

**7. (1:00, palm up, the wrist menu)**
Everything else is hands too. Turn your palm toward you for a small menu. Pause, comfort,
recenter.

**8. (1:08, turning with the comfort vignette)**
Comfort mode is on by default. It softens the edges of your view when you turn.

**9. (1:14, hands off the bars)**
Let go of the bars, and she coasts to a stop and waits for you.

**10. (1:20, both eyes)**
I don't own a headset, so I built all of this in Meta's emulator, and spent a lot of time on
frame rate so it runs smoothly on a Quest.

**11. (1:28, the shrine at dusk)**
The ride ends at a little shrine at dusk. The lanterns come on, fireflies drift over the grass,
and a temple bell rings somewhere far away.

**12. (1:45, the end card)**
Ride again, or just keep riding. Summer Cycle. Seated, hands only, in Quest Browser. Thanks for
riding.

## Cut plan (clips from `scripts/xr-reel.mjs`)

| Time | Clip | Line |
|---|---|---|
| 0:00 | 02-grab-bars-ride-off | 1 |
| 0:07 | 03-steering-through-village | 2 |
| 0:16 | 04-brake-pinch | 3 |
| 0:21 | 05-bell-ring | 4 |
| 0:26 | 06-reach-and-drag-sun | 5 |
| 0:50 | 10-desktop-before, then 01-enter-vr | 6 |
| 1:00 | 07-wrist-menu-pause-resume | 7 |
| 1:08 | 08-comfort-toggle-vignette | 8 |
| 1:14 | 12-hands-lost-coast | 9 |
| 1:20 | 11-stereo-both-eyes, 06b-sunset-ride | 10 |
| 1:28 | 09-arrival-at-shrine-dusk | 11 |
| 1:45 | 13-end-card-ride-again, title card with the URL | 12 |

Under 2:00 total, well inside Meta's 3-minute limit. Soundtrack: the game's own audio bed
(`audio-ride-bed.m4a`), ducked under the voice, with the bell and temple bell on their frames.
