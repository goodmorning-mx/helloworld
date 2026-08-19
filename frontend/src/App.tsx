import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { AuthGuard, AuthProvider, createAuthClient, useAuth } from '@goodmorning/gm-auth';
import { PwaRuntime } from '@goodmorning/gm-pwa';
import { CandlestickSeries, createChart, type Time, type UTCTimestamp } from 'lightweight-charts';
import './styles.css';

const configuredApiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const apiUrl = configuredApiUrl === '/api' && window.location.hostname === 'dev.helloworld.goodmorning.mx'
  ? 'https://api.dev.helloworld.goodmorning.mx'
  : configuredApiUrl;

const SESSION_TIMEZONE = 'America/Mexico_City';
const MARKET_SESSIONS = [
  { name: 'Tokyo', open: 18, close: 3, color: '#f59e0b' },
  { name: 'London', open: 2, close: 11, color: '#22c55e' },
  { name: 'New York', open: 7, close: 16, color: '#ef4444' },
  { name: 'Sydney', open: 16, close: 1, color: '#a855f7' },
];
const TIMEZONES = [
  ['Ciudad de México', 'America/Mexico_City'], ['UTC', 'UTC'], ['Nueva York', 'America/New_York'],
  ['Chicago', 'America/Chicago'], ['Los Ángeles', 'America/Los_Angeles'], ['Londres', 'Europe/London'],
  ['Madrid', 'Europe/Madrid'], ['Tokio', 'Asia/Tokyo'], ['Sídney', 'Australia/Sydney'],
] as const;

function timeNumber(time: unknown) {
  if (typeof time === 'number') return time;
  if (time && typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time) {
    const value = time as { year: number; month: number; day: number };
    return Date.UTC(value.year, value.month - 1, value.day) / 1000;
  }
  return 0;
}

function timezoneParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp * 1000));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

/**
 * Converts a wall-clock time in `timezone` to the UTC epoch used by the
 * chart. Lightweight Charts expects numeric times to always be UTC seconds;
 * passing the local hour as a timestamp shifts session lines by the zone
 * offset (for example, 07:00 becomes 13:00 in Mexico City).
 */
function timestampInTimezone(year: number, month: number, day: number, hour: number, timezone: string) {
  const wallClock = Date.UTC(year, month - 1, day, hour, 0, 0);
  const parts = timezoneParts(wallClock / 1000, timezone);
  const representedWallClock = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  const timezoneOffset = representedWallClock - wallClock;
  return Math.round((wallClock - timezoneOffset) / 1000);
}

function chartTimeLabel(time: Time, timezone: string, detailed: boolean) {
  const options: Intl.DateTimeFormatOptions = detailed
    ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: timezone }).format(new Date(timeNumber(time) * 1000));
}

function sessionDateLabel(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone: timezone, weekday: 'long', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const month = (values.month ?? '').replace('.', '').toLowerCase();
  return `${(values.weekday ?? '').toLowerCase()} ${values.hour ?? ''}:${values.minute ?? ''} ${values.day ?? ''} de ${month}`;
}

function useMobilePwa() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px), (display-mode: standalone)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px), (display-mode: standalone)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

function MobileSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="mobile-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <div className="mobile-sheet-head"><h2>{title}</h2><button onClick={onClose} aria-label="Cerrar">×</button></div>
      {children}
    </section>
  </div>;
}

type BinancePosition = {
  symbol?: string; side?: string; quantity?: string; entry_price?: string;
  mark_price?: string; unrealized_pnl?: string; liquidation_price?: string;
};
type BinanceAccount = {
  enabled?: boolean; healthy?: boolean; stream_connected?: boolean;
  last_update?: string; last_event?: string; error?: string | null;
  wallet_balance?: string | null; available_balance?: string | null;
  total_unrealized_pnl?: string | null; positions?: BinancePosition[];
  events?: Array<{ time?: string; type?: string; symbol?: string; status?: string }>;
};

