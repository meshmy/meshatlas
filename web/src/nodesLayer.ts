import type {
  FilterSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";
import type { FeatureCollection, NodeFeature } from "./types";

const SOURCE_ID = "meshatlas-nodes";
const CIRCLE_LAYER_ID = "meshatlas-nodes-circle";
const LABEL_LAYER_ID = "meshatlas-nodes-label";

const FRESH_SECONDS = 15 * 60; // seen in the last 15 min
const STALE_SECONDS = 60 * 60; // seen in the last hour

export type NodeStatus = "fresh" | "stale" | "offline";

export class NodesLayer {
  private readonly map: MapLibreMap;
  private readonly nodes = new Map<string, NodeFeature>();
  private onSelect: ((feature: NodeFeature) => void) | null = null;
  private onHover: ((feature: NodeFeature | null) => void) | null = null;
  private hoveredId: string | null = null;
  private refreshTimer: number | undefined;

  // null = "no restriction"; both default to showing everything.
  private visibleSystems: Set<string> | null = null;
  private visibleStatuses: Set<NodeStatus> = new Set(["fresh", "stale", "offline"]);

  constructor(map: MapLibreMap) {
    this.map = map;
    this.map.addSource(SOURCE_ID, {
      type: "geojson",
      // See the cast in render() for why this needs `unknown` in between:
      // our NodeFeature type allows a null geometry, maplibre's stricter
      // GeoJSON type doesn't, and an empty features array trivially
      // satisfies both at runtime.
      data: emptyCollection() as unknown as GeoJSON.FeatureCollection,
    });

    this.map.addLayer({
      id: CIRCLE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 12, 8],
        "circle-color": [
          "match",
          ["get", "status"],
          "fresh",
          "#3ecf6a",
          "stale",
          "#e0a63c",
          /* offline */ "#6b7684",
        ],
        "circle-stroke-color": "#0d1117",
        "circle-stroke-width": 1.5,
      },
    });

    this.map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      layout: {
        "text-field": ["coalesce", ["get", "short_name"], ["get", "native_id"]],
        "text-size": 11,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-color": "#e6edf3",
        "text-halo-color": "#0d1117",
        "text-halo-width": 1,
      },
    });

    this.map.on("click", CIRCLE_LAYER_ID, (event) => {
      const feature = event.features?.[0] as MapGeoJSONFeature | undefined;
      if (feature) this.onSelect?.(featureFromMapFeature(feature));
    });
    this.map.on("mouseenter", CIRCLE_LAYER_ID, () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", CIRCLE_LAYER_ID, () => {
      this.map.getCanvas().style.cursor = "";
      if (this.hoveredId !== null) {
        this.hoveredId = null;
        this.onHover?.(null);
      }
    });
    // "mouseenter"/"mouseleave" on a layer only fire once for the whole
    // layer (entering/leaving *a* circle, not switching between two
    // adjacent ones), so per-feature hover needs "mousemove" instead,
    // comparing against the last-hovered id to only fire onHover when it
    // actually changes.
    this.map.on("mousemove", CIRCLE_LAYER_ID, (event) => {
      const feature = event.features?.[0] as MapGeoJSONFeature | undefined;
      const id = (feature?.properties.native_id as string | undefined) ?? null;
      if (id === this.hoveredId) return;
      this.hoveredId = id;
      this.onHover?.(feature ? featureFromMapFeature(feature) : null);
    });

    this.refreshTimer = window.setInterval(() => this.render(), 30_000);
  }

  onNodeClick(handler: (feature: NodeFeature) => void): void {
    this.onSelect = handler;
  }

  /** Fires with the hovered node's feature on entry, and with `null` when
   * the pointer leaves it (whether onto empty map or straight onto a
   * different node -- see the mousemove/mouseleave wiring above). */
  onNodeHover(handler: (feature: NodeFeature | null) => void): void {
    this.onHover = handler;
  }

  /** `null` clears the restriction (show every system). Purely a display
   * filter -- it doesn't affect what's fetched/stored, so toggling it
   * back off is instant with no refetch. */
  setSystemFilter(systemIds: string[] | null): void {
    this.visibleSystems = systemIds ? new Set(systemIds) : null;
    this.applyFilter();
  }

  setStatusFilter(statuses: NodeStatus[]): void {
    this.visibleStatuses = new Set(statuses);
    this.applyFilter();
  }

  setAll(collection: FeatureCollection<NodeFeature>): void {
    this.nodes.clear();
    for (const feature of collection.features) {
      this.nodes.set(feature.properties.id, feature);
    }
    this.render();
  }

  upsert(feature: NodeFeature): void {
    this.nodes.set(feature.properties.id, feature);
    this.render();
  }

  get(nodeId: string): NodeFeature | undefined {
    return this.nodes.get(nodeId);
  }

  findByNativeId(nativeId: string): NodeFeature | undefined {
    for (const feature of this.nodes.values()) {
      if (feature.properties.native_id === nativeId) return feature;
    }
    return undefined;
  }

  destroy(): void {
    window.clearInterval(this.refreshTimer);
  }

  private render(): void {
    const now = Date.now();
    // Nodes without a known position can't be placed on the map; they
    // still exist in `this.nodes` (e.g. for the sidebar/history lookup)
    // but are excluded from what we hand to the GeoJSON source.
    const features = [...this.nodes.values()]
      .filter(hasGeometry)
      .map((f) => ({
        ...f,
        properties: { ...f.properties, status: statusFor(f, now) },
      }));
    const source = this.map.getSource(SOURCE_ID);
    if (source && "setData" in source) {
      // Our NodeFeature type allows `geometry: null` (a node with no
      // position yet); the filter above guarantees every feature here has
      // one, but expressing that as a type guard for maplibre's stricter
      // GeoJSON.FeatureCollection type isn't worth the ceremony -- cast.
      (source as GeoJSONSource).setData({
        type: "FeatureCollection",
        features,
      } as unknown as GeoJSON.FeatureCollection);
    }
    this.applyFilter();
  }

  /** Recomputes the combined MapLibre `filter` expression from
   * `visibleSystems` + `visibleStatuses` and applies it to both layers.
   * Called after every render() (status is recomputed there) and
   * whenever a filter setter runs. */
  private applyFilter(): void {
    const clauses: unknown[] = [["==", ["geometry-type"], "Point"]];
    if (this.visibleSystems) {
      clauses.push(["in", ["get", "system_id"], ["literal", [...this.visibleSystems]]]);
    }
    clauses.push(["in", ["get", "status"], ["literal", [...this.visibleStatuses]]]);

    const filter = ["all", ...clauses] as unknown as FilterSpecification;
    if (this.map.getLayer(CIRCLE_LAYER_ID)) this.map.setFilter(CIRCLE_LAYER_ID, filter);
    if (this.map.getLayer(LABEL_LAYER_ID)) this.map.setFilter(LABEL_LAYER_ID, filter);
  }
}

function hasGeometry(feature: NodeFeature): feature is NodeFeature & { geometry: NonNullable<NodeFeature["geometry"]> } {
  return feature.geometry !== null;
}

function statusFor(feature: NodeFeature, nowMs: number): NodeStatus {
  const lastSeen = feature.properties.last_seen;
  if (!lastSeen) return "offline";
  const ageSeconds = (nowMs - new Date(lastSeen).getTime()) / 1000;
  if (ageSeconds <= FRESH_SECONDS) return "fresh";
  if (ageSeconds <= STALE_SECONDS) return "stale";
  return "offline";
}

function emptyCollection(): FeatureCollection<NodeFeature> {
  return { type: "FeatureCollection", features: [] };
}

function featureFromMapFeature(feature: MapGeoJSONFeature): NodeFeature {
  return {
    type: "Feature",
    geometry: feature.geometry as NodeFeature["geometry"],
    properties: feature.properties as NodeFeature["properties"],
  };
}
