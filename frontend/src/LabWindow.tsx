import { useMemo, useState } from 'react';
import { aggregateBars, loadThirtyDays, type MarketBar } from './marketData';
import { analyzeLab, type LabDirection, type LabRow } from './labEngine';

export default function LabWindow({ initialSymbol = 'BTCUSDT' }: { initialSymbol?: string }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [direction, setDirection] = useState<LabDirection>('long');
  const [horizon, setHorizon] = useState(48);
  const [riskFraction, setRiskFraction] = useState(1);
  const [bars, setBars] = useState<MarketBar[]>([]);
  const [rows, setRows] = useState<LabRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Carga 30 días para iniciar el estudio.');

  const best = rows[0];
  const fiveMinuteBars = useMemo(() => aggregateBars(bars, 5), [bars]);

  async function run() {
    setLoading(true);
    setMessage('Leyendo cache OHLC y completando hasta 30 días…');
    try {
      const loaded = await loadThirtyDays(symbol, '1m');
      setBars(loaded);
      const aggregated = aggregateBars(loaded, 5);
      const result = analyzeLab(aggregated, direction, horizon, riskFraction);
      setRows(result);
      setMessage(`${aggregated.length.toLocaleString('es-MX')} velas de 5m analizadas.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo cargar el OHLC.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  return <main className="lab-window">
    <header className="lab-window-header">
      <div><span className="lab-kicker">GOODMORNING RESEARCH</span><h1>MAE · MFE Lab</h1><p>TP, SL y leverage por momento de entrada.</p></div>
      <button className="lab-load-button" onClick={() => void run()} disabled={loading}>{loading ? 'Analizando…' : 'Cargar 30 días'}</button>
    </header>
    <section className="lab-controls" aria-label="Parámetros del estudio">
      <label>Símbolo<select value={symbol} onChange={event => setSymbol(event.target.value)}>{['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Dirección<select value={direction} onChange={event => setDirection(event.target.value as LabDirection)}><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Horizonte (velas 5m)<input type="number" min="1" max="576" value={horizon} onChange={event => setHorizon(Math.max(1, Math.min(576, Number(event.target.value) || 1)))} /></label>
      <label>Riesgo sobre margen<input type="number" min="0.05" max="1" step="0.05" value={riskFraction} onChange={event => setRiskFraction(Math.max(.05, Math.min(1, Number(event.target.value) || .05)))} /></label>
    </section>
    <p className="lab-message">{message}</p>
    {best && <section className="lab-summary"><div><small>MEJOR MOMENTO</small><strong>{best.label} UTC</strong></div><div><small>EXPECTANCY</small><strong>{best.expectancyR.toFixed(3)}R</strong></div><div><small>TP / SL</small><strong>{best.rr.toFixed(2)}:1</strong></div><div><small>LEVERAGE TEÓRICO</small><strong>{Math.min(best.leverage, 999).toFixed(1)}x</strong></div></section>}
    <section className="lab-table-card"><div className="lab-table-title"><div><span className="lab-kicker">OPTIMIZACIÓN POR SLOT</span><h2>TP / SL y leverage recomendado</h2></div><span>{rows.length ? `${rows.length} slots` : 'Sin resultados'}</span></div>{rows.length ? <div className="lab-table-scroll"><table className="lab-table"><thead><tr><th>Momento</th><th>Muestras</th><th>SL MAE</th><th>TP MFE</th><th>RR</th><th>Win rate</th><th>Expectancy</th><th>Leverage</th></tr></thead><tbody>{rows.slice(0, 96).map(row => <tr key={row.slot}><td>{row.label} UTC</td><td>{row.samples}</td><td>{row.stop.toFixed(4)}%</td><td>{row.target.toFixed(4)}%</td><td>{row.rr.toFixed(2)}:1</td><td>{row.winRate.toFixed(1)}%</td><td className={row.expectancyR > 0 ? 'lab-positive' : 'lab-negative'}>{row.expectancyR.toFixed(3)}R</td><td>{Math.min(row.leverage, 999).toFixed(1)}x</td></tr>)}</tbody></table></div> : <div className="lab-empty">El estudio permanece inactivo para no descargar datos hasta que lo solicites.</div>}</section>
    <footer className="lab-footnote">Fuente: cache OHLC del terminal · gráfico operativo limitado a 7 días · investigación cargada bajo demanda hasta 30 días · {fiveMinuteBars.length ? `${fiveMinuteBars.length.toLocaleString('es-MX')} velas 5m en memoria` : 'sin dataset cargado'}.</footer>
  </main>;
}
