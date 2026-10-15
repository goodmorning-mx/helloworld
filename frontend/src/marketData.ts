export type MarketBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const DATABASE_NAME = 'helloworld-market-data';
const STORE_NAME = 'ohlc';
const LIVE_CACHE_DAYS = 2;
const HISTORY_CACHE_DAYS = 31;
const HISTORY_CACHE_PREFIX = 'history:';
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const memoryCache = new Map<string, MarketBar[]>();
const persistTimers = new Map<string, number>();
const recentRequests = new Map<string, Promise<MarketBar[]>>();
const preloadQueue: Array<() => void> = [];
let activePreloads = 0;
const MAX_ACTIVE_PRELOADS = 4;
let cacheCleanup: Promise<void> | null = null;
let cacheCleanupLastRunAt = 0;
let cacheCleanupTimer: number | null = null;

export type MarketCacheScope = 'live' | 'history';

function cacheKey(symbol: string, interval: string, scope: MarketCacheScope = 'live') {
  const key = `${symbol.toUpperCase()}:${interval}`;
  return scope === 'history' ? `${HISTORY_CACHE_PREFIX}${key}` : key;
}

function cacheCutoff(scope: MarketCacheScope = 'live') {
  const days = scope === 'history' ? HISTORY_CACHE_DAYS : LIVE_CACHE_DAYS;
  return Math.floor(Date.now() / 1000) - days * 86400;
}

function pruneMemoryCache() {
  for (const [key, bars] of memoryCache) {
    const history = key.startsWith(HISTORY_CACHE_PREFIX);
    const cutoff = cacheCutoff(history ? 'history' : 'live');
    const retained = bars.filter(bar => bar.time >= cutoff);
    if (retained.length !== bars.length) memoryCache.set(key, retained);
  }
}

function pruneStoredCache(database: IDBDatabase): Promise<void> {
  if (cacheCleanup) return cacheCleanup;
  if (Date.now() - cacheCleanupLastRunAt < CACHE_CLEANUP_INTERVAL_MS) return Promise.resolve();
  const cleanup = new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const request = transaction.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const key = String(cursor.key);
      const scope = key.startsWith(HISTORY_CACHE_PREFIX) ? 'history' : 'live';
      const cached = Array.isArray(cursor.value) ? cursor.value as MarketBar[] : [];
      const cutoff = cacheCutoff(scope);
      const retained = cached.filter(bar => Number.isFinite(bar.time) && bar.time >= cutoff);
      if (retained.length !== cached.length) {
        if (retained.length) cursor.update(retained);
        else cursor.delete();
      }
      cursor.continue();
    };
    transaction.oncomplete = () => {
      cacheCleanupLastRunAt = Date.now();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('No se pudo limpiar el cache OHLC'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Se canceló la limpieza del cache OHLC'));
  });
  cacheCleanup = cleanup.then(() => {
    cacheCleanup = null;
  }, error => {
    cacheCleanup = null;
    throw error;
  });
  return cacheCleanup;
}

function scheduleCacheCleanup() {
  if (cacheCleanupTimer !== null) return;
  cacheCleanupTimer = window.setInterval(() => {
    void openDatabase().then(async database => {
      try {
        await pruneStoredCache(database);
      } catch {
        // Retry on the next interval; stale rows are filtered on read meanwhile.
      } finally {
        database.close();
      }
    }).catch(() => undefined);
  }, CACHE_CLEANUP_INTERVAL_MS);
}

function hasFreshRecentBar(bars: MarketBar[], interval: string) {
  const latest = bars[bars.length - 1]?.time;
  const match = /^(\d+)([smhd])$/.exec(interval);
  const size = Number(match?.[1] ?? 1);
  const unit = match?.[2] ?? 'm';
  const secondsPerUnit = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  const seconds = size * secondsPerUnit;
  const lastExpectedCandle = Math.floor(Date.now() / 1000 / seconds) * seconds - seconds;
  return Number.isFinite(latest) && latest >= lastExpectedCandle - seconds;
}

