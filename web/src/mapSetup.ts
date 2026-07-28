import {
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
  map.addSource("meshatlas-terrain", {
    type: "raster-dem",
    tiles: [TERRAIN_DEM_URL],
    tileSize: 256,
    maxzoom: 15,
    encoding: "terrarium",
    attribution: "Terrain: AWS Terrain Tiles (Mapzen/Amazon)",
  });
  map.setTerrain({ source: "meshatlas-terrain", exaggeration: 1.3 });

  map.addLayer({
    id: "meshatlas-hillshade",
    type: "hillshade",
    source: "meshatlas-terrain",
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

  map.addControl(
    new TerrainControl({ source: "meshatlas-terrain", exaggeration: 1.3 }),
    "top-left",
  );

  improveLowZoomContrast(map);

  const buildingSourceId = pickBuildingSource(map);
  if (buildingSourceId) {
    map.addLayer({
      id: "meshatlas-3d-buildings",
      type: "fill-extrusion",
      source: buildingSourceId,
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": "#5c6b7a",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
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

function pickBuildingSource(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources ?? {};
  for (const candidate of BUILDING_SOURCE_CANDIDATES) {
    if (sources[candidate]?.type === "vector") return candidate;
  }
  const firstVectorSource = Object.entries(sources).find(([, src]) => src.type === "vector");
  return firstVectorSource ? firstVectorSource[0] : null;
}
