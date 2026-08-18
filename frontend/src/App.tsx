import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { AuthGuard, AuthProvider, createAuthClient, useAuth } from '@goodmorning/gm-auth';
import { PwaRuntime } from '@goodmorning/gm-pwa';
import { CandlestickSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import './styles.css';

const configuredApiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const apiUrl = configuredApiUrl === '/api' && window.location.hostname === 'dev.helloworld.goodmorning.mx'
  ? 'https://api.dev.helloworld.goodmorning.mx'
  : configuredApiUrl;

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
  const chartContainer = useRef<HTMLDivElement>(null);
  const chartStage = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [tool, setTool] = useState<'line' | 'ruler' | 'long' | 'short' | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  type ChartPoint = { time: UTCTimestamp; price: number };
  type Drawing = { type: 'line' | 'ruler' | 'long' | 'short'; start: ChartPoint; end: ChartPoint; stop?: ChartPoint };
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingStart, setDrawingStart] = useState<ChartPoint | null>(null);
  const [drawingEnd, setDrawingEnd] = useState<ChartPoint | null>(null);
  const [resizeStart, setResizeStart] = useState<{ index: number; endpoint: 'start' | 'end' | 'stop' } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<number | null>(null);
  const [moveStart, setMoveStart] = useState<{ index: number; point: ChartPoint; drawing: Drawing } | null>(null);

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
    if (!chartContainer.current) return;
    const chart = createChart(chartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e' });
    chartRef.current = chart;
    candlesRef.current = candles;
    const refreshDrawings = () => setViewportRevision(value => value + 1);
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshDrawings);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshDrawings);
    let active = true;
    const stream = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_1m`);
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=500`)
      .then(response => response.json())
      .then(rows => {
        if (!active || !Array.isArray(rows)) return;
        candles.setData(rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })));
        chart.timeScale().fitContent();
      })
      .catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      const candle = JSON.parse(event.data).k;
      candles.update({ time: Math.floor(candle.t / 1000) as UTCTimestamp, open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), close: Number(candle.c) });
    };
    return () => {
      active = false;
      stream.close();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshDrawings);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshDrawings);
      chartRef.current = null;
      candlesRef.current = null;
      chart.remove();
    };
  }, [symbol]);

  function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function chartPointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return null;
    const time = chart.timeScale().coordinateToTime(point.x);
    const price = candles.coordinateToPrice(point.y);
    if (time === null || price === null) return null;
    return { time: time as UTCTimestamp, price };
  }

  function screenPoint(point: ChartPoint) {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return null;
    const x = chart.timeScale().timeToCoordinate(point.time);
    const y = candles.priceToCoordinate(point.price);
    return x === null || y === null ? null : { x, y };
  }

  function drawingHandles(drawing: Drawing, index: number) {
    const start = screenPoint(drawing.start);
    const end = screenPoint(drawing.end);
    if (!start || !end) return [];
    if (drawing.type !== 'long' && drawing.type !== 'short') return [
      { ...start, index, endpoint: 'start' as const },
      { ...end, index, endpoint: 'end' as const },
    ];
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice });
    if (!stop) return [];
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    return [
      { x: left, y: end.y, index, endpoint: 'end' as const },
      { x: right, y: end.y, index, endpoint: 'end' as const },
      { x: left, y: stop.y, index, endpoint: 'stop' as const },
      { x: right, y: stop.y, index, endpoint: 'stop' as const },
    ];
  }

  function handleAt(point: { x: number; y: number }) {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const handle = drawingHandles(drawings[index], index).find(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12);
      if (handle) return handle;
    }
    return null;
  }

  function drawingAt(point: { x: number; y: number }) {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      const start = screenPoint(drawing.start);
      const end = screenPoint(drawing.end);
      if (!start || !end) continue;
      if (drawing.type === 'line' || drawing.type === 'ruler') {
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const distance = Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / length;
        if (distance <= 10) return index;
      } else {
        const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
        const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice });
        if (stop && point.x >= Math.min(start.x, end.x) - 8 && point.x <= Math.max(start.x, end.x) + 8 && point.y >= Math.min(start.y, end.y, stop.y) - 8 && point.y <= Math.max(start.y, end.y, stop.y) + 8) return index;
      }
    }
    return null;
  }

  function startDrawing(event: PointerEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    const handle = handleAt(point);
    if (handle) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizeStart({ index: handle.index, endpoint: handle.endpoint });
      setSelectedDrawing(handle.index);
      return;
    }
    if (!tool) {
      const hit = drawingAt(point);
      setSelectedDrawing(hit);
      if (hit !== null) {
        const chartPoint = chartPointFromEvent(event);
        if (chartPoint) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          setMoveStart({ index: hit, point: chartPoint, drawing: drawings[hit] });
        }
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const chartPoint = chartPointFromEvent(event);
    if (chartPoint) {
      setDrawingStart(chartPoint);
      setDrawingEnd(chartPoint);
    }
  }

  function updateDrawing(event: PointerEvent<HTMLDivElement>) {
    if (moveStart) {
      const point = chartPointFromEvent(event);
      if (!point) return;
      const timeDelta = Number(point.time) - Number(moveStart.point.time);
      const priceDelta = point.price - moveStart.point.price;
      const shift = (value: ChartPoint): ChartPoint => ({ time: (Number(value.time) + timeDelta) as UTCTimestamp, price: value.price + priceDelta });
      setDrawings(current => current.map((drawing, index) => index === moveStart.index ? { start: shift(moveStart.drawing.start), end: shift(moveStart.drawing.end), stop: moveStart.drawing.stop ? shift(moveStart.drawing.stop) : undefined, type: drawing.type } : drawing));
      return;
    }
    if (!tool || !drawingStart || resizeStart) return;
    const point = chartPointFromEvent(event);
    if (point) setDrawingEnd(point);
  }

  function finishDrawing(event: PointerEvent<HTMLDivElement>) {
    if (moveStart) {
      updateDrawing(event);
      setMoveStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (resizeStart) {
      const end = chartPointFromEvent(event);
      const resize = resizeStart;
      if (end) setDrawings(current => current.map((drawing, index) => {
        if (index !== resize.index) return drawing;
        if (resize.endpoint === 'end' && drawing.stop) return { ...drawing, end, stop: { ...drawing.stop, time: end.time } };
        return { ...drawing, [resize.endpoint]: end };
      }));
      setResizeStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!tool || !drawingStart) return;
    event.preventDefault();
    event.stopPropagation();
    const end = chartPointFromEvent(event);
    if (!end) return;
    const stopPrice = drawingStart.price - (end.price - drawingStart.price) / 4;
    const stop = tool === 'long' || tool === 'short' ? { time: end.time, price: stopPrice } : undefined;
    setDrawings(current => [...current, { type: tool, start: drawingStart, end, stop }]);
    setDrawingStart(null);
    setDrawingEnd(null);
    setTool(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const renderDrawing = (drawing: Drawing, index: number | string) => {
    void viewportRevision;
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return null;
    const startX = chart.timeScale().timeToCoordinate(drawing.start.time);
    const endX = chart.timeScale().timeToCoordinate(drawing.end.time);
    const startY = candles.priceToCoordinate(drawing.start.price);
    const endY = candles.priceToCoordinate(drawing.end.price);
    if (startX === null || endX === null || startY === null || endY === null) return null;
    const start = { x: startX, y: startY };
    const end = { x: endX, y: endY };
    const handles = drawingHandles(drawing, typeof index === 'number' ? index : -1);
    const handleClass = drawing.type === 'long' ? 'drawing-handle handle-long' : drawing.type === 'short' ? 'drawing-handle handle-short' : drawing.type === 'ruler' ? 'drawing-handle handle-ruler' : 'drawing-handle';
    const handleNodes = handles.map((handle, handleIndex) => <circle key={handleIndex} cx={handle.x} cy={handle.y} r="7" className={handleClass} />);
    const pricePercent = ((drawing.end.price - drawing.start.price) / drawing.start.price) * 100;
    const selectedClass = typeof index === 'number' && selectedDrawing === index ? 'drawing-selected' : undefined;
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
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice });
    if (!stop) return null;
    const targetPercent = pricePercent * (drawing.type === 'long' ? 1 : -1);
    const riskPercent = ((stopPrice - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1);
    const targetLabel = `${targetPercent >= 0 ? '+' : ''}${targetPercent.toFixed(2)}%`;
    const riskLabel = `${riskPercent >= 0 ? '+' : ''}${riskPercent.toFixed(2)}%`;
    const targetTop = Math.min(start.y, end.y);
    const targetHeight = Math.abs(start.y - end.y);
    const stopTop = Math.min(start.y, stop.y);
    const stopHeight = Math.abs(start.y - stop.y);
    return <g key={index} className={selectedClass}><rect x={left} y={targetTop} width={width} height={targetHeight} className={targetPercent >= 0 ? 'position-profit' : 'position-risk'} /><rect x={left} y={stopTop} width={width} height={stopHeight} className={riskPercent <= 0 ? 'position-risk' : 'position-profit'} /><line x1={left} y1={start.y} x2={left + width} y2={start.y} className="position-entry" /><text x={left + 8} y={targetTop + 18} className="position-label">TP {targetLabel}</text><text x={left + 8} y={stopTop + 18} className="position-label">SL {riskLabel}</text>{handleNodes}</g>;
  };

  return <main className="trading-shell"><div className="symbol-bar"><select className="symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">
    {['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(option => <option key={option}>{option}</option>)}
  </select><span className="chart-source">BINANCE · 1M</span><div className="chart-tools" aria-label="Herramientas del gráfico">
    <button className={!tool ? 'tool-active' : ''} onClick={() => setTool(null)} aria-label="Seleccionar y navegar" title="Seleccionar y navegar">↖</button>
    {([['line', '╱', 'Línea'], ['ruler', '↔', 'Regla'], ['long', 'L', 'Long'], ['short', 'S', 'Short']] as const).map(([key, icon, label]) => <button key={key} className={tool === key ? 'tool-active' : ''} onClick={() => setTool(tool === key ? null : key)} aria-label={label} title={label}>{icon}</button>)}
    <button onClick={() => setDrawings([])} aria-label="Borrar dibujos" title="Borrar dibujos">×</button>
  </div><button className="logout-button" onClick={() => void auth.logout()} aria-label="Cerrar sesión">Salir</button></div><div ref={chartStage} className={`chart-stage ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={startDrawing} onPointerMoveCapture={updateDrawing} onPointerUpCapture={finishDrawing} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); setResizeStart(null); }}>
    <div ref={chartContainer} className="candlestick-chart" /><svg className="drawing-overlay" viewBox={`0 0 ${stageSize.width} ${stageSize.height}`} preserveAspectRatio="none" aria-hidden="true">{drawings.map(renderDrawing)}{tool && drawingStart && drawingEnd && renderDrawing({ type: tool, start: drawingStart, end: drawingEnd }, 'preview')}</svg>
  </div></main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.3', serviceWorkerUrl: '/sw.js?v=0.1.3', updateIntervalMs: 5 * 60 * 1000 }}><AuthProvider client={client}><AuthGuard fallback={<Access />}><Workspace /></AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
