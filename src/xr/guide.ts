import * as THREE from "three";
import { INK, Panel, text, washiCard } from "./ui";

/** Distance from the opening spot to the red torii on the second lap (m): about three minutes. */
export const JOURNEY = 772;

export type Step = "hold" | "brake" | "bell" | "sun" | "ride" | "near" | "arrive" | "free";

const COPY: Record<Step, [string, string]> = {
  hold: ["Summer Cycle", "Rest both hands on the handlebars to ride"],
  brake: ["Easy does it", "Pinch thumb and finger to brake. Let go of the bars to coast."],
  bell: ["Say hello", "Tap the little bell by your left hand"],
  sun: ["Late summer light", "Reach up, pinch the sun and pull it down toward the hills"],
  ride: ["Ride to the shrine", ""],
  near: ["Nearly there", "Slow down by the red torii"],
  arrive: ["The end of summer", "The lanterns are coming on. Stay as long as you like."],
  free: ["", ""],
};

export interface GuideState {
  held: number;
  rang: boolean;
  sunPos: number;
  sunMoved: number;
  dist: number;
  speed: number;
}

/**
 * The short guided ride: hands on the bars, brake, bell, drag the sun, then on to the shrine for
 * the ending. Each prompt is a washi card floating over the basket, inside a narrow field of view.
 */
export class Guide {
  readonly group = new THREE.Group();
  step: Step = "hold";
  private t = 0;
  private panel: Panel;
  private body = "";
  private title = "";
  private shownK = 0;
  /** Set on the frame the ride arrives (the XR mode plays the ending). */
  arrived = false;

  constructor() {
    this.panel = new Panel(0.42, 0.13, 1024, (g, w, h) => {
      if (!this.title && !this.body) return;
      washiCard(g, w, h);
      if (this.title) text(g, this.title, w / 2, h * (this.body ? 0.33 : 0.5), 58, w * 0.86, INK, 400, 0.08);
      if (this.body) text(g, this.body, w / 2, h * (this.title ? 0.68 : 0.5), 40, w * 0.88, "rgba(58, 42, 34, 0.82)");
    });
    // Above the basket, a touch below eye level, tilted up to face her.
    this.panel.mesh.position.set(0, 1.27, -0.78);
    this.panel.mesh.rotation.x = 0.28;
    this.group.add(this.panel.mesh);
    this.set("hold");
  }

  reset(): void {
    this.arrived = false;
    this.set("hold");
  }

  private set(s: Step): void {
    this.step = s;
    this.t = 0;
    this.show(...COPY[s]);
  }

  private show(title: string, body: string): void {
    if (title === this.title && body === this.body) return;
    this.title = title;
    this.body = body;
    this.panel.redraw();
  }

  update(dt: number, g: GuideState): void {
    this.t += dt;
    const left = Math.max(0, JOURNEY - g.dist);
    const next = (s: Step) => this.set(s);
    switch (this.step) {
      case "hold":
        if (g.held > 0.6) next("brake");
        break;
      case "brake":
        if (this.t > 8) next("bell");
        break;
      case "bell":
        if (g.rang || this.t > 30) next("sun");
        break;
      case "sun":
        if ((g.sunPos >= 1.6 && g.sunMoved > 0.5) || this.t > 45) next("ride");
        break;
      case "ride":
        this.show(COPY.ride[0], `${Math.round(left / 10) * 10} m to go, on past the shops`);
        if (left < 110) next("near");
        break;
      case "near":
        if (left <= 0) {
          this.arrived = true;
          next("arrive");
        }
        break;
      case "arrive":
        if (this.t > 14) {
          this.show("Ride on", "Hands on the bars whenever you like. Palm up for the menu.");
          if (this.t > 22) next("free");
        }
        break;
    }
    // Cards fade out while riding once read (the distance card stays short), fade back on change.
    const quiet = (this.step === "ride" && this.t > 6 && left > 110) || this.step === "free";
    this.shownK += ((quiet ? 0 : 1) - this.shownK) * Math.min(1, dt * 3);
    this.panel.opacity = this.shownK * Math.min(1, this.t * 2.5);
  }

  /** Metres left to the torii (0 after arriving). */
  static left(dist: number): number {
    return Math.max(0, JOURNEY - dist);
  }
}
