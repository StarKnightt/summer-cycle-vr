import * as THREE from "three";
import { TOD_GRADE } from "../render/todUniforms";
import { G } from "../render/materials";

/**
 * In the headset there is no room for the MRT + ink + bloom + grade chain: the scene draws straight
 * into the XR framebuffer. Every scene shader (the ones writing the colour + normal MRT pair) is
 * wrapped once so its colour output can take the warm grade and the sRGB encode itself when `uXR`
 * is 1. On the desktop `uXR` stays 0 and the output is untouched.
 */
export const XR_OUT = {
  uXR: { value: 0 },
  uXRGrade: { value: TOD_GRADE.uGradeMul.value },
  uXRSat: TOD_GRADE.uSat,
  /** The headset look switch (G.uXRLook) under its own name: scene shaders already declare that one. */
  uXRLookOut: G.uXRLook,
};

const OUT0 = /layout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+(\w+)\s*;/;
const MAIN = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/;

const WRAP = /* glsl */ `
uniform float uXR;
uniform vec3 uXRGrade;
uniform float uXRSat;
uniform float uXRLookOut;
vec3 xrSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float xrHash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// The desktop grade pass (post.ts) without its screen-space parts: tint, saturation, split tone, shoulder.
vec3 xrGrade(vec3 c){
  c *= uXRGrade;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uXRSat);
  c *= mix(vec3(0.96, 1.0, 1.04), vec3(1.0, 0.945, 0.85) * 1.04, smoothstep(0.08, 0.75, l));
  c = c / (1.0 + max(c - 0.85, 0.0) * 0.8);
  vec3 s = xrSRGB(c);
  // Triangular dither of one 8-bit step: the dusk sky and the fog gradients band on the panel
  // otherwise. Fixed per pixel, so it never crawls.
  s += (xrHash(gl_FragCoord.xy) + xrHash(gl_FragCoord.xy + 57.1) - 1.0) * (uXRLookOut / 255.0);
  return clamp(s, 0.0, 1.0);
}
`;

function wrap(shader: THREE.WebGLProgramParametersWithUniforms): void {
  const fs = shader.fragmentShader;
  if (!/out\s+vec4\s+gNormal\b/.test(fs)) return;
  const m = OUT0.exec(fs);
  if (!m || !MAIN.test(fs)) return;
  const name = m[1];
  shader.fragmentShader =
    fs.replace(OUT0, `layout(location = 0) out vec4 xrOut0;\nvec4 ${name};`).replace(MAIN, "void xrMain()") +
    `${WRAP}\nvoid main(){ ${name} = vec4(0.0); xrMain(); xrOut0 = uXR > 0.5 ? vec4(xrGrade(${name}.rgb), ${name}.a) : ${name}; }\n`;
  Object.assign(shader.uniforms, XR_OUT);
}

/**
 * Install the wrapper for every material compiled from now on. Must run before the first compile:
 * the same programs then serve the desktop MRT pass and the headset.
 */
export function installXrOutput(): void {
  const base = THREE.Material.prototype.onBeforeCompile;
  THREE.Material.prototype.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    base.call(this, shader, renderer);
    if ((this as THREE.ShaderMaterial).isShaderMaterial && (this as THREE.ShaderMaterial).glslVersion === THREE.GLSL3) wrap(shader);
  };
}
