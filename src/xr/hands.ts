import * as THREE from "three";
import { G } from "../render/materials";

type Side = "left" | "right";
const JOINTS = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
] as const;
type Joint = (typeof JOINTS)[number];
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<Joint, number>;
const FINGERS = ["index", "middle", "ring", "pinky"] as const;
/** Capsules drawn between joints: thumb chain, palm rays, finger chains, knuckle line. */
export const BONES: [number, number][] = [
  [J.wrist, J["thumb-metacarpal"]], [J["thumb-metacarpal"], J["thumb-phalanx-proximal"]], [J["thumb-phalanx-proximal"], J["thumb-phalanx-distal"]], [J["thumb-phalanx-distal"], J["thumb-tip"]],
  ...FINGERS.flatMap((f): [number, number][] => [
    [J.wrist, J[`${f}-finger-phalanx-proximal`]],
    [J[`${f}-finger-phalanx-proximal`], J[`${f}-finger-phalanx-intermediate`]],
    [J[`${f}-finger-phalanx-intermediate`], J[`${f}-finger-phalanx-distal`]],
    [J[`${f}-finger-phalanx-distal`], J[`${f}-finger-tip`]],
  ]),
  [J["index-finger-phalanx-proximal"], J["middle-finger-phalanx-proximal"]], [J["middle-finger-phalanx-proximal"], J["ring-finger-phalanx-proximal"]], [J["ring-finger-phalanx-proximal"], J["pinky-finger-phalanx-proximal"]],
];

/** One tracked hand (or a controller standing in for it), in world space, refreshed per frame. */
export class Hand {
  tracked = false;
  /** A controller, not a hand: no joints, buttons instead of gestures. */
  pad: Gamepad | null = null;
  readonly joint = JOINTS.map(() => new THREE.Vector3());
  readonly radius = new Float32Array(JOINTS.length).fill(0.008);
  /** 0 open … 1 thumb and index tips touching. */
  pinch = 0;
  /** Pinch with hysteresis (on under 2 cm, off over 3.5 cm). */
  pinching = false;
  pinchStart = false;
  pinchEnd = false;
  readonly pinchPoint = new THREE.Vector3();
  /** Middle of the palm, a little in front of it (where a handlebar grip would sit). */
  readonly palm = new THREE.Vector3();
  /** Out of the palm (away from the back of the hand). */
  readonly palmNormal = new THREE.Vector3(0, 0, -1);
  /** Controller grip pose (pads only). */
  readonly gripQ = new THREE.Quaternion();

  constructor(readonly side: Side) {}

  get indexTip(): THREE.Vector3 {
    return this.joint[J["index-finger-tip"]];
  }
  get thumbTip(): THREE.Vector3 {
    return this.joint[J["thumb-tip"]];
  }
  get wrist(): THREE.Vector3 {
    return this.joint[J.wrist];
  }
}

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Both hands: three's XR hand spaces under the rig, gesture features, and the drawn hands. */
export class Hands {
  readonly left = new Hand("left");
  readonly right = new Hand("right");
  readonly group = new THREE.Group();
  private spaces: { space: THREE.XRHandSpace; side: Side | null }[] = [];
  private pads: { grip: THREE.Group; side: Side | null; source: XRInputSource | null }[] = [];
  private beads: THREE.InstancedMesh;
  private beadInk: THREE.InstancedMesh;
  private rods: THREE.InstancedMesh;
  private rodInk: THREE.InstancedMesh;
  private readonly perHand = JOINTS.length + 1;

