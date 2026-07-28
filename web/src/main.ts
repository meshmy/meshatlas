import { LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import { connectLiveFeed, getLinks, getNodeHistory, getNodes, getSystems } from "./api";
import { createMap } from "./mapSetup";
import { DeckOverlay } from "./deckOverlay";
import { LinksLayer } from "./linksLayer";
import { NodesLayer, type NodeStatus } from "./nodesLayer";
import "./style.css";
import type { LinkFeature, LiveMessage, NodeFeature } from "./types";

const HISTORY_SOURCE_ID = "meshatlas-history";
const HISTORY_LAYER_ID = "meshatlas-history-line";
const ALL_STATUSES: NodeStatus[] = ["fresh", "stale", "offline"];

const mapContainer = document.getElementById("map");
if (!mapContainer) throw new Error("missing #map container");

const map = createMap(mapContainer);

const hoursInput = requireElement<HTMLInputElement>("hours");
const hoursValue = requireElement<HTMLOutputElement>("hours-value");
const activeHoursSelect = requireElement<HTMLSelectElement>("active-hours");
const toggleHeardDirect = requireElement<HTMLInputElement>("toggle-heard-direct");
const toggleNeighborReport = requireElement<HTMLInputElement>("toggle-neighbor-report");
const statusCheckboxes: Record<NodeStatus, HTMLInputElement> = {
  fresh: requireElement<HTMLInputElement>("status-fresh"),
  stale: requireElement<HTMLInputElement>("status-stale"),
  offline: requireElement<HTMLInputElement>("status-offline"),
};
const systemsList = requireElement<HTMLElement>("systems-list");
const selectionSection = requireElement<HTMLElement>("selection");
const selectionName = requireElement<HTMLElement>("selection-name");
const selectionDetails = requireElement<HTMLDListElement>("selection-details");
const clearSelectionButton = requireElement<HTMLButtonElement>("clear-selection");
const statusEl = requireElement<HTMLElement>("status");

let nodesLayer: NodesLayer | null = null;
let linksLayer: LinksLayer | null = null;
let selectedNativeId: string | null = null;
// The default center/zoom (see mapSetup.ts) is a static world view, which
// on a dark basemap style renders as an almost featureless rectangle --
// dark styles only get strong visual contrast (roads, buildings, place
// labels) once zoomed in past roughly city/regional level. Once we know
// where the actual nodes are, fit to them instead; see fitToNodesOnce().
// Only happens once so it doesn't fight the user panning around afterwards.
let hasFitInitialBounds = false;
// Populated from GET /api/systems on load. Every system this deployment's
// backend knows about (see app/db.py::KNOWN_SYSTEMS) gets a checkbox here
// automatically -- enabling e.g. APRS on the backend later needs no
// frontend change to show up as a filterable system.
let enabledSystems = new Set<string>();

// Creating the deck.gl/MapLibre layers requires the basemap style to have
// finished loading (addSource/addLayer need a parsed style); fetching our
// own node/link data and opening the live WebSocket feed do not. Gating
// everything behind map "load" meant a slow or unreachable basemap CDN
// stalled data loading too, even though the two are unrelated. Data
// fetching and the live feed below start immediately; layersReady is the
// one gate for the handful of calls that actually touch the map layers,
// so a slow basemap only delays rendering, not data.
let resolveLayersReady: () => void;
const layersReady = new Promise<void>((resolve) => {
  resolveLayersReady = resolve;
});

// MapLibre logs style/tile/sprite/glyph fetch failures (e.g. a CDN
// unreachable from this network) as "error" events rather than throwing,
// so without this they'd be entirely silent -- the map would just sit
// there forever having never fired "load".
map.on("error", (event) => {
  console.error("meshatlas: maplibre error", event.error ?? event);
  statusEl.textContent = "map error (see console) -- basemap tiles may be unreachable";
});

// If this callback throws partway through, or "load" never fires at all,
// the failure used to be completely silent -- no map, nothing in the
// console, and (before the refactor above) no data either. The try/catch
// and the timeout warning below exist purely to make that failure visible
// instead of a mystery; data/live-feed status are unaffected by it now.
const loadTimeout = window.setTimeout(() => {
  console.warn(
    "meshatlas: map 'load' event hasn't fired after 10s -- the basemap style, sprite or glyphs " +
      "may be unreachable (check the Network tab for the MAP_STYLE_URL request and its sub-resources). " +
      "Node/link data and the live feed don't depend on this and should still be working.",
  );
  statusEl.textContent = "still waiting on the basemap (slow/unreachable tile CDN?)";
}, 10_000);

map.on("load", () => {
  window.clearTimeout(loadTimeout);
  try {
    nodesLayer = new NodesLayer(map);
    linksLayer = new LinksLayer(new DeckOverlay(map), map);

    map.addSource(HISTORY_SOURCE_ID, { type: "geojson", data: emptyLineCollection() });
    map.addLayer({
      id: HISTORY_LAYER_ID,
      type: "line",
      source: HISTORY_SOURCE_ID,
      paint: {
        "line-color": "#4da3ff",
        "line-width": 2,
        "line-dasharray": [1, 1],
      },
    });

    nodesLayer.onNodeClick((feature) => selectNode(feature.properties.native_id, feature));
    // Terrain DEM tiles (used by linksLayer's queryTerrainElevation) can
    // still be loading when links first render, and more tiles load in as
    // the camera pans -- "idle" fires once the map has settled after each
    // such change, so re-running the link render against already-cached
    // data here keeps line endpoints matched to where node markers render.
    map.on("idle", () => linksLayer?.refreshHeights());
    resolveLayersReady();
  } catch (err) {
    console.error("meshatlas: failed to initialize map layers", err);
    statusEl.textContent = "failed to initialize (see console)";
  }
});

// Starts now, in parallel with the map/basemap -- see the layersReady
// comment above.
void loadSystemsList();
void refreshAll();

connectLiveFeed(
  (message) => void handleLiveMessage(message),
  (status) => {
    statusEl.textContent =
      status === "open" ? "live" : status === "connecting" ? "connecting…" : "disconnected, retrying…";
  },
);

const initialNode = new URLSearchParams(location.search).get("node");
if (initialNode) selectNode(initialNode, null);

async function handleLiveMessage(message: LiveMessage): Promise<void> {
  await layersReady;
  if (message.type === "node") {
    if (enabledSystems.has(message.feature.properties.system_id)) nodesLayer!.upsert(message.feature);
  } else if (message.type === "link" && linkPassesFilters(message.feature)) {
    linksLayer!.upsert(message.feature);
  }
}

hoursInput.addEventListener("input", () => {
  hoursValue.textContent = `${hoursInput.value}h`;
});
hoursInput.addEventListener("change", () => void refreshLinks());
activeHoursSelect.addEventListener("change", () => void refreshNodes());
toggleHeardDirect.addEventListener("change", () => void refreshLinks());
toggleNeighborReport.addEventListener("change", () => void refreshLinks());
clearSelectionButton.addEventListener("click", () => selectNode(null, null));
for (const status of ALL_STATUSES) {
  statusCheckboxes[status].addEventListener("change", () => void applyStatusFilter());
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshNodes(), refreshLinks()]);
}

