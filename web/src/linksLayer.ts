import { PathLayer, SolidPolygonLayer } from "@deck.gl/layers";
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

const METERS_PER_DEG_LAT = 111_320;

type Coordinate3D = [number, number, number];

// RF links are one-way reports (a hears b at some SNR is a separate
// observation from b hears a), so when both directions have been observed
// between the same two nodes, drawing them as a single overlapping line
// would hide that one direction might be far weaker than the other. When
// a reverse observation exists, each direction's path bows out to its own
// side of the straight line between the nodes -- proportional to the
// link's length so it stays visible whether the nodes are 500m or 40km
// apart, clamped so short links don't get an absurdly tight curve and
// long ones don't bow out implausibly far.
const CURVE_OFFSET_FRACTION = 0.08;
const CURVE_OFFSET_MIN_M = 40;
const CURVE_OFFSET_MAX_M = 1500;
// Even, so t=0.5 (the arrow position) lands exactly on a sampled index
// below -- an odd count would mean the loop's `i === CURVE_SAMPLE_POINTS/2`
// check never matches an integer i, silently leaving the arrow at the
// pre-loop fallback position (the raw, non-terrain-lifted control point)
// instead of the actual curve midpoint.
const CURVE_SAMPLE_POINTS = 8;

// The directional arrowhead is plain triangle geometry (SolidPolygonLayer)
// rather than a rotated icon -- this deck.gl version's IconLayer turned
// out to have real, confirmed problems with billboard:false (the mode we
// need so the arrow stays flat in the world and tracks the map's
// bearing/pitch like the line does, instead of always facing the
// camera): getAngle silently not taking visual effect, and switching from
// one constant icon to a dynamic per-instance icon set making everything
// disappear entirely with no error. Geometry sidesteps all of that by
// reusing the exact same world-space rendering path already proven
// correct for the line itself -- there's no icon atlas, rotation
// accessor, or billboard mode left to go wrong.
//
// Sized relative to the link's own length (like CURVE_OFFSET_*) so it
// stays visible whether the link spans hundreds of metres or tens of
// kilometres, clamped so it neither disappears on short links nor
// dwarfs long ones.
const ARROW_LENGTH_FRACTION = 0.05;
const ARROW_LENGTH_MIN_M = 30;
const ARROW_LENGTH_MAX_M = 400;
const ARROW_WIDTH_RATIO = 0.7;

/** A small filled triangle centered at `at`, tip pointing from src toward
 * dst. */
function buildArrowTriangle(
  src: Coordinate3D,
  dst: Coordinate3D,
  at: Coordinate3D,
): [Coordinate3D, Coordinate3D, Coordinate3D] {
  const [srcLon, srcLat] = src;
  const [dstLon, dstLat] = dst;
  const midLat = (srcLat + dstLat) / 2;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);

  const dxM = (dstLon - srcLon) * metersPerDegLon;
  const dyM = (dstLat - srcLat) * METERS_PER_DEG_LAT;
  const lengthM = Math.hypot(dxM, dyM) || 1;
  const uxM = dxM / lengthM;
  const uyM = dyM / lengthM;
  // Perpendicular to (uxM, uyM).
  const pxM = -uyM;
  const pyM = uxM;

  const arrowLenM = clamp(lengthM * ARROW_LENGTH_FRACTION, ARROW_LENGTH_MIN_M, ARROW_LENGTH_MAX_M);
  const halfLenM = arrowLenM / 2;
  const halfWidthM = (arrowLenM * ARROW_WIDTH_RATIO) / 2;
  const backXM = -uxM * halfLenM;
  const backYM = -uyM * halfLenM;

  return [
    offsetMeters(at, uxM * halfLenM, uyM * halfLenM, metersPerDegLon),
    offsetMeters(at, backXM + pxM * halfWidthM, backYM + pyM * halfWidthM, metersPerDegLon),
    offsetMeters(at, backXM - pxM * halfWidthM, backYM - pyM * halfWidthM, metersPerDegLon),
  ];
}

