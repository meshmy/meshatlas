// Mirrors the GeoJSON shapes produced by api/app/schemas.py. Kept as plain
// interfaces (not a shared schema/codegen step) since the API is small and
// stable; if it grows, generating these from the FastAPI OpenAPI schema
// would be the next step.

export interface NodeProperties {
  id: string;
  system_id: string;
  native_id: string;
  display_name: string | null;
  short_name: string | null;
  hardware_model: string | null;
  battery_pct: number | null;
  voltage: number | null;
  snr: number | null;
  rssi: number | null;
  first_seen: string | null;
  last_seen: string | null;
  last_position_at: string | null;
}

export interface NodeFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number, number] } | null;
  properties: NodeProperties;
}

export interface LinkProperties {
  id: number;
  system_id: string;
  link_type: "heard_direct" | "neighbor_report" | string;
  from_node_id: string;
  to_node_id: string;
  from_native_id: string;
  to_native_id: string;
  from_display_name: string;
  to_display_name: string;
  snr: number | null;
  rssi: number | null;
  distance_m: number | null;
  observed_at: string | null;
}

export interface LinkFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number, number][] };
  properties: LinkProperties;
}

export interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

export interface SystemInfo {
  id: string;
  name: string;
  description: string | null;
}

export interface HistoryPoint {
  observed_at: string;
  lon: number;
  lat: number;
  altitude_m: number | null;
}

export interface HistoryResponse {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number, number][] } | null;
  properties: {
    node_id: string;
    native_id: string;
    point_count: number;
    points: HistoryPoint[];
  };
}

export type LiveMessage =
  | { type: "node"; feature: NodeFeature }
  | { type: "link"; feature: LinkFeature };
