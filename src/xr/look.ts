import * as THREE from "three";
import { G } from "../render/materials";

/**
 * The headset's own look: ink on outlined surfaces (materials.ts, `uXRLook`), a glow around a low
 * sun, a painted sky wash and a dithered output (grade.ts). The desktop gets these from its post
 * chain. `?xrlook=0` keeps the plain headset render for comparisons.
 */
export const XR_LOOK = new URLSearchParams(location.search).get("xrlook") !== "0";

const _c = new THREE.Color();

/**
 * Bloom stand-in: a soft additive glow around the sun, drawn at infinity on top of the scene the way
 * glare veils whatever stands in front of a low sun. Strongest at golden hour and sunset, gone in
 * the high afternoon (the sun is behind her) and once it has set. One draw, hidden when dark.
 */
export class SunGlow {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSkySun: G.uSkySun, uColor: { value: new THREE.Color() }, uAmt: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform vec3 uSkySun;
        out vec2 vQ;
        void main(){
          vQ = position.xy * 2.0;
          // 3 km out toward the sun (no parallax between the eyes), facing the eye, ~46° across.
          vec3 c = cameraPosition + uSkySun * 3000.0;
          vec3 rt = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          gl_Position = projectionMatrix * viewMatrix * vec4(c + (rt * position.x + up * position.y) * 2550.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAmt;
        in vec2 vQ;
        layout(location = 0) out vec4 o;
        void main(){
          float r2 = dot(vQ, vQ);
          if (r2 > 1.0) discard;
          float r = sqrt(r2);
          float g = exp(-r2 * 90.0) * 0.9 + exp(-r2 * 12.0) * 0.5 + (1.0 - r) * (1.0 - r) * 0.22;
          o = vec4(uColor * g * uAmt, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.name = "xr-sun-glow";
  }

  /** Follow the time of day: the sun disk's strength, its glow colour, and the horizon. */
  update(): void {
    const d = G.uSunDisk.value;
    const disk = Math.min(1, (d.r * 0.2126 + d.g * 0.7152 + d.b * 0.0722) / 1.9);
    const up = THREE.MathUtils.smoothstep(G.uSkySun.value.y, -0.06, 0.05);
    const amt = disk * up * 0.75;
    this.mat.uniforms.uAmt.value = amt;
    // Display-ready colour (this material skips the grade): the sky's warm sun glow, lightened.
    _c.copy(G.uSunGlow.value).lerp(G.uHorizGlow.value, 0.25);
    this.mat.uniforms.uColor.value.setRGB(Math.sqrt(_c.r), Math.sqrt(_c.g), Math.sqrt(_c.b));
    this.mesh.visible = amt > 0.004;
  }
}
