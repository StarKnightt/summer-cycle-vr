import * as THREE from "three";
import { G, REFL } from "../render/materials";
import type { SunShadow } from "../render/lightpasses";
import type { Rider } from "../rider/rider";
import type { Controller } from "../rider/controller";
import type { Input } from "../core/input";
import type { TimeOfDay } from "../world/timeofday";
import type { World } from "../world/chunks";
import type { RideAudio } from "../audio";
import { XRRide } from "./session";
import { Hands } from "./hands";
import { Bars } from "./bars";
import { SunDial } from "./sundial";
import { WristMenu } from "./menu";
import { FpsMeter, Vignette } from "./comfort";
import { Guide } from "./guide";
import { INK, Panel, text, washiCard } from "./ui";
import { XR_TIER } from "./tier";
import { Proxies } from "./proxies";
import { Adaptive, levels } from "./adaptive";
import { SunGlow, XR_LOOK } from "./look";
import { GhostHands, type Hint } from "./ghost";
import { EndCard, Fade } from "./ending";

export { installXrOutput } from "./grade";
export { XR_TIER, QUEST } from "./tier";

/** Where the guided ride starts (the desktop opening composition). */
const START_Z = -54;
/** Lessons whose start is worth a chime (the one before was just done). */
const CHIME_ON = new Set(["brake", "sun", "menu", "ride"]);
const PACES = [
  { name: "gentle", cruise: 4.2, accel: 0.55 },
  { name: "breezy", cruise: 6.0, accel: 0.8 },
];

interface Deps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  rider: Rider;
  ctl: Controller;
  input: Input;
  tod: TimeOfDay;
  world: World;
  audio: RideAudio;
  place: (u: number, z: number, speed: number) => void;
  onStart: () => void;
  onEnd: () => void;
}

/**
 * Everything the headset adds: the session and seated rig, tracked hands on the bars, the sun
 * dial, the wrist menu, comfort vignette, the guided ride and the stripped render path. The
 * desktop game runs exactly as before while no session is live.
 */
export class XRMode {
  readonly session: XRRide;
  readonly hands: Hands;
  readonly bars: Bars;
  readonly sun: SunDial;
  readonly menu: WristMenu;
  readonly vignette = new Vignette();
  readonly fps = new FpsMeter();
  readonly guide = new Guide();
  readonly glow = new SunGlow();
  readonly ghost = new GhostHands();
  readonly endCard = new EndCard();
  readonly fade = new Fade();
  /** "Can't see your hands" card (both hands gone for a moment, or none yet). */
  private notice: Panel;
  private noticeKind: "" | "lost" | "none" = "";
  private lostFor = [0, 0];
  private noHandsT = 0;
  private everHands = false;
  private cueAt = -10;
  /** Grip rings invite the hands back for a moment after they return. */
  private inviteT = 0;
  /** This ride: did the brake / the sun once (hints stop), time, bell rings (end card summary). */
  private braked = false;
  private sunTaken = false;
  private rideT = 0;
  private bells = 0;
  /** Ride again: 1 = fading out, 2 = restarted, fading in. */
  private again = 0;
  private bellLocal = new THREE.Vector3();
  readonly proxies: Proxies;
  readonly adaptive: Adaptive;
  private adaptiveOn = true;
  /** Sun shadow cadence for the current quality level (0 = off). */
  private shadowEvery: number = XR_TIER.shadow ? XR_TIER.shadowEvery : 0;
  /** Sun shadow strength, easing toward on / off over about a second (stale map meanwhile). */
  private shadowK = 1;
  /** World-space XR bits (grip rings, hands). */
  private worldGroup = new THREE.Group();
  private pauseCard: Panel;
  comfort = true;
  pace = 0;
  /** Paused from the wrist menu or by the headset (system menu); resume with a pinch. */
  paused = false;
  private pausedBySystem = false;
  private dist = 0;
  private lastSpeed = 0;
  private arriveT = -1;
  private started = false;
  readonly head = new THREE.Vector3();
  /** Draw calls of the last headset frame: sun shadow pass, and in total. */
  shadowCalls = 0;
  private frame = 0;
  private rideIn = { ride: false, steer: 0, brake: 0, cruise: 4.2, accel: 0.55, assist: 0.5 };

