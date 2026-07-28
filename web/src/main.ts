import { LngLatBounds, Popup, type GeoJSONSource } from "maplibre-gl";
import { connectLiveFeed, getLinks, getNodeHistory, getNodes, getSystems } from "./api";
import { createMap, setBuildingExaggeration, setTerrainExaggeration } from "./mapSetup";
import { DeckOverlay } from "./deckOverlay";
import { LinksLayer } from "./linksLayer";
import { NodesLayer, type NodeStatus } from "./nodesLayer";
import { loadSavedViewport } from "./viewportPersistence";
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
const terrainExaggerationInput = requireElement<HTMLInputElement>("terrain-exaggeration");
const terrainExaggerationValue = requireElement<HTMLOutputElement>("terrain-exaggeration-value");
const toggleHeardDirect = requireElement<HTMLInputElement>("toggle-heard-direct");
const toggleNeighborReport = requireElement<HTMLInputElement>("toggle-neighbor-report");
const toggleShowAllLinks = requireElement<HTMLInputElement>("toggle-show-all-links");
const statusCheckboxes: Record<NodeStatus, HTMLInputElement> = {
  fresh: requireElement<HTMLInputElement>("status-fresh"),
  stale: requireElement<HTMLInputElement>("status-stale"),
  offline: requireElement<HTMLInputElement>("status-offline"),
};
const systemsList = requireElement<HTMLElement>("systems-list");
const statusEl = requireElement<HTMLElement>("status");

let nodesLayer: NodesLayer | null = null;
let linksLayer: LinksLayer | null = null;
let selectedNativeId: string | null = null;
let hoveredNativeId: string | null = null;
let activePopup: Popup | null = null;
// The full set of links last fetched for the current `hours` window,
// keyed by id -- server-side filtering used to also narrow this to just
// `selectedNativeId`'s links via a `node=` query param, but that meant the
// "always show all" checkbox couldn't work (the other links were never
// even fetched) and every hover/selection change needed a network
// round-trip. Now the fetch always pulls the full window and every other
// filter (system, link type, selection/hover focus, show-all) is applied
// client-side via applyLinkFilters(), so those changes are instant.
const allLinks = new Map<number, LinkFeature>();
// The default center/zoom (see mapSetup.ts) is a static world view, which
// on a dark basemap style renders as an almost featureless rectangle --
// dark styles only get strong visual contrast (roads, buildings, place
// labels) once zoomed in past roughly city/regional level. Once we know
// where the actual nodes are, fit to them instead; see fitToNodesOnce().
// Only happens once so it doesn't fight the user panning around afterwards.
// Also skipped entirely when a saved viewport was restored (see
// viewportPersistence.ts) -- otherwise a returning user's restored view
// would immediately get clobbered by this auto-fit.
let hasFitInitialBounds = loadSavedViewport() !== null;
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
    nodesLayer.onNodeHover((feature) => {
      hoveredNativeId = feature?.properties.native_id ?? null;
      void applyLinkFilters();
    });
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
  } else if (message.type === "link") {
    // Cached regardless of whether it passes the current filters, so a
    // later hover/selection/show-all change can reveal it without a
    // refetch -- see the allLinks comment above.
    allLinks.set(message.feature.properties.id, message.feature);
    if (linkPassesFilters(message.feature)) linksLayer!.upsert(message.feature);
  }
}

