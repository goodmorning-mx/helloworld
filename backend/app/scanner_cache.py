"""Bounded, process-local caches for incremental scanner data and results."""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable


BarsLoader = Callable[[list[dict[str, Any]]], Awaitable[list[dict[str, Any]]]]


class ScannerCache:
    """Share candle refreshes and analysis work across scanner requests.

    Scanner data is derived from public exchange data, so it can be rebuilt
    after a process restart. A symbol and its analyses expire after the
    retention window without a successful candle refresh. Keeping this cache
    bounded avoids a database or separate cache service for disposable data.
    """

    def __init__(
        self,
        *,
        max_symbols: int = 100,
        max_bars: int = 2880,
        refresh_seconds: float = 5.0,
        retention_seconds: float = 48 * 60 * 60,
    ) -> None:
        self.max_symbols = max_symbols
        self.max_bars = max_bars
        self.refresh_seconds = refresh_seconds
        self.retention_seconds = retention_seconds
        self._bars: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
        self._bars_refreshed_at: dict[str, float] = {}
        self._bar_tasks: dict[str, asyncio.Task[tuple[list[dict[str, Any]], str | None, bool]]] = {}
        self._analyses: OrderedDict[tuple[str, tuple[Any, ...]], tuple[int, dict[str, Any]]] = OrderedDict()
        self._analysis_saved_at: dict[tuple[str, tuple[Any, ...]], float] = {}
        self._analysis_tasks: dict[tuple[str, tuple[Any, ...], int], asyncio.Task[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    async def refresh_bars(
        self,
        symbol: str,
        loader: BarsLoader,
        *,
        refresh_if: Callable[[list[dict[str, Any]]], bool] | None = None,
    ) -> tuple[list[dict[str, Any]], str | None, bool]:
        key = symbol.strip().upper()
        now = time.monotonic()
        async with self._lock:
            self._evict_expired_symbols(now)
            self._evict_expired_analyses(now)
            current = self._bars.get(key, [])
            refreshed_at = self._bars_refreshed_at.get(key, 0.0)
            if current and now - refreshed_at < self.refresh_seconds:
                self._bars.move_to_end(key)
                return list(current), None, False
            if refresh_if is not None and not refresh_if(list(current)):
                self._bars.move_to_end(key)
                return list(current), None, False
            task = self._bar_tasks.get(key)
            if task is None:
                task = asyncio.create_task(self._load_bars(key, list(current), loader))
                self._bar_tasks[key] = task
        try:
            return await task
        finally:
            async with self._lock:
                if self._bar_tasks.get(key) is task:
                    self._bar_tasks.pop(key, None)

    async def _load_bars(
        self,
        symbol: str,
        current: list[dict[str, Any]],
        loader: BarsLoader,
    ) -> tuple[list[dict[str, Any]], str | None, bool]:
        try:
            incoming = await loader(list(current))
            merged = {int(row["time"]): row for row in current if "time" in row}
            merged.update({int(row["time"]): row for row in incoming if "time" in row})
            bars = [merged[timestamp] for timestamp in sorted(merged)][-self.max_bars :]
            async with self._lock:
                self._bars[symbol] = bars
                self._bars.move_to_end(symbol)
                self._bars_refreshed_at[symbol] = time.monotonic()
                self._evict_symbols()
            return list(bars), None, bars != current
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return list(current), str(exc), False

    def _evict_symbols(self) -> None:
        while len(self._bars) > self.max_symbols:
            evicted, _ = self._bars.popitem(last=False)
            self._evict_symbol_data(evicted)

    def _evict_symbol_data(self, symbol: str) -> None:
        self._bars_refreshed_at.pop(symbol, None)
        for key in [key for key in self._analyses if key[0] == symbol]:
            self._analyses.pop(key, None)
            self._analysis_saved_at.pop(key, None)

    def _evict_expired_analyses(self, now: float) -> None:
        expired = [
            key
            for key, saved_at in self._analysis_saved_at.items()
            if now - saved_at >= self.retention_seconds
        ]
        for key in expired:
            self._analyses.pop(key, None)
            self._analysis_saved_at.pop(key, None)

    def _evict_expired_symbols(self, now: float) -> None:
        expired = [
            symbol
            for symbol, refreshed_at in self._bars_refreshed_at.items()
            if now - refreshed_at >= self.retention_seconds
        ]
        for symbol in expired:
            self._bars.pop(symbol, None)
            self._evict_symbol_data(symbol)

    async def cached_analysis(
        self,
        symbol: str,
        config_key: tuple[Any, ...],
        last_bar_time: int,
    ) -> dict[str, Any] | None:
        key = (symbol.strip().upper(), config_key)
        async with self._lock:
            self._evict_expired_analyses(time.monotonic())
            cached = self._analyses.get(key)
            if cached and cached[0] == last_bar_time:
                self._analyses.move_to_end(key)
                return dict(cached[1])
            return None

    async def remember_analysis(
        self,
        symbol: str,
        config_key: tuple[Any, ...],
        last_bar_time: int,
        result: dict[str, Any],
    ) -> None:
        key = (symbol.strip().upper(), config_key)
        async with self._lock:
            self._evict_expired_analyses(time.monotonic())
            self._analyses[key] = (last_bar_time, dict(result))
            self._analysis_saved_at[key] = time.monotonic()
            self._analyses.move_to_end(key)
            while len(self._analyses) > self.max_symbols * 8:
                evicted, _ = self._analyses.popitem(last=False)
                self._analysis_saved_at.pop(evicted, None)

    async def latest_analysis(
        self,
        symbol: str,
        config_key: tuple[Any, ...],
    ) -> tuple[int, dict[str, Any]] | None:
        key = (symbol.strip().upper(), config_key)
        async with self._lock:
            self._evict_expired_analyses(time.monotonic())
            cached = self._analyses.get(key)
            return (cached[0], dict(cached[1])) if cached else None

    async def analyze_once(
        self,
        symbol: str,
        config_key: tuple[Any, ...],
        last_bar_time: int,
        analyze: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        key = (symbol.strip().upper(), config_key, last_bar_time)
        async with self._lock:
            task = self._analysis_tasks.get(key)
            if task is None:
                task = asyncio.create_task(analyze())
                self._analysis_tasks[key] = task
        try:
            result = await task
            await self.remember_analysis(symbol, config_key, last_bar_time, result)
            return dict(result)
        finally:
            async with self._lock:
                if self._analysis_tasks.get(key) is task:
                    self._analysis_tasks.pop(key, None)
