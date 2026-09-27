import * as THREE from "three";
import { Panel, text } from "./ui";

/**
 * Head-locked comfort vignette: a sphere around the eyes that darkens the edge of view while the
 * bike turns (and a little while it changes speed). Child of the XR camera.
 */
export class Vignette {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private k = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: { uAmt: { value: 0 }, uInner: { value: 0.9 } },
      vertexShader: /* glsl */ `out vec3 vL; void main(){ vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uAmt, uInner; in vec3 vL;
        layout(location = 0) out vec4 o;
        void main(){
          float a = acos(clamp(dot(normalize(vL), vec3(0.0, 0.0, -1.0)), -1.0, 1.0));
          float k = smoothstep(uInner, uInner + 0.38, a) * uAmt;
          if (k < 0.004) discard;
          o = vec4(0.035, 0.028, 0.022, k);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
  }

  /** `turn` = |yaw rate| rad/s, `accel` = |dv/dt| m/s². Comfort mode starts sooner and closes tighter. */
  update(dt: number, turn: number, accel: number, comfort: boolean): void {
    const want = Math.min(1, THREE.MathUtils.smoothstep(turn, 0.04, comfort ? 0.3 : 0.5) + THREE.MathUtils.smoothstep(accel, 0.5, 2.5) * 0.4);
    this.k += (want - this.k) * Math.min(1, dt * (want > this.k ? 6 : 2.5));
    this.mat.uniforms.uAmt.value = this.k * (comfort ? 0.92 : 0.6);
    // Inner edge: from ~55° off-axis (open) down to ~32° (strong).
    this.mat.uniforms.uInner.value = THREE.MathUtils.lerp(0.96, comfort ? 0.56 : 0.72, this.k);
    this.mesh.visible = this.mat.uniforms.uAmt.value > 0.004;
  }

  get amount(): number {
    return this.k;
  }
}

/** Small head-locked fps readout (?xrfps=1, or the wrist menu). */
export class FpsMeter {
  readonly panel: Panel;
  private frames = 0;
  private acc = 0;
  fps = 0;
  calls = 0;

  constructor() {
    this.panel = new Panel(0.13, 0.034, 384, (g, w, h) => {
      g.fillStyle = "rgba(20, 16, 12, 0.6)";
      g.beginPath();
      g.roundRect(0, 0, w, h, 14);
      g.fill();
      text(g, `${Math.round(this.fps)} fps  ${this.calls} calls`, w / 2, h / 2, 40, w * 0.9, this.fps >= 70 ? "#cfe8b0" : this.fps >= 58 ? "#f1d58a" : "#f09a80");
    });
    this.panel.mesh.position.set(0.12, -0.14, -0.6);
    this.panel.mesh.renderOrder = 1001;
    (this.panel.mesh.material as THREE.ShaderMaterial).depthTest = false;
  }

  tick(dt: number, calls: number): void {
    this.frames++;
    this.acc += dt;
    if (this.acc >= 0.5) {
      this.fps = this.frames / this.acc;
      this.calls = calls;
      this.frames = 0;
      this.acc = 0;
      if (this.panel.mesh.visible) this.panel.redraw();
    }
  }
}
