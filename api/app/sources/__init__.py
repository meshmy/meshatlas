"""Source plugin registry.

Importing this module has the side effect of registering every built-in
source (so that `REGISTRY` below is complete), without the rest of the app
needing to know the concrete list.
"""
from __future__ import annotations

from .base import Source

REGISTRY: dict[str, type[Source]] = {}


def register_source(system_id: str):
    def decorator(cls: type[Source]) -> type[Source]:
        cls.system_id = system_id
        REGISTRY[system_id] = cls
        return cls

    return decorator


# Import built-in sources so their @register_source decorators run.
from . import meshtastic_mqtt  # noqa: E402,F401
