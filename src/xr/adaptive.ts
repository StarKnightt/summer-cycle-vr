import type { ProxyRadii } from "./proxies";

/** One headset quality level. Every knob is a count, a radius or a uniform: nothing recompiles. */
export interface Level {
  name: string;
  radii: ProxyRadii;
  /** Keep every n-th fine-detail instance (grass, flowers), fading the rest out. */
  thin: number;
  /** Sun shadow refresh cadence in frames; 0 = no sun shadow. */
  shadowEvery: number;
  /** Whole chunks past this distance (m) are hidden. */
  far: number;
  foveation: number;
}

/**
 * The ladder, lightest last. L0 is the full tier (Quest default or xrlite); a session may start
 * lower (Quest 2, or a headset that struggled before). The framebuffer scale can't change
 * mid-session, so the steps trade detail radii, shadow cadence, view distance and grass density;
 * a headset still under the target at L4 gets a smaller framebuffer next session (Memory).
 */
export function levels(base: { radii: ProxyRadii; shadowEvery: number; shadow: boolean; far: number; foveation: number }): Level[] {
  return [
    { name: "L0", radii: base.radii, thin: 1, shadowEvery: base.shadow ? base.shadowEvery : 0, far: base.far, foveation: base.foveation },
    { name: "L1", radii: { hero: 12, trees: 62, fine: 14, other: 38 }, thin: 1, shadowEvery: base.shadow ? 3 : 0, far: Math.min(base.far, 180), foveation: 1 },
    { name: "L2", radii: { hero: 10, trees: 60, fine: 12, other: 30 }, thin: 1, shadowEvery: 0, far: Math.min(base.far, 140), foveation: 1 },
    { name: "L3", radii: { hero: 6, trees: 45, fine: 9, other: 20 }, thin: 2, shadowEvery: 0, far: 100, foveation: 1 },
    { name: "L4", radii: { hero: 4, trees: 34, fine: 6.5, other: 14 }, thin: 2, shadowEvery: 0, far: 80, foveation: 1 },
  ];
}

/**
 * What earlier sessions on this headset learned (localStorage): a framebuffer scale step for the
 * next session (the scale is fixed while presenting) and the level to start on.
 */
export interface Memory {
  step: number;
  start: number;
}
const KEY = "summer-cycle-vr:xr-quality";
export function loadMemory(): Memory {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Memory> | null;
    if (m && Number.isFinite(m.step) && Number.isFinite(m.start)) return { step: m.step!, start: m.start! };
  } catch {
    /* private mode, bad value */
  }
  return { step: 0, start: 0 };
}
export function saveMemory(m: Memory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode */
  }
}

/** Seconds of frames averaged for a step-down decision, and the fps margin under the target. */
const WINDOW = 2.5;
const MARGIN = 0.9;
/** Frames are ignored this long after entering or resuming (s), and after a level change. */
const SETTLE = 2;
const SETTLE_STEP = 3;
/** Step up only after this long at a level with steady headroom (s); doubled after a bounce. */
const UP_AFTER = 10;
const UP_WINDOW = 4;

/**
 * Automatic quality for the headset. Frame intervals come from the XR frame loop; a sustained
 * (2.5 s) window under the display rate (minus a margin) steps one level lighter. Stepping back up needs
 * several seconds of clear headroom and at least UP_AFTER seconds at the level, and a level that
 * had to be left again soon after stepping up is not retried for twice as long.
 */
export class Adaptive {
  level = 0;
  readonly ladder: Level[];
  /** Display target (Hz), from the session when it reports one. */
  target = 72;
  /** Last measured average fps (for the readout). */
  fps = 0;
  private hold = SETTLE;
  private at = 0;
  private win: number[] = [];
  private winSum = 0;
  private check = 0;
  private upWait = UP_AFTER;
  private lastUp = -1;
  private t = 0;
  /** Timeline of changes (tests, readout). */
  readonly log: string[] = [];
  /** Emulator test: busy-wait this many ms per frame, scaled by the scene's triangle count. */
  slow = 0;
  /** Still under the target at the lightest level (the next session should start lighter). */
  struggling = false;
  /** The lightest level reached this session. */
  deepest = 0;