function offsetMeters([lon, lat, alt]: Coordinate3D, xM: number, yM: number, metersPerDegLon: number): Coordinate3D {
  return [lon + xM / metersPerDegLon, lat + yM / METERS_PER_DEG_LAT, alt];
}

/** A link plus everything derived from comparing it against any reverse
 * (opposite-direction) observation between the same two nodes -- computed
 * once per render() pass rather than repeated per-layer. */
interface RenderableLink {
  feature: LinkFeature;
  path: Coordinate3D[];
  arrowTriangle: [Coordinate3D, Coordinate3D, Coordinate3D];
}

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
    const renderable = this.buildRenderableLinks();

    this.overlay.setLayers([
      new PathLayer<RenderableLink>({
        id: "meshatlas-links",
        data: renderable,
        pickable: true,
        widthUnits: "pixels",
        widthMinPixels: 3.5,
        // These are connectivity edges, not literal line-of-sight beams --
        // depth-testing them against the 3D terrain mesh meant a link
        // whose curve happened to dip (in interpolated altitude) below a
        // real hill anywhere along its length got partially occluded by
        // that hill, rendering as a dashed-looking line over rugged
        // terrain instead of a solid one. Disabling depth test keeps them
        // always drawn on top, which is also just more legible.
        parameters: { depthCompare: "always", depthWriteEnabled: false },
        getPath: (r) => r.path,
        getColor: (r) => colorForSnr(r.feature.properties.snr),
        getWidth: (r) => (r.feature.properties.link_type === "heard_direct" ? 4 : 2.5),
        updateTriggers: {
          getPath: [renderable.length],
          getColor: [renderable.length],
          getWidth: [renderable.length],
        },
      }),
      new SolidPolygonLayer<RenderableLink>({
        id: "meshatlas-links-arrows",
        data: renderable,
        pickable: false,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
        getPolygon: (r) => r.arrowTriangle,
        getFillColor: (r) => colorForSnr(r.feature.properties.snr),
        updateTriggers: {
          getPolygon: [renderable.length],
          getFillColor: [renderable.length],
        },
      }),
    ]);
  }

  /** Groups links by node pair (regardless of direction) so that when both
   * directions have been observed, each one bows to its own side instead
   * of drawing on top of the other -- see the CURVE_* constants above. */
  private buildRenderableLinks(): RenderableLink[] {
    const byPair = new Map<string, LinkFeature[]>();
    for (const feature of this.links.values()) {
      const key = pairKey(feature);
      const group = byPair.get(key);
      if (group) group.push(feature);
      else byPair.set(key, [feature]);
    }

    const renderable: RenderableLink[] = [];
    for (const group of byPair.values()) {
      const hasReverse = group.length > 1;
      for (const feature of group) {
        renderable.push(this.buildRenderableLink(feature, hasReverse));
      }
    }
    return renderable;
  }

  private buildRenderableLink(feature: LinkFeature, hasReverse: boolean): RenderableLink {
    const src = feature.geometry.coordinates[0];
    const dst = feature.geometry.coordinates[1];

    if (!hasReverse) {
      const path: Coordinate3D[] = [this.liftCoordinate(src), this.liftCoordinate(dst)];
      return {
        feature,
        path,
        arrowTriangle: buildArrowTriangle(src, dst, midpoint3D(path[0], path[1])),
      };
    }

    // isLow decides which side of the straight line this direction bows
    // to: whichever of the pair's two node ids sorts first always curves
    // the same way, so the two directions are guaranteed to land on
    // opposite sides regardless of which one we're processing right now.
    // Passing the canonical (low, high) coordinate order in for the
    // perpendicular calculation -- rather than this feature's own
    // (possibly swapped) src/dst -- matters: the reverse-direction link
    // has src/dst swapped relative to the forward one, which by itself
    // already flips the perpendicular's sign once; using each feature's
    // own src/dst here would flip it a *second* time via isLow, and the
    // two flips would cancel out, landing both directions on the same
    // side instead of mirrored ones.
    const isLow = feature.properties.from_node_id < feature.properties.to_node_id;
    const canonicalLow = isLow ? src : dst;
    const canonicalHigh = isLow ? dst : src;
    const { path, midpoint } = this.buildCurvedPath(src, dst, canonicalLow, canonicalHigh, isLow);
    return {
      feature,
      path,
      arrowTriangle: buildArrowTriangle(src, dst, midpoint),
    };
  }

  private buildCurvedPath(
    src: Coordinate3D,
    dst: Coordinate3D,
    canonicalLow: Coordinate3D,
    canonicalHigh: Coordinate3D,
    isLow: boolean,
  ): { path: Coordinate3D[]; midpoint: Coordinate3D } {
    const [srcLon, srcLat] = src;
    const [dstLon, dstLat] = dst;
    const [lowLon, lowLat] = canonicalLow;
    const [highLon, highLat] = canonicalHigh;
    const midLat = (srcLat + dstLat) / 2;
    const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);

    // Fixed regardless of which direction this particular feature runs --
    // see the comment at the call site.
    const dxM = (highLon - lowLon) * metersPerDegLon;
    const dyM = (highLat - lowLat) * METERS_PER_DEG_LAT;
    const lengthM = Math.hypot(dxM, dyM) || 1;

    const offsetM = clamp(lengthM * CURVE_OFFSET_FRACTION, CURVE_OFFSET_MIN_M, CURVE_OFFSET_MAX_M);
    const sign = isLow ? 1 : -1;
    // Perpendicular to (dxM, dyM), normalized, scaled to offsetM.
    const perpXM = (-dyM / lengthM) * offsetM * sign;
    const perpYM = (dxM / lengthM) * offsetM * sign;

    const controlLon = (srcLon + dstLon) / 2 + perpXM / metersPerDegLon;
    const controlLat = (srcLat + dstLat) / 2 + perpYM / METERS_PER_DEG_LAT;

    // Height only ever gets sampled from terrain at the two endpoints (as
    // for a straight link) and interpolated linearly across the curve --
    // querying terrain at every intermediate sample instead used to
    // literally re-follow the real hillside between the endpoints, and
    // over the Bay Area's sharp elevation changes that made the 3D ribbon
    // pinch to near-zero width wherever the terrain height jumped between
    // adjacent samples, rendering as a dashed-looking line instead of a
    // solid one.
    const liftedSrc = this.liftCoordinate(src);
    const liftedDst = this.liftCoordinate(dst);

    const path: Coordinate3D[] = [];
    let midpoint: Coordinate3D = [controlLon, controlLat, (liftedSrc[2] + liftedDst[2]) / 2];
    for (let i = 0; i <= CURVE_SAMPLE_POINTS; i++) {
      const t = i / CURVE_SAMPLE_POINTS;
      const omt = 1 - t;
      const lon = omt * omt * srcLon + 2 * omt * t * controlLon + t * t * dstLon;
      const lat = omt * omt * srcLat + 2 * omt * t * controlLat + t * t * dstLat;
      const alt = liftedSrc[2] + (liftedDst[2] - liftedSrc[2]) * t;
      const point: Coordinate3D = [lon, lat, alt];
      path.push(point);
      if (i === CURVE_SAMPLE_POINTS / 2) midpoint = point;
    }
    return { path, midpoint };
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

function pairKey(feature: LinkFeature): string {
  const { from_node_id, to_node_id } = feature.properties;
  return from_node_id < to_node_id ? `${from_node_id}|${to_node_id}` : `${to_node_id}|${from_node_id}`;
}

function midpoint3D(a: Coordinate3D, b: Coordinate3D): Coordinate3D {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function colorForSnr(snr: number | null): [number, number, number, number] {
  if (snr === null) return [...UNKNOWN_COLOR, 255];
  const t = clamp((snr - SNR_MIN) / (SNR_MAX - SNR_MIN), 0, 1);
  return [...lerpColor(WEAK_COLOR, GOOD_COLOR, t), 255];
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
