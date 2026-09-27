import * as THREE from "three";
import { XR_OUT } from "./grade";

/** Where her eyes sit on the bike (bike space: ground origin, -Z forward), upright over the saddle. */
export const EYE = new THREE.Vector3(0, 1.5, 0.14);

type Hooks = {
  /** Session is live (the first XR frame follows). */
  onStart: () => void;
  onEnd: () => void;
  /** Headset visibility: false while the system menu or a dialog covers the ride. */
  onVisible: (visible: boolean) => void;
};

/**
 * The immersive session and the seated rig. `rig` follows the bike (position and heading only, so
 * the horizon never tilts); `offset` inside it maps the player's calibrated head pose onto her eye
 * point, and holds the camera and both hands.
 */
export class XRRide {
  readonly rig = new THREE.Group();
  readonly offset = new THREE.Group();
  readonly cam = new THREE.PerspectiveCamera(70, 1, 0.05, 4200);
  readonly button: HTMLButtonElement;
  presenting = false;
  visible = true;
  supported = false;
  private session: XRSession | null = null;
  private calibrate = 0;

  constructor(private renderer: THREE.WebGLRenderer, private hooks: Hooks, private opts: { framebufferScale: number; foveation: number; frameRate: number }) {
    this.rig.add(this.offset);
    this.offset.add(this.cam);
    this.rig.name = "xr-rig";
    renderer.xr.setReferenceSpaceType("local");
    renderer.xr.setFramebufferScaleFactor(opts.framebufferScale);
    renderer.xr.setFoveation(opts.foveation);

    this.button = document.createElement("button");
    this.button.id = "xr-enter";
    this.button.dataset.xrEnter = "1";
    this.button.type = "button";
    this.button.innerHTML = `<span class="xr-k">VR</span><span class="xr-t">Enter VR</span><span class="xr-s">hands on the bars</span>`;
    this.button.hidden = true;
    document.body.appendChild(this.button);

    const xr = navigator.xr;
    if (xr?.isSessionSupported)
      xr.isSessionSupported("immersive-vr")
        .then((ok) => {
          this.supported = ok;
          this.button.hidden = !ok;
        })
        .catch(() => {});
  }

  /** Must run inside a user gesture. */
  async enter(): Promise<void> {
    if (this.presenting || this.session) return;
    const xr = navigator.xr;
    if (!xr) return;
    let s: XRSession;
    try {
      s = await xr.requestSession("immersive-vr", { optionalFeatures: ["hand-tracking", "layers"] });
    } catch (e) {
      console.warn("[xr] requestSession failed", e);
      return;
    }
    this.session = s;
    s.addEventListener("end", this.onEnd);
    s.addEventListener("visibilitychange", this.onVisibility);
    // The XR render target copies the renderer's output colour space. Linear keeps its program
    // cache keys identical to the desktop MRT pass, so no scene shader recompiles on entry; the
    // wrapped shaders encode sRGB themselves (see grade.ts).
    const cs = this.renderer.outputColorSpace;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    try {
      await this.renderer.xr.setSession(s);
    } finally {
      this.renderer.outputColorSpace = cs;
    }
    try {
      const rates = s.supportedFrameRates;
      if (this.opts.frameRate && rates && [...rates].includes(this.opts.frameRate)) await s.updateTargetFrameRate?.(this.opts.frameRate);
    } catch {
      /* optional */
    }
    this.renderer.xr.getReferenceSpace()?.addEventListener("reset", () => this.recenter());
    this.presenting = true;
    this.visible = true;
    XR_OUT.uXR.value = 1;
    this.calibrate = 2;
    this.hooks.onStart();
  }

  exit(): void {
    void this.session?.end().catch(() => {});
  }

  /** Map the current head pose onto her eye point again (next frame). */
  recenter(): void {
    this.calibrate = 1;
  }

  /** Once per XR frame, before rendering: place the rig on the bike, recalibrate if asked. */
  place(x: number, z: number, yaw: number): void {
    this.rig.position.set(x, 0.02, z);
    this.rig.rotation.set(0, yaw, 0);
    // The camera's local pose (inside `offset`) is the head pose in the reference space; it is
    // written by the render call, so calibration uses last frame's pose.
    if (this.calibrate > 0 && --this.calibrate === 0) {
      const h = this.cam.position;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
      const headYaw = Math.atan2(-f.x, -f.z);
      this.offset.rotation.set(0, -headYaw, 0);
      this.offset.position.copy(EYE).sub(h.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -headYaw));
    }
  }

  get calibrating(): boolean {
    return this.calibrate > 0;
  }

  private readonly onVisibility = () => {
    const v = this.session?.visibilityState !== "hidden" && this.session?.visibilityState !== "visible-blurred";
    if (v === this.visible) return;
    this.visible = v;
    this.hooks.onVisible(v);
  };

  private readonly onEnd = () => {
    this.session?.removeEventListener("visibilitychange", this.onVisibility);
    this.session = null;
    this.presenting = false;
    this.visible = true;
    XR_OUT.uXR.value = 0;
    this.hooks.onEnd();
  };
}