hoursInput.addEventListener("input", () => {
  hoursValue.textContent = `${hoursInput.value}h`;
});
hoursInput.addEventListener("change", () => void refreshLinks());
terrainExaggerationInput.addEventListener("input", () => {
  const exaggeration = Number(terrainExaggerationInput.value);
  terrainExaggerationValue.textContent = `${exaggeration}x`;
  setTerrainExaggeration(map, exaggeration);
  // Line endpoints are lifted to queryTerrainElevation() (see
  // linksLayer.ts), which changes as soon as the DEM is redrawn at the new
  // exaggeration -- without this the links stay pinned to the old terrain
  // height until the next unrelated camera move fires "idle".
  void layersReady.then(() => linksLayer?.refreshHeights());
});
// Deliberately "change" (drag release), not "input" -- see
// setBuildingExaggeration's comment in mapSetup.ts for why firing this on
// every drag tick left buildings stuck at a stale height.
terrainExaggerationInput.addEventListener("change", () => {
  setBuildingExaggeration(map, Number(terrainExaggerationInput.value));
});
activeHoursSelect.addEventListener("change", () => void refreshNodes());
toggleHeardDirect.addEventListener("change", () => void applyLinkFilters());
toggleNeighborReport.addEventListener("change", () => void applyLinkFilters());
toggleShowAllLinks.addEventListener("change", () => void applyLinkFilters());
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
  // refreshAll() (called in parallel with this function, not awaited on it)
  // may already have populated allLinks and run applyLinkFilters() before
  // this line populates enabledSystems -- since it starts as an empty Set,
  // every link would fail the `enabledSystems.has(...)` check and get
  // silently dropped, with nothing left to ever re-trigger a render.
  // Re-running the link filter now, with enabledSystems actually
  // populated, is what makes links reliably appear on first load instead
  // of only after some later UI event (a filter toggle, a node
  // hover/click) happens to call applyLinkFilters() again.
  void applyLinkFilters();

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
      void applyLinkFilters();
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
  // refreshNodes() and refreshLinks() run in parallel from refreshAll()
  // with no ordering guarantee -- if links finish filtering first,
  // linkPassesFilters()'s node-existence check (see above) would find no
  // nodes loaded yet and drop every link, with nothing left to ever
  // re-trigger a render. Re-running the link filter now, with the node
  // set actually populated, is the same fix pattern as loadSystemsList()
  // uses for enabledSystems above.
  void applyLinkFilters();
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

/** Refetches the full link set for the current `hours` window from the
 * server -- the only filter that's actually server-side, since it changes
 * what the backend even has to query. Every other filter is client-side;
 * see applyLinkFilters(). */
async function refreshLinks(): Promise<void> {
  // Fetch runs immediately; only the render step waits on the map layers.
  const hours = Number(hoursInput.value);
  const collection = await getLinks({ hours });
  allLinks.clear();
  for (const feature of collection.features) allLinks.set(feature.properties.id, feature);
  await applyLinkFilters();
}

/** Re-renders the link layer from the already-fetched allLinks cache
 * against the current filters -- no network round-trip, so this is what
 * hover/selection changes and filter-checkbox toggles call directly
 * instead of refreshLinks(). */
async function applyLinkFilters(): Promise<void> {
  // Awaited before filtering (not just before the setAll() below) because
  // linkPassesFilters() now needs to look nodes up in nodesLayer -- it
  // must exist first.
  await layersReady;
  const filtered = [...allLinks.values()].filter(linkPassesFilters);
  linksLayer!.setAll(filtered);
}

function linkPassesFilters(feature: LinkFeature): boolean {
  if (!enabledSystems.has(feature.properties.system_id)) return false;
  if (feature.properties.link_type === "heard_direct" && !toggleHeardDirect.checked) return false;
  if (feature.properties.link_type === "neighbor_report" && !toggleNeighborReport.checked) return false;
  // A link can reference a node that isn't currently in the active node
  // set -- e.g. observed via a neighbor's periodic NeighborInfo report
  // more recently than that node's own last position update, so it falls
  // outside the "last seen within" window while the link observation
  // itself doesn't. Rendering it anyway draws a line with no marker at
  // one end, which just reads as a rendering bug (a line that "ends in
  // the ground") rather than what it actually is.
  if (!nodesLayer!.get(feature.properties.from_node_id)) return false;
  if (!nodesLayer!.get(feature.properties.to_node_id)) return false;
  if (toggleShowAllLinks.checked) return true;
  // Unchecked: links only show for whichever node currently has focus --
  // hovered takes priority over (and typically coincides with, right
  // after a click) selected -- and nothing shows at all otherwise.
  const focusNativeId = hoveredNativeId ?? selectedNativeId;
  if (!focusNativeId) return false;
  return (
    feature.properties.from_native_id === focusNativeId || feature.properties.to_native_id === focusNativeId
  );
}

