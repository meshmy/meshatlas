import { IconLayer, PathLayer } from "@deck.gl/layers";
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

// The bow's perpendicular offset above is purely horizontal (lon/lat
// plane), which can visually collapse to near-zero screen separation when
// high camera pitch coincides with a bearing that looks straight along
// that offset axis. A vertical (altitude) offset is orthogonal to any
// camera ray as long as pitch stays under 90 deg (mapSetup's maxPitch: 85
// guarantees that), and is most visible in exactly the near-horizon views
// where the horizontal bow is weakest -- so adding it alongside the
// horizontal bow keeps the two directions visually separated regardless of
// pitch/bearing. Applied asymmetrically (see buildCurvedPath) so it can
// only raise a curve further from the ground, never toward it.
const CURVE_VERTICAL_OFFSET_FRACTION = 0.02;
const CURVE_VERTICAL_OFFSET_MIN_M = 8;
const CURVE_VERTICAL_OFFSET_MAX_M = 200;

// Even, so t=0.5 (the arrow position) lands exactly on a sampled index
// below -- an odd count would mean the loop's `i === CURVE_SAMPLE_POINTS/2`
// check never matches an integer i, silently leaving the arrow at the
// pre-loop fallback position (the raw, non-terrain-lifted control point)
// instead of the actual curve midpoint.
const CURVE_SAMPLE_POINTS = 16;

// The directional arrowhead is a billboarded IconLayer (always facing the
// camera, constant on-screen pixel size) rather than the flat world-space
// triangle geometry this used to be. An earlier deck.gl version had real,
// confirmed problems with IconLayer in billboard:false mode (world-
// tracking rotation) combined with a dynamic per-instance icon atlas:
// getAngle silently not taking visual effect, and switching from one
// constant icon to a dynamic per-instance icon set making everything
// disappear entirely with no error. billboard:true with a single static
// icon (below) is a materially different, much more standard code path.
const ARROW_ICON_TEXTURE_PX = 128;
const ARROW_SIZE_HEARD_DIRECT_PX = 20;
const ARROW_SIZE_RELAYED_PX = 15;

