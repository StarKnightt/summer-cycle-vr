import * as THREE from "three";

/**
 * Headset UI surfaces. These shaders write display-ready colour (they are not scene surfaces and
 * skip the grade wrapper), so washi cream and ink brown come out exactly as drawn on the canvas.
 */

export const INK = "#3a2a22";
export const WASHI = "rgba(246, 239, 220, 0.94)";
export const SERIF = '"Georgia", "Times New Roman", serif';

/** A canvas-textured card, `w` metres wide; `draw` paints it (call `redraw` after state changes). */
export class Panel {
  readonly mesh: THREE.Mesh;
  readonly canvas = document.createElement("canvas");
  readonly ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private mat: THREE.ShaderMaterial;

  constructor(
    readonly w: number,
    readonly h: number,
    px: number,
    private draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  ) {
    this.canvas.width = px;
    this.canvas.height = Math.round((px * h) / w);
    this.ctx = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.anisotropy = 4;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      uniforms: { uMap: { value: this.tex }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `out vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform float uOpacity; in vec2 vUv;
        layout(location = 0) out vec4 o;
        void main(){ vec4 c = texture(uMap, vUv); o = vec4(c.rgb, c.a * uOpacity); if (o.a < 0.01) discard; }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat);
    this.mesh.renderOrder = 10;
    this.redraw();
  }

  set opacity(v: number) {
    this.mat.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.01;
  }
  get opacity(): number {
    return this.mat.uniforms.uOpacity.value;
  }

  redraw(): void {
    const { width: W, height: H } = this.canvas;
    this.ctx.clearRect(0, 0, W, H);
    this.draw(this.ctx, W, H);
    this.tex.needsUpdate = true;
  }
}

/** Washi card background: rounded, a faint deckle edge and paper fibre. */
export function washiCard(g: CanvasRenderingContext2D, W: number, H: number, r = H * 0.16): void {
  g.save();
  g.beginPath();
  g.roundRect(4, 4, W - 8, H - 8, r);
  g.fillStyle = WASHI;
  g.shadowColor = "rgba(40, 28, 18, 0.25)";
  g.shadowBlur = 8;
  g.fill();
  g.shadowBlur = 0;
  g.clip();
  // Fibres: a few hundred faint short strokes, seeded so the card never flickers on redraw.
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = "rgba(120, 96, 70, 0.07)";
  g.lineWidth = 1;
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * 14, y + Math.sin(a) * 14);
    g.stroke();
  }
  g.restore();
}

/** Centered text line; shrinks to fit `maxW`. */
export function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, maxW: number, color = INK, weight = 400, spacing = 0): void {
  let px = size;
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (;;) {
    g.font = `${weight} ${px}px ${SERIF}`;
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing * px}px`;
    if (g.measureText(s).width <= maxW || px < 10) break;
    px -= 2;
  }
  g.fillText(s, x, y);
}

/** Soft additive glow (billboard disc or ring), display-ready colour. */
export function glowMaterial(color: THREE.Color, ring = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: color }, uAmt: { value: 1 } },
    vertexShader: /* glsl */ `out vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAmt; in vec2 vUv;
      layout(location = 0) out vec4 o;
      void main(){
        float r = length(vUv - 0.5) * 2.0;
        float a = ${ring ? "smoothstep(0.62, 0.8, r) * (1.0 - smoothstep(0.84, 1.0, r))" : "pow(max(1.0 - r, 0.0), 2.2)"};
        o = vec4(uColor * a * uAmt, 1.0);
      }`,
  });
}

/** Flat display-ready colour (arcs, dots, markers). */
export function flatMaterial(color: THREE.Color, opacity = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    uniforms: { uColor: { value: color }, uOpacity: { value: opacity } },
    vertexShader: /* glsl */ `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity;
      layout(location = 0) out vec4 o;
      void main(){ o = vec4(uColor, uOpacity); }`,
  });
}

/** sRGB hex as the raw display value (these materials skip colour management). */
export const disp = (hex: string) => new THREE.Color().setStyle(hex, THREE.NoColorSpace);
