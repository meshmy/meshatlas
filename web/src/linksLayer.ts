import { LineLayer } from "@deck.gl/layers";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { DeckOverlay } from "./deckOverlay";
import type { LinkFeature } from "./types";

// Purely visual: lifts link lines a few metres above the terrain surface
// so they don't z-fight with it and read as antenna-height links rather
// than lines painted on the ground. Real Meshtastic antenna heights vary
// a lot more than this, but the terrain-draped height (see
// liftCoordinate) is used as the base, so this is just a small
// legibility offset on top of that.
const HEIGHT_OFFSET_M = 3;

// Rough calibration for Meshtastic LongFast: SNR usefully ranges from
// about -20 dB (at the edge of decodability) to +10 dB (excellent, close
// range). This is a visualization aid, not a spec value.
const SNR_MIN = -20;
const SNR_MAX = 10;

const GOOD_COLOR: [number, number, number] = [62, 207, 106];
const WEAK_COLOR: [number, number, number] = [224, 85, 60];
const UNKNOWN_COLOR: [number, number, number] = [120, 130, 140];

type Coordinate3D = [number, number, number];

export class LinksLayer {
  private readonly overlay: DeckOverlay;
  private readonly map: MapLibreMap;
  private readonly links = new Map<number, LinkFeature>();

  /** One instance covers every RF system's links: each feature already
   * carries `properties.system_id`, and (per app/db.py) a link's two ends
   * are always in the same system, so there's nothing a per-system
   * instance would buy here -- see deckOverlay.ts for the reasoning. */
  constructor(overlay: DeckOverlay, map: MapLibreMap) {
    this.overlay = overlay;
    this.map = map;
  }

  setAll(features: LinkFeature[]): void {
    this.links.clear();
    for (const feature of features) this.links.set(feature.properties.id, feature);
    this.render();
  }

  /** Live updates (from the WebSocket feed) and refetches (from
   * setAll/the REST API after a filter change) both flow through here --
   * an upsert from the live feed just adds one more entry on top of
   * whatever the last full fetch loaded. */
  upsert(feature: LinkFeature): void {
    this.links.set(feature.properties.id, feature);
    this.render();
  }

  /** Terrain DEM tiles needed by liftCoordinate() often finish loading
   * just after the initial render (or after panning to a new area), so
   * line endpoints computed before that would sit at the wrong height
   * until the next data change. Call this on the map's "idle" event to
   * re-run the same render against already-cached link data once terrain
   * is ready. */
  refreshHeights(): void {
    if (this.links.size > 0) this.render();
  }

  private render(): void {
    const data = [...this.links.values()];
    this.overlay.setLayers([
      new LineLayer<LinkFeature>({
        id: "meshatlas-links",
        data,
        pickable: true,
        widthUnits: "pixels",
        widthMinPixels: 1.5,
        getSourcePosition: (f) => this.liftCoordinate(f.geometry.coordinates[0]),
        getTargetPosition: (f) => this.liftCoordinate(f.geometry.coordinates[1]),
        getColor: (f) => colorForSnr(f.properties.snr),
        getWidth: (f) => (f.properties.link_type === "heard_direct" ? 2.5 : 1.5),
        updateTriggers: {
          getColor: [data.length],
          getWidth: [data.length],
        },
      }),
    ]);
  }

  /** Node markers are a MapLibre `circle` layer, which (per MapLibre's own
   * bucket/shader code) always renders draped onto the terrain DEM
   * surface -- it has no way to read a GeoJSON Z coordinate at all. So to
   * have line endpoints actually meet the markers in tilted view, this
   * has to match that same terrain height (DEM elevation with the
   * mapSetup.ts exaggeration already applied by queryTerrainElevation),
   * not the node's raw GPS altitude. Falls back to the old
   * altitude-based height when terrain isn't loaded/covered yet, so a
   * line still renders something reasonable instead of nothing. */
  private liftCoordinate([lon, lat, alt]: Coordinate3D): Coordinate3D {
    const terrainElevation = this.map.queryTerrainElevation([lon, lat]);
    const base = terrainElevation ?? alt ?? 0;
    return [lon, lat, base + HEIGHT_OFFSET_M];
  }
}

function colorForSnr(snr: number | null): [number, number, number, number] {
  if (snr === null) return [...UNKNOWN_COLOR, 160];
  const t = clamp((snr - SNR_MIN) / (SNR_MAX - SNR_MIN), 0, 1);
  return [...lerpColor(WEAK_COLOR, GOOD_COLOR, t), 210];
}

function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
