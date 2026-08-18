import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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

  return <main className="trading-shell"><div className="symbol-bar"><select className="symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">
    {['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(option => <option key={option}>{option}</option>)}
  </select><span className="chart-source">BINANCE · 1M</span></div><div ref={chartContainer} className="candlestick-chart" /></main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.0', updateIntervalMs: 60 * 60 * 1000 }}><AuthProvider client={client}><AuthGuard fallback={<Access />}><Workspace /></AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
