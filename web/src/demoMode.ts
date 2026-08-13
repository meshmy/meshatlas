import type { Map as MapLibreMap } from "maplibre-gl";
import type { LinkFeature, NodeFeature } from "./types";

// Deliberately close/low: this is a cinematic "flying low over the mesh"
// camera, not the inspection view flyToNode() uses elsewhere in main.ts.
const DEMO_ZOOM = 15;
// mapSetup's maxPitch is 85 -- staying a little under that keeps some
// headroom while still tilting far enough toward horizontal to show the
// horizon during flight, per the "low enough angle to see the horizon"
// requirement.
const DEMO_PITCH = 70;
// Per-hop choreography: hold on the current node with its popup open for
// the full rotate -- that's the reading time for the popup -- then hide
// it and fly to the next node with no popup showing, only opening the new
// one once the camera has actually landed.
const STATIC_DURATION_MS = 10_000;
// Fly duration scales with actual distance (see flyDurationFor()) rather
// than being fixed, so a hop between two nearby nodes doesn't drag out as
// long as a hop across the whole region. CRUISE_SPEED_MPS is picked so
// typical LoRa mesh spacing (a few hundred meters to a couple of
// kilometers) lands in between the floor and ceiling rather than pinned
// to one end.
const CRUISE_SPEED_MPS = 500;
const MIN_FLY_DURATION_MS = 2000;
const MAX_FLY_DURATION_MS = 10_000;
// MapLibre's flyTo() zooms out mid-flight for a cinematic "rise" before
// zooming back in, scaled by this curve (1.42 default -- "a high value
// maximizes zooming for an exaggerated animation"; 1 is "circular
// motion"). At DEMO_ZOOM/the default curve, longer hops rise enough to
// dip below the 3D buildings layer's minzoom (12, see mapSetup.ts) and
// buildings visibly vanish mid-flight. A flatter curve keeps the dip
// shallow enough to stay above that threshold.
const FLY_CURVE = 0.6;

export interface DemoStatus {
  running: boolean;
  label: string | null;
}

interface Graph {
  nodesById: Map<string, NodeFeature>;
  adjacency: Map<string, Set<string>>;
}

/** Runs an unattended camera tour of the mesh: starts from a random
 * eligible node, then works through a shuffled playlist of every other
 * eligible node currently on screen, flying to each in turn via the
 * shortest path (hopping through, and checking off, whatever other nodes
 * that path happens to pass along the way). "Eligible" excludes 2-node
 * islands (see eligibleNodeIds()) -- a pair of nodes linked only to each
 * other has nothing to zig-zag through, just an immediate bounce back, so
 * they're skipped rather than given their own stop. The playlist only
 * reshuffles and starts repeating once every eligible node has had its
 * own stop. */
export class DemoMode {
  private running = false;
  private generation = 0;
  private timer: number | undefined;
  private pendingResolve: (() => void) | null = null;