  constructor(renderer: THREE.WebGLRenderer, parent: THREE.Object3D) {
    for (let i = 0; i < 2; i++) {
      const space = renderer.xr.getHand(i);
      const e = { space, side: null as Side | null };
      space.addEventListener("connected", (ev) => (e.side = ((ev as unknown as { data: XRInputSource }).data.handedness as Side) ?? null));
      space.addEventListener("disconnected", () => (e.side = null));
      parent.add(space);
      this.spaces.push(e);
      const grip = renderer.xr.getControllerGrip(i);
      const p = { grip, side: null as Side | null, source: null as XRInputSource | null };
      grip.addEventListener("connected", (ev) => {
        const src = (ev as unknown as { data: XRInputSource }).data;
        if (src.hand) return;
        p.side = src.handedness as Side;
        p.source = src;
      });
      grip.addEventListener("disconnected", () => ((p.side = null), (p.source = null)));
      parent.add(grip);
      this.pads.push(p);
    }
    const skin = new THREE.Color("#f1c6a8");
    const bead = new THREE.SphereGeometry(1, 9, 6);
    const rod = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true);
    const n = this.perHand * 2, nb = BONES.length * 2;
    this.beads = new THREE.InstancedMesh(bead, handMaterial(skin, false), n);
    this.beadInk = new THREE.InstancedMesh(bead, handMaterial(skin, true), n);
    this.rods = new THREE.InstancedMesh(rod, handMaterial(skin, false), nb);
    this.rodInk = new THREE.InstancedMesh(rod, handMaterial(skin, true), nb);
    for (const m of [this.beads, this.beadInk, this.rods, this.rodInk]) {
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = 2;
      this.group.add(m);
    }
    this.group.visible = false;
  }

  /** Read joints (the rig must be placed and its world matrices current). */
  update(): void {
    for (const h of [this.left, this.right]) {
      h.tracked = false;
      h.pad = null;
    }
    for (const e of this.spaces) {
      const h = e.side === "left" ? this.left : e.side === "right" ? this.right : null;
      if (!h) continue;
      const joints = e.space.joints as Partial<Record<string, THREE.XRJointSpace>>;
      const wrist = joints["wrist"];
      if (!wrist || !wrist.visible) continue;
      let ok = true;
      for (let i = 0; i < JOINTS.length; i++) {
        const j = joints[JOINTS[i]];
        if (!j) {
          ok = false;
          break;
        }
        j.getWorldPosition(h.joint[i]);
        h.radius[i] = j.jointRadius ?? 0.008;
      }
      if (!ok) continue;
      h.tracked = true;
      // Palm frame from the middle metacarpal joint: -Y of a joint pose points out of the palm.
      joints["middle-finger-metacarpal"]!.getWorldQuaternion(_q);
      h.palmNormal.set(0, -1, 0).applyQuaternion(_q);
      h.palm.copy(h.wrist).lerp(h.joint[J["middle-finger-phalanx-proximal"]], 0.55).addScaledVector(h.palmNormal, 0.025);
      const d = h.thumbTip.distanceTo(h.indexTip);
      h.pinch = 1 - THREE.MathUtils.smoothstep(d, 0.012, 0.045);
      h.pinchPoint.copy(h.thumbTip).lerp(h.indexTip, 0.5);
      const was = h.pinching;
      h.pinching = was ? d < 0.035 : d < 0.02;
      h.pinchStart = h.pinching && !was;
      h.pinchEnd = !h.pinching && was;
    }
    for (const p of this.pads) {
      if (!p.side || !p.source?.gamepad || !p.grip.visible) continue;
      const h = p.side === "left" ? this.left : this.right;
      if (h.tracked) continue;
      h.pad = p.source.gamepad;
      p.grip.getWorldPosition(h.palm);
      p.grip.getWorldQuaternion(h.gripQ);
      h.palmNormal.set(0, 0, -1).applyQuaternion(h.gripQ);
      // Trigger = pinch, so the sun and the menu work the same way with pads.
      const trig = h.pad.buttons[0]?.value ?? 0;
      h.pinch = trig;
      const was = h.pinching;
      h.pinching = was ? trig > 0.35 : trig > 0.6;
      h.pinchStart = h.pinching && !was;
      h.pinchEnd = !h.pinching && was;
      h.pinchPoint.copy(h.palm).addScaledVector(h.palmNormal, 0.04);
      for (const v of h.joint) v.copy(h.pinchPoint);
      h.indexTip.copy(h.pinchPoint);
      h.thumbTip.copy(h.pinchPoint);
    }
    this.draw();
  }

  private draw(): void {
    let nb = 0, nr = 0;
    for (const h of [this.left, this.right]) {
      if (!h.tracked) continue;
      for (let i = 0; i < JOINTS.length; i++) {
        const r = h.radius[i] * (i === J.wrist ? 1.3 : 1.12);
        _m.compose(h.joint[i], _q.identity(), _s.setScalar(r));
        this.beads.setMatrixAt(nb, _m);
        this.beadInk.setMatrixAt(nb++, _m);
      }
      // Palm pad: a flattened bead filling the space between the palm rays.
      _w.subVectors(h.joint[J["middle-finger-phalanx-proximal"]], h.wrist);
      const len = _w.length();
      _v.copy(h.wrist).addScaledVector(_w, 0.55).addScaledVector(h.palmNormal, -0.004);
      _m.lookAt(_v, _v.clone().add(h.palmNormal), _w.normalize());
      _q.setFromRotationMatrix(_m);
      _m.compose(_v, _q, _s.set(0.036, len * 0.5, 0.011));
      this.beads.setMatrixAt(nb, _m);
      this.beadInk.setMatrixAt(nb++, _m);
      for (const [a, b] of BONES) {
        _w.subVectors(h.joint[b], h.joint[a]);
        const l = _w.length();
        if (l < 1e-4) continue;
        _q.setFromUnitVectors(_up, _w.divideScalar(l));
        const r = Math.min(h.radius[a], h.radius[b]) * 1.02;
        _m.compose(_v.addVectors(h.joint[a], h.joint[b]).multiplyScalar(0.5), _q, _s.set(r, l, r));
        this.rods.setMatrixAt(nr, _m);
        this.rodInk.setMatrixAt(nr++, _m);
      }
    }
    this.beads.count = this.beadInk.count = nb;
    this.rods.count = this.rodInk.count = nr;
    for (const m of [this.beads, this.beadInk, this.rods, this.rodInk]) m.instanceMatrix.needsUpdate = true;
    this.group.visible = nb > 0;
  }
}

