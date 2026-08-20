import { useEffect, useMemo, useState } from 'react';
import { aggregateBars, loadThirtyDays, readCachedBars, type MarketBar } from './marketData';
import { analyzeLab, type LabCapitalModel, type LabDirection, type LabResolution, type LabRow } from './labEngine';

export default function LabWindow({ initialSymbol = 'BTCUSDT', initialBars = [], onClose }: { initialSymbol?: string; initialBars?: MarketBar[]; onClose?: () => void }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [direction, setDirection] = useState<LabDirection>('long');
  const [resolution, setResolution] = useState<LabResolution>(5);
  const [capitalModel, setCapitalModel] = useState<LabCapitalModel>('compound');
  const [horizon, setHorizon] = useState(48);
  const [riskFraction, setRiskFraction] = useState(1);
  const [bars, setBars] = useState<MarketBar[]>(initialBars);
  const [rows, setRows] = useState<LabRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Carga 30 días para iniciar el estudio.');

  const best = rows[0];
  const fiveMinuteBars = useMemo(() => aggregateBars(bars, 5), [bars]);
  const studyBars = useMemo(() => resolution === 5 ? fiveMinuteBars : bars, [bars, fiveMinuteBars, resolution]);

  function analyzeLoaded(nextBars: MarketBar[], nextResolution = resolution, nextModel = capitalModel) {
    const normalized = nextResolution === 5 ? aggregateBars(nextBars, 5) : nextBars;
    setRows(analyzeLab(normalized, direction, horizon, riskFraction, nextResolution, nextModel));
  }

  useEffect(() => {
    void readCachedBars(symbol, '1m').then(cached => {
      const available = initialBars.length > 0 && symbol === initialSymbol ? initialBars : cached;
      if (available.length === 0) return;
      setBars(available);
      const normalized = resolution === 5 ? aggregateBars(available, 5) : available;
      setRows(analyzeLab(normalized, direction, horizon, riskFraction, resolution, capitalModel));
      setMessage(`Cache del gráfico: ${new Date(available[0].time * 1000).toLocaleDateString('es-MX')} → ${new Date(available[available.length - 1].time * 1000).toLocaleDateString('es-MX')}.`);
    });
  }, [capitalModel, direction, horizon, initialBars, initialSymbol, resolution, riskFraction, symbol]);

  async function run() {
    setLoading(true);
    setMessage('Leyendo cache OHLC y completando hasta 30 días…');
    try {
      const loaded = await loadThirtyDays(symbol, '1m');
      setBars(loaded);
      analyzeLoaded(loaded);
      setMessage(`OHLC ampliado: ${new Date(loaded[0].time * 1000).toLocaleDateString('es-MX')} → ${new Date(loaded[loaded.length - 1].time * 1000).toLocaleDateString('es-MX')}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo cargar el OHLC.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  const content = <main className={`lab-window${onClose ? ' lab-window-modal' : ''}`}>
    <header className="lab-window-header">
      <div><span className="lab-kicker">GOODMORNING RESEARCH</span><h1>MAE · MFE Lab</h1><p>TP, SL y leverage por momento de entrada.</p></div>
      {onClose && <button className="lab-close-button" onClick={onClose} aria-label="Cerrar Lab">×</button>}
      <button className="lab-load-button" onClick={() => void run()} disabled={loading}>{loading ? 'Analizando…' : 'Cargar 30 días'}</button>
    </header>
    <section className="lab-controls" aria-label="Parámetros del estudio">
      <label>Símbolo<select value={symbol} onChange={event => setSymbol(event.target.value)}>{['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Dirección<select value={direction} onChange={event => setDirection(event.target.value as LabDirection)}><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Horizonte (velas {resolution}m)<input type="number" min="1" max="576" value={horizon} onChange={event => setHorizon(Math.max(1, Math.min(576, Number(event.target.value) || 1)))} /></label>
      <label>Riesgo sobre margen<input type="number" min="0.05" max="1" step="0.05" value={riskFraction} onChange={event => setRiskFraction(Math.max(.05, Math.min(1, Number(event.target.value) || .05)))} /></label>
    </section>
    <div className="lab-tabs" role="tablist" aria-label="Configuración del Lab"><div><span>Resolución</span><button className={resolution === 1 ? 'lab-tab-active' : ''} onClick={() => { setResolution(1); analyzeLoaded(bars, 1); }}>1m</button><button className={resolution === 5 ? 'lab-tab-active' : ''} onClick={() => { setResolution(5); analyzeLoaded(bars, 5); }}>5m</button></div><div><span>Capital</span><button className={capitalModel === 'compound' ? 'lab-tab-active' : ''} onClick={() => { setCapitalModel('compound'); analyzeLoaded(bars, resolution, 'compound'); }}>Compound</button><button className={capitalModel === 'simple' ? 'lab-tab-active' : ''} onClick={() => { setCapitalModel('simple'); analyzeLoaded(bars, resolution, 'simple'); }}>Simple</button></div></div>
    <p className="lab-message">{message}</p>
    {best && <section className="lab-summary"><div><small>MEJOR MOMENTO</small><strong>{best.label} UTC</strong></div><div><small>EXPECTANCY</small><strong>{best.expectancyR.toFixed(3)}R</strong></div><div><small>TP / SL</small><strong>{best.rr.toFixed(2)}:1</strong></div><div><small>LEVERAGE TEÓRICO</small><strong>{Math.min(best.leverage, 999).toFixed(1)}x</strong></div></section>}
    <section className="lab-table-card"><div className="lab-table-title"><div><span className="lab-kicker">OPTIMIZACIÓN POR SLOT</span><h2>TP / SL y leverage recomendado</h2></div><span>{rows.length ? `${rows.length} slots` : 'Sin resultados'}</span></div>{rows.length ? <div className="lab-table-scroll"><table className="lab-table"><thead><tr><th>Momento</th><th>Muestras</th><th>SL MAE</th><th>TP MFE</th><th>RR</th><th>Win rate</th><th>Expectancy</th><th>Leverage</th></tr></thead><tbody>{rows.slice(0, 96).map(row => <tr key={row.slot}><td>{row.label} UTC</td><td>{row.samples}</td><td>{row.stop.toFixed(4)}%</td><td>{row.target.toFixed(4)}%</td><td>{row.rr.toFixed(2)}:1</td><td>{row.winRate.toFixed(1)}%</td><td className={row.expectancyR > 0 ? 'lab-positive' : 'lab-negative'}>{row.expectancyR.toFixed(3)}R</td><td>{Math.min(row.leverage, 999).toFixed(1)}x</td></tr>)}</tbody></table></div> : <div className="lab-empty">El estudio permanece inactivo para no descargar datos hasta que lo solicites.</div>}</section>
    <footer className="lab-footnote">Fuente: cache OHLC del terminal · gráfico operativo limitado a 7 días · investigación cargada bajo demanda hasta 30 días · {studyBars.length ? `${studyBars.length.toLocaleString('es-MX')} velas ${resolution}m en memoria` : 'sin dataset cargado'}.</footer>
  </main>;
  return onClose ? <div className="lab-modal-backdrop" role="presentation" onClick={onClose}><section className="lab-modal" role="dialog" aria-modal="true" aria-label="GoodMorning Lab" onClick={event => event.stopPropagation()}>{content}</section></div> : content;
}
