import * as THREE from "three";
import type { Hands } from "./hands";
import { INK, Panel, text, washiCard } from "./ui";

export interface MenuItem {
  label: () => string;
  act: () => void;
}

const W = 0.15, ROW = 0.034, PAD = 0.02;
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Palm-up wrist menu: turn the left palm toward your face and a small card opens above the wrist.
 * Poke a row with the right index finger. Only when the left hand is off the bars.
 */
export class WristMenu {
  readonly group = new THREE.Group();
  private panel: Panel;
  private open = 0;
  private hot = -1;
  private flash = 0;
  private armed = true;
  shown = false;

  constructor(private items: MenuItem[]) {
    const H = PAD * 2 + ROW * items.length + 0.02;
    this.panel = new Panel(W, H, 512, (g, pw, ph) => {
      washiCard(g, pw, ph, 36);
      const s = pw / W;
      text(g, "Summer Cycle", pw / 2, (PAD * 0.9) * s, 26, pw * 0.8, "rgba(58, 42, 34, 0.6)", 400, 0.2);
      items.forEach((it, i) => {
        const y = (PAD + 0.02 + ROW * i) * s;
        if (i === this.hot) {
          g.fillStyle = this.flash > 0 ? "rgba(214, 140, 72, 0.42)" : "rgba(214, 160, 96, 0.2)";
          g.beginPath();
          g.roundRect(pw * 0.07, y + 4, pw * 0.86, ROW * s - 8, 18);
          g.fill();
        }
        text(g, it.label(), pw / 2, y + (ROW * s) / 2, 40, pw * 0.8, INK);
      });
    });
    this.group.add(this.panel.mesh);
    this.panel.opacity = 0;
  }

  refresh(): void {
    this.panel.redraw();
  }

  update(dt: number, hands: Hands, head: THREE.Vector3, leftOnBar: boolean): void {
    const L = hands.left, Rt = hands.right;
    let want = false;
    if (L.tracked && !leftOnBar) {
      _v.subVectors(head, L.palm);
      const d = _v.length();
      want = d < 0.6 && L.palmNormal.dot(_v.divideScalar(d)) > (this.shown ? 0.45 : 0.65);
    }
    this.open += ((want ? 1 : 0) - this.open) * Math.min(1, dt * 9);
    this.shown = this.open > 0.5;
    this.panel.opacity = this.open;
    if (this.open < 0.02) return;
    // Hover above the wrist, a little toward the thumb, facing the eyes.
    const m = this.panel.mesh;
    m.position.copy(L.wrist).addScaledVector(L.palmNormal, 0.05).add(_n.set(0, 0.1, 0));
    m.lookAt(head);
    m.scale.setScalar(0.8 + 0.2 * this.open);
    this.flash = Math.max(0, this.flash - dt);
    // Poke: the right index tip crossing the card plane inside a row.
    let hot = -1;
    if (Rt.tracked && this.shown) {
      const p = m.worldToLocal(_v.copy(Rt.indexTip));
      const H = this.panel.h;
      const row = Math.floor((H / 2 - p.y - PAD - 0.02) / ROW);
      const inside = Math.abs(p.x) < W * 0.43 && row >= 0 && row < this.items.length;
      if (inside && Math.abs(p.z) < 0.03) hot = row;
      if (inside && p.z < 0.008 && p.z > -0.03 && this.armed) {
        this.armed = false;
        this.flash = 0.25;
        this.items[row].act();
      }
      if (p.z > 0.02 || !inside) this.armed = true;
    }
    if (hot !== this.hot || this.flash > 0) {
      this.hot = hot;
      this.panel.redraw();
    }
  }
}
