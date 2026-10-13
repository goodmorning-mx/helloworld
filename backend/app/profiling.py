"""Small, dependency-free timing profiler used by request-level workflows."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from time import perf_counter
from typing import Iterator


@dataclass
class _ProfileEntry:
    count: int = 0
    total_ms: float = 0.0
    last_ms: float = 0.0
    max_ms: float = 0.0


class Profiling:
    """Collect inclusive wall-clock timings without changing business logic."""

    def __init__(self, name: str = "workflow") -> None:
        self.name = name
        self._started = perf_counter()
        self._entries: dict[str, _ProfileEntry] = {}

    @contextmanager
    def measure(self, stage: str) -> Iterator[None]:
        started = perf_counter()
        try:
            yield
        finally:
            elapsed_ms = (perf_counter() - started) * 1000
            entry = self._entries.setdefault(stage, _ProfileEntry())
            entry.count += 1
            entry.total_ms += elapsed_ms
            entry.last_ms = elapsed_ms
            entry.max_ms = max(entry.max_ms, elapsed_ms)

    def snapshot(self) -> dict[str, object]:
        stages = [
            {
                "stage": stage,
                "count": entry.count,
                "total_ms": round(entry.total_ms, 2),
                "last_ms": round(entry.last_ms, 2),
                "max_ms": round(entry.max_ms, 2),
            }
            for stage, entry in sorted(self._entries.items(), key=lambda item: item[1].total_ms, reverse=True)
        ]
        return {
            "name": self.name,
            "total_ms": round((perf_counter() - self._started) * 1000, 2),
            "stages": stages,
        }
