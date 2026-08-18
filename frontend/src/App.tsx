import { useMemo, useState, type FormEvent } from 'react';
import { AgentChat, type AgentClient } from '@goodmorning/gm-agent';
import { AuthGuard, AuthProvider, createAuthClient, useAuth } from '@goodmorning/gm-auth';
import { PwaRuntime, PwaStatus } from '@goodmorning/gm-pwa';
import './styles.css';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

function Access() {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  async function login(event: FormEvent) {
    event.preventDefault();
    await auth.login(username, password, remember);
  }

  return <main className="access-shell"><form className="login-card" onSubmit={login} aria-label="Iniciar sesión">
    <h1>helloworld</h1>
    <input type="text" autoComplete="username" placeholder="Usuario" value={username} onChange={e => setUsername(e.target.value)} required />
    <input type="password" autoComplete="current-password" placeholder="Contraseña" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
    <label className="remember-me"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Recordarme</label>
    {auth.error && <p className="login-error" role="alert">{auth.error}</p>}
    <button type="submit" disabled={auth.loading}>{auth.loading ? 'Entrando…' : 'Entrar'}</button>
  </form></main>;
}

function Workspace() {
  const auth = useAuth();
  const [tab, setTab] = useState('terminal');
  const agentClient = useMemo<AgentClient>(() => async (prompt, conversationId, confirmation) => {
    const response = await fetch(`${apiUrl}/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` }, body: JSON.stringify({ prompt, conversation_id: conversationId, confirm: Boolean(confirmation) }) });
    if (!response.ok) throw new Error('El agente no está disponible.');
    return response.json();
  }, [auth.accessToken]);
  return <main className="terminal-shell">
    <header className="topbar"><div><span className="live-dot" /> HELLOWORLD <small>AI TERMINAL</small></div><div className="top-actions"><PwaStatus /><button className="avatar" onClick={() => void auth.logout()}>{(auth.identity?.name ?? 'U').slice(0, 1).toUpperCase()}</button></div></header>
    <section className="welcome"><div><p className="eyebrow">BUENOS DÍAS, {auth.identity?.name?.split(' ')[0].toUpperCase()}</p><h1>¿Qué quieres analizar?</h1></div><span className="market-state">● MERCADO PAPER</span></section>
    <section className="market-strip">{['BTCUSDT', 'ETHUSDT', 'XAUUSD'].map((symbol, index) => <button key={symbol} className={`quote ${index === 0 ? 'quote-active' : ''}`}><span>{symbol}</span><strong>{index === 0 ? '67,421.20' : index === 1 ? '3,482.90' : '2,386.40'}</strong><em className={index === 1 ? 'down' : ''}>{index === 1 ? '−1.24%' : '+2.18%'}</em></button>)}</section>
    <section className="main-grid"><div className="chart-card"><div className="card-head"><div><span className="muted">BTCUSDT · BINANCE</span><h2>67,421.20 <em>+2.18%</em></h2></div><select defaultValue="1H"><option>15M</option><option>1H</option><option>4H</option><option>1D</option></select></div><div className="chart"><div className="chart-grid" /><svg viewBox="0 0 700 260" preserveAspectRatio="none" aria-label="BTCUSDT price chart"><polyline points="0,220 35,198 70,210 110,166 145,184 180,142 220,158 255,110 295,128 330,92 365,118 400,76 440,101 480,62 520,84 555,42 590,64 625,32 660,50 700,18" fill="none" stroke="#f5b84b" strokeWidth="3" vectorEffect="non-scaling-stroke" /></svg><div className="price-line" /></div><div className="chart-foot"><span>RSI 14 <b>61.8</b></span><span>EMA 20 <b>67,102</b></span><span>ATR <b>842.4</b></span></div></div><div className="agent-card"><div className="card-head"><div><span className="muted">ASISTENTE</span><h2>Habla con tu estrategia</h2></div><span className="ai-badge">✦ AI</span></div><AgentChat client={agentClient} title="" /></div></section>
    <nav className="bottom-nav">{[['terminal', '⌁', 'Terminal'], ['watchlist', '☆', 'Lista'], ['orders', '⌁', 'Órdenes'], ['account', '◉', 'Cuenta']].map(([key, icon, label]) => <button key={key} className={tab === key ? 'nav-active' : ''} onClick={() => setTab(key)}><span>{icon}</span>{label}</button>)}</nav>
  </main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.0', updateIntervalMs: 60 * 60 * 1000 }}><AuthProvider client={client}><AuthGuard fallback={<Access />}><Workspace /></AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