  constructor(private d: Deps) {
    const { renderer, scene } = d;
    this.session = new XRRide(renderer, {
      onStart: () => this.start(),
      onEnd: () => this.end(),
      onVisible: (v) => {
        if (!v) {
          this.pausedBySystem = true;
          this.setPaused(true);
        }
      },
    }, XR_TIER);
    this.hands = new Hands(renderer, this.session.offset);
    this.bars = new Bars(d.rider, this.worldGroup);
    this.worldGroup.add(this.hands.group);
    this.sun = new SunDial(d.tod);
    this.session.rig.add(this.sun.group, this.guide.group, this.ghost.group, this.endCard.group);
    this.session.cam.add(this.vignette.mesh, this.fps.panel.mesh, this.fade.mesh);
    this.notice = new Panel(0.4, 0.11, 1024, (g, w, h) => {
      if (!this.noticeKind) return;
      washiCard(g, w, h);
      const [title, body] = this.noticeKind === "lost" ? ["Your hands are out of view", "Hold them up in front of you to ride on"] : ["Where are your hands?", "Hold them up in front of you. Controllers work too."];
      text(g, title, w / 2, h * 0.36, 52, w * 0.86, INK, 400, 0.06);
      text(g, body, w / 2, h * 0.7, 38, w * 0.88, "rgba(58, 42, 34, 0.82)");
    });
    // At eye height, in the middle of the view (the guide's card sits lower, over the basket).
    this.notice.mesh.position.set(0, 1.43, -0.72);
    this.notice.mesh.renderOrder = 15;
    this.notice.opacity = 0;
    this.session.rig.add(this.notice.mesh);
    this.fps.panel.mesh.visible = XR_TIER.showFps;
    this.menu = new WristMenu([
      { label: () => (this.paused ? "Resume" : "Pause"), act: () => this.setPaused(!this.paused) },
      { label: () => `Comfort: ${this.comfort ? "on" : "off"}`, act: () => (this.comfort = !this.comfort) },
      { label: () => `Pace: ${PACES[this.pace].name}`, act: () => (this.pace = (this.pace + 1) % PACES.length) },
      { label: () => "Recenter view", act: () => this.session.recenter() },
      { label: () => "Restart the ride", act: () => this.restart() },
      { label: () => `Frame rate: ${this.fps.panel.mesh.visible ? "shown" : "hidden"} (${this.adaptive?.current.name ?? "L0"})`, act: () => (this.fps.panel.mesh.visible = !this.fps.panel.mesh.visible) },
      { label: () => "Leave VR", act: () => this.session.exit() },
    ]);
    // Sound feedback: a glass furin for menu pokes and taking the sun, a soft rattle on the bars.
    this.menu.onPoke = () => d.audio.trigger("furin");
    this.worldGroup.add(this.menu.group);
    this.pauseCard = new Panel(0.36, 0.12, 1024, (g, w, h) => {
      washiCard(g, w, h);
      text(g, "Paused", w / 2, h * 0.34, 60, w * 0.8, INK, 400, 0.1);
      text(g, "Pinch with either hand to ride on", w / 2, h * 0.68, 40, w * 0.86, "rgba(58, 42, 34, 0.82)");
    });
    this.pauseCard.mesh.position.set(0, 1.42, -0.62);
    this.pauseCard.mesh.renderOrder = 20;
    this.pauseCard.opacity = 0;
    this.session.rig.add(this.pauseCard.mesh);
    this.session.rig.visible = this.worldGroup.visible = false;
    this.proxies = new Proxies(d.world, XR_TIER.radii);
    this.adaptive = new Adaptive(levels(XR_TIER), (l) => {
      this.proxies.setDetail(l.radii, l.thin);
      d.world.setDetail(XR_TIER.cullK, l.far, XR_TIER.treeFar);
      this.shadowEvery = l.shadowEvery;
      renderer.xr.setFoveation(l.foveation);
      this.fps.level = l.name;
      this.fps.panel.redraw();
      this.menu.refresh();
    });
    // ?xradapt=0 pins L0 (scripted captures run on a 30 fps virtual clock).
    this.adaptiveOn = new URLSearchParams(location.search).get("xradapt") !== "0";
    const slow = Number(new URLSearchParams(location.search).get("xrslow"));
    if (Number.isFinite(slow) && slow > 0) this.adaptive.slow = slow;
    scene.add(this.session.rig, this.worldGroup, this.proxies.group, this.glow.mesh);
  }

  get presenting(): boolean {
    return this.session.presenting;
  }

  /**
   * Compile every headset material behind the loader, hidden ones included (prompts, ghost hands,
   * the end card), so nothing compiles on entering VR or mid-ride. An offscreen target has the same
   * program keys as the XR target (linear output, no tone mapping).
   */
  precompile(target: THREE.WebGLRenderTarget, camera: THREE.Camera): void {
    const { renderer, scene } = this.d;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    for (const o of [this.session.rig, this.worldGroup, this.proxies.group, this.glow.mesh]) renderer.compile(o, camera, scene);
    renderer.setRenderTarget(prev);
  }

