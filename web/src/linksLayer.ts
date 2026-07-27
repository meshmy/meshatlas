import { LineLayer } from "@deck.gl/layers";
import type { DeckOverlay } from "./deckOverlay";
import type { LinkFeature } from "./types";

// Purely visual: lifts link lines a few metres above the ground/terrain
// surface so they don't z-fight with it and read as antenna-height links
// rather than lines painted on the ground. Real Meshtastic antenna
// heights vary a lot more than this, but node altitude (when known, from
// GPS) is used as the base, so this is just a small legibility offset on
// top of that.
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
  private readonly links = new Map<number, LinkFeature>();

  /** One instance covers every RF system's links: each feature already
   * carries `properties.system_id`, and (per app/db.py) a link's two ends
   * are always in the same system, so there's nothing a per-system
   * instance would buy here -- see deckOverlay.ts for the reasoning. */
  constructor(overlay: DeckOverlay) {
    this.overlay = overlay;
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

  private render(): void {
    const data = [...this.links.values()];
    this.overlay.setLayers([
      new LineLayer<LinkFeature>({
        id: "meshatlas-links",
        data,
        pickable: true,
        widthUnits: "pixels",
        widthMinPixels: 1.5,
        getSourcePosition: (f) => liftCoordinate(f.geometry.coordinates[0]),
        getTargetPosition: (f) => liftCoordinate(f.geometry.coordinates[1]),
        getColor: (f) => colorForSnr(f.properties.snr),
        getWidth: (f) => (f.properties.link_type === "heard_direct" ? 2.5 : 1.5),
        updateTriggers: {
          getColor: [data.length],
          getWidth: [data.length],
        },
      }),
    ]);
  }
}

function liftCoordinate([lon, lat, alt]: Coordinate3D): Coordinate3D {
  return [lon, lat, (alt ?? 0) + HEIGHT_OFFSET_M];
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
