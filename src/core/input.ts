export interface XrRideInput {
  /** At least one hand on the bars: she pedals toward `cruise`. Hands off: a gentle coast to a stop. */
  ride: boolean;
  /** -1 (right) … 1 (left), the bars' turn. */
  steer: number;
  /** 0…1 brake. */
  brake: number;
  /** Target riding speed (m/s) and how fast she gets there (m/s²). */
  cruise: number;
  accel: number;
  /** 0…1 lane keeping blended into the steering (comfort). */
  assist: number;
}

export class Input {
  up = false;
  down = false;
  left = false;
  right = false;
  /** Shift held (sprint on the bike; the on-foot explorer reads Shift itself for running). */
  sprint = false;
  /** Headset ride input (hands on the bars or pads); replaces the keys while set. */
  xr: XrRideInput | null = null;

  constructor(onFirst: () => void, onToggleView: () => void = () => {}) {
    const set = (code: string, v: boolean) => {
      switch (code) {
        case "KeyW":
        case "ArrowUp":
          this.up = v;
          return true;
        case "KeyS":
        case "ArrowDown":
          this.down = v;
          return true;
        case "KeyA":
        case "ArrowLeft":
          this.left = v;
          return true;
        case "KeyD":
        case "ArrowRight":
          this.right = v;
          return true;
        case "ShiftLeft":
        case "ShiftRight":
          this.sprint = v;
          return false;
      }
      return false;
    };
    addEventListener("keydown", (e) => {
      onFirst();
      if (e.code === "KeyV" && !e.repeat) onToggleView();
      if (set(e.code, true)) e.preventDefault();
    });
    addEventListener("keyup", (e) => {
      set(e.code, false);
    });
    addEventListener("pointerdown", onFirst);
    addEventListener("blur", () => {
      this.up = this.down = this.left = this.right = this.sprint = false;
    });
  }
}
