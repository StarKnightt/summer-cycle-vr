import * as THREE from "three";
import type { World } from "../world/chunks";

/** Radii (m) around the rider for the headset's instanced scenery. */
export interface ProxyRadii {
  /** Hero leaf-card trees. */
  hero: number;
  /** Lobed trees (hero trees further out, and the distant tree stands). */
  trees: number;
  /** Grass, rice, flowers, plants: fine detail that fades out by shrinking into the ground. */
  fine: number;
  /** Bamboo, rocks and anything else instanced. */
  other: number;
}

/** One chunk InstancedMesh, its instances sorted by local z for a range search. */
interface Source {
  chunk: THREE.Object3D;
  z: Float32Array;
  x: Float32Array;
  m: Float32Array;
  c: Float32Array | null;
  /** Proxy for the near band and (trees) the far band. */
  near: Proxy | null;
  far: Proxy | null;
  rNear: number;
  rFar: number;
  fade: boolean;
}

interface Proxy {
  mesh: THREE.InstancedMesh;
  n: number;
}

/**
 * Headset scenery instancing. Each chunk carries dozens of InstancedMeshes (one per plant, tree
 * and grass variant), and a chunk only knows its distance as a whole, so the one she rides through
 * always draws everything it holds. Here every distinct (geometry, material) pair gets a single
 * world-space InstancedMesh, refilled as she moves with only the instances within its radius, taken
 * from all chunks at once: a few dozen draws instead of a few hundred, a per-instance tree LOD
 * (leaf-card heroes close, lobed trees beyond), and grass and flowers that shrink into the ground
 * at the edge of their radius instead of popping.
 */
export class Proxies {
  readonly group = new THREE.Group();
  private sources: Source[] = [];
  private proxies = new Map<string, Proxy>();
  private lastX = NaN;
  private lastZ = NaN;
  active = false;

  constructor(private world: World, private r: ProxyRadii) {
    this.group.name = "xr-proxies";
    this.group.visible = false;
    for (const c of world.chunks)
      for (const o of c.group.children) {
        const im = o as THREE.InstancedMesh;
        if (!im.isInstancedMesh) continue;
        const u = im.userData;
        const tree = !!u.far;
        const fine = u.cull !== undefined;
        const nearGeo = tree ? (u.near as THREE.BufferGeometry) : im.geometry;
        const near = this.proxy(nearGeo, im);
        const far = tree ? this.proxy(u.far as THREE.BufferGeometry, im) : null;
        const rNear = tree ? r.hero : u.distant ? r.trees : fine ? Math.min(r.fine, u.cull) : r.other;
        this.sources.push({ chunk: c.group, near, far, rNear, rFar: tree ? r.trees : 0, fade: fine, ...sortByZ(im) });
      }
    for (const p of this.proxies.values()) {
      p.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(p.n * 16), 16);
      p.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (p.mesh.instanceColor) {
        p.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(p.n * 3), 3);
        p.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      p.mesh.count = 0;
      this.group.add(p.mesh);
    }
  }

  get count(): number {
    return this.proxies.size;
  }

  private proxy(geo: THREE.BufferGeometry, src: THREE.InstancedMesh): Proxy {
    const mat = src.material as THREE.Material;
    const key = `${geo.uuid}|${mat.uuid}`;
    let p = this.proxies.get(key);
    if (!p) {
      const mesh = new THREE.InstancedMesh(geo, mat, 1);
      if (src.instanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
      mesh.layers.mask = src.layers.mask;
      mesh.frustumCulled = false;
      mesh.renderOrder = src.renderOrder;
      p = { mesh, n: 0 };
      this.proxies.set(key, p);
    }
    p.n += src.count;
    return p;
  }

  setActive(on: boolean): void {
    this.active = on;
    this.group.visible = on;
    this.world.setProxied(on);
    this.lastX = NaN;
  }

  /** Refill around (px, pz) once she has moved far enough to matter. */
  update(px: number, pz: number): void {
    if (!this.active) return;
    if (Math.hypot(px - this.lastX, pz - this.lastZ) < 0.75) return;
    this.lastX = px;
    this.lastZ = pz;
    for (const p of this.proxies.values()) p.mesh.count = 0;
    for (const s of this.sources) this.gather(s, px, pz);
    for (const p of this.proxies.values()) {
      p.mesh.visible = p.mesh.count > 0;
      p.mesh.instanceMatrix.clearUpdateRanges();
      p.mesh.instanceMatrix.addUpdateRange(0, p.mesh.count * 16);
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) {
        p.mesh.instanceColor.clearUpdateRanges();
        p.mesh.instanceColor.addUpdateRange(0, p.mesh.count * 3);
        p.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private gather(s: Source, px: number, pz: number): void {
    const oz = s.chunk.position.z;
    const R = Math.max(s.rNear, s.rFar);
    const lz = pz - oz;
    const zs = s.z;
    // Lower bound of lz - R.
    let lo = 0, hi = zs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (zs[mid] < lz - R) lo = mid + 1;
      else hi = mid;
    }
    const rn2 = s.rNear * s.rNear, rf2 = s.rFar * s.rFar;
    for (let i = lo; i < zs.length && zs[i] <= lz + R; i++) {
      const dx = s.x[i] - px, dz = zs[i] - lz;
      const d2 = dx * dx + dz * dz;
      let p: Proxy | null = null;
      if (d2 < rn2) p = s.near;
      else if (d2 < rf2) p = s.far;
      if (!p) continue;
      const k = p.mesh.count++;
      const dst = p.mesh.instanceMatrix.array as Float32Array;
      const o = k * 16, j = i * 16;
      // Fade at the outer edge of the band by shrinking into the ground: fine detail over its last
      // 30%, trees (and the distant stands) over the last 20% of the lobed radius.
      let f = 1;
      const edge = p === s.far ? s.rFar : s.rNear;
      const band = s.fade ? 0.3 : p === s.far || s.rFar === 0 ? 0.2 : 0;
      if (band > 0) {
        const d = Math.sqrt(d2), e = edge * band;
        f = d > edge - e ? Math.max(0.02, (edge - d) / e) : 1;
        f = f * f * (3 - 2 * f);
      }
      for (let q = 0; q < 12; q++) dst[o + q] = s.m[j + q] * f;
      dst[o + 12] = s.m[j + 12];
      dst[o + 13] = s.m[j + 13];
      dst[o + 14] = s.m[j + 14] + oz;
      dst[o + 15] = 1;
      if (s.c && p.mesh.instanceColor) {
        const cd = p.mesh.instanceColor.array as Float32Array;
        cd[k * 3] = s.c[i * 3];
        cd[k * 3 + 1] = s.c[i * 3 + 1];
        cd[k * 3 + 2] = s.c[i * 3 + 2];
      }
    }
  }
}

function sortByZ(im: THREE.InstancedMesh): Pick<Source, "z" | "x" | "m" | "c"> {
  const n = im.count;
  const src = im.instanceMatrix.array as Float32Array;
  const col = im.instanceColor?.array as Float32Array | undefined;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => src[a * 16 + 14] - src[b * 16 + 14]);
  const z = new Float32Array(n), x = new Float32Array(n), m = new Float32Array(n * 16);
  const c = col ? new Float32Array(n * 3) : null;
  order.forEach((i, k) => {
    m.set(src.subarray(i * 16, i * 16 + 16), k * 16);
    z[k] = src[i * 16 + 14];
    x[k] = src[i * 16 + 12];
    if (c && col) c.set(col.subarray(i * 3, i * 3 + 3), k * 3);
  });
  return { z, x, m, c };
}
