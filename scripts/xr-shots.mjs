#!/usr/bin/env node
/**
 * Headset verification in Meta's IWER emulator (Quest 3, simulated hands), no headset needed.
 * Needs `pnpm dev` (port 5421). Walks the guided ride with scripted hands and saves the headset
 * view (one eye) to shots/xr/, plus a JSON report: state checks, shader programs before / after
 * entering VR (no recompiles expected), draw calls, frame rate and console errors. The first 14
 * checks are the original walkthrough; the rest cover the ghost-hand lessons, hands lost and found
 * mid-ride, and the end card.
 *   node scripts/xr-shots.mjs [--url=http://localhost:5421/] [--tier=quest] [--out=dir] [--level=0..3]
 * --level pins an adaptive quality level for the whole walk (?xradapt=0, then forced).
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const URL = arg("url", "http://localhost:5421/");
const OUT = path.resolve(ROOT, arg("out", "shots/xr"));
const TIER = arg("tier", "quest");
const LEVEL = arg("level", "");
const W = 1600, H = 1000;

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const report = { checks: [] };
/** `added` marks the checks beyond the original 14-step walkthrough. */
const check = (name, pass, detail, added = false) => {
  report.checks.push({ name, pass, detail, added });
  console.log(`${pass ? "PASS" : "FAIL"}${added ? " +" : ""} ${name}: ${JSON.stringify(detail)}`);
};
/** The ghost hint showing at each lesson (checked together near the end). */
const hints = {};
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/warning X\d{4}|GPU stall|Automatic fallback/.test(t)) return;
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${t}`);
  });
  const R = (fn, a) => page.evaluate(fn, a);
  const wait = (ms) => page.waitForTimeout(ms);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 92 });

  await page.goto(`${URL}?xremu=hands&xrtier=${TIER}&fs=0&xrfps=1${LEVEL ? "&xradapt=0" : ""}`);
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 180000 });
  await wait(600);
  await shot("00-loader-enter-vr");
  const progBefore = await R(() => window.__ride.post && window.__rideRenderer?.info.programs.length);
  // Enter VR from the loader button (a real click: the session needs a user gesture).
  await page.click("#xr-enter");
  await page.waitForFunction(() => window.__ride.xr.state.presenting, null, { timeout: 20000 });
  check("session starts from the loader button", true, await R(() => window.__ride.xr.state));
  if (LEVEL) await R((l) => window.__ride.xr.mode.adaptive.force(l), Number(LEVEL));

  // Head: seated, eyes 1.2 m above the local origin, looking ahead and a little down.
  const head = (pitchDeg, yawDeg = 0) =>
    R(([p, y]) => {
      const d = window.__xrdev;
      d.position.set(0, 1.2, 0);
      const a = (p * Math.PI) / 360, b = (y * Math.PI) / 360;
      // yaw (Y) then pitch (X)
      const cy = Math.cos(b), sy = Math.sin(b), cp = Math.cos(a), sp = Math.sin(a);
      d.quaternion.set(sp * cy, cp * sy, -sp * sy, cp * cy);
    }, [pitchDeg, yawDeg]);
  await head(-18);
  await wait(300);
  await R(() => window.__ride.xr.mode.session.recenter());
  await wait(400);

  // Place a hand so a feature point lands on a bike-space target: iterate on the measured error.
  const aim = async (side, target, feature = "palm", pose = "default", pinch = 0) => {
    for (let i = 0; i < 5; i++) {
      await R(
        ([side, target, feature, pose, pinch]) => {
          const d = window.__xrdev, m = window.__ride.xr.mode;
          const hin = d.hands[side];
          hin.poseId = pose;
          hin.updatePinchValue(pinch);
          const h = m.hands[side];
          if (!h.tracked) {
            hin.position.set(side === "left" ? -0.25 : 0.25, 0.8, -0.4);
            return;
          }
          const THREE = window.__THREE;
          const root = window.__ride.xrRoot;
          const want = root.localToWorld(new THREE.Vector3(...target));
          const have = feature === "palm" ? h.palm : feature === "index" ? h.indexTip : feature === "thumb" ? h.thumbTip : h.pinchPoint;
          const dw = want.sub(have);
          // World delta -> reference-space delta (undo the rig and calibration rotation).
          const q = new THREE.Quaternion();
          m.session.offset.getWorldQuaternion(q);
          dw.applyQuaternion(q.invert());
          hin.position.set(hin.position.x + dw.x, hin.position.y + dw.y, hin.position.z + dw.z);
        },
        [side, target, feature, pose, pinch],
      );
      await wait(120);
    }
  };
  const handRot = (side, x, y, z, w) => R(([s, q]) => window.__xrdev.hands[s].quaternion.set(...q), [side, [x, y, z, w]]);
  // Palms down on the bars.
  await handRot("left", -0.5, 0.5, 0.5, 0.5);
  await handRot("right", -0.5, -0.5, -0.5, 0.5);
  await aim("left", [-0.9, 0.95, -0.5]);
  await aim("right", [0.9, 0.95, -0.5]);
  await wait(800);
  await shot("01-start-card");
  const s0 = await R(() => window.__ride.xr.state);
  check("guide opens on 'hold'", s0.step === "hold", s0);
  const progAfter = await R(() => window.__rideRenderer.info.programs.length);
  report.programs = { beforeEnter: progBefore, afterEnter: progAfter };
  // Ghost hands settle onto the grips (they loop, fading out between passes).
  const ghostOn = await page.waitForFunction(() => window.__ride.xr.mode.ghost.group.visible, null, { timeout: 4000 }).then(() => true, () => false);
  await wait(450);
  hints.hold = await R(() => window.__ride.xr.state.hint);
  check("ghost hands show how to hold the bars", ghostOn && hints.hold === "hold", { visible: ghostOn, hint: hints.hold }, true);
  await shot("01b-ghost-hold");

  // Hands on the grips.
  await aim("left", [-0.29, 1.05, -0.17]);
  await aim("right", [0.29, 1.05, -0.17]);
  await wait(1500);
  const s1 = await R(() => window.__ride.xr.state);
  check("both hands hold the grips", s1.held[0] && s1.held[1], s1);
  await shot("02-hands-on-bars");
  await wait(4000);
  const s2 = await R(() => ({ ...window.__ride.xr.state, speed: window.__ride.ctl.speed }));
  check("holding the bars rides (gentle ramp)", s2.speed > 1 && s2.speed < 5, s2);
  hints.brake = s2.hint;
  await shot("03-riding-brake-card");

  // Steer: turn the bars left (right hand forward, left back) and check the steer sign.
  await aim("left", [-0.28, 1.05, -0.1]);
  await aim("right", [0.27, 1.05, -0.26]);
  await wait(500);
  const s3 = await R(() => ({ steer: window.__ride.xr.state.steer, yawRate: window.__ride.ctlYawRate }));
  check("turning the bars left steers left", s3.steer > 0.2, s3);
  await shot("04-turning-vignette");
  await aim("left", [-0.29, 1.05, -0.17]);
  await aim("right", [0.29, 1.05, -0.17]);

  // Brake: pinch on the right grip.
  await aim("right", [0.29, 1.05, -0.17], "palm", "pinch", 1);
  await wait(900);
  const s4 = await R(() => ({ brake: window.__ride.xr.state.brake, speed: window.__ride.ctl.speed, hint: window.__ride.xr.state.hint }));
  check("pinch brakes", s4.brake > 0.5, s4);
  check("the brake lesson's ghost pinch stops once she has braked", hints.brake === "brake" && s4.hint !== "brake", { before: hints.brake, after: s4.hint }, true);
  await aim("right", [0.29, 1.05, -0.17], "palm", "default", 0);

  // Wait for the bell card, then touch the bell with the left thumb.
  await page.waitForFunction(() => window.__ride.xr.state.step === "bell", null, { timeout: 20000 });
  await wait(600);
  hints.bell = await R(() => window.__ride.xr.state.hint);
  await shot("05-bell-card");
  const bell = await R(() => {
    const THREE = window.__THREE;
    const v = window.__ride.bike.bellWorld(new THREE.Vector3());
    return window.__ride.xrRoot.worldToLocal(v).toArray();
  });
  await aim("left", bell, "thumb");
  await wait(400);
  await shot("06-bell-ring");
  await page.waitForFunction(() => window.__ride.xr.state.step === "sun", null, { timeout: 5000 }).catch(() => {});
  const s5 = await R(() => window.__ride.xr.state);
  check("touching the bell rings it and advances the guide", s5.step === "sun", s5);
  await aim("left", [-0.29, 1.05, -0.17]);

  // Sun: reach up with the right hand, pinch the sun, drag it down to the left (sunset).
  await head(10, 12);
  await wait(500);
  const arc = (s) => R((s) => window.__ride.xrArc(s), s);
  await aim("right", await arc(0), "pinch", "default", 0);
  await wait(300);
  hints.sun = await R(() => window.__ride.xr.state.hint);
  await shot("07-reach-for-sun");
  await aim("right", await arc(0), "pinch", "pinch", 1);
  for (const s of [0.4, 0.8, 1.2]) await aim("right", await arc(s), "pinch", "pinch", 1);
  await wait(400);
  await head(0, -8);
  await shot("08-drag-sun-golden");
  for (const s of [1.6, 2.0, 2.2]) await aim("right", await arc(s), "pinch", "pinch", 1);
  await wait(500);
  const s6 = await R(() => window.__ride.xr.state);
  check("dragging the sun scrubs the time of day", s6.sun > 1.6, s6);
  await aim("right", await arc(2.2), "pinch", "default", 0);
  await head(-6, -10);
  await wait(600);
  await shot("09-sunset-after-drag");
  await aim("right", [0.29, 1.05, -0.17]);
  await head(-18);
  const sm = await R(() => window.__ride.xr.state);
  hints.palm = sm.hint;

  // Wrist menu: left hand off the bars, palm toward the face; poke "Pause" with the right index.
  await handRot("left", 0.0, 0.707, 0.707, 0.0);
  await aim("left", [-0.08, 1.2, -0.12]);
  await wait(700);
  let s7 = await R(() => window.__ride.xr.state);
  if (!s7.menu) {
    for (const q of [[0.5, 0.5, 0.5, 0.5], [0.707, 0, 0, 0.707], [0, 0, 0.707, 0.707], [-0.707, 0, 0, 0.707], [0.5, -0.5, -0.5, 0.5], [0, 0.707, -0.707, 0], [0.707, 0, 0.707, 0], [0, 0, -0.707, 0.707]]) {
      await handRot("left", ...q);
      await wait(300);
      s7 = await R(() => window.__ride.xr.state);
      if (s7.menu) {
        report.menuQuat = q;
        break;
      }
    }
  }
  check("palm toward the face opens the wrist menu", s7.menu, s7);
  check("the menu lesson follows the sun and ends when the menu opens", sm.step === "menu" && s7.step === "ride", { before: sm.step, after: s7.step }, true);
  await head(-28, -12);
  await wait(500);
  await shot("10-wrist-menu");
  // Poke the first row (Pause).
  const row = await R(() => window.__ride.xrMenuRow(0));
  if (row) {
    await aim("right", row.front, "index", "point", 0);
    await wait(200);
    await aim("right", row.through, "index", "point", 0);
    await wait(400);
  }
  const s8 = await R(() => window.__ride.xr.state);
  check("poking Pause pauses (hands only)", s8.paused, s8);
  await head(-6);
  await aim("left", [-0.29, 1.05, -0.17]);
  await aim("right", [0.29, 1.05, -0.17], "palm", "default", 0);
  await wait(600);
  await shot("11-paused");
  // Resume with a pinch.
  await aim("right", [0.29, 1.05, -0.17], "palm", "pinch", 1);
  await wait(300);
  await aim("right", [0.29, 1.05, -0.17], "palm", "default", 0);
  await wait(300);
  const s9 = await R(() => window.__ride.xr.state);
  check("a pinch resumes", !s9.paused, s9);

  // Headset visibility (system menu): pause, and stay paused until a pinch.
  await R(() => window.__xrdev.updateVisibilityState("visible-blurred"));
  await wait(400);
  const sv = await R(() => window.__ride.xr.state);
  await R(() => window.__xrdev.updateVisibilityState("visible"));
  await wait(400);
  const sv2 = await R(() => window.__ride.xr.state);
  check("system menu (visibility) pauses and stays paused until a pinch", sv.paused && sv2.paused, { blurred: sv.paused, back: sv2.paused });
  await aim("right", [0.29, 1.05, -0.17], "palm", "pinch", 1);
  await wait(300);
  await aim("right", [0.29, 1.05, -0.17], "palm", "default", 0);

  // Hand tracking lost mid-ride (both hands leave the session), then found again.
  await aim("left", [-0.29, 1.05, -0.17]);
  await wait(1500);
  const ride0 = await R(() => window.__ride.ctl.speed);
  await R(() => {
    window.__xrdev.hands.left.connected = false;
    window.__xrdev.hands.right.connected = false;
  });
  await wait(1600);
  const lost = await R(() => ({ ...window.__ride.xr.state, speed: window.__ride.ctl.speed }));
  await shot("11b-hands-lost");
  check("hands lost mid-ride: a card at eye level, the bike coasts", lost.notice === "lost" && !lost.held[0] && !lost.held[1] && !lost.hands[0] && !lost.hands[1] && lost.speed < ride0, { ride0, lost }, true);
  await R(() => {
    window.__xrdev.hands.left.connected = true;
    window.__xrdev.hands.right.connected = true;
  });
  await wait(400);
  await aim("left", [-0.29, 1.05, -0.17]);
  await aim("right", [0.29, 1.05, -0.17]);
  await wait(900);
  const back = await R(() => window.__ride.xr.state);
  check("hands found again: the card clears and they hold the bars", back.notice === "" && back.held[0] && back.held[1] && back.hands[0] && back.hands[1], back, true);

  // Jump ahead to the approach, then ride into the ending.
  await R(() => {
    const r = window.__ride;
    r.xr.mode.guide.step = "ride";
    r.place(-0.9, -170 - 640 + 640, 4);
    r.xr.skip(772 - 16);
  });
  await head(-8);
  await page.waitForFunction(() => window.__ride.xr.state.step === "arrive", null, { timeout: 30000 }).catch(() => {});
  await wait(7000);
  const s10 = await R(() => ({ ...window.__ride.xr.state, speed: window.__ride.ctl.speed }));
  check("arrival: stops at the torii and dusk comes", s10.step === "arrive" && s10.speed < 0.5, s10);
  // Hands back in the lap: she stays at the torii (hands on the bars would ride on).
  await R(() => {
    for (const s of ["left", "right"]) window.__xrdev.hands[s].position.set(s === "left" ? -0.2 : 0.2, 0.5, 0.1);
  });
  await head(-4, -35);
  await wait(500);
  await shot("12-arrival-dusk");
  await head(-10, 0);
  await page.waitForFunction(() => window.__ride.xr.state.end, null, { timeout: 8000 }).catch(() => {});
  await wait(900);
  await shot("13-end-card");
  const se = await R(() => window.__ride.xr.state);
  check("the end card appears after the arrival", se.end === true && se.step === "arrive", se, true);
  hints.end = se.hint;
  // Ride again: the right index pokes the left tag.
  const tag = await R(() => window.__ride.xrEndButton("again"));
  if (tag) {
    await aim("right", tag.front, "index", "point", 0);
    await wait(200);
    await aim("right", tag.through, "index", "point", 0);
    await wait(250);
  }
  const fading = await R(() => window.__ride.xr.state.fade);
  await page.waitForFunction(() => {
    const s = window.__ride.xr.state;
    return s.step === "hold" && s.fade < 0.05;
  }, null, { timeout: 8000 }).catch(() => {});
  const sa = await R(() => window.__ride.xr.state);
  check("Ride again fades out and restarts the ride in the afternoon", fading > 0 && sa.step === "hold" && sa.sun < 0.05 && !sa.end, { tag: !!tag, fading, step: sa.step, sun: sa.sun, end: sa.end }, true);
  await shot("13b-ride-again");
  check("each lesson shows its ghost hint", hints.hold === "hold" && hints.brake === "brake" && hints.bell === "bell" && hints.sun === "sun" && hints.palm === "palm", hints, true);

  const perf = await R(() => window.__ride.xr.state);
  report.perf = { fps: perf.fps, calls: perf.calls, note: "desktop GPU running the emulator; not Quest numbers" };
  report.programs.endOfSession = await R(() => window.__rideRenderer.info.programs.length);
  check("no shader compiles during the whole session (lessons, ghost hands, sunset glow, end card)", report.programs.endOfSession === progBefore, report.programs, true);
  // Leave VR through the menu's last row.
  await R(() => window.__ride.xr.mode.session.exit());
  await wait(1500);
  const s11 = await R(() => ({ presenting: window.__ride.xr.state.presenting, fps: window.__ride.fps }));
  check("leaving VR returns to the desktop ride", !s11.presenting, s11);
  await shot("14-back-on-desktop");
} catch (e) {
  errors.push(`script: ${e.stack || e}`);
} finally {
  report.errors = errors;
  report.level = LEVEL || "adaptive";
  await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const orig = report.checks.filter((c) => !c.added), more = report.checks.filter((c) => c.added);
  console.log(`walkthrough ${orig.filter((c) => c.pass).length}/${orig.length}, added ${more.filter((c) => c.pass).length}/${more.length} (level ${report.level})`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 20)) console.log("  " + e);
  await browser.close();
}
