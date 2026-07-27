from app.sources.crypto import DEFAULT_CHANNEL_KEY, decode_key, decrypt


def test_decode_key_expands_default_shorthand():
    assert decode_key("AQ==") == DEFAULT_CHANNEL_KEY


def test_decode_key_passes_through_full_length_keys():
    # A 16-byte (AES-128) key round-trips unchanged.
    key = bytes(range(16))
    import base64

    assert decode_key(base64.b64encode(key).decode()) == key


def test_decrypt_is_the_inverse_of_encrypt():
    # AES-CTR is symmetric: encrypting and decrypting are the same
    # operation, so we can validate the nonce/keystream logic round-trips
    # without needing a real captured Meshtastic packet.
    key = DEFAULT_CHANNEL_KEY
    plaintext = b"hello mesh world"
    packet_id, from_node = 123456, 987654321

    ciphertext = decrypt(plaintext, key, packet_id, from_node)
    assert ciphertext != plaintext

    recovered = decrypt(ciphertext, key, packet_id, from_node)
    assert recovered == plaintext


def test_decrypt_with_wrong_nonce_does_not_recover_plaintext():
    key = DEFAULT_CHANNEL_KEY
    plaintext = b"hello mesh world"
    ciphertext = decrypt(plaintext, key, 1, 2)
    assert decrypt(ciphertext, key, 3, 4) != plaintext
