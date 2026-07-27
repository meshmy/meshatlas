"""AES-CTR helpers for decrypting Meshtastic channel payloads.

Meshtastic encrypts the payload of every packet with AES-CTR using a
per-channel pre-shared key (PSK). The nonce is derived from fields already
present in the (unencrypted) packet header, so any client that knows the
channel's PSK can decrypt traffic on that channel without a handshake.

Nonce layout (16 bytes, little-endian):
    bytes[0:8]  = packet id   (uint64)
    bytes[8:16] = from_node   (uint64)

The default/"public" channel uses a well-known single-byte PSK shorthand
("AQ==" in base64) which the firmware expands to a fixed 16-byte AES-128
key. That expansion is reproduced in DEFAULT_CHANNEL_KEY below so this
service can read public traffic out of the box. Private channels use a
full 16 or 32 byte PSK configured by the mesh operator; those keys are
never guessable and must be supplied via MESHTASTIC_CHANNEL_KEYS.
"""
from __future__ import annotations

import base64

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# The firmware's hard-coded expansion of the one-byte default PSK ("AQ==",
# i.e. 0x01) into a full 16-byte AES-128 key. This is public knowledge, not
# a secret -- it is what makes the default channel "unencrypted in
# practice" despite technically being encrypted.
DEFAULT_CHANNEL_KEY: bytes = bytes(
    [0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59, 0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01]
)


def build_nonce(packet_id: int, from_node: int) -> bytes:
    return (packet_id & 0xFFFFFFFFFFFFFFFF).to_bytes(8, "little") + (
        from_node & 0xFFFFFFFFFFFFFFFF
    ).to_bytes(8, "little")


def decrypt(ciphertext: bytes, key: bytes, packet_id: int, from_node: int) -> bytes:
    """Decrypt (or encrypt -- CTR mode is symmetric) a Meshtastic payload."""
    nonce = build_nonce(packet_id, from_node)
    cipher = Cipher(algorithms.AES(key), modes.CTR(nonce))
    decryptor = cipher.decryptor()
    return decryptor.update(ciphertext) + decryptor.finalize()


def decode_key(value: str) -> bytes:
    """Decode a base64-encoded channel PSK, expanding the one-byte
    "default channel" shorthand the same way the firmware does."""
    raw = base64.b64decode(_pad(value))
    if len(raw) == 1:
        expanded = bytearray(DEFAULT_CHANNEL_KEY)
        expanded[-1] = raw[0]
        return bytes(expanded)
    return raw


def _pad(value: str) -> str:
    return value + "=" * (-len(value) % 4)