  constructor(
    private readonly map: MapLibreMap,
    // Expected to return only currently-visible nodes (system/status/
    // region filters applied) -- see NodesLayer.visible() in main.ts's
    // wiring. Re-called on every leg, so toggling a filter mid-tour is
    // picked up on the next graph rebuild.
    private readonly getNodes: () => NodeFeature[],
    private readonly getLinks: () => LinkFeature[],
    private readonly onArrive: (feature: NodeFeature) => void,
    // Called right as a fly leg starts, so the outgoing node's popup
    // closes instead of staying open (mismatched with the camera) while
    // the camera is in transit.
    private readonly onDepart: () => void,
    private readonly onStatusChange: (status: DemoStatus) => void,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  /** Returns false (and does nothing) if there's currently no node with at
   * least one neighbor to start a tour from. */
  start(): boolean {
    if (this.running) return true;
    const graph = buildGraph(this.getNodes(), this.getLinks());
    if (!pickRandomStartNode(graph)) return false;
    this.running = true;
    const generation = ++this.generation;
    void this.run(generation);
    return true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    window.clearTimeout(this.timer);
    // Cancels whatever easeTo/flyTo is mid-flight so the camera doesn't
    // keep drifting toward the demo's last target after the user's asked
    // to stop.
    this.map.stop();
    this.pendingResolve?.();
    this.pendingResolve = null;
    this.onStatusChange({ running: false, label: null });
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.timer = window.setTimeout(() => {
        this.pendingResolve = null;
        resolve();
      }, ms);
    });
  }

  private announce(feature: NodeFeature): void {
    this.onArrive(feature);
    const p = feature.properties;
    this.onStatusChange({ running: true, label: p.short_name || p.display_name || p.native_id });
  }

  /** Gets the camera into position on `feature` (no rotation -- the first
   * hop of whatever leg runs next takes care of that) and opens its info
   * popup. Used for the very first node of a tour, and for playlist
   * targets that aren't reachable from the current node at all (a
   * different connected component) -- there's no path to hop through, so
   * this just cuts straight there instead. Uses the same distance-scaled
   * duration function as the regular between-node fly leg (measured from
   * the camera's current position, since there's no "from" node here) so
   * every movement in the tour feels the same, whether or not it's
   * preceded by a rotate. */
  private async arriveAtFresh(feature: NodeFeature, generation: number): Promise<void> {
    const center = this.map.getCenter();
    const target = coordsOf(feature);
    const duration = flyDurationFor([center.lng, center.lat], target);
    this.map.flyTo({
      center: target,
      zoom: DEMO_ZOOM,
      pitch: DEMO_PITCH,
      duration,
      curve: FLY_CURVE,
      easing: easeInOutSine,
      essential: true,
    });
    await this.delay(duration);
    if (!this.isActive(generation)) return;
    this.announce(feature);
  }

  private async run(generation: number): Promise<void> {
    let graph = buildGraph(this.getNodes(), this.getLinks());
    let current = pickRandomStartNode(graph);
    if (!current) {
      this.stop();
      return;
    }
    await this.arriveAtFresh(graph.nodesById.get(current)!, generation);

    // Nodes that have had their own stop this cycle -- either as a
    // playlist target or as an intermediate hop passed through on the way
    // to one. A fresh playlist is drawn, excluding these, whenever the
    // current one runs out; only then does anything start repeating.
    let touched = new Set([current]);
    let playlist = shufflePlaylist(graph, touched);
    let playlistIndex = 0;

    while (this.isActive(generation)) {
      if (playlistIndex >= playlist.length) {
        graph = buildGraph(this.getNodes(), this.getLinks());
        touched = new Set([current]);
        playlist = shufflePlaylist(graph, touched);
        playlistIndex = 0;
        if (playlist.length === 0) break; // nothing left anywhere to tour
      }

      const target = playlist[playlistIndex++];
      // Already reached as a pass-through hop earlier this cycle, or
      // dropped out of the live/filtered node set since the playlist was
      // drawn -- either way, nothing to do, move on to the next entry.
      if (touched.has(target) || !graph.nodesById.has(target)) continue;

      graph = buildGraph(this.getNodes(), this.getLinks());
      const path = computePathTo(graph, current, target);
      if (!path) {
        // Different connected component -- no path to hop through.
        current = target;
        touched.add(current);
        await this.arriveAtFresh(graph.nodesById.get(current)!, generation);
        continue;
      }

      for (let i = 1; i < path.length && this.isActive(generation); i++) {
        const from = graph.nodesById.get(path[i - 1])!;
        const to = graph.nodesById.get(path[i])!;
        // shortestBearing() re-expresses the target compass bearing as a
        // value numerically close to the camera's actual current bearing
        // (which may itself be outside 0-360 from a previous hop's own
        // shortest-path adjustment), so the rotate always turns whichever
        // way is shorter instead of potentially sweeping the long way
        // around to an equivalent angle.
        const bearing = shortestBearing(this.map.getBearing(), bearingBetween(coordsOf(from), coordsOf(to)));

        this.map.easeTo({ bearing, duration: STATIC_DURATION_MS, easing: easeInOutSine, essential: true });
        await this.delay(STATIC_DURATION_MS);
        if (!this.isActive(generation)) return;

        // Popup closes as the fly leg starts -- no node is "current" while
        // the camera's in transit, so nothing should be shown until arrival.
        this.onDepart();

        const flyDuration = flyDurationFor(coordsOf(from), coordsOf(to));
        this.map.flyTo({
          center: coordsOf(to),
          zoom: DEMO_ZOOM,
          pitch: DEMO_PITCH,
          bearing,
          duration: flyDuration,
          curve: FLY_CURVE,
          easing: easeInOutSine,
          essential: true,
        });

        await this.delay(flyDuration);
        if (!this.isActive(generation)) return;

        current = path[i];
        touched.add(current);
        this.announce(to);
      }
    }
    this.stop();
  }
}

function buildGraph(nodes: NodeFeature[], links: LinkFeature[]): Graph {
  const nodesById = new Map<string, NodeFeature>();
  for (const node of nodes) {
    if (node.geometry) nodesById.set(node.properties.id, node);
  }

  const adjacency = new Map<string, Set<string>>();
  const neighborsOf = (id: string): Set<string> => {
    let set = adjacency.get(id);
    if (!set) {
      set = new Set();
      adjacency.set(id, set);
    }
    return set;
  };
  for (const link of links) {
    const { from_node_id, to_node_id } = link.properties;
    if (from_node_id === to_node_id) continue;
    if (!nodesById.has(from_node_id) || !nodesById.has(to_node_id)) continue;
    neighborsOf(from_node_id).add(to_node_id);
    neighborsOf(to_node_id).add(from_node_id);
  }
  return { nodesById, adjacency };
}

