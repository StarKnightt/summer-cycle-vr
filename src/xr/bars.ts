import * as THREE from "three";
import type { Hand, Hands } from "./hands";
import type { Rider } from "../rider/rider";
import { HEAD_BOT } from "../rider/bike";
import { glowMaterial, disp } from "./ui";

/** Grip centres and the steering pivot at grip height, in bike space (see bike.ts buildSteer). */
const GRIP = [new THREE.Vector3(-0.29, 1.05, -0.17), new THREE.Vector3(0.29, 1.05, -0.17)];
const PIVOT = new THREE.Vector3(0, 1.05, -0.382);
const REST = GRIP.map((g) => Math.atan2(-(g.z - PIVOT.z), g.x - PIVOT.x));
/** Bars turned this far (rad) = full steering lock. */
const FULL_LOCK = 0.34;
const GRAB_IN = 0.13, GRAB_OUT = 0.22;
const BELL_IN = 0.038, BELL_OUT = 0.065;

const _v = new THREE.Vector3();
const _l = new THREE.Vector3();

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The bars as the headset's controls. A hand resting near a grip holds it (no gesture needed);
 * turning the bars about the stem steers, pinching brakes, and a thumb or finger touching the bell
 * rings it. Controllers: hold the grip button to ride, stick steers, trigger brakes, A / X rings.
 */
export class Bars {
  /** Per side (0 left, 1 right): holding its grip. */
  readonly held = [false, false];
  steer = 0;
  brake = 0;
  /** Set for one frame when the bell was struck. */
  rang = false;
  /** Seconds either hand has been on the bars (for the guide). */
  heldFor = 0;
  private armed = [true, true];
  private padArmed = [true, true];
  private rings: THREE.Mesh[] = [];
  private bell = new THREE.Vector3();
  /** 0…1 how strongly the grips invite a hand (pulse at the start). */
  invite = 0;

  constructor(private rider: Rider, readonly group: THREE.Group) {
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), glowMaterial(disp("#ffd9a0"), true));
      m.renderOrder = 5;
      m.frustumCulled = false;
      this.rings.push(m);
      group.add(m);
    }
  }

  /** Carry the grip rings by the rig's move this frame (see Hands.shift). */
  shift(m: THREE.Matrix4, q: THREE.Quaternion): void {
    for (const r of this.rings) {
      r.position.applyMatrix4(m);
      r.quaternion.premultiply(q);
    }
  }

  update(dt: number, hands: Hands, head: THREE.Vector3, t: number): void {
    const steerG = this.rider.bike.steer;
    const root = this.rider.root;
    let sum = 0, n = 0, brake = 0;
    this.rang = false;
    this.rider.bike.bellWorld(this.bell);
    ([hands.left, hands.right] as Hand[]).forEach((h, i) => {
      const grip = steerG.localToWorld(_v.copy(GRIP[i]).sub(HEAD_BOT));
      if (h.pad) {
        const squeeze = (h.pad.buttons[1]?.value ?? 0) > 0.4;
        this.held[i] = squeeze;
        if (squeeze) {
          const x = h.pad.axes[2] ?? 0;
          if (Math.abs(x) > 0.12) (sum += -x * FULL_LOCK), n++;
          else n++;
          brake = Math.max(brake, h.pinch);
        }
        const a = !!h.pad.buttons[4]?.pressed;
        if (a && this.padArmed[i]) this.rang = true;
        this.padArmed[i] = !a;
        return;
      }
      if (!h.tracked) {
        this.held[i] = false;
        return;
      }
      const d = h.palm.distanceTo(grip);
      this.held[i] = this.held[i] ? d < GRAB_OUT : d < GRAB_IN;
      if (this.held[i]) {
        // The palm's angle about the stem, relative to where the grip rests.
        root.worldToLocal(_l.copy(h.palm));
        sum += wrap(Math.atan2(-(_l.z - PIVOT.z), _l.x - PIVOT.x) - REST[i]);
        n++;
        brake = Math.max(brake, THREE.MathUtils.smoothstep(h.pinch, 0.35, 0.9));
      }
      // Bell: thumb or index tip on the dome, re-armed once it has moved away.
      const bd = Math.min(h.thumbTip.distanceTo(this.bell), h.indexTip.distanceTo(this.bell));
      if (bd < BELL_IN && this.armed[i]) {
        this.rang = true;
        this.armed[i] = false;
      } else if (bd > BELL_OUT) this.armed[i] = true;
    });
    const target = n ? THREE.MathUtils.clamp(sum / n / FULL_LOCK, -1, 1) : 0;
    this.steer += (target - this.steer) * Math.min(1, dt * 14);
    this.brake = brake;
    const any = this.held[0] || this.held[1];
    this.heldFor = any ? this.heldFor + dt : 0;

    // Grip rings: face the head, glow while held, pulse softly when inviting a hand.
    for (let i = 0; i < 2; i++) {
      const m = this.rings[i];
      steerG.localToWorld(m.position.copy(GRIP[i]).sub(HEAD_BOT));
      m.lookAt(head);
      const pulse = this.invite * (0.55 + 0.45 * Math.sin(t * 3.2 + i));
      (m.material as THREE.ShaderMaterial).uniforms.uAmt.value = this.held[i] ? 0.55 : pulse * 0.9;
      m.visible = this.held[i] || pulse > 0.02;
    }
  }
}
