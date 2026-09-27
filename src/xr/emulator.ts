/**
 * Development only (`pnpm dev`, `?xremu=1`): Meta's IWER runtime stands in for a Quest 3 so the
 * headset path runs in a desktop browser, with simulated hands (`?xremu=hands`, the default) or
 * controllers (`?xremu=pads`). `&devui=1` adds the IWER DevUI panel. The device is exposed as
 * `window.__xrdev` for scripted captures (scripts/xr-shots.mjs).
 */
export async function installEmulator(mode: string | null): Promise<void> {
  const { XRDevice, metaQuest3 } = await import("iwer");
  const dev = new XRDevice(metaQuest3);
  dev.installRuntime();
  dev.stereoEnabled = new URLSearchParams(location.search).get("stereo") === "1";
  dev.primaryInputMode = mode === "pads" ? "controller" : "hand";
  (window as unknown as { __xrdev: unknown }).__xrdev = dev;
  if (new URLSearchParams(location.search).get("devui") === "1") {
    const { DevUI } = await import("@iwer/devui");
    dev.installDevUI(DevUI as never);
  }
}
