import * as THREE from "three";
import { POSES, RADII } from "./handposes";
import { BONES, J } from "./hands";
import { EYE } from "./session";
import { arcPoint } from "./sundial";

/** What the ghost hands are showing: a gesture, demonstrated where it is done. */
export type Hint = "hold" | "brake" | "bell" | "sun" | "palm";

/** Grip centres at rest (bike space, see bars.ts). */
const GRIP = [new THREE.Vector3(-0.29, 1.05, -0.17), new THREE.Vector3(0.29, 1.05, -0.17)];
/** Where a palm rests on a grip, in the pose frame (see hands.ts `palm`). */
const PALM = new THREE.Vector3(0, 0.0526, 0.025);
const SHOULDER_R = new THREE.Vector3(0.16, 1.27, 0.25);
const NJ = 25;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const ease = (x: number) => {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
};

/** Hand orientation: fingers along `f`, palm facing `n` (made perpendicular), as a rotation of the pose frame. */
function frame(f: THREE.Vector3, n: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const F = _a.copy(f).normalize();
  const N = _b.copy(n).addScaledVector(F, -n.dot(F)).normalize();
  return out.setFromRotationMatrix(_m.makeBasis(_c.crossVectors(F, N), F, N));
}

interface Ghost {
  /** Shown 0…1, and where it is heading. */
  on: number;
  want: number;
  /** Palm point (bike space) and orientation of the pose frame. */
  pos: THREE.Vector3;
  q: THREE.Quaternion;
  pinch: number;
  joints: THREE.Vector3[];
}

/**
 * Ghost-hand hints: translucent light hands that show each gesture once, where it is done (resting
 * on the grips, pinching above the right grip, a thumb on the bell, reaching for the sun, turning
 * the left palm up). Poses are Meta's IWER hand recordings (handposes.ts). Two instanced draws,
 * additive with a bright rim, so they read as light and never hide the real hands.
 */
export class GhostHands {
  readonly group = new THREE.Group();
  private beads: THREE.InstancedMesh;
  private rods: THREE.InstancedMesh;
  private hands: Ghost[];
  private hint: Hint | null = null;
  private t = 0;
  private cj = new Float32Array(NJ * 3);
  private bellTop = new THREE.Vector3();
  private at = new THREE.Vector3();
  private from = new THREE.Vector3();
  private q1 = new THREE.Quaternion();