function pickRandomStartNode(graph: Graph): string | null {
  const candidates = eligibleNodeIds(graph);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Every node with at least one neighbor, excluding ones whose connected
 * component has exactly 2 members -- a pair of nodes linked only to each
 * other isn't worth a tour stop (there's nothing to zig-zag through, just
 * an immediate bounce back), so skip those islands entirely rather than
 * giving them their own playlist turn. */
function eligibleNodeIds(graph: Graph): string[] {
  const componentSizes = computeComponentSizes(graph);
  return [...graph.adjacency.entries()]
    .filter(([id, neighbors]) => neighbors.size > 0 && componentSizes.get(id) !== 2)
    .map(([id]) => id);
}

/** Size of each node's connected component, keyed by node id. Nodes with
 * no neighbors at all are omitted. */
function computeComponentSizes(graph: Graph): Map<string, number> {
  const sizes = new Map<string, number>();
  const seen = new Set<string>();
  for (const id of graph.adjacency.keys()) {
    if (seen.has(id) || graph.adjacency.get(id)!.size === 0) continue;
    const component: string[] = [id];
    seen.add(id);
    for (let head = 0; head < component.length; head++) {
      for (const neighbor of graph.adjacency.get(component[head]) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        component.push(neighbor);
      }
    }
    for (const memberId of component) sizes.set(memberId, component.length);
  }
  return sizes;
}

/** BFS shortest-hop path from `current` to `target`. Returns the path
 * including `current` at index 0, or null if `target` isn't reachable
 * from `current` at all (a different connected component). */
function computePathTo(graph: Graph, current: string, target: string): string[] | null {
  if (current === target) return null;
  const prev = new Map<string, string>();
  const seen = new Set<string>([current]);
  const queue: string[] = [current];
  for (let head = 0; head < queue.length && !seen.has(target); head++) {
    const node = queue[head];
    for (const neighbor of graph.adjacency.get(node) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      prev.set(neighbor, node);
      queue.push(neighbor);
    }
  }
  if (!seen.has(target)) return null;

  const path: string[] = [target];
  let node = target;
  while (node !== current) {
    node = prev.get(node)!;
    path.push(node);
  }
  path.reverse();
  return path;
}

/** Fisher-Yates shuffle of every eligible node (see eligibleNodeIds()),
 * minus whatever's in `exclude`. */
function shufflePlaylist(graph: Graph, exclude: Set<string>): string[] {
  const ids = eligibleNodeIds(graph).filter((id) => !exclude.has(id));
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/** Ease-in-out sine, t in 0..1. Gentler than a cubic ease-in-out -- its
 * peak (midpoint) speed is only ~1.57x the average speed, vs. ~3x for a
 * cubic curve, so the camera doesn't feel like it's rushing through the
 * middle of the rotate/fly. Still eases fully to a stop at both ends,
 * unlike MapLibre's own default (a CSS "ease"-style cubic-bezier with a
 * nonzero start slope). */
function easeInOutSine(t: number): number {
  return (1 - Math.cos(Math.PI * t)) / 2;
}

/** Re-expresses `targetBearing` (a 0-360 compass bearing) as a value
 * numerically close to `currentBearing` -- possibly negative or past 360,
 * since `currentBearing` itself may already be outside 0-360 -- chosen so
 * that interpolating from `currentBearing` to the returned value sweeps
 * through the shortest of the two possible rotations rather than
 * whichever one a raw 0-360 target happens to land on. */
function shortestBearing(currentBearing: number, targetBearing: number): number {
  let delta = (targetBearing - currentBearing) % 360;
  if (delta < -180) delta += 360;
  else if (delta > 180) delta -= 360;
  return currentBearing + delta;
}

function coordsOf(feature: NodeFeature): [number, number] {
  const [lon, lat] = feature.geometry!.coordinates;
  return [lon, lat];
}

/** Forward-azimuth great-circle bearing, in degrees clockwise from north --
 * the same convention MapLibre's `bearing` camera option uses. */
function bearingBetween([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Haversine great-circle distance, in meters. */
function distanceMeters([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Fly duration proportional to real-world distance at CRUISE_SPEED_MPS,
 * clamped to [MIN_FLY_DURATION_MS, MAX_FLY_DURATION_MS] so a hop between
 * nearby nodes doesn't drag on as long as one clear across the region,
 * while a very long hop still resolves in a bounded time. */
function flyDurationFor(from: [number, number], to: [number, number]): number {
  const ms = (distanceMeters(from, to) / CRUISE_SPEED_MPS) * 1000;
  return Math.min(MAX_FLY_DURATION_MS, Math.max(MIN_FLY_DURATION_MS, ms));
}
