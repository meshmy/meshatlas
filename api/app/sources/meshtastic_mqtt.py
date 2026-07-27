"""Meshtastic source: subscribes to a Meshtastic MQTT broker (by default
mqtt.lucifernet.com) and turns the protobuf traffic it publishes into the
generic NodeUpdate / LinkObservation events the rest of the app deals in.

Background on the wire format, for anyone maintaining this:

- Every packet a Meshtastic node uplinks to MQTT arrives as a
  `ServiceEnvelope` protobuf (see meshtastic.protobuf.mqtt_pb2), wrapping a
  `MeshPacket`. `envelope.gateway_id` is the node that bridged this packet
  onto MQTT; it is *not* necessarily the packet's original sender.
- A MeshPacket's payload (`Data`) is either already decoded
  (`packet.decoded`) or, far more commonly, `packet.encrypted` and needs
  AES-CTR decryption with the channel's PSK first (see crypto.py). The
  public "LongFast" channel most trackers listen on uses the well-known
  default PSK, so this works out of the box; private channels need their
  PSK supplied via MESHTASTIC_CHANNEL_KEYS.
- `Data.portnum` says what kind of application payload this is. We only
  care about a handful: NODEINFO_APP (name/hardware), POSITION_APP (GPS),
  TELEMETRY_APP (battery/voltage) and NEIGHBORINFO_APP (self-reported
  neighbor table) -- everything else (text messages, routing, admin, ...)
  is ignored.
- Coverage/"who heard whom" edges come from two independent signals:
    1. `heard_direct`: when a packet's `relay_node` is 0 (unset), the
       packet reached the MQTT gateway with no intermediate relay, so
       `envelope.gateway_id` demonstrably heard `packet.from` directly
       over RF, with signal quality `packet.rx_snr` / `packet.rx_rssi`.
       (If `relay_node` is set we deliberately skip emitting a link: it
       only contains the last hop's node id truncated to one byte, which
       isn't enough to safely resolve to a full node id.)
    2. `neighbor_report`: a node's own NEIGHBORINFO_APP payload, which is
       self-reported and independent of whether that node happens to be
       an MQTT gateway.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from google.protobuf.message import DecodeError
from meshtastic.protobuf import mesh_pb2, mqtt_pb2, portnums_pb2, telemetry_pb2

from . import register_source
from .base import Event, LinkObservation, NodeUpdate, Sink, Source
from .crypto import DEFAULT_CHANNEL_KEY, decode_key, decrypt

logger = logging.getLogger(__name__)


def node_native_id(node_num: int) -> str:
    """Meshtastic node numbers are 32-bit ints; the ecosystem convention
    (used in gateway_id, the official web client, etc.) is to display them
    as "!" + 8 lowercase hex digits. Normalizing every packet field to this
    form is what keeps a node's identity consistent across NodeInfo,
    Position, Telemetry and Neighbor packets, and across MQTT gateways."""
    return f"!{node_num & 0xFFFFFFFF:08x}"


def _normalize_gateway_id(gateway_id: str) -> str:
    if gateway_id.startswith("!"):
        return "!" + gateway_id[1:].lower()
    return gateway_id.lower()


def _is_json_topic(topic: str) -> bool:
    """Meshtastic MQTT brokers publish the same traffic twice under
    different topic trees when the JSON module is enabled: binary
    ServiceEnvelope protobufs under `.../2/e/<channel>/<node>` (what we
    want) and a human-readable JSON encoding under
    `.../2/json/<channel>/<node>`. Subscribing to the wildcard `msh/#`
    (the default MESHTASTIC_MQTT_TOPIC) picks up both, so this filters
    the JSON copies out before we waste a protobuf parse attempt on them."""
    return "json" in topic.split("/")


@register_source("meshtastic")
class MeshtasticMqttSource(Source):
    def __init__(self, config) -> None:
        super().__init__(config)
        # Default channel key is always tried first since it is, by far,
        # the most common case (public "LongFast" traffic).
        self._keys = [DEFAULT_CHANNEL_KEY] + [decode_key(k) for k in config.channel_keys]

    async def run(self, sink: Sink, stop_event: asyncio.Event) -> None:
        cfg = self.config
        loop = asyncio.get_running_loop()

        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        if cfg.mqtt_username:
            client.username_pw_set(cfg.mqtt_username, cfg.mqtt_password or None)
        if cfg.mqtt_tls:
            client.tls_set()

        def on_connect(client, userdata, connect_flags, reason_code, properties=None):
            if reason_code == 0:
                logger.info(
                    "meshtastic: connected to %s:%s, subscribing to %s",
                    cfg.mqtt_host,
                    cfg.mqtt_port,
                    cfg.mqtt_topic,
                )
                client.subscribe(cfg.mqtt_topic)
            else:
                logger.warning("meshtastic: mqtt connect failed: %s", reason_code)

        def on_disconnect(client, userdata, disconnect_flags, reason_code, properties=None):
            logger.warning("meshtastic: mqtt disconnected (%s), paho will auto-reconnect", reason_code)

        def on_message(client, userdata, msg):
            if _is_json_topic(msg.topic):
                return  # JSON-format duplicate of a topic we handle as protobuf; nothing to do
            try:
                events = list(self._decode_message(msg.payload))
            except DecodeError:
                # Expected background noise on a wildcard subscription --
                # non-ServiceEnvelope traffic (map reports, stats, or
                # anything not on a topic shape we already filter out
                # above), or an occasional truncated/corrupt packet. Not
                # actionable, so no traceback-level log for it.
                logger.debug("meshtastic: non-protobuf payload on topic %s, skipping", msg.topic)
                return
            except Exception:
                logger.exception("meshtastic: unexpected error decoding topic %s", msg.topic)
                return
            for event in events:
                asyncio.run_coroutine_threadsafe(sink(event), loop)

        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
        client.on_message = on_message

        client.connect(cfg.mqtt_host, cfg.mqtt_port, keepalive=60)
        client.loop_start()
        try:
            while not stop_event.is_set():
                await asyncio.sleep(1)
        finally:
            client.loop_stop()
            client.disconnect()

    # -- decoding -----------------------------------------------------

    def _decode_message(self, raw_payload: bytes) -> list[Event]:
        envelope = mqtt_pb2.ServiceEnvelope()
        envelope.ParseFromString(raw_payload)  # raises if not a ServiceEnvelope; caught by caller
        packet = envelope.packet

        if packet.HasField("decoded"):
            data = packet.decoded
        elif packet.encrypted:
            data = self._try_decrypt(packet)
            if data is None:
                return []  # none of our known channel keys could decrypt this
        else:
            return []

        observed_at = (
            datetime.fromtimestamp(packet.rx_time, tz=timezone.utc)
            if packet.rx_time
            else datetime.now(timezone.utc)
        )
        from_id = node_native_id(getattr(packet, "from"))

        events: list[Event] = list(self._decode_payload(data, from_id, observed_at))

        # A packet that reached MQTT with no intermediate relay tells us,
        # independent of its payload type, that the uplinking gateway
        # heard `from_id` directly over RF just now.
        if envelope.gateway_id and packet.relay_node == 0 and packet.rx_snr:
            events.append(
                LinkObservation(
                    system_id="meshtastic",
                    from_native_id=from_id,
                    to_native_id=_normalize_gateway_id(envelope.gateway_id),
                    observed_at=observed_at,
                    link_type="heard_direct",
                    snr=packet.rx_snr,
                    rssi=packet.rx_rssi or None,
                    extra={"hop_start": packet.hop_start, "hop_limit": packet.hop_limit},
                )
            )

        return events

    def _try_decrypt(self, packet) -> "mesh_pb2.Data | None":
        for key in self._keys:
            try:
                plaintext = decrypt(packet.encrypted, key, packet.id, getattr(packet, "from"))
                data = mesh_pb2.Data()
                data.ParseFromString(plaintext)
                return data
            except Exception:  # noqa: BLE001 - any of these means "wrong key", try the next one
                continue
        return None

    def _decode_payload(self, data, from_id: str, observed_at: datetime) -> list[Event]:
        port = data.portnum
        if port == portnums_pb2.PortNum.NODEINFO_APP:
            return self._decode_nodeinfo(data.payload, from_id, observed_at)
        if port == portnums_pb2.PortNum.POSITION_APP:
            return self._decode_position(data.payload, from_id, observed_at)
        if port == portnums_pb2.PortNum.TELEMETRY_APP:
            return self._decode_telemetry(data.payload, from_id, observed_at)
        if port == portnums_pb2.PortNum.NEIGHBORINFO_APP:
            return self._decode_neighborinfo(data.payload, from_id, observed_at)
        return []

    @staticmethod
    def _decode_nodeinfo(payload: bytes, from_id: str, observed_at: datetime) -> list[Event]:
        user = mesh_pb2.User()
        user.ParseFromString(payload)
        hw_model = None
        if user.hw_model:
            try:
                hw_model = mesh_pb2.HardwareModel.Name(user.hw_model)
            except ValueError:
                hw_model = str(user.hw_model)
        return [
            NodeUpdate(
                system_id="meshtastic",
                native_id=from_id,
                observed_at=observed_at,
                display_name=user.long_name or None,
                short_name=user.short_name or None,
                hardware_model=hw_model,
            )
        ]

    @staticmethod
    def _decode_position(payload: bytes, from_id: str, observed_at: datetime) -> list[Event]:
        pos = mesh_pb2.Position()
        pos.ParseFromString(payload)
        if not pos.latitude_i and not pos.longitude_i:
            return []
        return [
            NodeUpdate(
                system_id="meshtastic",
                native_id=from_id,
                observed_at=observed_at,
                latitude=pos.latitude_i * 1e-7,
                longitude=pos.longitude_i * 1e-7,
                altitude_m=float(pos.altitude) if pos.altitude else None,
            )
        ]

    @staticmethod
    def _decode_telemetry(payload: bytes, from_id: str, observed_at: datetime) -> list[Event]:
        telem = telemetry_pb2.Telemetry()
        telem.ParseFromString(payload)
        if not telem.HasField("device_metrics"):
            return []
        dm = telem.device_metrics
        return [
            NodeUpdate(
                system_id="meshtastic",
                native_id=from_id,
                observed_at=observed_at,
                battery_pct=dm.battery_level if dm.HasField("battery_level") else None,
                voltage=dm.voltage if dm.HasField("voltage") else None,
            )
        ]

    @staticmethod
    def _decode_neighborinfo(payload: bytes, from_id: str, observed_at: datetime) -> list[Event]:
        info = mesh_pb2.NeighborInfo()
        info.ParseFromString(payload)
        reporter_id = node_native_id(info.node_id) if info.node_id else from_id
        return [
            # `snr` has no explicit presence in this message (plain proto3
            # float), so 0.0 is treated as "not reported" like elsewhere in
            # this file rather than a real 0 dB reading.
            LinkObservation(
                system_id="meshtastic",
                from_native_id=reporter_id,
                to_native_id=node_native_id(neighbor.node_id),
                observed_at=observed_at,
                link_type="neighbor_report",
                snr=neighbor.snr or None,
            )
            for neighbor in info.neighbors
        ]
