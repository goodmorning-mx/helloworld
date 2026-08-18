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
  const chartContainer = useRef<HTMLDivElement>(null);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [tool, setTool] = useState<'line' | 'ruler' | 'long' | 'short' | null>(null);
  const [drawings, setDrawings] = useState<Array<{ type: 'line' | 'ruler' | 'long' | 'short'; start: { x: number; y: number }; end: { x: number; y: number } }>>([]);
  const [drawingStart, setDrawingStart] = useState<{ x: number; y: number } | null>(null);

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
    return () => { active = false; stream.close(); chart.remove(); };
  }, [symbol]);

  function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function startDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!tool) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    setDrawingStart(point);
  }

  function finishDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!tool || !drawingStart) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawings(current => [...current, { type: tool, start: drawingStart, end: pointFromEvent(event) }]);
    setDrawingStart(null);
  }

  const renderDrawing = (drawing: { type: 'line' | 'ruler' | 'long' | 'short'; start: { x: number; y: number }; end: { x: number; y: number } }, index: number) => {
    const { start, end } = drawing;
    if (drawing.type === 'line') return <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="drawing-line" />;
    if (drawing.type === 'ruler') return <g key={index}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="drawing-ruler" /><text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 8} className="drawing-label">{Math.round(Math.hypot(end.x - start.x, end.y - start.y))} px</text></g>;
    const profitTop = drawing.type === 'long' ? Math.min(start.y, end.y) : start.y;
    const riskTop = drawing.type === 'long' ? start.y : Math.min(start.y, end.y);
    const profitHeight = Math.abs(start.y - end.y);
    const riskHeight = Math.abs(start.y - end.y);
    return <g key={index}><rect x={start.x} y={profitTop} width={Math.max(80, Math.abs(end.x - start.x))} height={profitHeight} className={drawing.type === 'long' ? 'position-profit' : 'position-risk'} /><rect x={start.x} y={riskTop} width={Math.max(80, Math.abs(end.x - start.x))} height={riskHeight} className={drawing.type === 'long' ? 'position-risk' : 'position-profit'} /><line x1={start.x} y1={start.y} x2={end.x} y2={start.y} className="position-entry" /></g>;
  };

  return <main className="trading-shell"><div className="symbol-bar"><select className="symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">
    {['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(option => <option key={option}>{option}</option>)}
  </select><span className="chart-source">BINANCE · 1M</span><div className="chart-tools" aria-label="Herramientas del gráfico">
    {([['line', '╱', 'Línea'], ['ruler', '↔', 'Regla'], ['long', 'L', 'Long'], ['short', 'S', 'Short']] as const).map(([key, icon, label]) => <button key={key} className={tool === key ? 'tool-active' : ''} onClick={() => setTool(tool === key ? null : key)} aria-label={label} title={label}>{icon}</button>)}
    <button onClick={() => setDrawings([])} aria-label="Borrar dibujos" title="Borrar dibujos">×</button>
  </div></div><div className={`chart-stage ${tool ? 'drawing-mode' : ''}`} onPointerDown={startDrawing} onPointerUp={finishDrawing} onPointerCancel={() => setDrawingStart(null)}>
    <div ref={chartContainer} className="candlestick-chart" /><svg className="drawing-overlay" aria-hidden="true">{drawings.map(renderDrawing)}</svg>
  </div></main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.0', updateIntervalMs: 60 * 60 * 1000 }}><AuthProvider client={client}><AuthGuard fallback={<Access />}><Workspace /></AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
