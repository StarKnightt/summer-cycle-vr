import * as THREE from "three";
import type { Hands } from "./hands";
import { EYE } from "./session";
import { INK, Panel, text, washiCard } from "./ui";

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * A washi tag that a seated player can press: poke it with an index fingertip (from the front),
 * or pinch on it (a controller trigger counts as a pinch). Faces her eye, within arm's reach.
 */
export class Button {
  readonly panel: Panel;
  /** A fingertip has been in front of the tag since it appeared: a poke must come from there. */
  private armed = false;
  private hot = 0;
  private lit = -1;

  constructor(private label: string, w = 0.13, h = 0.052) {
    this.panel = new Panel(w, h, 512, (g, pw, ph) => {
      washiCard(g, pw, ph, ph * 0.3);
      if (this.hot > 0.05) {
        g.fillStyle = `rgba(214, 150, 84, ${(0.16 + 0.3 * this.hot).toFixed(3)})`;
        g.beginPath();
        g.roundRect(pw * 0.05, ph * 0.12, pw * 0.9, ph * 0.76, ph * 0.26);
        g.fill();
      }
      text(g, this.label, pw / 2, ph / 2 + 2, 76, pw * 0.82, INK, 400, 0.04);
    });
    this.panel.mesh.renderOrder = 12;
  }

  get mesh(): THREE.Mesh {
    return this.panel.mesh;
  }

  reset(): void {
    this.armed = false;
    this.hot = 0;
  }

  /** True on the frame it is pressed. */
  update(dt: number, hands: Hands): boolean {
    const m = this.panel.mesh, w = this.panel.w, h = this.panel.h;
    let pressed = false, near = Infinity;
    for (const hand of [hands.left, hands.right]) {
      if (!hand.tracked && !hand.pad) continue;
      if (hand.tracked) {
        const p = m.worldToLocal(_p.copy(hand.indexTip));
        const inside = Math.abs(p.x) < w / 2 + 0.008 && Math.abs(p.y) < h / 2 + 0.008;
        near = Math.min(near, inside ? Math.max(0, p.z) : Infinity);
        if (p.z > 0.02) this.armed = true;
        if (inside && this.armed && p.z < 0.006 && p.z > -0.04) pressed = true;
      }
      const q = m.worldToLocal(_p.copy(hand.pinchPoint));
      const onIt = Math.abs(q.x) < w / 2 + 0.02 && Math.abs(q.y) < h / 2 + 0.02 && Math.abs(q.z) < 0.05;
      if (onIt) near = Math.min(near, Math.abs(q.z));
      if (onIt && hand.pinchStart) pressed = true;
    }
    if (pressed) this.armed = false;
    this.hot += ((near < 0.07 ? 1 - near / 0.07 : 0) - this.hot) * Math.min(1, dt * 12);
    const lit = Math.round(this.hot * 8);
    if (lit !== this.lit) {
      this.lit = lit;
      this.panel.redraw();
    }
    return pressed;
  }
}

/**
 * The end of the guided ride: a card over the basket with what she rode, and two tags in reach,
 * "Ride again" (back to the afternoon at the start) and "Ride on" (free riding at dusk). Taking
 * the bars and riding off counts as "Ride on".
 */
export class EndCard {
  readonly group = new THREE.Group();
  private card: Panel;
  readonly again = new Button("Ride again");
  readonly on = new Button("Ride on");
  private summary = "";
  private k = 0;
  shown = false;

  constructor() {
    this.card = new Panel(0.62, 0.24, 1024, (g, w, h) => {
      washiCard(g, w, h);
      text(g, "The end of summer", w / 2, h * 0.27, 62, w * 0.86, INK, 400, 0.08);
      text(g, this.summary, w / 2, h * 0.52, 38, w * 0.88, "rgba(58, 42, 34, 0.85)");
      text(g, "Every tree, cloud and sound on the way was made in code.", w / 2, h * 0.76, 30, w * 0.86, "rgba(58, 42, 34, 0.6)");
    });
    // Over the basket like the guide's cards; the tags lower and nearer, ~55 cm from her eye.
    this.card.mesh.position.set(0, 1.27, -0.88);
    this.card.mesh.rotation.x = 0.28;
    this.again.mesh.position.set(-0.085, 1.215, -0.29);
    this.on.mesh.position.set(0.085, 1.215, -0.29);
    for (const b of [this.again, this.on]) b.mesh.lookAt(_v.copy(EYE).setX(b.mesh.position.x * 0.6));
    this.group.add(this.card.mesh, this.again.mesh, this.on.mesh);
    this.group.name = "xr-end-card";
    this.setK(0);
  }

  show(summary: string): void {
    this.summary = summary;
    this.card.redraw();
    this.again.reset();
    this.on.reset();
    this.shown = true;
  }

  hide(): void {
    this.shown = false;
  }

  /** Per frame: fade, and which tag was pressed (only once fully shown). */
  update(dt: number, hands: Hands): "again" | "on" | null {
    this.setK(this.k + ((this.shown ? 1 : 0) - this.k) * Math.min(1, dt * 2.5));
    if (!this.shown || this.k < 0.9) return null;
    // Both run every frame so their hover state stays current.
    const a = this.again.update(dt, hands), b = this.on.update(dt, hands);
    return a ? "again" : b ? "on" : null;
  }

  private setK(k: number): void {
    this.k = k;
    this.card.opacity = k;
    this.again.panel.opacity = this.on.panel.opacity = Math.max(0, k * 1.4 - 0.4);
  }
}

/** Head-locked fade to a warm dark and back (Ride again). Child of the XR camera. */
export class Fade {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  k = 0;
  target = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: { uAmt: { value: 0 } },
      vertexShader: /* glsl */ `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uAmt;
        layout(location = 0) out vec4 o;
        void main(){ o = vec4(0.07, 0.055, 0.05, uAmt); }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 10), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1002;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    const rate = this.target > this.k ? 1.8 : 1.1;
    this.k = this.target > this.k ? Math.min(this.target, this.k + dt * rate) : Math.max(this.target, this.k - dt * rate);
    const e = this.k * this.k * (3 - 2 * this.k);
    this.mat.uniforms.uAmt.value = e;
    this.mesh.visible = e > 0.002;
  }
}
