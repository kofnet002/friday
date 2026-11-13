"""Dict-backed stand-in for the async Redis client (decode_responses=True)."""

from __future__ import annotations

import fnmatch
from collections.abc import AsyncIterator
from typing import Any


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None, **_: Any) -> bool:
        self.store[key] = value
        return True

    async def delete(self, *keys: str) -> int:
        return sum(1 for k in keys if self.store.pop(k, None) is not None)

    async def scan_iter(self, match: str = "*", **_: Any) -> AsyncIterator[str]:
        for key in list(self.store):
            if fnmatch.fnmatchcase(key, match):
                yield key


def install_fake_redis(monkeypatch: Any) -> FakeRedis:
    from app import redis_client as rc

    fake = FakeRedis()

    async def get_redis() -> Any:
        return fake

    monkeypatch.setattr(rc, "get_redis", get_redis)
    return fake
