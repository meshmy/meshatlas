"""Central place for reading configuration from the environment.

Keeping this in one module (instead of scattering `os.environ.get()` calls
through the codebase) makes it obvious what the service's full
configuration surface is, which matters a lot once more sources get added.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _list(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True, slots=True)
class MeshtasticConfig:
    mqtt_host: str = "mqtt.lucifernet.com"
    mqtt_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_tls: bool = False
    mqtt_topic: str = "msh/#"
    channel_keys: list[str] = field(default_factory=list)

    @classmethod
    def from_env(cls) -> "MeshtasticConfig":
        # NB: deliberately using literal defaults here rather than
        # referencing `cls.mqtt_host` etc. -- on a slots=True dataclass
        # those class attributes are descriptors, not the default values.
        return cls(
            mqtt_host=os.environ.get("MESHTASTIC_MQTT_HOST", "mqtt.lucifernet.com"),
            mqtt_port=int(os.environ.get("MESHTASTIC_MQTT_PORT", "1883")),
            mqtt_username=os.environ.get("MESHTASTIC_MQTT_USERNAME", ""),
            mqtt_password=os.environ.get("MESHTASTIC_MQTT_PASSWORD", ""),
            mqtt_tls=_bool(os.environ.get("MESHTASTIC_MQTT_TLS"), False),
            mqtt_topic=os.environ.get("MESHTASTIC_MQTT_TOPIC", "msh/#"),
            channel_keys=_list(os.environ.get("MESHTASTIC_CHANNEL_KEYS")),
        )


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    enabled_sources: list[str]
    meshtastic: MeshtasticConfig

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_url=os.environ.get(
                "DATABASE_URL",
                "postgresql+psycopg://meshatlas:change-me@localhost:5432/meshatlas",
            ),
            enabled_sources=_list(os.environ.get("ENABLED_SOURCES", "meshtastic")),
            meshtastic=MeshtasticConfig.from_env(),
        )


settings = Settings.from_env()