/** Share an in-flight history request so entry/context charts and scanner
 * preloading never request the same symbol/interval twice. */
export function requestRecentBars(symbol: string, interval: string, loader: () => Promise<MarketBar[]>): Promise<MarketBar[]> {
  const key = cacheKey(symbol, interval);
  const existing = recentRequests.get(key);
  if (existing) return existing;
  const request = loader().finally(() => recentRequests.delete(key));
  recentRequests.set(key, request);
  return request;
}

function drainPreloadQueue() {
  while (activePreloads < MAX_ACTIVE_PRELOADS && preloadQueue.length > 0) {
    const start = preloadQueue.shift();
    if (!start) return;
    activePreloads += 1;
    start();
  }
}

/** Schedule low-priority history warming without competing with a selected
 * symbol's immediate request. */
export function preloadRecentBars(symbol: string, interval: string, loader: () => Promise<MarketBar[]>): Promise<MarketBar[]> {
  return new Promise((resolve, reject) => {
    preloadQueue.push(() => {
      void readCachedBars(symbol, interval)
        .then(cached => hasFreshRecentBar(cached, interval) ? cached : requestRecentBars(symbol, interval, loader))
        .then(bars => { void cacheBars(symbol, interval, bars); return bars; })
        .then(resolve, reject)
        .finally(() => { activePreloads -= 1; drainPreloadQueue(); });
    });
    drainPreloadQueue();
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB no está disponible'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      scheduleCacheCleanup();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir el cache OHLC'));
  });
}

export async function readCachedBars(symbol: string, interval: string, scope: MarketCacheScope = 'live'): Promise<MarketBar[]> {
  const key = cacheKey(symbol, interval, scope);
  const cutoff = cacheCutoff(scope);
  pruneMemoryCache();
  const inMemory = memoryCache.get(key);
  if (inMemory) return inMemory.filter(bar => bar.time >= cutoff);
  try {
    const database = await openDatabase();
    await pruneStoredCache(database);
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => {
        const bars = Array.isArray(request.result) ? request.result : [];
        const retained = bars.filter((bar: MarketBar) => Number.isFinite(bar.time) && bar.time >= cutoff);
        memoryCache.set(key, retained);
        resolve(retained);
      };
      request.onerror = () => reject(request.error ?? new Error('No se pudo leer el cache OHLC'));
    });
  } catch {
    return [];
  }
}

export async function cacheBars(symbol: string, interval: string, incoming: MarketBar[], scope: MarketCacheScope = 'live') {
  if (incoming.length === 0) return;
  const existing = await readCachedBars(symbol, interval, scope);
  const merged = [...new Map([...existing, ...incoming]
    .filter(bar => Number.isFinite(bar.time))
    .map(bar => [bar.time, bar] as const)).values()]
    .sort((left, right) => left.time - right.time);
  const cutoff = cacheCutoff(scope);
  const key = cacheKey(symbol, interval, scope);
  const retained = merged.filter(bar => bar.time >= cutoff);
  memoryCache.set(key, retained);
  if (persistTimers.has(key)) window.clearTimeout(persistTimers.get(key));
  persistTimers.set(key, window.setTimeout(() => {
    void (async () => {
      try {
        const database = await openDatabase();
        await new Promise<void>((resolve, reject) => {
          const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(memoryCache.get(key) ?? [], key);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error('No se pudo escribir el cache OHLC'));
        });
      } catch {
        // Charts must continue to work when browser storage is unavailable.
      }
    })();
    persistTimers.delete(key);
  }, 500));
}

function parseBinanceRows(rows: unknown[]): MarketBar[] {
  return rows.map(row => {
    const values = row as unknown[];
    return { time: Math.floor(Number(values[0]) / 1000), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]) };
  }).filter(bar => Number.isFinite(bar.time) && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close));
}

