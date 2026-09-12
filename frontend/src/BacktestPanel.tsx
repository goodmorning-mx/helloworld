import { useState } from 'react';

type BacktestResult = {
  symbol: string;
  interval: string;
  days: number;
  bars: number;
  event_count: number;
  scheduled_event_count: number;
  statistics: { operations: number; wins: number; losses: number; win_rate: number; net_pnl: number; profit_factor: number; max_drawdown: number };
  events: Array<{ event_id: string; action: string; timestamp: number; price: number; position_id?: string }>;
  trades: Array<{ id: string; side: string; entry_price: number; exit_price?: number; close_reason?: string; net_pnl: number }>;
};

const defaultStorycard = JSON.stringify({
  timezone: 'America/Mexico_City',
  events: [{ id: 'monday-open-long', weekday: 'monday', time: '07:00', action: 'open_long', sl_percent: 0.2, tp_percent: 1, risk_usdt: 1, leverage: 1 }],
}, null, 2);

export default function BacktestPanel({ activeSymbol, apiUrl, accessToken }: { activeSymbol: string; apiUrl: string; accessToken?: string | null }) {
  const [storycard, setStorycard] = useState(defaultStorycard);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [agentMessage, setAgentMessage] = useState('');
  const [message, setMessage] = useState('Backtest histórico limitado a 7 días.');
  const [loading, setLoading] = useState(false);

  const headers = { Authorization: `Bearer ${accessToken ?? ''}`, 'Content-Type': 'application/json' };
  async function run() {
    setLoading(true);
    setMessage('Descargando velas y ejecutando eventos…');
    try {
      const card = JSON.parse(storycard) as Record<string, unknown>;
      const response = await fetch(`${apiUrl}/trading/backtest`, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ symbol: activeSymbol, interval: '5m', days: 7, strategy: 'storycard', storycard: card }) });
      if (!response.ok) throw new Error(`Backtest ${response.status}`);
      setResult(await response.json() as BacktestResult);
      setMessage('Backtest completado con datos históricos de Binance Futures.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo ejecutar el backtest.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function askAgent() {
    setLoading(true);
    setAgentMessage('La IA está leyendo la storycard y el contexto de mercado…');
    try {
      const response = await fetch(`${apiUrl}/agent/chat`, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ prompt: `Ejecuta un backtest Paper de 7 días para ${activeSymbol} usando esta storycard exactamente: ${storycard}` }) });
      if (!response.ok) throw new Error(`GM Agent ${response.status}`);
      const payload = await response.json() as { content?: string };
      setAgentMessage(payload.content ?? 'La IA no devolvió un resumen.');
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : 'No se pudo consultar GM Agent.');
    } finally {
      setLoading(false);
    }
  }

  const stats = result?.statistics;
  return <section className="backtest-panel" aria-label="Backtest Paper de 7 días"><div className="backtest-head"><div><span className="positions-kicker">GM-AGENT · STORYCARD BACKTEST</span><h2>Backtest Paper · 7 días</h2><p>{message} · {activeSymbol}</p></div><div className="backtest-actions"><button type="button" onClick={() => void run()} disabled={loading}>{loading ? 'Procesando…' : 'Ejecutar backtest'}</button><button type="button" className="backtest-agent-button" onClick={() => void askAgent()} disabled={loading}>Analizar con IA</button></div></div><div className="backtest-editor"><label>Storycard de eventos<textarea value={storycard} onChange={event => setStorycard(event.target.value)} spellCheck={false} /></label><div className="backtest-help"><strong>Eventos disponibles</strong><small>open_long · open_short · close_all · observe</small><small>weekday/time o timestamp · SL/TP · risk_usdt · notional · leverage</small>{agentMessage && <p>{agentMessage}</p>}</div></div>{result && <><div className="backtest-summary"><div><small>Eventos</small><strong>{result.event_count}/{result.scheduled_event_count}</strong></div><div><small>Operaciones</small><strong>{stats?.operations ?? 0}</strong></div><div><small>Win rate</small><strong>{stats ? `${stats.win_rate.toFixed(1)}%` : '—'}</strong></div><div><small>PNL neto</small><strong className={(stats?.net_pnl ?? 0) >= 0 ? 'value-positive' : 'value-negative'}>{stats ? `${stats.net_pnl >= 0 ? '+' : ''}${stats.net_pnl.toFixed(2)} USDT` : '—'}</strong></div><div><small>Profit factor</small><strong>{stats ? (Number.isFinite(stats.profit_factor) ? stats.profit_factor.toFixed(2) : '∞') : '—'}</strong></div><div><small>Drawdown</small><strong className="value-negative">{stats ? `${stats.max_drawdown.toFixed(2)} USDT` : '—'}</strong></div></div><div className="backtest-event-list"><strong>Timeline de eventos</strong>{result.events.map(event => <div key={`${event.event_id}-${event.timestamp}`}><span>{new Date(event.timestamp * 1000).toLocaleString('es-MX')}</span><b>{event.action}</b><small>{event.price.toFixed(6)} · {event.position_id ?? 'sin posición'}</small></div>)}</div></>}</section>;
}