  private start(): void {
    const d = this.d;
    this.session.rig.visible = this.worldGroup.visible = true;
    d.rider.setXrView(true, XR_TIER.riderShadow);
    d.world.setDetail(XR_TIER.cullK, XR_TIER.far, XR_TIER.treeFar);
    this.proxies.setActive(true);
    // Judge against 72 Hz at most: a Quest running at 90 or 120 still clears the 60 fps bar.
    const hz = Math.min(72, renderer_frameRate(d.renderer) ?? XR_TIER.frameRate);
    this.adaptive.reset(0, hz);
    this.proxies.snap();
    this.shadowK = this.shadowEvery ? 1 : 0;
    REFL.uReflOn.value = 0;
    G.uXRLook.value = XR_LOOK ? 1 : 0;
    this.lostFor = [0, 0];
    this.noHandsT = 0;
    this.everHands = false;
    this.noticeKind = "";
    this.notice.opacity = 0;
    if (!this.started) this.restart();
    this.started = true;
    this.setPaused(false);
    d.onStart();
  }

  private end(): void {
    const d = this.d;
    this.session.rig.visible = this.worldGroup.visible = false;
    d.rider.setXrView(false);
    this.proxies.setActive(false);
    d.world.setDetail(1, Infinity, 130);
    REFL.uReflOn.value = 1;
    G.uXRLook.value = 0;
    this.glow.mesh.visible = false;
    this.fade.k = this.fade.target = 0;
    this.fade.update(0);
    if (this.again === 1) this.restart();
    this.again = 0;
    d.input.xr = null;
    this.paused = false;
    d.audio.setPaused(false);
    d.onEnd();
  }

  restart(): void {
    this.d.place(-0.9, START_Z, 0);
    this.d.tod.set("afternoon", true);
    this.dist = 0;
    this.arriveT = -1;
    this.guide.reset();
    this.sun.moved = 0;
    this.braked = this.sunTaken = false;
    this.rideT = 0;
    this.bells = 0;
    this.endCard.hide();
    this.session.recenter();
  }

  /** What she rode, for the end card. */
  private summary(): string {
    const m = Math.floor(this.rideT / 60), s = Math.round(this.rideT % 60);
    const time = m ? `${m} min ${s} s` : `${s} s`;
    const bells = this.bells === 0 ? "a quiet bell" : this.bells === 1 ? "one ring of the bell" : `${this.bells} rings of the bell`;
    return `${(this.dist / 1000).toFixed(1)} km in ${time}, ${bells}`;
  }

