# Adding a new RF system (APRS, LoRa APRS, MeshCore, ...)

MeshAtlas is built so a new node-and-RF-link network is a new plugin, not
a schema/API/frontend change. This walks through what that plugin needs
to do, using the existing Meshtastic source
(`api/app/sources/meshtastic_mqtt.py`) as the reference implementation.

## 1. Backend: implement a `Source`

Create `api/app/sources/<system>.py` with a class implementing
`app.sources.base.Source`:

```python
from . import register_source
from .base import Source, Sink
import asyncio

@register_source("aprs")
class AprsSource(Source):
    def __init__(self, config) -> None:
        super().__init__(config)

    async def run(self, sink: Sink, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            # ... connect to APRS-IS, decode packets ...
            await sink(NodeUpdate(system_id="aprs", native_id=callsign, ...))
            # and/or:
            await sink(LinkObservation(system_id="aprs", from_native_id=..., to_native_id=..., link_type="heard_direct", ...))
```

Your `run()` method is the entire contract: decode whatever wire format
your system uses, and call `sink(...)` with `NodeUpdate` (position/name/
telemetry) or `LinkObservation` (an RF contact/neighbor report) events,
defined in `app/sources/base.py`. Everything downstream -- persistence,
the WebSocket feed, the REST API, the frontend -- only ever sees those two
generic shapes. Look at `meshtastic_mqtt.py` for a fully worked example,
including how it derives `LinkObservation`s from packet metadata rather
than a dedicated "neighbor" message type.

A few rules that keep a new source consistent with the rest of the app:

- **Never touch the database directly.** `sink()` is provided by
  `app/ingest.py` and handles persistence; a `Source` that reached into
  `app.db` itself would break the "sources are dumb decoders" contract
  and make testing them (see `tests/test_meshtastic_source.py`) much
  harder.
- **`native_id` must be stable and unique within your system.** It's what
  `(system_id, native_id)` uniqueness in the `nodes` table hangs off of.
  For Meshtastic this is `"!" + hex(node_num)`; for APRS it would
  naturally be the callsign-SSID.
- **Both ends of a `LinkObservation` must be the same `system_id`.**
  Cross-system links (e.g. "this Meshtastic node heard an APRS station")
  aren't a case the schema or frontend currently model -- if you have a
  real need for that, it's a bigger design conversation, not a one-line change.

## 2. Config

Add a config dataclass to `api/app/config.py` (see `MeshtasticConfig`) and
wire it into `_config_for()` in `api/app/ingest.py`:

```python
if system_id == "aprs":
    return settings.aprs
```

Add the corresponding `APRS_*` environment variables to `.env.example`
and `docker-compose.yml`'s `api` service `environment:` block.

## 3. Register the system's identity

`app/db.py::KNOWN_SYSTEMS` already lists `aprs`, `lora_aprs` and
`meshcore` as placeholders (seeded by the initial migration into the
`systems` table), so `GET /api/systems` and the frontend's system
checkboxes already know about them with a "not yet implemented" style
description. Once you add a real `Source`, update the description there
if you want ("APRS-IS, live" instead of "Not yet implemented").

## 4. Enable it

Add your system id to `ENABLED_SOURCES` (comma-separated) in `.env`. That's it --
`app/ingest.py::IngestionManager.start()` looks up every id in
`ENABLED_SOURCES` against the `Source` registry and starts one background
task per match.

## What you don't need to touch

- **Database schema**: `nodes`, `node_positions`, `node_links` are all
  keyed by `system_id` already.
- **REST API**: `/api/nodes`, `/api/links`, `/api/nodes/{id}/history` all
  accept a `system` filter and work for any `system_id` present in the data.
- **Frontend**: nodes and links are each a single unified map layer across
  all systems, distinguished by the `system_id` property already present
  on every GeoJSON feature (see `web/src/deckOverlay.ts` for the reasoning).
  A new system's data shows up automatically, filterable via the
  dynamically-populated "Systems" checklist in the sidebar.
