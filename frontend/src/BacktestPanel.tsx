import { useEffect, useRef, useState } from 'react';
import { calculateSslChannel, calculateWickExtensions, type OhlcBar } from './indicators';
import { tradingCosts, type TradingBroker } from './tradingCosts';

export type WickBacktestTrade = {
  id: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  balanceBefore: number;
  balanceAfter: number;
  riskAmount: number;
  margin: number;
  notional: number;
  fees: number;
  grossPnl: number;
  pnl: number;
  mfePercent: number;
  maePercent: number;
  reason: 'TP' | 'SL' | 'END';
};

type WickBacktestReport = {
  bars: number;
  signals: number;
  operations: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  averageMfe: number;
  averageMae: number;
  initialBalance: number;
  finalBalance: number;
  totalFees: number;
};

function runWickBacktest(bars: OhlcBar[], period: number, multiplier: number, stopPercent: number, targetPercent: number, initialBalance: number, riskPercent: number, leverage: number, broker: TradingBroker, sslPeriod: number, regimeWindow: number, displayBars: number) {
  const visibleBars = Math.max(1, Math.round(displayBars));
  const warmup = Math.max(period, sslPeriod, 2);
  // SHOW N controls the tested range; warmup is only used to initialize SSL/wicks.
  const source = bars.slice(-(visibleBars + warmup));
  const extensions = calculateWickExtensions(source, period, multiplier);
  const ssl = calculateSslChannel(source, sslPeriod);
  const trades: WickBacktestTrade[] = [];
  let signals = 0;
  let balance = Math.max(0, initialBalance);
  const startingBalance = balance;
  let cursor = warmup;
  while (cursor < source.length) {
    const bar = source[cursor];
    const regimeActive = ssl.regimeAge[cursor] >= 2 && ssl.regimeAge[cursor] <= regimeWindow;
    const longSignal = regimeActive && extensions.long[cursor] != null && bar.low <= Number(extensions.long[cursor]) && ssl.bullish[cursor];
    const shortSignal = regimeActive && extensions.short[cursor] != null && bar.high >= Number(extensions.short[cursor]) && !ssl.bullish[cursor];
    if (!longSignal && !shortSignal) { cursor += 1; continue; }
    signals += 1;
    const side: 'long' | 'short' = longSignal ? 'long' : 'short';
    const entryPrice = Number(side === 'long' ? extensions.long[cursor] : extensions.short[cursor]);
    const riskAmount = balance * Math.max(0, riskPercent) / 100;
    const stopDistance = Math.max(stopPercent / 100, 0.000001);
    const riskNotional = riskAmount / stopDistance;
    const notional = Math.min(riskNotional, balance * Math.max(1, leverage));
    if (!(notional > 0) || !(entryPrice > 0)) { cursor += 1; continue; }
    const margin = leverage > 0 ? notional / leverage : notional;
    const balanceBefore = balance;
    const direction = side === 'long' ? 1 : -1;
    const stopPrice = entryPrice * (1 - direction * stopPercent / 100);
    const targetPrice = entryPrice * (1 + direction * targetPercent / 100);
    let exitIndex = source.length - 1;
    let exitPrice = source[exitIndex].close;
    let reason: WickBacktestTrade['reason'] = 'END';
    let mfe = 0;
    let mae = 0;
    for (let index = cursor; index < source.length; index += 1) {
      const next = source[index];
      const favorable = side === 'long' ? (next.high - entryPrice) / entryPrice * 100 : (entryPrice - next.low) / entryPrice * 100;
      const adverse = side === 'long' ? (entryPrice - next.low) / entryPrice * 100 : (next.high - entryPrice) / entryPrice * 100;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);
      const hitStop = side === 'long' ? next.low <= stopPrice : next.high >= stopPrice;
      const hitTarget = side === 'long' ? next.high >= targetPrice : next.low <= targetPrice;
      if (hitStop || hitTarget) {
        // Conservative same-candle rule: if both are touched, count the stop.
        reason = hitStop ? 'SL' : 'TP';
        exitIndex = index;
        exitPrice = hitStop ? stopPrice : targetPrice;
        break;
      }
    }
    const grossPnl = ((exitPrice - entryPrice) / entryPrice) * direction * notional;
    const fees = tradingCosts(broker, notional).total;
    const pnl = grossPnl - fees;
    balance = Math.max(0, balance + pnl);
    trades.push({ id: `wick-backtest-${source[cursor].time}-${side}`, side, entryTime: Number(source[cursor].time), exitTime: Number(source[exitIndex].time), entryPrice, exitPrice, stopPrice, targetPrice, balanceBefore, balanceAfter: balance, riskAmount, margin, notional, fees, grossPnl, pnl, mfePercent: mfe, maePercent: mae, reason });
    cursor = Math.max(cursor + 1, exitIndex + 1);
  }
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) { equity += trade.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const grossWins = trades.filter(trade => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLosses = Math.abs(trades.filter(trade => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const wins = trades.filter(trade => trade.pnl > 0).length;
  return { trades, report: { bars: Math.max(0, source.length - warmup), signals, operations: trades.length, wins, losses: trades.length - wins, winRate: trades.length ? wins / trades.length * 100 : 0, netPnl: equity, profitFactor: grossLosses ? grossWins / grossLosses : grossWins ? Infinity : 0, maxDrawdown, averageMfe: trades.length ? trades.reduce((sum, trade) => sum + trade.mfePercent, 0) / trades.length : 0, averageMae: trades.length ? trades.reduce((sum, trade) => sum + trade.maePercent, 0) / trades.length : 0, initialBalance: startingBalance, finalBalance: balance, totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0) } satisfies WickBacktestReport };
}

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

export default function BacktestPanel({ activeSymbol, apiUrl, accessToken, getBars, wickPeriod, wickMultiplier, stopPercent, targetPercent, initialBalance = 100, riskPercent = 1, leverage = 1, broker = 'binance', sslPeriod, regimeWindow, displayBars = 300, barRevision = 0, onWickTrades }: { activeSymbol: string; apiUrl: string; accessToken?: string | null; getBars?: () => OhlcBar[]; wickPeriod?: number; wickMultiplier?: number; stopPercent?: number; targetPercent?: number; initialBalance?: number; riskPercent?: number; leverage?: number; broker?: TradingBroker; sslPeriod?: number; regimeWindow?: number; displayBars?: number; barRevision?: number; onWickTrades?: (trades: WickBacktestTrade[]) => void }) {
  const [storycard, setStorycard] = useState(defaultStorycard);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [agentMessage, setAgentMessage] = useState('');
  const [message, setMessage] = useState('Backtest histórico limitado a 7 días.');
  const [loading, setLoading] = useState(false);
  const [wickReport, setWickReport] = useState<WickBacktestReport | null>(null);
  const [wickTrades, setWickTrades] = useState<WickBacktestTrade[]>([]);
  const lastAutoRevision = useRef<number | null>(null);

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

  function runWickStrategyBacktest() {
    const bars = getBars?.() ?? [];
    if (bars.length < Math.max(20, wickPeriod ?? 10)) { setAgentMessage('Aún no hay suficientes velas cargadas para el backtest.'); return; }
    const result = runWickBacktest(bars, wickPeriod ?? 10, wickMultiplier ?? 1.5, stopPercent ?? .2, targetPercent ?? 4.1, initialBalance, riskPercent, leverage, broker, sslPeriod ?? 9, regimeWindow ?? 5, displayBars);
    setWickReport(result.report);
    setWickTrades(result.trades);
    onWickTrades?.(result.trades);
    setMessage(`Backtest automático · últimas ${result.report.bars} velas.`);
  }

  useEffect(() => {
    const revision = Number(barRevision);
    const firstRun = lastAutoRevision.current === null;
    const enoughNewBars = lastAutoRevision.current !== null && revision - lastAutoRevision.current >= 10;
    if (!firstRun && !enoughNewBars) return;
    lastAutoRevision.current = revision;
    runWickStrategyBacktest();
  }, [barRevision, displayBars, wickPeriod, wickMultiplier, stopPercent, targetPercent, initialBalance, riskPercent, leverage, broker, sslPeriod, regimeWindow]);

  const formatTradeTime = (time?: number) => time == null ? '—' : new Date(time * 1000).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  const firstTrade = wickTrades[0];
  const lastTrade = wickTrades[wickTrades.length - 1];
  const stats = result?.statistics;
  return <section className="backtest-panel" aria-label="Backtest de extensiones de mechazo"><div className="backtest-head"><div><span className="positions-kicker">BACKTEST · MECHAZOS</span><h2>Backtest · SHOW {displayBars}</h2><p>{message} · {activeSymbol} · actualiza cada 10 velas</p></div><div className="backtest-actions"><button type="button" onClick={runWickStrategyBacktest}>Actualizar</button><button type="button" onClick={() => void run()} disabled={loading}>{loading ? 'Procesando…' : 'Ejecutar storycard'}</button><button type="button" className="backtest-agent-button" onClick={() => void askAgent()} disabled={loading}>Analizar con IA</button></div></div><div className="backtest-editor"><label>Storycard de eventos<textarea value={storycard} onChange={event => setStorycard(event.target.value)} spellCheck={false} /></label><div className="backtest-help"><strong>Estrategia de mechazos</strong><small>Long cuando cruza la extensión inferior con SSL positivo · Short cuando cruza la extensión superior con SSL negativo.</small><small>Balance {initialBalance.toFixed(2)} USDT · Riesgo {riskPercent.toFixed(2)}% · Leverage {leverage.toFixed(1)}x · SSL {sslPeriod ?? 9} · Mechazo {wickPeriod ?? 10} · SL {stopPercent ?? .2}% · TP {targetPercent ?? 4.1}%</small>{agentMessage && <p>{agentMessage}</p>}</div></div>{wickReport && <><div className="backtest-summary"><div><small>Primera operación</small><strong>{formatTradeTime(firstTrade?.entryTime)}</strong></div><div><small>Última operación</small><strong>{formatTradeTime(lastTrade?.exitTime ?? lastTrade?.entryTime)}</strong></div><div><small>Balance inicial</small><strong>{wickReport.initialBalance.toFixed(2)} USDT</strong></div><div><small>Balance final</small><strong className={wickReport.finalBalance >= wickReport.initialBalance ? 'value-positive' : 'value-negative'}>{wickReport.finalBalance.toFixed(2)} USDT</strong></div><div><small>Velas</small><strong>{wickReport.bars}</strong></div><div><small>Señales</small><strong>{wickReport.signals}</strong></div><div><small>Operaciones</small><strong>{wickReport.operations}</strong></div><div><small>Win rate</small><strong>{wickReport.winRate.toFixed(1)}%</strong></div><div><small>PNL neto</small><strong className={wickReport.netPnl >= 0 ? 'value-positive' : 'value-negative'}>{wickReport.netPnl >= 0 ? '+' : ''}{wickReport.netPnl.toFixed(4)} USDT</strong></div><div><small>Costos totales</small><strong>{wickReport.totalFees.toFixed(4)} USDT</strong></div><div><small>Profit factor</small><strong>{Number.isFinite(wickReport.profitFactor) ? wickReport.profitFactor.toFixed(2) : '∞'}</strong></div><div><small>Drawdown</small><strong className="value-negative">-{wickReport.maxDrawdown.toFixed(4)} USDT</strong></div><div><small>MFE / MAE prom.</small><strong>+{wickReport.averageMfe.toFixed(2)}% / -{wickReport.averageMae.toFixed(2)}%</strong></div></div><div className="backtest-balance-table-wrap"><strong>Desarrollo del balance</strong><table className="backtest-balance-table"><thead><tr><th>#</th><th>Fecha</th><th>Lado</th><th>Balance antes</th><th>Riesgo</th><th>Margen</th><th>Notional</th><th>Costos</th><th>PNL neto</th><th>Balance después</th></tr></thead><tbody>{wickTrades.map((trade, index) => <tr key={trade.id}><td>{index + 1}</td><td>{formatTradeTime(trade.entryTime)}</td><td>{trade.side.toUpperCase()}</td><td>{trade.balanceBefore.toFixed(2)}</td><td>{trade.riskAmount.toFixed(2)}</td><td>{trade.margin.toFixed(2)}</td><td>{trade.notional.toFixed(2)}</td><td>{trade.fees.toFixed(4)}</td><td className={trade.pnl >= 0 ? 'value-positive' : 'value-negative'}>{trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(4)}</td><td>{trade.balanceAfter.toFixed(2)}</td></tr>)}</tbody></table></div><div className="backtest-event-list"><strong>Operaciones dibujadas · {wickTrades.length}</strong>{wickTrades.map(trade => <div key={trade.id}><span>{trade.side.toUpperCase()}</span><b className={trade.pnl >= 0 ? 'value-positive' : 'value-negative'}>{trade.reason} · {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(4)} USDT</b><small>MFE +{trade.mfePercent.toFixed(2)}% · MAE -{trade.maePercent.toFixed(2)}%</small></div>)}</div></>}{result && <><div className="backtest-summary"><div><small>Eventos</small><strong>{result.event_count}/{result.scheduled_event_count}</strong></div><div><small>Operaciones</small><strong>{stats?.operations ?? 0}</strong></div><div><small>Win rate</small><strong>{stats ? `${stats.win_rate.toFixed(1)}%` : '—'}</strong></div><div><small>PNL neto</small><strong className={(stats?.net_pnl ?? 0) >= 0 ? 'value-positive' : 'value-negative'}>{stats ? `${stats.net_pnl >= 0 ? '+' : ''}${stats.net_pnl.toFixed(2)} USDT` : '—'}</strong></div><div><small>Profit factor</small><strong>{stats ? (Number.isFinite(stats.profit_factor) ? stats.profit_factor.toFixed(2) : '∞') : '—'}</strong></div><div><small>Drawdown</small><strong className="value-negative">{stats ? `${stats.max_drawdown.toFixed(2)} USDT` : '—'}</strong></div></div><div className="backtest-event-list"><strong>Timeline de eventos</strong>{result.events.map(event => <div key={`${event.event_id}-${event.timestamp}`}><span>{new Date(event.timestamp * 1000).toLocaleString('es-MX')}</span><b>{event.action}</b><small>{event.price.toFixed(6)} · {event.position_id ?? 'sin posición'}</small></div>)}</div></>}</section>;
}
