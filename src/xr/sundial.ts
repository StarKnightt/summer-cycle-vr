import * as THREE from "three";
import type { Hand, Hands } from "./hands";
import type { TimeOfDay } from "../world/timeofday";
import { EYE } from "./session";
import { disp, flatMaterial, glowMaterial } from "./ui";

const DEG = Math.PI / 180;
/** Arc radius around her eye (m): inside a seated arm's reach. */
const R = 0.46;
const SAMPLES = 96;
const GRAB = 0.085, HOVER = 0.14;
/** Sun colour along the arc: afternoon, golden, sunset, dusk (a pale moon-blue once it has set). */
const TINTS = ["#fff3cf", "#ffc672", "#ff8b4c", "#b4bdf0"].map(disp);

/** The arc's centre sits a little in front of and below her eye. */
const _fwd = new THREE.Vector3(0, -0.04, -0.06);

/** Bike-space point on the arc for s in 0…3 (afternoon high on the right, dusk low on the left). */
export function arcPoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  const k = s / 3;
  const az = (38 - 82 * k) * DEG;
  const el = (50 - 50 * k * (0.7 + 0.3 * k) + 2) * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(R).add(EYE).add(_fwd);
}

const _p = new THREE.Vector3();

/**
 * A little sun on a painted arc in front of her: pinch it (or grab it with a controller trigger)
 * and drag it along the arc to set the light anywhere from afternoon to dusk. The real sun, the
 * sky and the lamps follow as you drag.
 */
export class SunDial {
  /** Bike-space group (child of the rig). */
  readonly group = new THREE.Group();
  private sun: THREE.Mesh;
  private halo: THREE.Mesh;
  private sunMat: THREE.ShaderMaterial;
  private haloMat: THREE.ShaderMaterial;
  private arc: THREE.Mesh;
  private arcMat: THREE.ShaderMaterial;
  private held: Hand | null = null;
  private pts: THREE.Vector3[] = [];
  private s = 0;
  /** 0…1: something is near or holding it (the guide can also ask it to beckon). */
  hover = 0;
  beckon = 0;
  /** Dragged this session (for the guide). */
  moved = 0;

  constructor(private tod: TimeOfDay) {
    for (let i = 0; i <= SAMPLES; i++) this.pts.push(arcPoint((i / SAMPLES) * 3, new THREE.Vector3()));
    const curve = new THREE.CatmullRomCurve3(this.pts);
    this.arcMat = flatMaterial(disp("#fff4dc"), 0.35);
    this.arc = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.0022, 5, false), this.arcMat);
    this.group.add(this.arc);
    // Four stops marking the presets.
    const dots = new THREE.SphereGeometry(0.006, 8, 6);
    for (let i = 0; i < 4; i++) {
      const d = new THREE.Mesh(dots, flatMaterial(TINTS[i], 0.8));
      arcPoint(i, d.position);
      this.group.add(d);
    }
    this.sunMat = flatMaterial(TINTS[0].clone());
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 14), this.sunMat);
    this.haloMat = glowMaterial(TINTS[0].clone());
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), this.haloMat);
    this.halo.renderOrder = 6;
    for (const m of [this.arc, this.sun, this.halo]) m.frustumCulled = false;
    this.group.add(this.sun, this.halo);
  }

  update(dt: number, hands: Hands, head: THREE.Vector3, t: number): void {
    const toLocal = (w: THREE.Vector3) => this.group.worldToLocal(_p.copy(w));
    if (this.held && (!this.held.pinching || !(this.held.tracked || this.held.pad))) this.held = null;
    let near = Infinity;
    if (!this.held)
      for (const h of [hands.left, hands.right]) {
        if (!h.tracked && !h.pad) continue;
        const d = toLocal(h.pinchPoint).distanceTo(this.sun.position);
        near = Math.min(near, d);
        if (h.pinchStart && d < GRAB) this.held = h;
      }
    if (this.held) {
      // Nearest point on the arc to the pinch, eased so small tremors don't flicker the sky.
      const q = toLocal(this.held.pinchPoint);
      let best = 0, bd = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const d = this.pts[i].distanceToSquared(q);
        if (d < bd) (bd = d), (best = i);
      }
      const want = (best / SAMPLES) * 3;
      const next = this.s + (want - this.s) * Math.min(1, dt * 10);
      this.moved += Math.abs(next - this.s);
      this.s = next;
      this.tod.scrub(this.s);
    } else this.s = this.tod.pos;

    const k = this.held ? 1 : Math.max(0, 1 - (near - GRAB) / (HOVER - GRAB));
    this.hover += (Math.min(1, k) - this.hover) * Math.min(1, dt * 10);
    arcPoint(this.s, this.sun.position);
    this.halo.position.copy(this.sun.position);
    this.halo.lookAt(head);
    const i = Math.min(2, Math.floor(this.s)), f = this.s - i;
    this.sunMat.uniforms.uColor.value.copy(TINTS[i]).lerp(TINTS[i + 1], f);
    this.haloMat.uniforms.uColor.value.copy(this.sunMat.uniforms.uColor.value);
    const pulse = this.beckon * (0.5 + 0.5 * Math.sin(t * 3));
    this.sun.scale.setScalar(1 + this.hover * 0.35 + pulse * 0.25);
    this.haloMat.uniforms.uAmt.value = 0.45 + this.hover * 0.5 + pulse * 0.5;
    this.arcMat.uniforms.uOpacity.value = 0.22 + this.hover * 0.4 + this.beckon * 0.2;
  }

  get grabbed(): boolean {
    return this.held !== null;
  }
}