/** Fetches the full list of RF systems the backend knows about (whether
 * or not an ingestion Source for them is currently running -- see
 * GET /api/systems) and renders one checkbox each, all enabled by
 * default. This is the "metadata to classify/filter by system" hook:
 * nodes/links are still a single unified layer each, distinguished by
 * `properties.system_id`, rather than a separate map layer per system. */
async function loadSystemsList(): Promise<void> {
  const systems = await getSystems();
  systemsList.innerHTML = "";
  enabledSystems = new Set(systems.map((s) => s.id));

  for (const system of systems) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.systemId = system.id;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) enabledSystems.add(system.id);
      else enabledSystems.delete(system.id);
      void layersReady.then(() => nodesLayer!.setSystemFilter([...enabledSystems]));
      void refreshLinks();
    });
    label.append(checkbox, ` ${system.name}`);
    systemsList.append(label);
  }
}

async function applyStatusFilter(): Promise<void> {
  await layersReady;
  const visible = ALL_STATUSES.filter((status) => statusCheckboxes[status].checked);
  nodesLayer!.setStatusFilter(visible);
}

async function refreshNodes(): Promise<void> {
  // Fetch runs immediately; only the render step waits on the map layers.
  const activeHours = activeHoursSelect.value ? Number(activeHoursSelect.value) : undefined;
  const collection = await getNodes({ activeHours });
  await layersReady;
  nodesLayer!.setAll(collection);
  await applyStatusFilter();
  fitToNodesOnce(collection.features);
}

