/**
 * The headset's own look: ink on outlined surfaces (materials.ts, `uXRLook`); the desktop gets it
 * from its post chain. `?xrlook=0` keeps the plain headset render for comparisons.
 */
export const XR_LOOK = new URLSearchParams(location.search).get("xrlook") !== "0";
