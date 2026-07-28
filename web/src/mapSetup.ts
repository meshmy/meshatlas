import {
  type DataDrivenPropertyValueSpecification,
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  TerrainControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { loadSavedViewport, persistViewportOnChange } from "./viewportPersistence";

// Public, free, no-API-key elevation tiles descended from the original
// Mapzen/AWS "Terrarium" DEM tileset. See:
// https://registry.opendata.aws/terrain-tiles/
const TERRAIN_DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

// OpenFreeMap's free, no-API-key "dark" style. We tried CARTO's Dark
// Matter style here briefly for its better default water/land contrast,
// but its tile/sprite/glyph CDN (tiles.basemaps.cartocdn.com) turned out
// to hang indefinitely on at least one deployment's network -- MapLibre's
// "load" event never fired, and nothing in the app ever rendered. That's
// not something we can fix in code; OpenFreeMap is the CDN we've actually
// confirmed loads, so it's the safer default. Its low contrast at world
// zoom (background rgb(12,12,12) vs water rgb(27,27,29)) is fixed below
// in improveLowZoomContrast() instead. Override via MAP_STYLE_URL if your
// network reaches CARTO fine and you'd rather have it out of the box.
const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/** Candidate vector source ids to try for 3D building extrusion, in
 * priority order. OpenFreeMap/OpenMapTiles-based styles publish an
 * "openmaptiles" source with a "building" layer carrying
 * `render_height`/`render_min_height` -- the de facto standard schema
 * most free OSM vector tile providers follow; CARTO's styles publish
 * their vector source as "carto" instead, with a "building" source-layer
 * but no per-feature height metadata (buildings extrude to the flat
 * default height below). If none of these match, we fall back to the
 * first vector source in the style so a custom MAP_STYLE_URL still gets
 * *some* attempt at buildings. */
const BUILDING_SOURCE_CANDIDATES = ["openmaptiles", "carto", "openfreemap", "protomaps"];

const TERRAIN_SOURCE_ID = "meshatlas-terrain";
const BUILDINGS_LAYER_ID = "meshatlas-3d-buildings";
export const DEFAULT_TERRAIN_EXAGGERATION = 1;

// Set once setUpTerrainAndBuildings() runs (on the map's "load" event); a
// module-level singleton is fine since createMap() is only ever called once
// per page. Kept around so setTerrainExaggeration() can update its
// `options.exaggeration` too -- TerrainControl's own on/off button
// (_toggleTerrain in maplibre-gl) re-reads that field every time it turns
// terrain back on, so without this a slider change would get silently
// reverted the next time the user toggled terrain off and on.
let terrainControl: TerrainControl | null = null;

export function createMap(container: HTMLElement): MapLibreMap {
  const styleUrl = import.meta.env.VITE_MAP_STYLE_URL ?? DEFAULT_STYLE_URL;
  const savedViewport = loadSavedViewport();

  const map = new MapLibreMap({
    container,
    style: styleUrl,
    center: savedViewport ? [savedViewport.lng, savedViewport.lat] : [0, 20],
    zoom: savedViewport?.zoom ?? 2,
    pitch: savedViewport?.pitch ?? 45,
    bearing: savedViewport?.bearing ?? 0,
    maxPitch: 85,
    canvasContextAttributes: { antialias: true },
  });

  map.addControl(new NavigationControl({ visualizePitch: true }), "top-left");
  map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
  map.addControl(new GeolocateControl({ trackUserLocation: false }), "top-left");

  map.on("load", () => setUpTerrainAndBuildings(map));
  persistViewportOnChange(map);

  return map;
}

function setUpTerrainAndBuildings(map: MapLibreMap): void {
  map.addSource(TERRAIN_SOURCE_ID, {
    type: "raster-dem",
    tiles: [TERRAIN_DEM_URL],
    tileSize: 256,
    maxzoom: 15,
    encoding: "terrarium",
    attribution: "Terrain: AWS Terrain Tiles (Mapzen/Amazon)",
  });
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });

  map.addLayer({
    id: "meshatlas-hillshade",
    type: "hillshade",
    source: TERRAIN_SOURCE_ID,
    paint: {
      "hillshade-exaggeration": 0.3,
      // MapLibre's default hillshade-shadow-color is pure black, which on
      // top of an already-dark basemap reads as solid black in low-relief
      // or coarse-DEM areas (e.g. at low zoom). A dark blue-gray keeps the
      // shading legible without crushing everything to black.
      "hillshade-shadow-color": "#1a2230",
      "hillshade-highlight-color": "#8a97a8",
    },
  });

  terrainControl = new TerrainControl({
    source: TERRAIN_SOURCE_ID,
    exaggeration: DEFAULT_TERRAIN_EXAGGERATION,
  });
  map.addControl(terrainControl, "top-left");

  improveLowZoomContrast(map);

  const buildingSourceId = pickBuildingSource(map);
  if (buildingSourceId) {
    map.addLayer({
      id: BUILDINGS_LAYER_ID,
      type: "fill-extrusion",
      source: buildingSourceId,
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": "#5c6b7a",
        "fill-extrusion-height": buildingHeightExpr(DEFAULT_TERRAIN_EXAGGERATION),
        "fill-extrusion-base": buildingBaseExpr(DEFAULT_TERRAIN_EXAGGERATION),
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
}

/** Scaling building height/base by the same factor as the terrain slider
 * keeps buildings visually proportionate to the (exaggerated) terrain
 * relief around them instead of looking flat/undersized once the ground
 * is stretched vertically. */
function buildingHeightExpr(exaggeration: number): DataDrivenPropertyValueSpecification<number> {
  return ["*", exaggeration, ["coalesce", ["get", "render_height"], ["get", "height"], 6]];
}

function buildingBaseExpr(exaggeration: number): DataDrivenPropertyValueSpecification<number> {
  return ["*", exaggeration, ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0]];
}

/** OpenFreeMap's "dark" style keeps water only a couple of shades lighter
 * than the background (rgb(27,27,29) vs rgb(12,12,12)), which reads as a
 * plain black rectangle at world zoom -- exactly the view a user sees
 * before any node data has loaded (or fitToNodesOnce() has run). Nudging
 * just the water fill to a clearly distinct dark blue restores visible
 * coastlines/continents without fighting the rest of the style's dark
 * palette. Guarded with getLayer() checks since a custom MAP_STYLE_URL
 * may not use the OpenMapTiles "water"/"water_intermittent" layer ids at
 * all -- in that case this is a harmless no-op. */
function improveLowZoomContrast(map: MapLibreMap): void {
  for (const layerId of ["water", "water_intermittent"]) {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, "fill-color", "#1b2838");
    }
  }
}

/** Called from the terrain-exaggeration slider. Updates the live terrain
 * (a no-op if terrain is currently toggled off via TerrainControl) and the
 * control's own options so a subsequent toggle-off/on doesn't revert to
 * DEFAULT_TERRAIN_EXAGGERATION -- see the terrainControl comment above. */
export function setTerrainExaggeration(map: MapLibreMap, exaggeration: number): void {
  if (terrainControl) terrainControl.options.exaggeration = exaggeration;
  if (map.getTerrain()) map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
  if (map.getLayer(BUILDINGS_LAYER_ID)) {
    map.setPaintProperty(BUILDINGS_LAYER_ID, "fill-extrusion-height", buildingHeightExpr(exaggeration));
    map.setPaintProperty(BUILDINGS_LAYER_ID, "fill-extrusion-base", buildingBaseExpr(exaggeration));
  }
}

function pickBuildingSource(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources ?? {};
  for (const candidate of BUILDING_SOURCE_CANDIDATES) {
    if (sources[candidate]?.type === "vector") return candidate;
  }
  const firstVectorSource = Object.entries(sources).find(([, src]) => src.type === "vector");
  return firstVectorSource ? firstVectorSource[0] : null;
}