  constructor(ladder: Level[], private apply: (l: Level, index: number) => void, start = 0) {
    this.ladder = ladder;
    this.level = start;
  }

  /** Seconds of headset frames since the session started. */
  get sessionT(): number {
    return this.t;
  }

  get current(): Level {
    return this.ladder[this.level];
  }

  /** Ignore frames for a while (entering, resuming from pause). */
  settle(s = SETTLE): void {
    this.hold = Math.max(this.hold, s);
    this.win.length = 0;
    this.winSum = 0;
  }

  /** Session (re)started: back to the start level with a fresh history. */
  reset(start: number, targetHz: number): void {
    this.target = targetHz;
    this.upWait = UP_AFTER;
    this.lastUp = -1;
    this.at = 0;
    this.t = 0;
    this.struggling = false;
    this.deepest = start;
    this.set(start, "session start");
  }

  /** Test hook: jump to a level. */
  force(i: number): void {
    this.set(Math.max(0, Math.min(this.ladder.length - 1, i)), "forced");
  }

  private set(i: number, why: string): void {
    this.level = i;
    this.deepest = Math.max(this.deepest, i);
    this.at = 0;
    // Let the new level's own frame time fill the window before judging it.
    this.settle(SETTLE_STEP);
    this.log.push(`${this.t.toFixed(1)}s ${this.ladder[i].name} (${why})`);
    if (this.log.length > 40) this.log.shift();
    this.apply(this.ladder[i], i);
  }

  /** One XR frame: `interval` ms since the previous one. */
  tick(interval: number): void {
    const dt = interval / 1000;
    this.t += dt;
    this.at += dt;
    // Stalls (a hidden page, a GC, a capture tool) say nothing about the steady frame cost.
    if (interval <= 0 || interval > 250) return;
    if (this.hold > 0) {
      this.hold -= dt;
      return;
    }
    this.win.push(dt);
    this.winSum += dt;
    const span = Math.max(WINDOW, UP_WINDOW);
    while (this.winSum > span && this.win.length > 1) this.winSum -= this.win.shift()!;
    this.check += dt;
    if (this.check < 0.5) return;
    this.check = 0;
    // Average fps over the last WINDOW seconds.
    let s = 0, n = 0;
    for (let i = this.win.length - 1; i >= 0 && s < WINDOW; i--) (s += this.win[i]), n++;
    if (s < WINDOW * 0.9) return;
    this.fps = n / s;
    if (this.fps < this.target * MARGIN && this.level < this.ladder.length - 1) {
      // Left a level soon after climbing into it: that level is too heavy, wait longer next time.
      if (this.lastUp >= 0 && this.t - this.lastUp < UP_AFTER * 1.5) this.upWait = Math.min(this.upWait * 2, 60);
      this.set(this.level + 1, `${this.fps.toFixed(0)} fps < ${(this.target * MARGIN).toFixed(0)}`);
      return;
    }
    if (this.fps < this.target * MARGIN && !this.struggling) {
      this.struggling = true;
      this.log.push(`${this.t.toFixed(1)}s still ${this.fps.toFixed(0)} fps at ${this.current.name}`);
    }
    if (this.level > 0 && this.at >= this.upWait && this.winSum >= UP_WINDOW * 0.9) {
      // Headroom: the whole up-window ran at or near the target, with no slow frames at all.
      const avg = this.win.length / this.winSum;
      let worst = 0;
      for (const w of this.win) worst = Math.max(worst, w);
      if (avg >= this.target * 0.97 && worst < (1000 / this.target) * 1.5 / 1000) {
        this.lastUp = this.t;
        this.set(this.level - 1, `${avg.toFixed(0)} fps headroom`);
      }
    }
  }
}
