import { useEffect, useMemo, useRef, useState } from 'react';
import { aggregateBars, loadThirtyDays, readCachedBars, type MarketBar } from './marketData';
import { analyzeLab, buildLabSeries, type LabCapitalModel, type LabDirection, type LabResolution, type LabRow, type LabSeriesPoint } from './labEngine';

function LabChart({ points, resolution, mode }: { points: LabSeriesPoint[]; resolution: LabResolution; mode: 'mae' | 'mfe' | 'comparison' }) {
  const slotsPerDay = 1440 / resolution;
  const maxSlot = slotsPerDay * 7 - 1;
  const width = 1000;
  const height = 250;
  const left = 48;
  const right = 980;
  const top = 18;
  const bottom = 208;
  const grouped = new Map<number, { mae: number; mfe: number; count: number }>();
  points.forEach(point => {
    const current = grouped.get(point.slot) ?? { mae: 0, mfe: 0, count: 0 };
    current.mae += point.mae;
    current.mfe += point.mfe;
    current.count += 1;
    grouped.set(point.slot, current);
  });
  const values = [...grouped.values()].flatMap(value => [value.mae / value.count, value.mfe / value.count]);
  const maxValue = Math.max(0.0001, ...values) * 1.08;
  const x = (slot: number) => left + (slot / maxSlot) * (right - left);
  const y = (value: number) => bottom - (value / maxValue) * (bottom - top);
  const series = (key: 'mae' | 'mfe') => [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, value]) => `${x(slot).toFixed(1)},${y(value[key] / value.count).toFixed(1)}`)
    .join(' ');
  const showMae = mode !== 'mfe';
  const showMfe = mode !== 'mae';
  const dayLabels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const title = mode === 'mae' ? 'MAE vs índice semanal' : mode === 'mfe' ? 'MFE vs índice semanal' : 'MAE vs MFE vs índice semanal';
  return <div className="lab-chart-card">
    <div className="lab-chart-head"><strong>{title}</strong><span>{points.length.toLocaleString('es-MX')} entradas · UTC</span></div>
    <svg className="lab-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      {[0, .25, .5, .75, 1].map(fraction => <g key={fraction}><line x1={left} x2={right} y1={y(maxValue * fraction)} y2={y(maxValue * fraction)} className="lab-chart-grid" /><text x={left - 8} y={y(maxValue * fraction) + 3} textAnchor="end" className="lab-chart-axis">{(maxValue * fraction).toFixed(3)}%</text></g>)}
      {dayLabels.map((label, index) => <g key={label}><line x1={x(index * slotsPerDay)} x2={x(index * slotsPerDay)} y1={top} y2={bottom} className="lab-chart-day" /><text x={x(index * slotsPerDay) + 4} y={bottom + 22} className="lab-chart-axis">{label}</text></g>)}
      {showMae && <polyline points={series('mae')} className="lab-chart-line lab-chart-mae" />}
      {showMfe && <polyline points={series('mfe')} className="lab-chart-line lab-chart-mfe" />}
      <text x={right - 4} y={top + 12} textAnchor="end" className="lab-chart-legend"><tspan className="lab-chart-mae-text">{showMae ? 'MAE' : ''}</tspan>{showMae && showMfe ? '  ·  ' : ''}<tspan className="lab-chart-mfe-text">{showMfe ? 'MFE' : ''}</tspan></text>
    </svg>
  </div>;
}