function buildArrowIconDataUrl(px: number): string {
  const tipX = px / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${px} ${px}"><polygon points="${tipX},4 ${px - 4},${px - 4} 4,${px - 4}" fill="#fff"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Structural stand-in for deck.gl's UnpackedIcon (icon-manager.ts) -- not
// re-exported from @deck.gl/layers's public index, so this is typed
// locally; IconLayer's getIcon accessor type-checks against it
// structurally.
interface ArrowIconDef {
  url: string;
  id: string;
  width: number;
  height: number;
  mask: boolean;
}

// A flat white triangle, tip at the top of its square viewBox. mask: true
// means only this image's alpha channel is used for shape -- getColor
// fully supplies the RGB per-instance, so this one icon covers every SNR
// color (see colorForSnr) without needing per-color variants.
const ARROW_ICON: ArrowIconDef = {
  url: buildArrowIconDataUrl(ARROW_ICON_TEXTURE_PX),
  id: "meshatlas-arrow",
  width: ARROW_ICON_TEXTURE_PX,
  height: ARROW_ICON_TEXTURE_PX,
  mask: true,
};

function normalizeAngleDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** A link plus everything derived from comparing it against any reverse
 * (opposite-direction) observation between the same two nodes -- computed
 * once per render() pass rather than repeated per-layer. */
interface RenderableLink {
  feature: LinkFeature;
  path: Coordinate3D[];
  arrowAt: Coordinate3D;
  // Two nearby points along the path, in the direction of travel, used to
  // derive the arrow's on-screen rotation (see getArrowAngle) -- not a
  // compass bearing, because a compass bearing can't be turned into a
  // screen angle by a simple map-bearing subtraction once the camera is
  // pitched: ground-plane perspective projection isn't angle-preserving,
  // so a link's projected screen direction depends on pitch as well as
  // bearing. Projecting these two actual world points and measuring the
  // resulting screen-space delta sidesteps that entirely.
  arrowTangentFrom: Coordinate3D;
  arrowTangentTo: Coordinate3D;
}

export class LinksLayer {
  private readonly overlay: DeckOverlay;
  private readonly map: MapLibreMap;
  private readonly links = new Map<number, LinkFeature>();
  private renderable: RenderableLink[] = [];
  // Bumped every renderLayers() call and fed into the arrow layer's
  // getAngle updateTrigger -- the projected screen angle depends on the
  // map's *entire* camera transform (pan/zoom/bearing/pitch all affect
  // the projection, see arrowTangentFrom/To's doc comment), so rather
  // than tracking which specific camera fields changed, every
  // renderLayers() call is treated as a potential angle change.
  private angleRevision = 0;

  // Stable references so deck.gl's accessor-identity check only recomputes
  // GPU attributes flagged by updateTriggers, not everything, when
  // renderLayers() re-runs on every camera move tick.
  private readonly getLinkPath = (r: RenderableLink) => r.path;
  private readonly getLinkColor = (r: RenderableLink) => colorForSnr(r.feature.properties.snr);
  private readonly getLinkWidth = (r: RenderableLink) =>
    r.feature.properties.link_type === "heard_direct" ? 3 : 2;
  private readonly getArrowPosition = (r: RenderableLink) => r.arrowAt;
  private readonly getArrowColor = (r: RenderableLink) => colorForSnr(r.feature.properties.snr);
  private readonly getArrowSize = (r: RenderableLink) =>
    r.feature.properties.link_type === "heard_direct" ? ARROW_SIZE_HEARD_DIRECT_PX : ARROW_SIZE_RELAYED_PX;
  // Billboard icon rotation is purely in screen space, with no built-in
  // awareness of the map's camera -- so the angle has to be derived from
  // actually projecting two nearby world points along the link's
  // direction of travel and reading off the resulting on-screen delta,
  // rather than from the link's compass bearing (see arrowTangentFrom/To's
  // doc comment for why a bearing-based formula doesn't hold up once the
  // camera is pitched).
  private readonly getArrowAngle = (r: RenderableLink): number => {
    const from = this.map.project([r.arrowTangentFrom[0], r.arrowTangentFrom[1]]);
    const to = this.map.project([r.arrowTangentTo[0], r.arrowTangentTo[1]]);
    // Screen space has y growing downward, so "up" is -y; this is the
    // clockwise-from-up angle matching IconLayer's getAngle convention.
    return normalizeAngleDeg((Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI);
  };
  private readonly getArrowIcon = () => ARROW_ICON;

  /** One instance covers every RF system's links: each feature already
   * carries `properties.system_id`, and (per app/db.py) a link's two ends
   * are always in the same system, so there's nothing a per-system
   * instance would buy here -- see deckOverlay.ts for the reasoning. */
  constructor(overlay: DeckOverlay, map: MapLibreMap) {
    this.overlay = overlay;
    this.map = map;
    // "move" (not just "rotate") because arrow angle now comes from
    // reprojecting world points, which shifts under any camera change --
    // pan/zoom/rotate/pitch all fire "move".
    map.on("move", () => this.renderLayers());
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

  /** Rebuilds link geometry (paths, terrain heights, arrow positions/
   * bearings) from current link data. Expensive (queries terrain per
   * endpoint) -- call only when link data actually changes (setAll/
   * upsert/refreshHeights), not on every camera move. */
  private render(): void {
    this.renderable = this.buildRenderableLinks();
    this.renderLayers();
  }

  /** Rebuilds just the deck.gl layer objects from the cached `renderable`
   * array. Cheap: no terrain queries, no path recomputation. Called after
   * render() (data changed) AND on every map "move" event (pan/zoom/
   * bearing/pitch all changed) so arrow angles keep tracking the camera. */
  private renderLayers(): void {
    const renderable = this.renderable;
    this.angleRevision++;

    this.overlay.setLayers([
      new PathLayer<RenderableLink>({
        id: "meshatlas-links",
        data: renderable,
        pickable: true,
        widthUnits: "pixels",
        widthMinPixels: 2,
        // Billboard: extrude the ribbon's width in clipspace (always
        // facing the camera) instead of world space, so it no longer
        // thins toward edge-on and disappears at extreme pitch/viewing
        // angles.
        billboard: true,
        jointRounded: true,
        capRounded: true,
        // These are connectivity edges, not literal line-of-sight beams --
        // depth-testing them against the 3D terrain mesh meant a link
        // whose curve happened to dip (in interpolated altitude) below a
        // real hill anywhere along its length got partially occluded by
        // that hill, rendering as a dashed-looking line over rugged
        // terrain instead of a solid one. Disabling depth test keeps them
        // always drawn on top, which is also just more legible.
        parameters: { depthCompare: "always", depthWriteEnabled: false },
        getPath: this.getLinkPath,
        getColor: this.getLinkColor,
        getWidth: this.getLinkWidth,
        updateTriggers: {
          getPath: [renderable.length],
          getColor: [renderable.length],
          getWidth: [renderable.length],
        },
      }),
      new IconLayer<RenderableLink>({
        id: "meshatlas-links-arrows",
        data: renderable,
        pickable: false,
        billboard: true,
        sizeUnits: "pixels",
        parameters: { depthCompare: "always", depthWriteEnabled: false },
        getPosition: this.getArrowPosition,
        getIcon: this.getArrowIcon,
        getColor: this.getArrowColor,
        getSize: this.getArrowSize,
        getAngle: this.getArrowAngle,
        updateTriggers: {
          getPosition: [renderable.length],
          getColor: [renderable.length],
          getSize: [renderable.length],
          getAngle: [this.angleRevision],
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
        arrowAt: midpoint3D(path[0], path[1]),
        arrowTangentFrom: path[0],
        arrowTangentTo: path[1],
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
    const { path, midpoint, tangentFrom, tangentTo } = this.buildCurvedPath(
      src,
      dst,
      canonicalLow,
      canonicalHigh,
      isLow,
    );
    return {
      feature,
      path,
      arrowAt: midpoint,
      arrowTangentFrom: tangentFrom,
      arrowTangentTo: tangentTo,
    };
  }

  private buildCurvedPath(
    src: Coordinate3D,
    dst: Coordinate3D,
    canonicalLow: Coordinate3D,
    canonicalHigh: Coordinate3D,
    isLow: boolean,
  ): { path: Coordinate3D[]; midpoint: Coordinate3D; tangentFrom: Coordinate3D; tangentTo: Coordinate3D } {
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
    // for a straight link) and interpolated across the curve (see the
    // control-altitude comment below) -- querying terrain at every
    // intermediate sample instead used to literally re-follow the real
    // hillside between the endpoints, and over the Bay Area's sharp
    // elevation changes that made the 3D ribbon pinch to near-zero width
    // wherever the terrain height jumped between adjacent samples,
    // rendering as a dashed-looking line instead of a solid one.
    const liftedSrc = this.liftCoordinate(src);
    const liftedDst = this.liftCoordinate(dst);

    // Vertical bow component (see CURVE_VERTICAL_OFFSET_* above), applied
    // asymmetrically: the isLow direction's altitude is left exactly as it
    // was (linear interpolation, midAlt extra = 0) so it carries zero new
    // terrain-clipping risk; only the isHigh direction's curve is raised
    // further above the endpoint interpolation, so this can only move a
    // curve further from the ground than before, never closer to it.
    const midAlt = (liftedSrc[2] + liftedDst[2]) / 2;
    const vertOffsetM = clamp(lengthM * CURVE_VERTICAL_OFFSET_FRACTION, CURVE_VERTICAL_OFFSET_MIN_M, CURVE_VERTICAL_OFFSET_MAX_M);
    const controlAlt = midAlt + (isLow ? 0 : vertOffsetM);

    const midIndex = CURVE_SAMPLE_POINTS / 2;
    const path: Coordinate3D[] = [];
    let midpoint: Coordinate3D = [controlLon, controlLat, controlAlt];
    // Fallback tangent (used only if CURVE_SAMPLE_POINTS were ever small
    // enough that midIndex-1/+1 fell outside the loop, which it never
    // does at 16) -- overwritten below on the matching iterations.
    let tangentFrom: Coordinate3D = midpoint;
    let tangentTo: Coordinate3D = midpoint;
    for (let i = 0; i <= CURVE_SAMPLE_POINTS; i++) {
      const t = i / CURVE_SAMPLE_POINTS;
      const omt = 1 - t;
      const lon = omt * omt * srcLon + 2 * omt * t * controlLon + t * t * dstLon;
      const lat = omt * omt * srcLat + 2 * omt * t * controlLat + t * t * dstLat;
      // Quadratic Bezier in altitude too, matching the lon/lat
      // parameterization -- still anchors exactly to liftedSrc[2]/
      // liftedDst[2] at t=0/t=1 regardless of controlAlt, so lines still
      // meet the node markers correctly.
      const alt = omt * omt * liftedSrc[2] + 2 * omt * t * controlAlt + t * t * liftedDst[2];
      const point: Coordinate3D = [lon, lat, alt];
      path.push(point);
      if (i === midIndex) midpoint = point;
      // Points either side of the arrow, used for its on-screen rotation
      // (see arrowTangentFrom/To's doc comment) -- close enough together
      // that the local secant is a good stand-in for the curve's true
      // tangent at the arrow's position.
      if (i === midIndex - 1) tangentFrom = point;
      if (i === midIndex + 1) tangentTo = point;
    }
    return { path, midpoint, tangentFrom, tangentTo };
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
