# MeshAtlas

A live 3D map of Meshtastic nodes and RF coverage -- vector basemap, real
elevation/terrain, 3D buildings, and "who heard whom" contact lines you
can view from any angle. Think lora-aprs.live's [coverage
view](https://lora-aprs.live/coverage.html) crossed with
[meshmap](https://meshmap2.lucifernet.com/)-style node tracking, rendered
on a proper GIS stack instead of a flat 2D map.

Ingests live from a Meshtastic MQTT broker (defaults to
`mqtt.lucifernet.com`). Built to add other node-and-RF-link networks later
(APRS, LoRa APRS, MeshCore) without reworking the schema, API or frontend
-- see [docs/ADDING_A_SOURCE.md](docs/ADDING_A_SOURCE.md).

## Quick start

```bash
cp .env.example .env      # adjust MQTT broker / channel keys if needed
docker compose up --build
```

Then open http://localhost:8080. The API is at http://localhost:8000/api
(OpenAPI docs at `/docs`).

Everything -- Postgres/PostGIS, the ingestion+API service, the web
frontend -- comes up from that one `docker compose up`. No local Python,
Node or Postgres installation needed.

## What you get

- **Live node positions**, updated in real time over a WebSocket as
  Meshtastic packets arrive (position, name, battery, hardware model).
- **Coverage / RF contact lines** in true 3D: which nodes have heard each
  other directly over RF (`heard_direct`, derived from MQTT gateway +
  hop metadata) and which nodes self-report each other as neighbors
  (`neighbor_report`, from NEIGHBORINFO_APP), colored by SNR. Because
  they're real 3D lines over real terrain, tilting the map lets you see
  whether a hill sits between two stations, not just how far apart they are.
- **Real elevation** (free, no API key, [AWS Terrain
  Tiles](https://registry.opendata.aws/terrain-tiles/)) with pan/tilt/orbit.
- **3D buildings** extruded from OpenStreetMap data.
- **Per-node history trail** and a **coverage-only-for-this-node** view
  (click a node, or open `?node=!a1b2c3d4` directly -- mirrors
  lora-aprs.live's `?rx_callsign=` pattern).
- Filters for time window, link type, node status (fresh/stale/offline),
  and RF system -- all client-side/instant except the coverage time
  window and active-node cutoff, which are server-side query params so
  payloads stay small on a big mesh.

## Architecture

```
Meshtastic MQTT  ──▶  api (FastAPI monolith)  ──▶  Postgres/PostGIS
mqtt.lucifernet.com    │        │                    (nodes, node_positions,
                       │        └── WebSocket ──▶     node_links)
                       │             /ws/live              │
                       └── REST ──▶ /api/nodes,             │
                            /api/links, /api/systems ◀──────┘
                                    │
                                    ▼
                          web (MapLibre + deck.gl, nginx)
```

It's one deployable service today (`api`), not several microservices --
that's a deliberate choice for now (see `docker-compose.yml`), but the
code inside it is already split by responsibility (`sources/`, `db.py`,
`ingest.py`, `api/`) so pulling ingestion out into its own container
later is a matter of moving files and adding a compose service, not a
rewrite.

### Why these components

| Layer | Choice | Why |
|---|---|---|
| Basemap | [MapLibre GL JS](https://maplibre.org/) + [OpenFreeMap](https://openfreemap.org/) | Open-source Mapbox GL fork; free OSM vector tiles, no API key |
| Terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Free, unauthenticated, Terrarium-encoded DEM MapLibre supports natively |
| 3D buildings | OSM `building` layer (`fill-extrusion`) | No extra data source needed |
| Coverage lines | [deck.gl](https://deck.gl/) `LineLayer` over MapLibre | True 3D lines at node altitude, not lines painted on the ground |
| DB | PostgreSQL + PostGIS | Geospatial indexing/queries; ships in the official `postgis/postgis` image |
| API/ingestion | FastAPI + sync SQLAlchemy + paho-mqtt | Message volume is low (a few/sec); sync code is simpler to read/debug than an async ORM for that volume |

## Configuration

All configuration is environment variables, see `.env.example`. The ones
you're most likely to change:

- `MESHTASTIC_MQTT_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` / `_TLS` --
  point at a different MQTT broker (e.g. your own Meshtastic MQTT
  module, or `mqtt.meshtastic.org`).
- `MESHTASTIC_CHANNEL_KEYS` -- comma-separated base64 PSKs for private
  channels. The public default channel key is always tried first, so
  public "LongFast" traffic decodes with no configuration.
- `MAP_STYLE_URL` -- swap the basemap for any MapLibre-compatible style
  (Protomaps, your own OpenMapTiles server, etc.). 3D buildings look for
  a `building` layer using the OpenMapTiles schema; other schemas will
  just skip that layer gracefully.

## Repository layout

```
api/
  app/
    sources/        Source plugin interface + Meshtastic MQTT implementation
    models.py        SQLAlchemy schema (systems, nodes, node_positions, node_links)
    db.py             CRUD + the event -> DB dispatch used by every source
    ingest.py         Wires sources to persistence to the WebSocket feed
    api/              REST routes
    main.py           FastAPI app + lifespan (starts/stops ingestion)
  migrations/         Alembic
  tests/              Unit tests for MQTT decoding/decryption (no live broker needed)
web/
  src/
    mapSetup.ts       MapLibre init, terrain, 3D buildings
    nodesLayer.ts     Node markers, live updates, status/system filtering
    linksLayer.ts     deck.gl coverage lines
    api.ts            REST + WebSocket client
docs/
  ADDING_A_SOURCE.md  How to plug in APRS/LoRa APRS/MeshCore/etc.
```

## Running tests

```bash
cd api
pip install -r requirements-dev.txt
pytest
```

The test suite constructs synthetic (but protocol-accurate) Meshtastic
protobuf packets -- including AES-CTR encrypted ones -- and checks the
decoding/decryption/link-derivation logic, so it runs with no MQTT broker
or database required.

## Known limitations / next steps

- **`relay_node` ambiguity**: Meshtastic packets only carry the *last
  byte* of a relaying node's id, which isn't enough to safely resolve to
  a full node id. `heard_direct` links are only emitted when a packet
  wasn't relayed at all (`relay_node == 0`), which is unambiguous but
  means relayed traffic doesn't currently contribute coverage edges.
- **No historical replay/scrubbing yet** -- filters are "now, looking
  back N hours", not a date-range time-travel UI. `node_positions` and
  `node_links` already store full history, so this is a frontend feature
  away, not a schema change.
- **Frontend bundle size**: the production build is a single ~1.6MB JS
  chunk. Fine for a self-hosted single-page app, but worth splitting
  `deck.gl`/`maplibre-gl` into a separate chunk if this grows further.
- **APRS / LoRa APRS / MeshCore**: schema, API and frontend are ready
  (see `systems` table and `docs/ADDING_A_SOURCE.md`); no ingestion
  Source is implemented for them yet, by design.