function fitToNodesOnce(features: NodeFeature[]): void {
  if (hasFitInitialBounds) return;
  const positioned = features.filter((f) => f.geometry !== null);
  if (positioned.length === 0) return;

  const bounds = new LngLatBounds();
  for (const feature of positioned) {
    const [lon, lat] = feature.geometry!.coordinates;
    bounds.extend([lon, lat]);
  }
  hasFitInitialBounds = true;
  map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 0 });
}

async function refreshLinks(): Promise<void> {
  // Fetch runs immediately; only the render step waits on the map layers.
  const hours = Number(hoursInput.value);
  const collection = await getLinks({ hours, node: selectedNativeId ?? undefined });
  const filtered = collection.features.filter(linkPassesFilters);
  await layersReady;
  linksLayer!.setAll(filtered);
}

function linkPassesFilters(feature: LinkFeature): boolean {
  if (!enabledSystems.has(feature.properties.system_id)) return false;
  if (feature.properties.link_type === "heard_direct" && !toggleHeardDirect.checked) return false;
  if (feature.properties.link_type === "neighbor_report" && !toggleNeighborReport.checked) return false;
  if (selectedNativeId) {
    return (
      feature.properties.from_native_id === selectedNativeId ||
      feature.properties.to_native_id === selectedNativeId
    );
  }
  return true;
}

function selectNode(nativeId: string | null, feature: NodeFeature | null): void {
  selectedNativeId = nativeId;

  const url = new URL(location.href);
  if (nativeId) url.searchParams.set("node", nativeId);
  else url.searchParams.delete("node");
  history.replaceState(null, "", url);

  void refreshLinks();

  if (!nativeId) {
    selectionSection.hidden = true;
    void layersReady.then(() => setHistoryTrail(null));
    return;
  }

  void resolveSelection(nativeId, feature);
}

/** The lookup/render/history-trail part of selectNode() -- split out
 * because it needs the node layer (to resolve a bare native id to a full
 * feature) and the history source (added alongside the other layers in
 * map.on("load")), while the URL update and refreshLinks() above it don't. */
async function resolveSelection(nativeId: string, feature: NodeFeature | null): Promise<void> {
  await layersReady;
  const resolved = feature ?? nodesLayer!.findByNativeId(nativeId);
  if (!resolved) return;
  renderSelection(resolved);
  void loadHistory(resolved.properties.id);
}

function renderSelection(feature: NodeFeature): void {
  const p = feature.properties;
  selectionSection.hidden = false;
  selectionName.textContent = p.display_name || p.native_id;
  selectionDetails.innerHTML = "";
  const rows: [string, string][] = [
    ["Native id", p.native_id],
    ["System", p.system_id],
    ["Hardware", p.hardware_model ?? "unknown"],
    ["Battery", p.battery_pct !== null ? `${p.battery_pct}%` : "unknown"],
    ["Last seen", p.last_seen ? new Date(p.last_seen).toLocaleString() : "never"],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    selectionDetails.append(dt, dd);
  }
}

async function loadHistory(nodeId: string): Promise<void> {
  const history = await getNodeHistory(nodeId, 24);
  setHistoryTrail(history.geometry);
}

function setHistoryTrail(geometry: { type: "LineString"; coordinates: [number, number, number][] } | null): void {
  const source = map.getSource(HISTORY_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(geometry ? { type: "Feature", geometry, properties: {} } : emptyLineCollection());
}

function emptyLineCollection() {
  return { type: "FeatureCollection" as const, features: [] };
}

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} element`);
  return el as T;
}
