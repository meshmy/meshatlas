import type { Map as MapLibreMap } from "maplibre-gl";

const STORAGE_KEY = "meshatlas:viewport";

export interface SavedViewport {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** Reads the last-saved viewport, if any. localStorage can throw (private
 * browsing in some browsers, storage disabled by policy) or hold malformed
 * JSON from a previous app version -- either case should just fall back to
 * the default view rather than breaking map init. */
export function loadSavedViewport(): SavedViewport | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.lng === "number" &&
      typeof parsed?.lat === "number" &&
      typeof parsed?.zoom === "number" &&
      typeof parsed?.pitch === "number" &&
      typeof parsed?.bearing === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persists the map's viewport on every pan/zoom/rotate/tilt so a reload
 * restores where the user left off, instead of resetting to the world view
 * (or re-running fitToNodesOnce -- see main.ts, which skips that when a
 * saved viewport exists). */
export function persistViewportOnChange(map: MapLibreMap): void {
  map.on("moveend", () => saveViewport(map));
  map.on("pitchend", () => saveViewport(map));
  map.on("rotateend", () => saveViewport(map));
}

function saveViewport(map: MapLibreMap): void {
  const center = map.getCenter();
  const viewport: SavedViewport = {
    lng: center.lng,
    lat: center.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(viewport));
  } catch {
    // Storage full or disabled -- persistence is a nice-to-have, not
    // worth surfacing an error for.
  }
}
