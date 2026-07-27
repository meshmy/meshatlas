"""Exercises MeshtasticMqttSource's decoding against synthetic (but
protocol-accurate) protobuf messages, so the MQTT parsing logic can be
verified without a live broker or captured firmware traffic.
"""
from meshtastic.protobuf import mesh_pb2, mqtt_pb2, portnums_pb2, telemetry_pb2

from app.config import MeshtasticConfig
from app.sources.base import LinkObservation, NodeUpdate
from app.sources.crypto import DEFAULT_CHANNEL_KEY, decrypt
from app.sources.meshtastic_mqtt import MeshtasticMqttSource, node_native_id

CONFIG = MeshtasticConfig()


def make_source() -> MeshtasticMqttSource:
    return MeshtasticMqttSource(CONFIG)


def envelope_bytes(packet: mesh_pb2.MeshPacket, gateway_id: str = "!aaaaaaaa") -> bytes:
    envelope = mqtt_pb2.ServiceEnvelope(packet=packet, channel_id="LongFast", gateway_id=gateway_id)
    return envelope.SerializeToString()


def unencrypted_packet(from_node: int, portnum, payload: bytes, **kwargs) -> mesh_pb2.MeshPacket:
    data = mesh_pb2.Data(portnum=portnum, payload=payload)
    return mesh_pb2.MeshPacket(**{"from": from_node}, decoded=data, id=1, **kwargs)


def test_decodes_nodeinfo_packet():
    user = mesh_pb2.User(long_name="Test Node", short_name="TST", hw_model=1)
    packet = unencrypted_packet(0xDEADBEEF, portnums_pb2.PortNum.NODEINFO_APP, user.SerializeToString())

    events = make_source()._decode_message(envelope_bytes(packet))

    node_events = [e for e in events if isinstance(e, NodeUpdate)]
    assert len(node_events) == 1
    update = node_events[0]
    assert update.system_id == "meshtastic"
    assert update.native_id == node_native_id(0xDEADBEEF)
    assert update.display_name == "Test Node"
    assert update.short_name == "TST"
    assert update.hardware_model == "TLORA_V2"


def test_decodes_position_packet():
    pos = mesh_pb2.Position(latitude_i=int(1.23456 * 1e7), longitude_i=int(103.6543 * 1e7), altitude=42)
    packet = unencrypted_packet(0x1, portnums_pb2.PortNum.POSITION_APP, pos.SerializeToString())

    events = make_source()._decode_message(envelope_bytes(packet))

    update = next(e for e in events if isinstance(e, NodeUpdate))
    assert round(update.latitude, 5) == 1.23456
    assert round(update.longitude, 4) == 103.6543
    assert update.altitude_m == 42


def test_decodes_telemetry_packet():
    telem = telemetry_pb2.Telemetry(
        device_metrics=telemetry_pb2.DeviceMetrics(battery_level=87, voltage=4.01)
    )
    packet = unencrypted_packet(0x2, portnums_pb2.PortNum.TELEMETRY_APP, telem.SerializeToString())

    events = make_source()._decode_message(envelope_bytes(packet))

    update = next(e for e in events if isinstance(e, NodeUpdate))
    assert update.battery_pct == 87
    assert abs(update.voltage - 4.01) < 1e-6


def test_decodes_neighborinfo_as_link_observations():
    info = mesh_pb2.NeighborInfo(
        node_id=0x10,
        neighbors=[
            mesh_pb2.Neighbor(node_id=0x20, snr=5.5),
            mesh_pb2.Neighbor(node_id=0x30, snr=-2.0),
        ],
    )
    packet = unencrypted_packet(0x10, portnums_pb2.PortNum.NEIGHBORINFO_APP, info.SerializeToString())

    events = make_source()._decode_message(envelope_bytes(packet))

    links = [e for e in events if isinstance(e, LinkObservation) and e.link_type == "neighbor_report"]
    assert {(l.from_native_id, l.to_native_id, l.snr) for l in links} == {
        (node_native_id(0x10), node_native_id(0x20), 5.5),
        (node_native_id(0x10), node_native_id(0x30), -2.0),
    }


def test_unrelayed_packet_emits_heard_direct_link_from_gateway():
    pos = mesh_pb2.Position(latitude_i=1, longitude_i=1)
    packet = unencrypted_packet(
        0x99,
        portnums_pb2.PortNum.POSITION_APP,
        pos.SerializeToString(),
        relay_node=0,
        rx_snr=7.25,
        rx_rssi=-91,
        hop_start=3,
        hop_limit=3,
    )

    events = make_source()._decode_message(envelope_bytes(packet, gateway_id="!AABBCCDD"))

    link = next(e for e in events if isinstance(e, LinkObservation) and e.link_type == "heard_direct")
    assert link.from_native_id == node_native_id(0x99)
    assert link.to_native_id == "!aabbccdd"  # normalized to lowercase
    assert link.snr == 7.25
    assert link.rssi == -91


def test_relayed_packet_does_not_emit_heard_direct_link():
    pos = mesh_pb2.Position(latitude_i=1, longitude_i=1)
    packet = unencrypted_packet(
        0x99,
        portnums_pb2.PortNum.POSITION_APP,
        pos.SerializeToString(),
        relay_node=0xAB,  # nonzero -> packet was relayed, ambiguous last hop
        rx_snr=7.25,
    )

    events = make_source()._decode_message(envelope_bytes(packet))

    assert not any(isinstance(e, LinkObservation) for e in events)


def test_decrypts_default_channel_traffic():
    user = mesh_pb2.User(long_name="Encrypted Node", short_name="ENC", hw_model=1)
    data = mesh_pb2.Data(portnum=portnums_pb2.PortNum.NODEINFO_APP, payload=user.SerializeToString())
    plaintext = data.SerializeToString()

    from_node = 0x42
    packet_id = 555
    ciphertext = decrypt(plaintext, DEFAULT_CHANNEL_KEY, packet_id, from_node)
    packet = mesh_pb2.MeshPacket(**{"from": from_node}, id=packet_id, encrypted=ciphertext)

    events = make_source()._decode_message(envelope_bytes(packet))

    update = next(e for e in events if isinstance(e, NodeUpdate))
    assert update.display_name == "Encrypted Node"


def test_unknown_channel_key_is_silently_ignored():
    plaintext = mesh_pb2.Data(portnum=portnums_pb2.PortNum.NODEINFO_APP).SerializeToString()
    ciphertext = decrypt(plaintext, b"\x00" * 16, 1, 1)
    packet = mesh_pb2.MeshPacket(**{"from": 1}, id=1, encrypted=ciphertext)

    events = make_source()._decode_message(envelope_bytes(packet))

    assert events == []
