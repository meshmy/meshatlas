import type {
  FeatureCollection,
  HistoryResponse,
  LinkFeature,
  LiveMessage,
  NodeFeature,
  SystemInfo,
} from "./types";

// Vite bakes VITE_-prefixed env vars in at build time (see
// web/Dockerfile). Defaulting to "/api" matches the nginx reverse-proxy
// setup in docker-compose.yml, so a plain `npm run build` still points
// somewhere sane.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getSystems(): Promise<SystemInfo[]> {
  return getJSON("/systems");
}

export function getNodes(params: { system?: string; activeHours?: number } = {}): Promise<
  FeatureCollection<NodeFeature>
> {
  const q = new URLSearchParams();
  if (params.system) q.set("system", params.system);
  if (params.activeHours) q.set("active_hours", String(params.activeHours));
  return getJSON(`/nodes?${q}`);
}

export function getLinks(
  params: {
    system?: string;
    hours?: number;
    linkType?: string;
    node?: string;
  } = {},
): Promise<FeatureCollection<LinkFeature>> {
  const q = new URLSearchParams();
  if (params.system) q.set("system", params.system);
  if (params.hours) q.set("hours", String(params.hours));
  if (params.linkType) q.set("link_type", params.linkType);
  if (params.node) q.set("node", params.node);
  return getJSON(`/links?${q}`);
}

export function getNodeHistory(nodeId: string, hours = 24): Promise<HistoryResponse> {
  return getJSON(`/nodes/${nodeId}/history?hours=${hours}`);
}

/** Opens the live WebSocket feed and calls `onMessage` for every event.
 * Reconnects with backoff on drop -- a live map should keep trying rather
 * than silently going stale after one blip. */
export function connectLiveFeed(
  onMessage: (message: LiveMessage) => void,
  onStatusChange: (status: "connecting" | "open" | "closed") => void,
): () => void {
  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let retryDelayMs = 1000;

  const wsBase = API_BASE.startsWith("http")
    ? API_BASE.replace(/^http/, "ws").replace(/\/api\/?$/, "")
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

  function connect() {
    if (closedByCaller) return;
    onStatusChange("connecting");
    socket = new WebSocket(`${wsBase}/ws/live`);

    socket.onopen = () => {
      retryDelayMs = 1000;
      onStatusChange("open");
    };
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data) as LiveMessage);
      } catch (err) {
        console.error("meshatlas: failed to parse live message", err);
      }
    };
    socket.onclose = () => {
      onStatusChange("closed");
      if (!closedByCaller) {
        setTimeout(connect, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    };
    socket.onerror = () => {
      socket?.close();
    };
  }

  connect();

  return () => {
    closedByCaller = true;
    socket?.close();
  };
}