/** Cel-shaded skin (two bands + rim) or its ink hull, in the scene's MRT output convention. */
function handMaterial(skin: THREE.Color, ink: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: ink ? THREE.BackSide : THREE.FrontSide,
    uniforms: {
      uSunDir: G.uSunDir,
      uSunColor: G.uSunColor,
      uShadowTint: G.uShadowTint,
      uSkyMid: G.uSkyMid,
      uWorldTint: G.uWorldTint,
      uCol: { value: skin },
    },
    vertexShader: /* glsl */ `
      out vec3 vN; out vec3 vW;
      void main(){
        mat4 m = modelMatrix * instanceMatrix;
        vec3 n = normalize(mat3(m) * normal);
        vec4 w = m * vec4(position, 1.0);
        ${ink ? "w.xyz += n * 0.0022;" : ""}
        vN = n; vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uSunColor, uShadowTint, uSkyMid, uWorldTint, uCol;
      in vec3 vN; in vec3 vW;
      layout(location = 0) out vec4 gColor;
      layout(location = 1) out vec4 gNormal;
      void main(){
        ${
          ink
            ? "gColor = vec4(vec3(0.045, 0.026, 0.018) * uWorldTint, 1.0);"
            : `vec3 N = normalize(vN);
        float t = dot(N, uSunDir);
        vec3 lit = uCol * uSunColor;
        vec3 sh = uCol * vec3(0.9, 0.75, 0.7) * mix(uShadowTint, vec3(1.0), 0.35);
        vec3 c = mix(sh, lit, smoothstep(0.0, 0.08, t)) + uCol * uSkyMid * 0.1;
        float fr = 1.0 - max(dot(N, normalize(cameraPosition - vW)), 0.0);
        c += vec3(1.0, 0.85, 0.7) * smoothstep(0.62, 0.8, fr) * 0.12;
        gColor = vec4(c * uWorldTint, 1.0);`
        }
        gNormal = vec4(0.5, 0.5, 0.0, 0.0);
      }`,
  });
}