function BinanceAccountPanel() {
  const [account, setAccount] = useState<BinanceAccount | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/trading/binance`, { credentials: 'include' });
        if (!response.ok) throw new Error(`Binance ${response.status}`);
        const payload = await response.json() as BinanceAccount;
        if (active) setAccount(payload);
      } catch {
        if (active) setAccount({ enabled: true, healthy: false, error: 'No fue posible consultar el monitor Binance.' });
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const online = Boolean(account?.healthy && account?.stream_connected);
  return <section className="binance-account-panel" aria-label="Estado de Binance">
    <div className="binance-panel-head"><div><span className="positions-kicker">BINANCE · CUENTA</span><h2>Estado de Binance</h2></div><span className={`stream-badge ${online ? 'stream-good' : 'stream-bad'}`}>{loading ? 'Consultando…' : online ? 'Saludable · User Stream' : 'Sin conexión'}</span></div>
    {account?.error && <p className="binance-error">{account.error}</p>}
    <div className="binance-metrics"><div><small>Saldo wallet</small><strong>{account?.wallet_balance ?? '—'}</strong></div><div><small>Disponible</small><strong>{account?.available_balance ?? '—'}</strong></div><div><small>PNL no realizado</small><strong>{account?.total_unrealized_pnl ?? '—'}</strong></div><div><small>Última actualización</small><strong>{account?.last_update ? new Date(account.last_update).toLocaleTimeString() : '—'}</strong></div></div>
    <h3>Posiciones de Binance</h3>
    <div className="positions-table-scroll"><table className="positions-table binance-table"><thead><tr><th>Símbolo</th><th>Lado</th><th>Cantidad</th><th>Entrada</th><th>Mark</th><th>UPNL</th></tr></thead><tbody>{account?.positions?.length ? account.positions.map((position, index) => <tr key={`${position.symbol}-${index}`}><td>{position.symbol ?? '—'}</td><td className={position.side === 'LONG' ? 'value-positive' : 'value-negative'}>{position.side ?? '—'}</td><td>{position.quantity ?? '—'}</td><td>{position.entry_price ?? '—'}</td><td>{position.mark_price ?? '—'}</td><td>{position.unrealized_pnl ?? '—'}</td></tr>) : <tr><td colSpan={6}>Sin posiciones abiertas</td></tr>}</tbody></table></div>
    <h3>Últimos eventos del User Stream</h3>
    <div className="binance-events">{account?.events?.length ? account.events.slice(-5).reverse().map((event, index) => <div key={`${event.time}-${index}`}><span>{event.time ? new Date(event.time).toLocaleTimeString() : '—'}</span>{event.type ?? 'evento'} · {event.symbol ?? ''} · {event.status ?? ''}</div>) : 'Sin eventos recientes'}</div>
  </section>;
}

function Access() {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);

  async function login(event: FormEvent) {
    event.preventDefault();
    await auth.login(username, password, remember);
  }

  return <main className="access-shell"><form className="login-card" onSubmit={login} aria-label="Iniciar sesión">
    <h1>helloworld</h1>
    <input type="text" autoComplete="username" placeholder="Usuario" value={username} onChange={e => setUsername(e.target.value)} required />
    <div className="password-field"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Contraseña" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} /><button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}>{showPassword ? 'Ocultar' : 'Ver'}</button></div>
    <label className="remember-me"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Recordarme</label>
    {auth.error && <p className="login-error" role="alert">{auth.error}</p>}
    <button type="submit" disabled={auth.loading}>{auth.loading ? 'Entrando…' : 'Entrar'}</button>
  </form></main>;
}

function Workspace() {
  const auth = useAuth();
  const mobilePwa = useMobilePwa();
  const chartContainer = useRef<HTMLDivElement>(null);
  const overviewChartContainer = useRef<HTMLDivElement>(null);
  const overviewChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const overviewCandlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const overviewCandleDataRef = useRef<Array<{ time: UTCTimestamp; close: number }>>([]);
  const overviewBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const overviewLoadingOlderRef = useRef(false);
  const overviewStage = useRef<HTMLDivElement>(null);
  const chartStage = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const candleBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const loadingOlderRef = useRef(false);
  const candleDataRef = useRef<Array<{ time: UTCTimestamp; close: number }>>([]);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [interval, setInterval] = useState<'1s' | '1m' | '3m' | '5m' | '15m'>('5m');
  const entryInterval = '1m' as const;
  const [timezone, setTimezone] = useState('America/Mexico_City');
  const [showSessions, setShowSessions] = useState(true);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [overviewSize, setOverviewSize] = useState({ width: 1, height: 1 });
  const [tool, setTool] = useState<'line' | 'ruler' | 'long' | 'short' | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [overviewRevision, setOverviewRevision] = useState(0);
  type ChartPoint = { time: UTCTimestamp; price: number };
  type ChartCanvas = 'entry' | 'context';
  type Drawing = { type: 'line' | 'ruler' | 'long' | 'short'; start: ChartPoint; end: ChartPoint; stop?: ChartPoint; target?: ChartPoint; chart?: ChartCanvas; paper?: boolean; closed?: boolean; closeReason?: 'TP' | 'SL' };
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingStart, setDrawingStart] = useState<ChartPoint | null>(null);
  const [drawingEnd, setDrawingEnd] = useState<ChartPoint | null>(null);
  const [resizeStart, setResizeStart] = useState<{ index: number; endpoint: 'start' | 'end' | 'stop' | 'target' } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<number | null>(null);
  const [selectedDrawings, setSelectedDrawings] = useState<number[]>([]);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [drawingCanvas, setDrawingCanvas] = useState<ChartCanvas>('entry');
  const [moveStart, setMoveStart] = useState<{ index: number; point: ChartPoint; drawing: Drawing } | null>(null);
  const [mobileSheet, setMobileSheet] = useState<'indicators' | 'tools' | null>(null);
  const [, setActivePositionIndex] = useState<number | null>(null);
  const activePositionIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const removeSelected = (event: KeyboardEvent) => {
      if ((event.key !== 'Delete' && event.key !== 'Backspace') || selectedDrawings.length === 0) return;
      event.preventDefault();
      setDrawings(current => current.filter((_, index) => !selectedDrawings.includes(index)));
      setSelectedDrawings([]);
      setSelectedDrawing(null);
      activePositionIndexRef.current = null;
      setActivePositionIndex(null);
    };
    window.addEventListener('keydown', removeSelected);
    return () => window.removeEventListener('keydown', removeSelected);
  }, [selectedDrawings]);

  useEffect(() => {
    if (!chartStage.current) return;
    const updateSize = () => {
      if (chartStage.current) {
        setStageSize({ width: chartStage.current.clientWidth, height: chartStage.current.clientHeight });
        setViewportRevision(value => value + 1);
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(chartStage.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mobilePwa || !overviewStage.current) return;
    const updateSize = () => overviewStage.current && setOverviewSize({ width: overviewStage.current.clientWidth, height: overviewStage.current.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(overviewStage.current);
    return () => observer.disconnect();
  }, [mobilePwa]);

  useEffect(() => {
    if (!chartContainer.current) return;
    activePositionIndexRef.current = null;
    setActivePositionIndex(null);
    const chart = createChart(chartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e' });
    chartRef.current = chart;
    candlesRef.current = candles;
    let active = true;
    const refreshDrawings = () => {
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (logicalRange && logicalRange.from < 80 && !loadingOlderRef.current && candleBarsRef.current.length > 0) {
        const oldest = Number(candleBarsRef.current[0].time);
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
        if (oldest > sevenDaysAgo) {
          loadingOlderRef.current = true;
          const previousRange = { from: logicalRange.from, to: logicalRange.to };
          const dayStart = Math.max(sevenDaysAgo, oldest - 86400);
          const fetchChunk = (endTime: number, limit: number) => fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${entryInterval}&limit=${limit}&endTime=${Math.max(sevenDaysAgo * 1000, endTime * 1000 - 1)}`).then(response => response.json());
          fetchChunk(oldest, 1000).then(firstRows => {
              if (!active || !Array.isArray(firstRows)) return [];
              const first = firstRows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
              const remaining = Math.max(0, Math.round((oldest - dayStart) / 60) - first.length);
              return remaining > 0 && first.length > 0 ? fetchChunk(Number(first[0].time), Math.min(1000, remaining)).then(secondRows => first.concat(Array.isArray(secondRows) ? secondRows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })) : []).sort((left, right) => Number(left.time) - Number(right.time))) : first;
            }).then(older => {
              if (!active || older.length === 0) return;
              candleBarsRef.current = [...older, ...candleBarsRef.current].filter((bar, index, all) => index === 0 || bar.time !== all[index - 1].time);
              candleBarsRef.current = candleBarsRef.current.filter(bar => Number(bar.time) >= sevenDaysAgo);
              candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
              candles.setData(candleBarsRef.current);
              chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + older.length, to: previousRange.to + older.length });
              setViewportRevision(value => value + 1);
            })
            .catch(() => undefined)
            .finally(() => { loadingOlderRef.current = false; });
        }
      }
      setViewportRevision(value => value + 1);
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshDrawings);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshDrawings);
    candleDataRef.current = [];
    candleBarsRef.current = [];
    const stream = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${entryInterval}`);
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${entryInterval}&limit=500`)
      .then(response => response.json())
      .then(rows => {
        if (!active || !Array.isArray(rows)) return;
        const parsed = rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
        candleBarsRef.current = parsed;
        candleDataRef.current = parsed.map(({ time, close }) => ({ time, close }));
        candles.setData(parsed);
        chart.timeScale().fitContent();
        setViewportRevision(value => value + 1);
      })
      .catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      const candle = JSON.parse(event.data).k;
      const next = { time: Math.floor(candle.t / 1000) as UTCTimestamp, open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), close: Number(candle.c) };
      candleBarsRef.current = [...candleBarsRef.current.filter(value => value.time !== next.time), next].sort((left, right) => Number(left.time) - Number(right.time));
      candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
      candles.update(next);
      setDrawings(current => {
        const currentPositionIndex = activePositionIndexRef.current;
        if (currentPositionIndex === null) return current;
        const activeDrawing = current[currentPositionIndex];
        if (!activeDrawing || activeDrawing.closed || !activeDrawing.paper || (activeDrawing.type !== 'long' && activeDrawing.type !== 'short')) return current;
        const direction = activeDrawing.type === 'long' ? 1 : -1;
        const targetPrice = activeDrawing.target?.price ?? activeDrawing.end.price;
        const stopPrice = activeDrawing.stop?.price ?? activeDrawing.start.price;
        const hitTarget = direction === 1 ? next.close >= targetPrice : next.close <= targetPrice;
        const hitStop = direction === 1 ? next.close <= stopPrice : next.close >= stopPrice;
        const closeReason = hitTarget ? 'TP' : hitStop ? 'SL' : undefined;
        if (closeReason) {
          activePositionIndexRef.current = null;
          setActivePositionIndex(null);
        }
        return current.map((drawing, index) => index === currentPositionIndex ? {
          ...drawing,
          end: { time: next.time, price: next.close },
          target: drawing.target ? { ...drawing.target, time: next.time } : undefined,
          stop: drawing.stop ? { ...drawing.stop, time: next.time } : undefined,
          closed: Boolean(closeReason),
          closeReason,
        } : drawing);
      });
      setViewportRevision(value => value + 1);
    };
    return () => {
      active = false;
      stream.close();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshDrawings);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshDrawings);
      chartRef.current = null;
      candlesRef.current = null;
      candleDataRef.current = [];
      candleBarsRef.current = [];
      loadingOlderRef.current = false;
      chart.remove();
    };
  }, [symbol]);

  useEffect(() => {
    if (mobilePwa || !overviewChartContainer.current) return;
    const chart = createChart(overviewChartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e' });
    overviewChartRef.current = chart;
    overviewCandlesRef.current = candles;
    const refreshOverview = () => {
      setOverviewRevision(value => value + 1);
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (!logicalRange || logicalRange.from >= 50 || overviewLoadingOlderRef.current || overviewBarsRef.current.length === 0) return;
      const oldest = Number(overviewBarsRef.current[0].time);
      const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      if (oldest <= sevenDaysAgo) return;
      overviewLoadingOlderRef.current = true;
      const previousRange = { from: logicalRange.from, to: logicalRange.to };
      const secondsPerBar = interval === '1s' ? 1 : interval === '1m' ? 60 : interval === '3m' ? 180 : interval === '5m' ? 300 : 900;
      const dayStart = Math.max(sevenDaysAgo, oldest - 86400);
      const expected = Math.ceil((oldest - dayStart) / secondsPerBar);
      const fetchChunk = (endTime: number, limit: number) => fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${Math.max(sevenDaysAgo * 1000, endTime * 1000 - 1)}`).then(response => response.json());
      const loadDay = async () => {
        const rows: any[] = [];
        let cursor = oldest;
        while (rows.length < expected && cursor > dayStart && active) {
          const batch = await fetchChunk(cursor, Math.min(1000, expected - rows.length));
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.unshift(...batch);
          cursor = Number(batch[0][0]) / 1000;
          if (batch.length < 1000) break;
        }
        return rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })).filter(bar => Number(bar.time) >= dayStart && Number(bar.time) < oldest).sort((left, right) => Number(left.time) - Number(right.time));
      };
      void loadDay().then(older => {
        if (!active || older.length === 0) return;
        overviewBarsRef.current = [...older, ...overviewBarsRef.current].filter((bar, index, all) => index === 0 || bar.time !== all[index - 1].time).filter(bar => Number(bar.time) >= sevenDaysAgo);
        overviewCandleDataRef.current = overviewBarsRef.current.map(({ time, close }) => ({ time, close }));
        candles.setData(overviewBarsRef.current);
        chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + older.length, to: previousRange.to + older.length });
        setOverviewRevision(value => value + 1);
      }).catch(() => undefined).finally(() => { overviewLoadingOlderRef.current = false; });
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshOverview);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshOverview);
    let active = true;
    const stream = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`);
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=300`)
      .then(response => response.json())
      .then(rows => {
        if (!active || !Array.isArray(rows)) return;
        const parsed = rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
        overviewBarsRef.current = parsed;
        overviewCandleDataRef.current = parsed.map(({ time, close }) => ({ time, close }));
        candles.setData(parsed);
        chart.timeScale().fitContent();
      }).catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      const candle = JSON.parse(event.data).k;
      const next = { time: Math.floor(candle.t / 1000) as UTCTimestamp, open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), close: Number(candle.c) };
      overviewBarsRef.current = [...overviewBarsRef.current.filter(value => value.time !== next.time), next].sort((left, right) => Number(left.time) - Number(right.time));
      overviewCandleDataRef.current = [...overviewCandleDataRef.current.filter(value => value.time !== next.time), { time: next.time, close: next.close }];
      candles.update(next);
    };
    return () => { active = false; stream.close(); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshOverview); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverview); overviewChartRef.current = null; overviewCandlesRef.current = null; overviewCandleDataRef.current = []; overviewBarsRef.current = []; overviewLoadingOlderRef.current = false; chart.remove(); };
  }, [symbol, interval, timezone, mobilePwa]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    setViewportRevision(value => value + 1);
  }, [timezone]);

  function pointFromEvent(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function chartContext(canvas: ChartCanvas) {
    return canvas === 'context'
      ? { chart: overviewChartRef.current, candles: overviewCandlesRef.current }
      : { chart: chartRef.current, candles: candlesRef.current };
  }

  function chartPointFromEvent(event: PointerEvent<HTMLElement>, canvas: ChartCanvas = 'entry') {
    const point = pointFromEvent(event);
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const time = chart.timeScale().coordinateToTime(point.x);
    const price = candles.coordinateToPrice(point.y);
    if (time === null || price === null) return null;
    return { time: time as UTCTimestamp, price };
  }

  function screenPoint(point: ChartPoint, canvas: ChartCanvas = 'entry') {
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const x = chart.timeScale().timeToCoordinate(point.time);
    const y = candles.priceToCoordinate(point.price);
    return x === null || y === null ? null : { x, y };
  }

  function drawingHandles(drawing: Drawing, index: number, canvas: ChartCanvas = 'entry') {
    const start = screenPoint(drawing.start, canvas);
    const end = screenPoint(drawing.end, canvas);
    if (!start || !end) return [];
    if (drawing.type === 'line') return [
      { ...start, index, endpoint: 'start' as const, role: 'default' as const },
      { ...end, index, endpoint: 'end' as const, role: 'default' as const },
    ];
    if (drawing.type === 'ruler') {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      return [
        { x: left, y: top, index, endpoint: 'start' as const, role: 'default' as const },
        { x: right, y: top, index, endpoint: 'end' as const, role: 'default' as const },
        { x: left, y: bottom, index, endpoint: 'start' as const, role: 'default' as const },
        { x: right, y: bottom, index, endpoint: 'end' as const, role: 'default' as const },
      ];
    }
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
    if (!stop) return [];
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    if (drawing.paper && drawing.target) {
      const target = screenPoint(drawing.target, canvas);
      if (!target) return [];
      return [
        { x: left, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: right, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: left, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
        { x: right, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      ];
    }
    return [
      { x: left, y: end.y, index, endpoint: 'end' as const, role: 'target' as const },
      { x: right, y: end.y, index, endpoint: 'end' as const, role: 'target' as const },
      { x: left, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      { x: right, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
    ];
  }

  function handleAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      if ((canvas === 'context' && drawings[index].chart !== 'context') || (canvas === 'entry' && drawings[index].chart === 'context')) continue;
      const candidates = drawingHandles(drawings[index], index, canvas).filter(candidate => !drawings[index].paper || candidate.endpoint === 'target' || candidate.endpoint === 'stop');
      const handle = candidates.find(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12);
      if (handle) return handle;
    }
    return null;
  }

  function renderSessionIndicator() {
    if (!showSessions || !chartRef.current) return null;
    const range = chartRef.current.timeScale().getVisibleRange();
    if (!range) return null;
    const from = timeNumber(range.from) - 2 * 86400;
    const to = timeNumber(range.to) + 2 * 86400;
    const events: Array<{ x: number; color: string; label: string; date: string }> = [];
    for (let day = new Date(from * 1000); day.getTime() / 1000 <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      const year = day.getUTCFullYear();
      const month = day.getUTCMonth() + 1;
      const date = day.getUTCDate();
      MARKET_SESSIONS.forEach(session => {
        [[session.open, 'Open'], [session.close, 'Close']].forEach(([hour, type]) => {
          if (session.name === 'New York' && type === 'Close') return;
          const eventTime = timestampInTimezone(year, month, date, Number(hour), SESSION_TIMEZONE);
          const x = chartRef.current?.timeScale().timeToCoordinate(eventTime as UTCTimestamp);
          if (x !== null && x !== undefined) events.push({ x, color: session.color, label: `${session.name} ${type}`, date: sessionDateLabel(eventTime, timezone) });
        });
      });
    }
    return <g className="session-indicator">{events.map((event, index) => <g key={`${event.label}-${event.x}-${index}`}><line x1={event.x} y1="0" x2={event.x} y2={stageSize.height} stroke={event.color} className="session-line" /><text x={event.x + 4} y="18" fill={event.color} className="session-label"><tspan x={event.x + 4} dy="0">{event.label}</tspan><tspan x={event.x + 4} dy="26">{event.date}</tspan></text></g>)}</g>;
  }

  function renderInterestMarkers() {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return null;
    const markers = candleDataRef.current.flatMap(candle => {
      const local = timezoneParts(Number(candle.time), SESSION_TIMEZONE);
      const hour = Number(local.hour);
      const minute = Number(local.minute);
      if (hour !== 7 || minute < 20 || minute >= 35) return [];
      const x = chart.timeScale().timeToCoordinate(candle.time);
      const y = candles.priceToCoordinate(candle.close);
      return x === null || x === undefined || y === null || y === undefined ? [] : [{ x, y }];
    });
    return <g className="ny-interest-markers">{markers.map((marker, index) => <circle key={`${marker.x}-${index}`} cx={marker.x} cy={marker.y} r="6" className="ny-interest-marker" />)}</g>;
  }

  function renderOverviewSessions() {
    void overviewRevision;
    if (!showSessions || !overviewChartRef.current) return null;
    const range = overviewChartRef.current.timeScale().getVisibleRange();
    if (!range) return null;
    const from = timeNumber(range.from) - 2 * 86400;
    const to = timeNumber(range.to) + 2 * 86400;
    const events: Array<{ x: number; color: string; label: string; date: string }> = [];
    for (let day = new Date(from * 1000); day.getTime() / 1000 <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      MARKET_SESSIONS.forEach(session => [[session.open, 'Open'], [session.close, 'Close']].forEach(([hour, type]) => {
        if (session.name === 'New York' && type === 'Close') return;
        const eventTime = timestampInTimezone(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(hour), SESSION_TIMEZONE);
        const x = overviewChartRef.current?.timeScale().timeToCoordinate(eventTime as UTCTimestamp);
        if (x !== null && x !== undefined) events.push({ x, color: session.color, label: `${session.name} ${type}`, date: sessionDateLabel(eventTime, timezone) });
      }));
    }
    return <g className="session-indicator">{events.map((event, index) => <g key={`${event.label}-${event.x}-${index}`}><line x1={event.x} y1="0" x2={event.x} y2={overviewSize.height} stroke={event.color} className="session-line" /><text x={event.x + 4} y="18" fill={event.color} className="session-label"><tspan x={event.x + 4} dy="0">{event.label}</tspan><tspan x={event.x + 4} dy="26">{event.date}</tspan></text></g>)}</g>;
  }

  function renderOverviewInterestMarkers() {
    if (!overviewChartRef.current || !overviewCandlesRef.current) return null;
    const markers = overviewCandleDataRef.current.flatMap(candle => {
      const local = timezoneParts(Number(candle.time), SESSION_TIMEZONE);
      if (Number(local.hour) !== 7 || Number(local.minute) < 20 || Number(local.minute) >= 35) return [];
      const x = overviewChartRef.current?.timeScale().timeToCoordinate(candle.time);
      const y = overviewCandlesRef.current?.priceToCoordinate(candle.close);
      return x === null || x === undefined || y === null || y === undefined ? [] : [{ x, y }];
    });
    return <g className="ny-interest-markers">{markers.map((marker, index) => <circle key={`${marker.x}-${index}`} cx={marker.x} cy={marker.y} r="6" className="ny-interest-marker" />)}</g>;
  }

  function drawingAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      if (drawing.paper) continue;
      if ((canvas === 'context' && drawing.chart !== 'context') || (canvas === 'entry' && drawing.chart === 'context')) continue;
      const start = screenPoint(drawing.start, canvas);
      const end = screenPoint(drawing.end, canvas);
      if (!start || !end) continue;
      if (drawing.type === 'ruler') {
        const left = Math.min(start.x, end.x) - 8;
        const right = Math.max(start.x, end.x) + 8;
        const top = Math.min(start.y, end.y) - 8;
        const bottom = Math.max(start.y, end.y) + 8;
        if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return index;
      } else if (drawing.type === 'line') {
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const distance = Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / length;
        if (distance <= 10) return index;
      } else {
        const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
        const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
        if (stop && point.x >= Math.min(start.x, end.x) - 8 && point.x <= Math.max(start.x, end.x) + 8 && point.y >= Math.min(start.y, end.y, stop.y) - 8 && point.y <= Math.max(start.y, end.y, stop.y) + 8) return index;
      }
    }
    return null;
  }

  function startDrawing(event: PointerEvent<HTMLElement>, canvas: ChartCanvas = 'entry') {
    if ((event.target as HTMLElement).closest('button')) return;
    setDrawingCanvas(canvas);
    const point = pointFromEvent(event);
    const handle = handleAt(point, canvas);
    if (handle) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizeStart({ index: handle.index, endpoint: handle.endpoint });
      if (!drawings[handle.index].paper) setSelectedDrawing(handle.index);
      return;
    }
    if (!tool) {
      const hit = drawingAt(point, canvas);
      setSelectedDrawing(hit);
      setSelectedDrawings(hit === null ? [] : [hit]);
      if (hit !== null) {
        const chartPoint = chartPointFromEvent(event, canvas);
        if (chartPoint) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          setMoveStart({ index: hit, point: chartPoint, drawing: drawings[hit] });
        }
      } else {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setLassoStart(point);
        setLassoEnd(point);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const chartPoint = chartPointFromEvent(event, canvas);
    if (chartPoint) {
      setDrawingStart(chartPoint);
      setDrawingEnd(chartPoint);
    }
  }

  function updateDrawing(event: PointerEvent<HTMLElement>) {
    if (lassoStart) {
      setLassoEnd(pointFromEvent(event));
      return;
    }
    if (moveStart) {
      const point = chartPointFromEvent(event, drawingCanvas);
      if (!point) return;
      const timeDelta = Number(point.time) - Number(moveStart.point.time);
      const priceDelta = point.price - moveStart.point.price;
      const shift = (value: ChartPoint): ChartPoint => ({ time: (Number(value.time) + timeDelta) as UTCTimestamp, price: value.price + priceDelta });
      setDrawings(current => current.map((drawing, index) => index === moveStart.index ? { ...drawing, start: shift(moveStart.drawing.start), end: shift(moveStart.drawing.end), stop: moveStart.drawing.stop ? shift(moveStart.drawing.stop) : undefined } : drawing));
      return;
    }
    if (!tool || !drawingStart || resizeStart) return;
    const point = chartPointFromEvent(event, drawingCanvas);
    if (point) setDrawingEnd(point);
  }

  function finishDrawing(event: PointerEvent<HTMLElement>) {
    if (lassoStart) {
      const end = pointFromEvent(event);
      const left = Math.min(lassoStart.x, end.x);
      const right = Math.max(lassoStart.x, end.x);
      const top = Math.min(lassoStart.y, end.y);
      const bottom = Math.max(lassoStart.y, end.y);
      const matches = drawings.map((drawing, index) => ({ drawing, index })).filter(({ drawing }) => {
        if (drawing.paper || (drawingCanvas === 'context' && drawing.chart !== 'context') || (drawingCanvas === 'entry' && drawing.chart === 'context')) return false;
        const points = [drawing.start, drawing.end, ...(drawing.stop ? [drawing.stop] : []), ...(drawing.target ? [drawing.target] : [])].map(point => screenPoint(point, drawingCanvas));
        return points.some(point => point !== null && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom);
      }).map(({ index }) => index);
      setSelectedDrawings(matches);
      setSelectedDrawing(matches[0] ?? null);
      setLassoStart(null);
      setLassoEnd(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (moveStart) {
      updateDrawing(event);
      setMoveStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (resizeStart) {
      const end = chartPointFromEvent(event, drawingCanvas);
      const resize = resizeStart;
      if (end) setDrawings(current => current.map((drawing, index) => {
        if (index !== resize.index) return drawing;
        if (resize.endpoint === 'target' && drawing.paper && drawing.target && drawing.stop) {
          const price = drawing.type === 'long' ? Math.max(end.price, drawing.stop.price) : Math.min(end.price, drawing.stop.price);
          return { ...drawing, target: { ...drawing.target, price, time: end.time } };
        }
        if (resize.endpoint === 'end' && drawing.type !== 'line' && drawing.type !== 'ruler') {
          const price = drawing.type === 'long' ? Math.max(end.price, drawing.start.price) : Math.min(end.price, drawing.start.price);
          const target = { ...end, price };
          return { ...drawing, end: target, stop: drawing.stop ? { ...drawing.stop, time: target.time } : undefined };
        }
        if (resize.endpoint === 'stop' && drawing.stop) {
          const boundary = drawing.paper && drawing.target ? drawing.target.price : drawing.start.price;
          const price = drawing.type === 'long' ? Math.min(end.price, boundary) : Math.max(end.price, boundary);
          return { ...drawing, stop: { ...end, price } };
        }
        return { ...drawing, [resize.endpoint]: end };
      }));
      setResizeStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!tool || !drawingStart) return;
    event.preventDefault();
    event.stopPropagation();
    const end = chartPointFromEvent(event, drawingCanvas);
    if (!end) return;
    const positionEnd = tool === 'long'
      ? { ...end, price: Math.max(end.price, drawingStart.price) }
      : tool === 'short'
        ? { ...end, price: Math.min(end.price, drawingStart.price) }
        : end;
    const stopPrice = drawingStart.price - (positionEnd.price - drawingStart.price) / 4;
    const stop = tool === 'long' || tool === 'short' ? { time: positionEnd.time, price: stopPrice } : undefined;
    setDrawings(current => [...current, { type: tool, chart: drawingCanvas, start: drawingStart, end: positionEnd, stop }]);
    setDrawingStart(null);
    setDrawingEnd(null);
    setTool(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function openSimulatedPosition(type: 'long' | 'short') {
    const latest = candleDataRef.current[candleDataRef.current.length - 1];
    if (!latest) return;
    const entry = latest.close;
    const direction = type === 'long' ? 1 : -1;
    const stopDistance = 0.00087;
    const targetDistance = stopDistance * 4;
    const target = entry * (1 + direction * targetDistance);
    const stop = entry * (1 - direction * stopDistance);
    const intervalSeconds = 60;
    const position: Drawing = {
      type,
      paper: true,
      start: { time: latest.time, price: entry },
      end: { time: (Number(latest.time) + intervalSeconds * 5) as UTCTimestamp, price: target },
      stop: { time: (Number(latest.time) + intervalSeconds * 5) as UTCTimestamp, price: stop },
      target: { time: (Number(latest.time) + intervalSeconds * 5) as UTCTimestamp, price: target },
    };
    setDrawings(current => {
      const next = [...current, position];
      activePositionIndexRef.current = next.length - 1;
      setActivePositionIndex(next.length - 1);
      setSelectedDrawing(null);
      return next;
    });
  }

  function chooseTool(key: 'line' | 'ruler' | 'long' | 'short') {
    setTool(tool === key ? null : key);
  }

  const paperPositions = drawings.filter(drawing => drawing.paper && (drawing.type === 'long' || drawing.type === 'short'));
  const positionsTable = <section className="positions-panel" aria-label="Posiciones abiertas">
    <div className="positions-panel-head"><div><span className="positions-kicker">TRADING</span><h2>Posiciones abiertas</h2></div><span className="paper-badge">PAPER</span></div>
    {paperPositions.length === 0 ? <p className="positions-empty">No hay operaciones abiertas.</p> : <div className="positions-table-scroll"><table className="positions-table"><thead><tr><th>Instrumento</th><th>Lado</th><th>Entrada</th><th>Actual</th><th>Margen</th><th>R:R</th><th>PNL</th><th>ROE</th><th>Estado</th></tr></thead><tbody>{paperPositions.map((position, index) => {
      const direction = position.type === 'long' ? 1 : -1;
      const margin = 100;
      const leverage = 10;
      const priceChange = ((position.end.price - position.start.price) / position.start.price) * direction;
      const pnl = priceChange * margin * leverage;
      const roe = (pnl / margin) * 100;
      const targetPrice = position.target?.price ?? position.end.price;
      const riskDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
      const rewardDistance = Math.abs(targetPrice - position.start.price);
      const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
      return <tr key={`${position.start.time}-${index}`}><td>{symbol}</td><td><span className={`position-side ${position.type}`}>{position.type.toUpperCase()}</span></td><td>{position.start.price.toFixed(8)}</td><td>{position.end.price.toFixed(8)}</td><td>{margin.toFixed(2)} USDT</td><td>{rr.toFixed(2)}:1</td><td className={pnl >= 0 ? 'value-positive' : 'value-negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(8)} USDT</td><td className={roe >= 0 ? 'value-positive' : 'value-negative'}>{roe >= 0 ? '+' : ''}{roe.toFixed(8)}%</td><td><span className={`position-status ${position.closed ? 'position-closed' : 'position-live'}`}><i />{position.closed ? `Cerrada · ${position.closeReason}` : 'Abierta'}</span></td></tr>;
    })}</tbody></table></div>}
  </section>;

  const renderDrawing = (drawing: Drawing, index: number | string, canvas: ChartCanvas = 'entry') => {
    void viewportRevision;
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const startX = chart.timeScale().timeToCoordinate(drawing.start.time);
    const endX = chart.timeScale().timeToCoordinate(drawing.end.time);
    const startY = candles.priceToCoordinate(drawing.start.price);
    const endY = candles.priceToCoordinate(drawing.end.price);
    if (startX === null || endX === null || startY === null || endY === null) return null;
    const start = { x: startX, y: startY };
    const end = { x: endX, y: endY };
    const handles = drawingHandles(drawing, typeof index === 'number' ? index : -1, canvas);
    const handleNodes = handles.filter(handle => !drawing.paper || handle.endpoint === 'target' || handle.endpoint === 'stop').map((handle, handleIndex) => <circle key={handleIndex} cx={handle.x} cy={handle.y} r="7" className={`drawing-handle ${handle.role === 'stop' ? 'handle-stop' : handle.role === 'target' ? 'handle-target' : drawing.type === 'ruler' ? 'handle-ruler' : ''}`} />);
    const pricePercent = ((drawing.end.price - drawing.start.price) / drawing.start.price) * 100;
    const selectedClass = typeof index === 'number' && (selectedDrawing === index || selectedDrawings.includes(index)) ? 'drawing-selected' : undefined;
    if (drawing.type === 'line') return <g key={index} className={selectedClass}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="drawing-line" /><text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 8} className="drawing-label">{pricePercent >= 0 ? '+' : ''}{pricePercent.toFixed(2)}%</text>{handleNodes}</g>;
    if (drawing.type === 'ruler') {
      const minutes = Math.round(Math.abs(Number(drawing.end.time) - Number(drawing.start.time)) / 60);
      const priceDelta = Math.abs(drawing.end.price - drawing.start.price);
      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      return <g key={index} className={selectedClass}><rect x={left} y={top} width={Math.max(1, Math.abs(end.x - start.x))} height={Math.max(1, Math.abs(end.y - start.y))} className="measurement-box" /><text x={left + 8} y={top + 18} className="measurement-label">{minutes} min · {priceDelta.toFixed(2)} · {pricePercent >= 0 ? '+' : ''}{pricePercent.toFixed(2)}%</text>{handleNodes}</g>;
    }
    const left = Math.min(start.x, end.x);
    const width = Math.max(1, Math.abs(end.x - start.x));
    const profitTop = drawing.type === 'long' ? Math.min(start.y, end.y) : start.y;
    const riskTop = drawing.type === 'long' ? start.y : Math.min(start.y, end.y);
    const profitHeight = Math.abs(start.y - end.y);
    const riskHeight = Math.abs(start.y - end.y);
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
    if (!stop) return null;
    const targetPercent = pricePercent * (drawing.type === 'long' ? 1 : -1);
    const riskPercent = ((stopPrice - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1);
    const currentPnlPercent = targetPercent;
    const maxTargetPercent = drawing.target ? ((drawing.target.price - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1) : targetPercent;
    const riskDistance = Math.abs(drawing.start.price - stopPrice);
    const rewardDistance = Math.abs((drawing.target?.price ?? drawing.end.price) - drawing.start.price);
    const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    const targetLabel = drawing.paper
      ? `${drawing.closed && drawing.closeReason === 'TP' ? 'Max TP alcanzado' : 'Max TP'} ${maxTargetPercent >= 0 ? '+' : ''}${maxTargetPercent.toFixed(8)}%`
      : `${targetPercent >= 0 ? '+' : ''}${targetPercent.toFixed(8)}%`;
    const riskLabel = `${riskPercent >= 0 ? '+' : ''}${riskPercent.toFixed(8)}%`;
    const targetTop = Math.min(start.y, end.y);
    const targetHeight = Math.abs(start.y - end.y);
    const stopTop = Math.min(start.y, stop.y);
    const stopHeight = Math.abs(start.y - stop.y);
    const paperClass = drawing.paper ? `paper-position ${drawing.type === 'long' ? 'paper-long' : 'paper-short'}` : '';
    const paperLabel = drawing.paper ? <text x={left + 8} y={Math.max(18, Math.min(targetTop, stopTop) - 10)} className="paper-operation-label">Paper Operation · {drawing.type.toUpperCase()}</text> : null;
    const targetPoint = drawing.paper ? screenPoint(drawing.target ?? drawing.end, canvas) : null;
    const pnlLabel = drawing.paper ? <text x={left + width + 8} y={end.y + 4} className="paper-pnl-label">PNL {currentPnlPercent >= 0 ? '+' : ''}{currentPnlPercent.toFixed(8)}%</text> : null;
    return <g key={index} className={`${selectedClass ?? ''} ${paperClass}`}><rect x={left} y={targetTop} width={width} height={targetHeight} className={targetPercent >= 0 ? 'position-profit' : 'position-risk'} /><rect x={left} y={stopTop} width={width} height={stopHeight} className={riskPercent <= 0 ? 'position-risk' : 'position-profit'} /><line x1={left} y1={start.y} x2={left + width} y2={start.y} className="position-entry" />{targetPoint && <line x1={left} y1={targetPoint.y} x2={left + width} y2={targetPoint.y} className="paper-target-line" />}<line x1={left} y1={stop.y} x2={left + width} y2={stop.y} className="paper-stop-line" /><line x1={left} y1={end.y} x2={left + width} y2={end.y} className="paper-current-price" /><text x={left + 8} y={targetTop + 18} className="position-label">{drawing.paper ? targetLabel : `TP ${targetLabel}`}</text><text x={left + 8} y={stopTop + 18} className="position-label">SL {riskLabel}</text><text x={left + 8} y={Math.max(targetTop, stopTop) + 34} className="position-label">R:R {rr.toFixed(2)}:1</text>{paperLabel}{pnlLabel}{drawing.paper ? handleNodes : null}{drawing.paper ? null : handleNodes}</g>;
  };

  const chartStageView = <div ref={chartStage} className={`chart-stage ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={startDrawing} onPointerMoveCapture={updateDrawing} onPointerUpCapture={finishDrawing} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); setResizeStart(null); }}>
    <div ref={chartContainer} className="candlestick-chart" /><svg className="drawing-overlay" viewBox={`0 0 ${stageSize.width} ${stageSize.height}`} preserveAspectRatio="none" aria-hidden="true">{renderSessionIndicator()}{renderInterestMarkers()}{drawings.map((drawing, index) => drawing.chart !== 'context' ? renderDrawing(drawing, index, 'entry') : null)}{tool && drawingStart && drawingEnd && drawingCanvas === 'entry' && renderDrawing({ type: tool, chart: 'entry', start: drawingStart, end: drawingEnd }, 'preview', 'entry')}{lassoStart && lassoEnd && drawingCanvas === 'entry' && <rect x={Math.min(lassoStart.x, lassoEnd.x)} y={Math.min(lassoStart.y, lassoEnd.y)} width={Math.abs(lassoEnd.x - lassoStart.x)} height={Math.abs(lassoEnd.y - lassoStart.y)} className="selection-lasso" />}</svg><div className="chart-bottom-controls"><span className="timezone-icon" aria-hidden="true">◷</span><select className="timezone-select" value={timezone} onChange={event => setTimezone(event.target.value)} aria-label="Zona horaria">{TIMEZONES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="floating-order-buttons" aria-label="Abrir operación simulada"><button className="open-long-button" onClick={() => openSimulatedPosition('long')}>▲ <span>Abrir Long</span></button><button className="open-short-button" onClick={() => openSimulatedPosition('short')}>▼ <span>Abrir Short</span></button></div>
  </div>;

  const desktopHeader = <div className="symbol-bar"><select className="symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">
    {['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(option => <option key={option}>{option}</option>)}
  </select><select className="interval-select" value={interval} onChange={event => setInterval(event.target.value as typeof interval)} aria-label="Intervalo de contexto">{(['1s', '1m', '3m', '5m', '15m'] as const).map(value => <option key={value} value={value}>{value}</option>)}</select><span className="chart-source">BINANCE · {entryInterval.toUpperCase()} ENTRADA · {interval.toUpperCase()} CONTEXTO</span><button className={`session-toggle ${showSessions ? 'session-active' : ''}`} onClick={() => setShowSessions(value => !value)} aria-label="Mostrar sesiones" title="Mostrar sesiones">Sesiones</button><div className="chart-tools" aria-label="Herramientas del gráfico">
    <button className={!tool ? 'tool-active' : ''} onClick={() => setTool(null)} aria-label="Seleccionar y navegar" title="Seleccionar y navegar">↖</button>
    {([['line', '╱', 'Línea'], ['ruler', '▥', 'Regla'], ['long', 'L', 'Long'], ['short', 'S', 'Short']] as const).map(([key, icon, label]) => <button key={key} className={tool === key ? 'tool-active' : ''} onClick={() => chooseTool(key)} aria-label={label} title={label}>{icon}</button>)}
    <button onClick={() => setDrawings([])} aria-label="Borrar dibujos" title="Borrar dibujos">×</button>
  </div><button className="logout-button" onClick={() => void auth.logout()} aria-label="Cerrar sesión">Salir</button></div>;

  const toolOptions = [['line', '╱', 'Línea'], ['ruler', '▥', 'Medir'], ['long', 'L', 'Long'], ['short', 'S', 'Short']] as const;
  const chartsRow = <div className="charts-row"><section ref={overviewStage} className={`secondary-chart ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={event => startDrawing(event, 'context')} onPointerMoveCapture={updateDrawing} onPointerUpCapture={finishDrawing} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); setResizeStart(null); setLassoStart(null); setLassoEnd(null); }}><div className="chart-panel-label">5M · CONTEXTO · BTCUSDT</div><div ref={overviewChartContainer} className="overview-chart" /><svg className="overview-overlay" viewBox={`0 0 ${overviewSize.width} ${overviewSize.height}`} preserveAspectRatio="none" aria-hidden="true">{renderOverviewSessions()}{renderOverviewInterestMarkers()}{drawings.map((drawing, index) => drawing.chart === 'context' ? renderDrawing(drawing, index, 'context') : null)}{tool && drawingStart && drawingEnd && drawingCanvas === 'context' && renderDrawing({ type: tool, chart: 'context', start: drawingStart, end: drawingEnd }, 'preview', 'context')}{lassoStart && lassoEnd && drawingCanvas === 'context' && <rect x={Math.min(lassoStart.x, lassoEnd.x)} y={Math.min(lassoStart.y, lassoEnd.y)} width={Math.abs(lassoEnd.x - lassoStart.x)} height={Math.abs(lassoEnd.y - lassoStart.y)} className="selection-lasso" />}</svg></section><section className="primary-chart"><div className="chart-panel-label">1M · AJUSTE DE ENTRADA</div>{chartStageView}</section></div>;

  return mobilePwa ? <main className="trading-shell pwa-shell">
    <header className="pwa-mobile-header"><div><span className="pwa-brand">helloworld</span><span className="pwa-market">BINANCE · {entryInterval.toUpperCase()} ENTRADA · {interval.toUpperCase()} CONTEXTO</span></div><select className="pwa-symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">{['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(option => <option key={option}>{option}</option>)}</select></header>
    <section className="pwa-chart-wrap">{chartStageView}</section><BinanceAccountPanel />{positionsTable}
    <nav className="pwa-bottom-nav" aria-label="Controles PWA"><button onClick={() => setTool(null)} className={!tool ? 'pwa-nav-active' : ''}>↖<span>Seleccionar</span></button><button onClick={() => setMobileSheet('indicators')} className={showSessions ? 'pwa-nav-active' : ''}>◉<span>Indicadores</span></button><button onClick={() => setMobileSheet('tools')} className={tool ? 'pwa-nav-active' : ''}>⌁<span>Herramientas</span></button><button onClick={() => void auth.logout()}>⇥<span>Salir</span></button></nav>
    {mobileSheet === 'indicators' && <MobileSheet title="Indicadores" onClose={() => setMobileSheet(null)}><button className={`mobile-option ${showSessions ? 'option-active' : ''}`} onClick={() => setShowSessions(value => !value)}><span><b>Sesiones de mercado</b><small>Tokyo, Londres, Nueva York y Sydney</small></span><i>{showSessions ? '✓' : ''}</i></button><label className="mobile-field">Intervalo<select value={interval} onChange={event => setInterval(event.target.value as typeof interval)}>{(['1s', '1m', '3m', '5m', '15m'] as const).map(value => <option key={value}>{value}</option>)}</select></label><label className="mobile-field">Zona horaria<select value={timezone} onChange={event => setTimezone(event.target.value)}>{TIMEZONES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></label></MobileSheet>}
    {mobileSheet === 'tools' && <MobileSheet title="Herramientas" onClose={() => setMobileSheet(null)}><div className="mobile-tool-grid"><button className={!tool ? 'option-active' : ''} onClick={() => { setTool(null); setMobileSheet(null); }}>↖<span>Seleccionar</span></button>{toolOptions.map(([key, icon, label]) => <button key={key} className={tool === key ? 'option-active' : ''} onClick={() => { chooseTool(key); setMobileSheet(null); }}>{icon}<span>{label}</span></button>)}<button onClick={() => { setDrawings([]); activePositionIndexRef.current = null; setActivePositionIndex(null); }}>×<span>Borrar todo</span></button></div></MobileSheet>}
  </main> : <main className="trading-shell">{desktopHeader}{chartsRow}<BinanceAccountPanel />{positionsTable}</main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.10', serviceWorkerUrl: '/sw.js?v=0.1.10', updateIntervalMs: 5 * 60 * 1000 }}><AuthProvider client={client}><AuthGuard fallback={<Access />}><Workspace /></AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