  constructor() {
    const mat = ghostMaterial();
    const n = (NJ + 1) * 2, nb = BONES.length * 2;
    this.beads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 7), mat, n);
    this.rods = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), mat, nb);
    for (const m of [this.beads, this.rods]) {
      // Per-instance fade in the colour (allocated now, so the compiled program has it).
      m.setColorAt(0, _col.setRGB(1, 1, 1));
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = 4;
      this.group.add(m);
    }
    this.hands = [0, 1].map(() => ({ on: 0, want: 0, pos: new THREE.Vector3(), q: new THREE.Quaternion(), pinch: 0, joints: Array.from({ length: NJ }, () => new THREE.Vector3()) }));
    this.group.name = "xr-ghost-hands";
    this.group.visible = false;
  }

  get showing(): Hint | null {
    return this.hint;
  }

  /** Per frame: `held` = real hands on the grips; `bell` = the bell (bike space); `sun` = dial position 0…3. */
  update(dt: number, hint: Hint | null, held: readonly boolean[], bell: THREE.Vector3, sun: number): void {
    if (hint !== this.hint) {
      this.hint = hint;
      this.t = 0;
    }
    this.t += dt;
    for (const h of this.hands) h.want = 0;
    const t = this.t;
    switch (hint) {
      case "hold":
        // Both hands settle onto the grips from above, palms down: holding is all it takes.
        for (let i = 0; i < 2; i++) {
          const p = (t / 2.8) % 1;
          const h = this.hands[i];
          const down = ease((p - 0.16) / 0.44);
          this.grip(h, i, _v.set(0, 0.11 * (1 - down), 0.03 * (1 - down)));
          h.pinch = 0;
          h.want = held[i] ? 0 : p < 0.84 ? 1 : 0;
          if (p < 0.03) h.on = 0;
        }
        break;
      case "brake": {
        // A pinch just above the right grip, over and over.
        const p = (t / 2.0) % 1, h = this.hands[1];
        this.grip(h, 1, _v.set(0, 0.085, 0.015));
        h.pinch = ease((p - 0.15) / 0.25) * (1 - ease((p - 0.65) / 0.25));
        h.want = 1;
        break;
      }
      case "bell": {
        // The left thumb reaches over and taps the bell dome.
        const p = (t / 2.2) % 1, h = this.hands[0];
        this.grip(h, 0, _v.set(0, 0.045, 0));
        h.pinch = 0;
        const reach = ease((p - 0.2) / 0.22) * (1 - ease((p - 0.55) / 0.22));
        this.bellTop.copy(bell).add(_v.set(0, 0.016, 0));
        this.place(h, 0);
        h.pos.addScaledVector(_w.subVectors(this.bellTop, h.joints[J["thumb-tip"]]), reach);
        h.want = 1;
        break;
      }
      case "sun": {
        // The right hand leaves the bar, pinches the little sun and pulls it a little way down its arc.
        const p = (t / 4.4) % 1, h = this.hands[1];
        const s0 = Math.min(sun, 2.4);
        const reach = ease((p - 0.08) / 0.3);
        const drag = ease((p - 0.5) / 0.3);
        h.pinch = ease((p - 0.38) / 0.1) * (1 - ease((p - 0.82) / 0.07));
        const at = this.from.copy(GRIP[1]).add(_v.set(0, 0.1, 0.04)).lerp(arcPoint(s0 + drag * 0.55, this.at), reach);
        at.y += Math.sin(reach * Math.PI) * 0.04;
        frame(_v.subVectors(at, SHOULDER_R), _w.set(-0.35, -0.9, 0), h.q);
        // Keep the pinch point (between thumb and index tips) on the path.
        h.pos.copy(at);
        this.place(h, 1);
        const tip = _v.copy(h.joints[J["thumb-tip"]]).lerp(h.joints[J["index-finger-tip"]], 0.5);
        h.pos.add(_s.subVectors(at, tip));
        h.want = p < 0.9 ? 1 : 0;
        if (p < 0.03) h.on = 0;
        break;
      }
      case "palm": {
        // The left hand lifts off the bar and turns its palm toward the eyes: that opens the menu.
        const p = (t / 3.2) % 1, h = this.hands[0];
        const k = ease((p - 0.1) / 0.4);
        this.grip(h, 0, _v.set(0, 0.08, 0));
        const end = this.at.set(-0.06, 1.22, -0.1);
        frame(_v.set(0.35, 1, -0.25), _w.subVectors(EYE, end), this.q1);
        h.pos.lerp(end, k);
        h.q.slerp(this.q1, k);
        h.pinch = 0;
        h.want = p < 0.86 ? 1 : 0;
        if (p < 0.03) h.on = 0;
        break;
      }
    }
    let any = false;
    for (const h of this.hands) {
      h.on += (h.want - h.on) * Math.min(1, dt * (h.want > h.on ? 6 : 8));
      if (h.on < 0.01) h.on = 0;
      any ||= h.on > 0;
    }
    this.group.visible = any;
    if (any) this.draw();
  }

  /** Palm down on grip `i`, raised by `raise` (bike space). */
  private grip(h: Ghost, i: number, raise: THREE.Vector3): void {
    const side = i === 0 ? -1 : 1;
    frame(_a.set(-side * 0.15, -0.3, -1), _b.set(0, -1, 0.25), h.q);
    h.pos.copy(GRIP[i]).add(raise);
  }

  /** Joint positions (bike space) for the current pose of hand `i`. */
  private place(h: Ghost, i: number): void {
    const mir = i === 0 ? 1 : -1;
    const R = POSES.relaxed, P = POSES.pinch;
    for (let k = 0; k < NJ * 3; k++) this.cj[k] = (R[k] + (P[k] - R[k]) * h.pinch) / 1000;
    for (let k = 0; k < NJ; k++) h.joints[k].set(this.cj[k * 3] * mir, this.cj[k * 3 + 1], this.cj[k * 3 + 2]).sub(PALM).applyQuaternion(h.q).add(h.pos);
  }

  private draw(): void {
    let nb = 0, nr = 0;
    this.hands.forEach((h, i) => {
      if (h.on <= 0) return;
      this.place(h, i);
      _col.setRGB(h.on, h.on, h.on);
      const P = h.joints;
      for (let k = 0; k < NJ; k++) {
        _m.compose(P[k], _q.identity(), _s.setScalar((RADII[k] / 1000) * (k === 0 ? 1.25 : 1.05)));
        this.beads.setMatrixAt(nb, _m);
        this.beads.setColorAt(nb++, _col);
      }
      // Palm pad between the palm rays.
      _w.subVectors(P[J["middle-finger-phalanx-proximal"]], P[0]);
      const len = _w.length();
      const n = _a.set(0, 0, 1).applyQuaternion(h.q);
      _v.copy(P[0]).addScaledVector(_w, 0.55).addScaledVector(n, -0.004);
      _m.lookAt(_v, _b.copy(_v).add(n), _w.normalize());
      _q.setFromRotationMatrix(_m);
      _m.compose(_v, _q, _s.set(0.036, len * 0.5, 0.011));
      this.beads.setMatrixAt(nb, _m);
      this.beads.setColorAt(nb++, _col);
      for (const [a, b] of BONES) {
        _w.subVectors(P[b], P[a]);
        const l = _w.length();
        if (l < 1e-4) continue;
        _q.setFromUnitVectors(_up, _w.divideScalar(l));
        const r = Math.min(RADII[a], RADII[b]) / 1000;
        _m.compose(_v.addVectors(P[a], P[b]).multiplyScalar(0.5), _q, _s.set(r, l, r));
        this.rods.setMatrixAt(nr, _m);
        this.rods.setColorAt(nr++, _col);
      }
    });
    this.beads.count = nb;
    this.rods.count = nr;
    for (const m of [this.beads, this.rods]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

/** Light, not skin: a faint fill with a bright rim, added on top (display-ready colour). */
function ghostMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0.92, 0.84, 0.68) } },
    vertexShader: /* glsl */ `
      out vec3 vN; out vec3 vW; out float vA;
      void main(){
        mat4 m = modelMatrix * instanceMatrix;
        vN = normalize(mat3(m) * normal);
        vec4 w = m * vec4(position, 1.0);
        vW = w.xyz;
        vA = 1.0;
      #ifdef USE_INSTANCING_COLOR
        vA = instanceColor.r;
      #endif
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      in vec3 vN; in vec3 vW; in float vA;
      layout(location = 0) out vec4 o;
      void main(){
        float f = 1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vW)));
        o = vec4(uColor * (0.06 + 0.5 * f * f) * vA, 1.0);
      }`,
  });
}
