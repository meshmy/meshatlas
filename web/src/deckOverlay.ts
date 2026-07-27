import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";

/** One shared deck.gl WebGL context for the whole map.
 *
 * Design note (nodes vs. links, and single- vs. multi-system layers):
 * nodes are rendered as a single MapLibre GeoJSON source/layer across all
 * RF systems, since every node/link feature already carries a `system_id`
 * property (see api/app/schemas.py + src/types.ts) -- that's the
 * "metadata to classify/filter by system" rather than needing a separate
 * MapLibre layer per system. NodesLayer.setSystemFilter() and the
 * `enabledSystems` filtering in main.ts both key off that property. A
 * link can never cross systems (see app/db.py::apply_link_observation --
 * both ends of a LinkObservation are resolved within the same
 * system_id), so per-system link styling is also just a matter of
 * branching on `feature.properties.system_id` inside one layer, not
 * maintaining N parallel layers.
 *
 * This class exists so that whoever owns link rendering (today just
 * LinksLayer) doesn't also have to own "how many deck.gl overlays are
 * attached to the map" -- there should only ever be one.
 */
export class DeckOverlay {
  private readonly overlay: MapboxOverlay;

  constructor(map: MapLibreMap) {
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(this.overlay as unknown as IControl);
  }

  setLayers(layers: Layer[]): void {
    this.overlay.setProps({ layers });
  }
}