function selectNode(nativeId: string | null, feature: NodeFeature | null): void {
  selectedNativeId = nativeId;

  const url = new URL(location.href);
  if (nativeId) url.searchParams.set("node", nativeId);
  else url.searchParams.delete("node");
  history.replaceState(null, "", url);

  void applyLinkFilters();

  if (!nativeId) {
    closePopup();
    void layersReady.then(() => setHistoryTrail(null));
    return;
  }

  void resolveSelection(nativeId, feature);
}

/** The lookup/popup/flyTo/history-trail part of selectNode() -- split out
 * because it needs the node layer (to resolve a bare native id to a full
 * feature) and the history source (added alongside the other layers in
 * map.on("load")), while the URL update and applyLinkFilters() above it don't. */
async function resolveSelection(nativeId: string, feature: NodeFeature | null): Promise<void> {
  await layersReady;
  const resolved = feature ?? nodesLayer!.findByNativeId(nativeId);
  if (!resolved) return;
  flyToNode(resolved);
  openNodePopup(resolved);
  void loadHistory(resolved.properties.id);
}

/** Pans/zooms the camera to the node. Math.max means it zooms *in* to a
 * reasonable inspection level (matching fitToNodesOnce()'s maxZoom above)
 * but never zooms out if the user was already closer. */
// Web Mercator resolution roughly halves each zoom level (~152m/px at z10,
// ~76m/px at z11 at the equator, scaled down further by cos(latitude)) --
// z11 keeps a typical map viewport width showing on the order of 60-70km
// across, i.e. a ~30-35km visible radius, rather than z14's city-block-level
// close-up.
const NODE_INSPECT_ZOOM = 11;

// MapLibre's `speed` option scales duration with flight distance, so a
// nearby node still snaps almost instantly no matter how low `speed` goes --
// a fixed `duration` instead gives every click the same deliberate pan/zoom
// regardless of how far the camera has to travel.
const FLY_TO_DURATION_MS = 2500;

function flyToNode(feature: NodeFeature): void {
  if (!feature.geometry) return;
  const [lon, lat] = feature.geometry.coordinates;
  map.flyTo({
    center: [lon, lat],
    zoom: Math.max(map.getZoom(), NODE_INSPECT_ZOOM),
    duration: FLY_TO_DURATION_MS,
  });
}

/** Nodes without a position can't be placed on the map at all (see
 * nodesLayer.ts's hasGeometry filter), so this is only reachable via a
 * stale/edge-case ?node= URL restore -- bail out rather than anchoring a
 * popup nowhere. */
function openNodePopup(feature: NodeFeature): void {
  if (!feature.geometry) return;
  closePopup();

  const [lon, lat] = feature.geometry.coordinates;
  const popup = new Popup({ closeButton: true, closeOnClick: false, className: "node-popup" })
    .setLngLat([lon, lat])
    .setDOMContent(buildPopupContent(feature))
    .addTo(map);
  popup.on("close", () => {
    if (activePopup === popup) {
      activePopup = null;
      selectNode(null, null);
    }
  });
  activePopup = popup;
}

/** Nulls the reference before removing so the popup's own "close" handler
 * (above) sees activePopup !== itself and doesn't recurse back into
 * selectNode() when we're the ones swapping it out. */
function closePopup(): void {
  if (!activePopup) return;
  const popup = activePopup;
  activePopup = null;
  popup.remove();
}

function buildPopupContent(feature: NodeFeature): HTMLElement {
  const p = feature.properties;
  const container = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = p.display_name || p.native_id;
  container.append(heading);

  const details = document.createElement("dl");
  // Click features come from MapLibre's GeoJSON source, which round-trips
  // through its internal vector-tile encoding -- a format with no `null`
  // value type. A `null` property in the source data comes back as
  // `undefined` here, not `null`, so these checks need `!= null` /
  // `?? null` (catches both) rather than a strict `=== null`.
  const rows: [string, string | null][] = [
    ["Native id", p.native_id],
    ["System", p.system_id],
    ["Hardware", p.hardware_model ?? null],
    ["Battery", p.battery_pct != null ? `${p.battery_pct}%` : null],
    ["SNR", p.snr != null ? `${p.snr} dB` : null],
    ["Last seen", p.last_seen ? new Date(p.last_seen).toLocaleString() : null],
  ];
  for (const [label, value] of rows) {
    if (value == null) continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    details.append(dt, dd);
  }
  container.append(details);
  return container;
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