type LoadMarketDataOptions = {
  broker?: 'binance' | 'ctrader';
  apiUrl?: string;
  accessToken?: string | null;
};

type CTraderCandleRow = {
  timestamp: number;
  low: number;
  delta_open: number;
  delta_high: number;
  delta_close: number;
};

function parseCTraderRows(rows: unknown[]): MarketBar[] {
  return rows.map(row => {
    const value = row as CTraderCandleRow;
    const low = Number(value.low);
    return {
      time: Math.floor(Number(value.timestamp) * 60),
      open: low + Number(value.delta_open),
      high: low + Number(value.delta_high),
      low,
      close: low + Number(value.delta_close),
    };
  }).filter(bar => Number.isFinite(bar.time) && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close));
}

export async function loadThirtyDays(symbol: string, interval = '1m', options: LoadMarketDataOptions = {}): Promise<MarketBar[]> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 30 * 86400;
  const validateCoverage = (rows: MarketBar[]) => {
    if (options.broker !== 'ctrader' || rows.length < 2) return rows;
    const coverage = rows[rows.length - 1].time - rows[0].time;
    if (coverage < 26 * 86400) {
      const first = new Date(rows[0].time * 1000).toLocaleDateString('es-MX');
      const last = new Date(rows[rows.length - 1].time * 1000).toLocaleDateString('es-MX');
      throw new Error(`cTrader solo devolvió ${first} → ${last}; no se completaron 30 días. El Lab no calculará resultados parciales.`);
    }
    return rows;
  };
  const cached = await readCachedBars(symbol, interval, 'history');
  if (cached.length > 0 && cached[0].time <= start + 600 && cached[cached.length - 1].time >= now - 600) return validateCoverage(cached.filter(bar => bar.time >= start && bar.time <= now));

  if (options.broker === 'ctrader') {
    if (!options.apiUrl) throw new Error('La API de cTrader no está configurada.');
    const headers = options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : undefined;
    const response = await fetch(`${options.apiUrl}/trading/ctrader/candles/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&days=30`, { headers, credentials: 'include' });
    let payload: { data?: unknown[]; detail?: string } = {};
    try { payload = await response.json() as typeof payload; } catch { /* use the HTTP status below */ }
    if (!response.ok) throw new Error(payload.detail ?? `cTrader respondió ${response.status} al cargar 30 días.`);
    const rows = parseCTraderRows(payload.data ?? []).filter(bar => bar.time >= start && bar.time <= now);
    if (rows.length === 0) throw new Error(`cTrader no devolvió velas de ${symbol} para los últimos 30 días.`);
    await cacheBars(symbol, interval, rows, 'history');
    return validateCoverage((await readCachedBars(symbol, interval, 'history')).filter(bar => bar.time >= start && bar.time <= now));
  }

  let cursor = now * 1000;
  const rows: MarketBar[] = [];
  while (cursor > start * 1000) {
    const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=1000&endTime=${cursor - 1}`);
    if (!response.ok) throw new Error(`Binance respondió ${response.status}`);
    const batch = parseBinanceRows(await response.json() as unknown[]).filter(bar => bar.time >= start && bar.time < now);
    if (batch.length === 0) break;
    rows.unshift(...batch);
    cursor = batch[0].time * 1000;
    if (batch.length < 1000) break;
  }
  await cacheBars(symbol, interval, rows, 'history');
  return (await readCachedBars(symbol, interval, 'history')).filter(bar => bar.time >= start && bar.time <= now);
}

export function aggregateBars(bars: MarketBar[], minutes: number): MarketBar[] {
  const bucket = minutes * 60;
  const result: MarketBar[] = [];
  for (const bar of [...bars].sort((left, right) => left.time - right.time)) {
    const time = Math.floor(bar.time / bucket) * bucket;
    const current = result[result.length - 1];
    if (!current || current.time !== time) result.push({ time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
    }
  }
  return result;
}