  /**
   * Hands found and lost. A soft cue when a hand comes back after a moment away, another (and a card
   * at eye height) when neither hand nor controller has been seen for most of a second; the bike
   * coasts meanwhile, and the grip rings invite the hands back once they return.
   */
  private watchHands(dt: number): void {
    const L = this.hands.left, R = this.hands.right;
    const seen = [L.tracked || !!L.pad, R.tracked || !!R.pad];
    const now = performance.now() / 1000;
    for (let i = 0; i < 2; i++) {
      if (seen[i]) {
        if (this.lostFor[i] > 0.8 && now - this.cueAt > 1) {
          this.d.audio.trigger("found");
          this.cueAt = now;
          this.inviteT = 1.6;
        }
        this.lostFor[i] = 0;
      } else this.lostFor[i] += dt;
    }
    this.everHands ||= seen[0] || seen[1];
    this.noHandsT = seen[0] || seen[1] ? 0 : this.noHandsT + dt;
    const kind = this.paused || this.again ? "" : this.everHands ? (this.noHandsT > 0.8 ? "lost" : "") : this.noHandsT > 2 ? "none" : "";
    if (kind !== this.noticeKind) {
      if (kind === "lost" && now - this.cueAt > 1) {
        this.d.audio.trigger("lost");
        this.cueAt = now;
      }
      this.noticeKind = kind;
      // Keep the last drawing while it fades out.
      if (kind) this.notice.redraw();
    }
    this.notice.opacity += ((kind ? 1 : 0) - this.notice.opacity) * Math.min(1, dt * 6);
  }

  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    if (!p) {
      this.pausedBySystem = false;
      this.adaptive.settle();
    }
    this.d.audio.setPaused(p);
    this.menu.refresh();
  }

  /** Before the ride simulation: read the hands, feed the bars into the controller. Returns dt. */
  preSim(dt: number, t: number): number {
    const s = this.session;
    s.rig.updateMatrixWorld(true);
    s.cam.getWorldPosition(this.head);
    this.worldGroup.updateMatrixWorld(true);
    this.hands.update();
    this.watchHands(dt);
    if (this.paused) {
      // Keep knowing which hand holds a grip (the wrist menu only opens off the bars).
      this.bars.update(0, this.hands, this.head, t);
      this.bars.rang = false;
      // Hands-only resume: a pinch anywhere (after the headset gave focus back).
      if (s.visible && (this.hands.left.pinchStart || this.hands.right.pinchStart) && !this.menu.shown) this.setPaused(false);
      this.rideIn.ride = false;
      this.rideIn.brake = 1;
      this.d.input.xr = this.rideIn;
      return 0;
    }
    this.inviteT = Math.max(0, this.inviteT - dt);
    this.bars.invite = this.guide.step === "hold" || this.inviteT > 0 ? 1 : 0;
    const w0 = this.bars.held[0], w1 = this.bars.held[1];
    this.bars.update(dt, this.hands, this.head, t);
    if ((this.bars.held[0] && !w0) || (this.bars.held[1] && !w1)) this.d.audio.bump(0.14);
    if (this.bars.rang) {
      this.d.rider.bike.ringBell();
      this.d.audio.ringBell();
      this.bells++;
    }
    if (this.guide.step === "brake" && this.bars.brake > 0.5) this.braked = true;
    const pace = PACES[this.comfort ? Math.min(this.pace, 0) : this.pace];
    const r = this.rideIn;
    r.ride = this.bars.held[0] || this.bars.held[1];
    r.steer = this.bars.steer * (this.comfort ? 0.75 : 1);
    r.brake = this.bars.brake;
    r.cruise = pace.cruise;
    r.accel = pace.accel;
    r.assist = this.comfort ? 0.55 : 0.3;
    if (this.arriveT >= 0 && this.arriveT < 7) {
      // The ending: she rolls to a stop at the torii whatever the hands are doing.
      r.ride = false;
      r.brake = Math.max(r.brake, 0.45);
    }
    this.d.input.xr = r;
    return dt;
  }

  /** After the simulation: move the rig with the bike, run the headset UI. */
  postSim(dt: number, t: number): void {
    const { ctl, tod, audio } = this.d;
    this.session.place(ctl.x, ctl.z, ctl.yaw);
    this.proxies.update(ctl.x, ctl.z, dt || 1 / 72);
    this.session.rig.updateMatrixWorld(true);
    const accel = dt > 0 ? Math.abs(ctl.speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = ctl.speed;
    this.vignette.update(dt || 1 / 72, Math.abs(ctl.yawRate), accel, this.comfort);
    this.pauseCard.opacity += ((this.paused ? 1 : 0) - this.pauseCard.opacity) * 0.2;
    this.menu.update(dt || 1 / 72, this.hands, this.head, this.bars.held[0]);
    if (XR_LOOK) this.glow.update();
    this.fade.update(dt || 1 / 72);
    if (this.paused) return;
    const step = this.guide.step;
    if (step !== "hold") this.dist += Math.max(0, ctl.speed) * dt;
    if (step !== "arrive" && step !== "free") this.rideT += dt;
    this.sun.beckon = step === "sun" && !this.sun.grabbed ? 1 : 0;
    const had = this.sun.grabbed;
    this.sun.update(dt, this.hands, this.head, t);
    if (this.sun.grabbed && !had) this.d.audio.trigger("furin");
    if (this.sun.grabbed && step === "sun") this.sunTaken = true;
    this.guide.update(dt, { held: this.bars.heldFor, rang: this.bars.rang, sunPos: tod.pos, sunMoved: this.sun.moved, menu: this.menu.shown, braked: this.braked, dist: this.dist, speed: ctl.speed });
    // A soft chime as each lesson is done (the bell and the arrival bring their own sounds).
    if (this.guide.step !== step && CHIME_ON.has(this.guide.step) && !this.bars.rang) audio.trigger("chime");
    if (this.guide.arrived && this.arriveT < 0) {
      this.arriveT = 0;
      if (tod.pos < 2.9) tod.set("dusk");
      audio.trigger("temple");
    }
    if (this.arriveT >= 0) this.arriveT += dt;
    this.hints(dt);
    this.ending(dt);
  }

  /** Ghost hands for the lesson at hand, until it has been done once. */
  private hints(dt: number): void {
    const s = this.guide.step;
    const hint: Hint | null =
      s === "hold" ? "hold" : s === "brake" && !this.braked ? "brake" : s === "bell" ? "bell" : s === "sun" && !this.sunTaken ? "sun" : s === "menu" && !this.menu.shown ? "palm" : null;
    this.d.rider.bike.bellWorld(this.bellLocal);
    this.session.rig.worldToLocal(this.bellLocal);
    this.ghost.update(dt, this.again ? null : hint, this.bars.held, this.bellLocal, this.d.tod.pos);
  }

  /** The end card a few seconds after arriving, its two tags, and Ride again's fade. */
  private ending(dt: number): void {
    const { ctl, audio } = this.d;
    if (this.guide.step === "arrive" && this.arriveT > 5 && !this.endCard.shown && !this.again) {
      this.endCard.show(this.summary());
      this.guide.hidden = true;
      audio.trigger("end");
    }
    const pick = this.endCard.update(dt, this.hands) ?? (this.endCard.shown && this.arriveT > 7 && ctl.speed > 1.2 ? "on" : null);
    if (pick === "again") {
      this.endCard.hide();
      this.again = 1;
      this.fade.target = 1;
      audio.trigger("furin");
    } else if (pick === "on") {
      this.endCard.hide();
      this.guide.rideOn();
      audio.trigger("chime");
    }
    if (this.again === 1 && this.fade.k >= 1) {
      this.restart();
      this.again = 2;
      this.fade.target = 0;
    } else if (this.again === 2 && this.fade.k <= 0) this.again = 0;
  }

  /** Stripped headset frame: sun shadow (optional), then the scene straight into the XR target. */
  render(shadow: SunShadow, center: THREE.Vector3, interval: number): void {
    const { renderer, scene } = this.d;
    const xrTarget = renderer.getRenderTarget();
    // No viewer pose yet (first frames): three hasn't bound the XR target. Drawing now would go to
    // the canvas and compile an sRGB-output variant of every scene shader.
    if (!(xrTarget as { isXRRenderTarget?: boolean } | null)?.isXRRenderTarget) return;
    const calls0 = renderer.info.render.calls;
    this.shadowK = Math.max(0, Math.min(1, this.shadowK + (this.shadowEvery ? 1 : -1) * (interval / 1000)));
    if (this.shadowEvery && this.frame++ % this.shadowEvery === 0) {
      // Casters are static scenery: a map a frame old (with the matrix it was drawn with) is still
      // right. The proxies already limit casters to the instances around her.
      renderer.xr.enabled = false;
      shadow.update(renderer, scene, center);
      renderer.xr.enabled = true;
      renderer.setRenderTarget(xrTarget);
    }
    // The shadow pass sets full strength; the fade (and a stale map while fading out) wins.
    G.uShadowOn.value = this.shadowK;
    this.shadowCalls = renderer.info.render.calls - calls0;
    // No MSAA on the layer (emulator): coverage alpha falls back to the ordered dither.
    G.uDither.value = renderer.getContextAttributes()?.antialias ? 0 : 1;
    renderer.render(scene, this.session.cam);
    G.uDither.value = 0;
    if (this.adaptive.slow > 0) {
      // Emulator test (?xrslow=ms): stand-in frame cost that shrinks with the scene's triangles.
      const until = performance.now() + (this.adaptive.slow * renderer.info.render.triangles) / 650e3;
      while (performance.now() < until);
    }
    if (!this.paused && this.adaptiveOn) this.adaptive.tick(interval);
    this.fps.tick(interval / 1000, renderer.info.render.calls - calls0);
  }

  /** Test hooks. */
  get state() {
    return {
      presenting: this.presenting,
      step: this.guide.step,
      dist: Math.round(this.dist),
      held: [...this.bars.held],
      steer: this.bars.steer,
      brake: this.bars.brake,
      paused: this.paused,
      menu: this.menu.shown,
      sun: this.d.tod.pos,
      hands: [this.hands.left.tracked, this.hands.right.tracked],
      fps: this.fps.fps,
      calls: this.fps.calls,
      shadowCalls: this.shadowCalls,
      level: this.adaptive.current.name,
      levelFps: Math.round(this.adaptive.fps),
      target: this.adaptive.target,
      hint: this.ghost.showing,
      notice: this.noticeKind,
      end: this.endCard.shown,
      fade: this.fade.k,
    };
  }
  skip(dist: number): void {
    this.dist = dist;
  }
}

/** The display rate the session runs at, when the browser reports it (Quest Browser does). */
function renderer_frameRate(renderer: THREE.WebGLRenderer): number | undefined {
  const r = (renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null)?.frameRate;
  return r && Number.isFinite(r) && r > 0 ? r : undefined;
}