export default function LabWindow({ initialSymbol = 'BTCUSDT', initialBars = [], onClose }: { initialSymbol?: string; initialBars?: MarketBar[]; onClose?: () => void }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [direction, setDirection] = useState<LabDirection>('long');
  const [resolution, setResolution] = useState<LabResolution>(5);
  const [capitalModel, setCapitalModel] = useState<LabCapitalModel>('compound');
  const [horizon, setHorizon] = useState(48);
  const [riskFraction, setRiskFraction] = useState(1);
  const [bars, setBars] = useState<MarketBar[]>(initialBars);
  const [loadedThirtyDays, setLoadedThirtyDays] = useState(false);
  const [rows, setRows] = useState<LabRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Carga 30 días para iniciar el estudio.');
  const autoLoadStarted = useRef(false);

  const best = rows[0];
  const fiveMinuteBars = useMemo(() => aggregateBars(bars, 5), [bars]);
  const studyBars = useMemo(() => resolution === 5 ? fiveMinuteBars : bars, [bars, fiveMinuteBars, resolution]);
  const series = useMemo(() => buildLabSeries(studyBars, direction, horizon, resolution), [direction, horizon, resolution, studyBars]);

  function analyzeLoaded(nextBars: MarketBar[], nextResolution = resolution, nextModel = capitalModel) {
    const normalized = nextResolution === 5 ? aggregateBars(nextBars, 5) : nextBars;
    setRows(analyzeLab(normalized, direction, horizon, riskFraction, nextResolution, nextModel));
  }

  useEffect(() => {
    if (loadedThirtyDays) return;
    void readCachedBars(symbol, '1m').then(cached => {
      const available = initialBars.length > 0 && symbol === initialSymbol ? initialBars : cached;
      if (available.length > 0) {
        setBars(available);
        const normalized = resolution === 5 ? aggregateBars(available, 5) : available;
        setRows(analyzeLab(normalized, direction, horizon, riskFraction, resolution, capitalModel));
        setMessage(`Cache del gráfico: ${new Date(available[0].time * 1000).toLocaleDateString('es-MX')} → ${new Date(available[available.length - 1].time * 1000).toLocaleDateString('es-MX')}. Completando perfil semanal…`);
      }
      if (!autoLoadStarted.current) {
        autoLoadStarted.current = true;
        void run();
      }
    });
  }, [capitalModel, direction, horizon, initialBars, initialSymbol, loadedThirtyDays, resolution, riskFraction, symbol]);

  async function run() {
    setLoading(true);
    setMessage('Leyendo cache OHLC y completando hasta 30 días…');
    try {
      const loaded = await loadThirtyDays(symbol, '1m');
      setBars(loaded);
      setLoadedThirtyDays(true);
      analyzeLoaded(loaded);
      setMessage(`30 días cargados: ${new Date(loaded[0].time * 1000).toLocaleDateString('es-MX')} → ${new Date(loaded[loaded.length - 1].time * 1000).toLocaleDateString('es-MX')}.`);
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
      <button className={`lab-load-button${loadedThirtyDays ? ' lab-load-complete' : ''}`} onClick={() => void run()} disabled={loading}>{loading ? 'Analizando…' : loadedThirtyDays ? '30 días cargados' : 'Cargar 30 días'}</button>
    </header>
    <section className="lab-controls" aria-label="Parámetros del estudio">
      <label>Símbolo<select value={symbol} onChange={event => { autoLoadStarted.current = false; setLoadedThirtyDays(false); setBars([]); setRows([]); setSymbol(event.target.value); }}>{['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Dirección<select value={direction} onChange={event => setDirection(event.target.value as LabDirection)}><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Horizonte (velas {resolution}m)<input type="number" min="1" max="576" value={horizon} onChange={event => setHorizon(Math.max(1, Math.min(576, Number(event.target.value) || 1)))} /></label>
      <label>Riesgo sobre margen<input type="number" min="0.05" max="1" step="0.05" value={riskFraction} onChange={event => setRiskFraction(Math.max(.05, Math.min(1, Number(event.target.value) || .05)))} /></label>
    </section>
    <div className="lab-tabs" role="tablist" aria-label="Configuración del Lab"><div><span>Resolución</span><button className={resolution === 1 ? 'lab-tab-active' : ''} onClick={() => { setResolution(1); analyzeLoaded(bars, 1); }}>1m</button><button className={resolution === 5 ? 'lab-tab-active' : ''} onClick={() => { setResolution(5); analyzeLoaded(bars, 5); }}>5m</button></div><div><span>Capital</span><button className={capitalModel === 'compound' ? 'lab-tab-active' : ''} onClick={() => { setCapitalModel('compound'); analyzeLoaded(bars, resolution, 'compound'); }}>Compound</button><button className={capitalModel === 'simple' ? 'lab-tab-active' : ''} onClick={() => { setCapitalModel('simple'); analyzeLoaded(bars, resolution, 'simple'); }}>Simple</button></div></div>
    <p className="lab-message">{message}</p>
    {best && <section className="lab-summary"><div><small>MEJOR MOMENTO</small><strong>{best.label} UTC</strong></div><div><small>EXPECTANCY</small><strong>{best.expectancyR.toFixed(3)}R</strong></div><div><small>TP / SL</small><strong>{best.rr.toFixed(2)}:1</strong></div><div><small>LEVERAGE TEÓRICO</small><strong>{Math.min(best.leverage, 999).toFixed(1)}x</strong></div></section>}
    {series.length > 0 && <section className="lab-charts"><div className="lab-section-label">PERFIL SEMANAL · CADA VELA CONSERVA SU ÍNDICE DE APERTURA</div><LabChart points={series} resolution={resolution} mode="mae" /><LabChart points={series} resolution={resolution} mode="mfe" /><LabChart points={series} resolution={resolution} mode="comparison" /></section>}
    <section className="lab-table-card"><div className="lab-table-title"><div><span className="lab-kicker">OPTIMIZACIÓN POR SLOT</span><h2>TP / SL y leverage recomendado</h2></div><span>{rows.length ? `${rows.length} slots` : 'Sin resultados'}</span></div>{rows.length ? <div className="lab-table-scroll"><table className="lab-table"><thead><tr><th>Momento</th><th>Muestras</th><th>SL MAE</th><th>TP MFE</th><th>RR</th><th>Win rate</th><th>Expectancy</th><th>Leverage</th></tr></thead><tbody>{rows.slice(0, 96).map(row => <tr key={row.slot}><td>{row.label} UTC</td><td>{row.samples}</td><td>{row.stop.toFixed(4)}%</td><td>{row.target.toFixed(4)}%</td><td>{row.rr.toFixed(2)}:1</td><td>{row.winRate.toFixed(1)}%</td><td className={row.expectancyR > 0 ? 'lab-positive' : 'lab-negative'}>{row.expectancyR.toFixed(3)}R</td><td>{Math.min(row.leverage, 999).toFixed(1)}x</td></tr>)}</tbody></table></div> : <div className="lab-empty">El estudio permanece inactivo para no descargar datos hasta que lo solicites.</div>}</section>
    <footer className="lab-footnote">Fuente: cache OHLC del terminal · gráfico operativo limitado a 7 días · investigación cargada bajo demanda hasta 30 días · {studyBars.length ? `${studyBars.length.toLocaleString('es-MX')} velas ${resolution}m en memoria` : 'sin dataset cargado'}.</footer>
  </main>;
  return onClose ? <div className="lab-modal-backdrop" role="presentation" onClick={onClose}><section className="lab-modal" role="dialog" aria-modal="true" aria-label="GoodMorning Lab" onClick={event => event.stopPropagation()}>{content}</section></div> : content;
}
