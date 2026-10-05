import * as THREE from "three";

/**
 * Headset ink for faceted props (houses, fences, poles, signs). The desktop finds its lines in a
 * post pass the headset can't afford, so every triangle corner carries `aEdge`: per corner, which
 * of the triangle's edges are hard (a crease between faces that don't share vertex normals, or an
 * open border). The uber shader turns it into a distance in pixels to the nearest hard edge and
 * inks along it. Smooth seams (round poles, blobs) get no line; their silhouettes come from the
 * contour ink. A missing attribute reads (0, 0, 0): no edges.
 *
 * Returns a non-indexed copy (each corner needs its own value).
 */
export function withEdges(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const P = g.attributes.position.array as Float32Array;
  const N = g.attributes.normal.array as Float32Array;
  const nv = P.length / 3, nt = Math.floor(nv / 3);
  // Weld corners that share a position (to the millimetre).
  const ids = new Int32Array(nv);
  const weld = new Map<string, number>();
  for (let v = 0; v < nv; v++) {
    const k = `${Math.round(P[v * 3] * 1000)},${Math.round(P[v * 3 + 1] * 1000)},${Math.round(P[v * 3 + 2] * 1000)}`;
    let id = weld.get(k);
    if (id === undefined) weld.set(k, (id = weld.size));
    ids[v] = id;
  }
  // Slot s = triangle t, edge opposite corner i. Slots on the same welded edge are chained.
  const slots = nt * 3;
  const ea = new Int32Array(slots), eb = new Int32Array(slots), next = new Int32Array(slots).fill(-1);
  const head = new Map<number, number>();
  for (let s = 0; s < slots; s++) {
    const t = s - (s % 3), i = s % 3;
    let a = t + ((i + 1) % 3), b = t + ((i + 2) % 3);
    if (ids[a] > ids[b]) [a, b] = [b, a];
    ea[s] = a;
    eb[s] = b;
    if (ids[a] === ids[b]) continue;
    const k = ids[a] * 4194304 + ids[b];
    const h = head.get(k);
    if (h !== undefined) next[s] = h;
    head.set(k, s);
  }
  const same = (u: number, v: number) => N[u * 3] * N[v * 3] + N[u * 3 + 1] * N[v * 3 + 1] + N[u * 3 + 2] * N[v * 3 + 2] > 0.98;
  const hard = new Uint8Array(slots);
  for (const first of head.values())
    for (let s = first; s >= 0; s = next[s]) {
      // Smooth when another triangle shares the edge with the same normals at both ends.
      let smooth = false;
      for (let o = first; o >= 0 && !smooth; o = next[o]) if (o - (o % 3) !== s - (s % 3)) smooth = same(ea[s], ea[o]) && same(eb[s], eb[o]);
      hard[s] = smooth ? 0 : 1;
    }
  // Per corner c and edge i: 1 - barycentric(i) on hard edges (0 at corner i, 1 on the far edge).
  const E = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++)
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < 3; i++) E[(t * 3 + c) * 3 + i] = hard[t * 3 + i] && c !== i ? 1 : 0;
  g.setAttribute("aEdge", new THREE.BufferAttribute(E, 3));
  return g;
}
