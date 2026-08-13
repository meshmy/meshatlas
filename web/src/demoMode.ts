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
// Per-hop choreography: hold on the current node with its popup open while
// the camera slowly rotates to face the next hop, then swap to the next
// node's popup and fly there. Both legs are the same duration so the
// rhythm stays even regardless of hop distance.
const STATIC_DURATION_MS = 10_000;
const FLY_DURATION_MS = 10_000;
const INITIAL_FLY_MS = 3000;
// How much earlier than STATIC_DURATION_MS's nominal end to cut the
// rotate-in-place easeTo short and start the fly leg. flyTo inherits
// whatever bearing the rotate left the camera at and re-targets the same
// final bearing, so the last sliver of turning gets folded into the fly's
// own bearing interpolation instead of the two legs visibly meeting at a
// dead stop.
const ROTATE_FLY_OVERLAP_MS = 1200;

export interface DemoStatus {
  running: boolean;
  label: string | null;
}

interface Graph {
  nodesById: Map<string, NodeFeature>;
  adjacency: Map<string, Set<string>>;
}

/** Runs an unattended camera tour of the mesh: starts from a random node
 * that has at least one neighbor, then repeatedly flies to whichever
 * reachable node is the most hops away (preferring nodes not yet visited),
 * following the shortest path to it one hop at a time -- a simple
 * heuristic that tends to zig-zag across the whole graph rather than
 * pacing back and forth between two adjacent nodes. */
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
   * popup. Used both for the very first node of a tour and whenever the
   * graph is exhausted and the tour has to jump to a fresh random node. */
  private async arriveAtFresh(feature: NodeFeature, generation: number): Promise<void> {
    this.map.flyTo({
      center: coordsOf(feature),
      zoom: DEMO_ZOOM,
      pitch: DEMO_PITCH,
      duration: INITIAL_FLY_MS,
      essential: true,
    });
    await this.delay(INITIAL_FLY_MS);
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
    let visited = new Set([current]);
    await this.arriveAtFresh(graph.nodesById.get(current)!, generation);

    while (this.isActive(generation)) {
      graph = buildGraph(this.getNodes(), this.getLinks());
      let path = computeNextPath(graph, current, visited);
      if (!path || path.length < 2) {
        // Every reachable node has already been visited -- allow revisits
        // so the tour keeps moving instead of stalling.
        visited = new Set([current]);
        path = computeNextPath(graph, current, visited);
      }
      if (!path || path.length < 2) {
        // current has gone isolated (e.g. its links dropped out of the
        // live feed) -- jump to a fresh random node elsewhere if one
        // exists, otherwise there's nothing left to tour.
        const restart = pickRandomStartNode(graph);
        if (!restart) break;
        current = restart;
        visited = new Set([current]);
        await this.arriveAtFresh(graph.nodesById.get(current)!, generation);
        continue;
      }

      for (let i = 1; i < path.length && this.isActive(generation); i++) {
        const from = graph.nodesById.get(path[i - 1])!;
        const to = graph.nodesById.get(path[i])!;
        const bearing = bearingBetween(coordsOf(from), coordsOf(to));

        this.map.easeTo({ bearing, duration: STATIC_DURATION_MS, easing: easeInOutCubic, essential: true });
        await this.delay(STATIC_DURATION_MS - ROTATE_FLY_OVERLAP_MS);
        if (!this.isActive(generation)) return;

        // Popup swap happens right at the rotate->fly handoff: announce()
        // closes the outgoing node's popup and opens the incoming node's
        // in one atomic call (openNodePopup() calls closePopup()
        // internally), so both halves land together, at the moment the
        // camera starts moving toward `to`.
        this.announce(to);

        this.map.flyTo({
          center: coordsOf(to),
          zoom: DEMO_ZOOM,
          pitch: DEMO_PITCH,
          bearing,
          duration: FLY_DURATION_MS,
          easing: easeInOutCubic,
          essential: true,
        });

        await this.delay(FLY_DURATION_MS);
        if (!this.isActive(generation)) return;

        current = path[i];
        visited.add(current);
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
  const candidates = [...graph.adjacency.entries()]
    .filter(([, neighbors]) => neighbors.size > 0)
    .map(([id]) => id);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** BFS shortest-hop path from `current` to whichever reachable node is
 * farthest in hop count -- preferring a node not yet in `visited` so the
 * tour keeps covering new ground; falls back to the overall farthest node
 * (ignoring `visited`) once everything reachable has already been seen.
 * Returns the path including `current` at index 0, or null if `current`
 * has no reachable neighbors at all. */
function computeNextPath(graph: Graph, current: string, visited: Set<string>): string[] | null {
  const dist = new Map<string, number>([[current, 0]]);
  const prev = new Map<string, string>();
  const queue: string[] = [current];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    const d = dist.get(node)!;
    for (const neighbor of graph.adjacency.get(node) ?? []) {
      if (dist.has(neighbor)) continue;
      dist.set(neighbor, d + 1);
      prev.set(neighbor, node);
      queue.push(neighbor);
    }
  }

  let best: string | null = null;
  let bestDist = -1;
  let bestAny: string | null = null;
  let bestAnyDist = -1;
  for (const [id, d] of dist) {
    if (id === current) continue;
    if (d > bestAnyDist) {
      bestAnyDist = d;
      bestAny = id;
    }
    if (!visited.has(id) && d > bestDist) {
      bestDist = d;
      best = id;
    }
  }
  const target = best ?? bestAny;
  if (!target) return null;

  const path: string[] = [target];
  let node = target;
  while (node !== current) {
    node = prev.get(node)!;
    path.push(node);
  }
  path.reverse();
  return path;
}

/** Standard ease-in-out cubic, t in 0..1. MapLibre's easeTo/flyTo both
 * default to a CSS "ease"-style curve (cubic-bezier(0.25, 0.1, 0.25, 1)),
 * whose nonzero start slope reads as a fairly brisk start next to a true
 * standing start. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
