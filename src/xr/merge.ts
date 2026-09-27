import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Merge static meshes that share a material and a parent into one mesh in that parent's frame.
 * Animation lives on groups (wheels, crank, steer, basket, bouquet), so merging siblings keeps it.
 * `keep` protects meshes that change on their own (visibility, per-object uniforms).
 * Returns how many draws it saved.
 */
export function mergeSiblings(root: THREE.Object3D, keep: (m: THREE.Mesh) => boolean): number {
  let saved = 0;
  const groups: THREE.Object3D[] = [];
  root.traverse((o) => groups.push(o));
  for (const g of groups) {
    const buckets = new Map<THREE.Material, THREE.Mesh[]>();
    for (const c of g.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) continue;
      if (Array.isArray(m.material) || m.children.length || keep(m) || !m.visible) continue;
      const list = buckets.get(m.material) ?? [];
      list.push(m);
      buckets.set(m.material, list);
    }
    for (const [mat, list] of buckets) {
      if (list.length < 2) continue;
      const geos = list.map((m) => {
        m.updateMatrix();
        return m.geometry.clone().applyMatrix4(m.matrix);
      });
      const names = Object.keys(geos[0].attributes).sort().join();
      if (geos.some((q) => Object.keys(q.attributes).sort().join() !== names || !!q.index !== !!geos[0].index)) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const out = new THREE.Mesh(merged, mat);
      out.layers.mask = list[0].layers.mask;
      out.renderOrder = list[0].renderOrder;
      out.userData = { ...list[0].userData, merged: list.length };
      for (const m of list) g.remove(m);
      g.add(out);
      saved += list.length - 1;
    }
  }
  return saved;
}
