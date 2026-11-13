"""Dict-backed stand-in for the async Redis client (decode_responses=True)."""

from __future__ import annotations

import fnmatch
from collections.abc import AsyncIterator
from typing import Any


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        # Last TTL set on each key (by set(ex=…) or expire), for TTL tests.
        self.ttl: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None, **_: Any) -> bool:
        self.store[key] = value
        if ex is not None:
            self.ttl[key] = ex
        return True

    async def expire(self, key: str, seconds: int) -> bool:
        if key not in self.store:
            return False
        self.ttl[key] = seconds
        return True

    async def incr(self, key: str) -> int:
        value = int(self.store.get(key, "0")) + 1
        self.store[key] = str(value)
        return value

    async def delete(self, *keys: str) -> int:
        for k in keys:
            self.ttl.pop(k, None)
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
