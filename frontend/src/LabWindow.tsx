import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { aggregateBars, loadThirtyDays, readCachedBars, type MarketBar } from './marketData';
import { analyzeLab, buildLabSeries, LAB_TIMEZONE, type LabCapitalModel, type LabDirection, type LabResolution, type LabRow, type LabSeriesPoint } from './labEngine';

export type LabRecommendation = { label: string; mae: number; mfe: number; rr: number; leverage: number; riskAmount: number; notional: number; margin: number; expectedProfit: number };
export type LabRecommendations = { long: LabRecommendation; short: LabRecommendation };

function LabChart({ points, resolution, mode }: { points: LabSeriesPoint[]; resolution: LabResolution; mode: 'mae' | 'mfe' | 'comparison' }) {
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const slotsPerDay = 1440 / resolution;
  const maxSlot = slotsPerDay * 7 - 1;
  const width = 1000;
  const height = 250;
  const left = 48;
  const right = 980;
  const top = 18;
  const bottom = 208;
  const grouped = useMemo(() => {
    const values = new Map<number, { mae: number; mfe: number; count: number }>();
    points.forEach(point => {
      const current = values.get(point.slot) ?? { mae: 0, mfe: 0, count: 0 };
      current.mae += point.mae;
      current.mfe += point.mfe;
      current.count += 1;
      values.set(point.slot, current);
    });
    return values;
  }, [points]);
  const groupedEntries = [...grouped.entries()].sort(([a], [b]) => a - b);
  const values = [...grouped.values()].flatMap(value => [value.mae / value.count, value.mfe / value.count]);
  const maxValue = Math.max(0.0001, ...values) * 1.08;
  const x = (slot: number) => left + (slot / maxSlot) * (right - left);
  const y = (value: number) => bottom - (value / maxValue) * (bottom - top);
  const series = (key: 'mae' | 'mfe') => groupedEntries
    .map(([slot, value]) => `${x(slot).toFixed(1)},${y(value[key] / value.count).toFixed(1)}`)
    .join(' ');
  const hovered = hoverSlot === null ? null : grouped.get(hoverSlot);
  const hoveredX = hoverSlot === null ? 0 : x(hoverSlot);
  const hoveredLabel = hoverSlot === null ? '' : points.find(point => point.slot === hoverSlot)?.label ?? '';
  const tooltipWidth = 190;
  const tooltipX = Math.max(left, Math.min(right - tooltipWidth, hoveredX - tooltipWidth / 2));
  const showMae = mode !== 'mfe';
  const showMfe = mode !== 'mae';
  const handleMove = (event: MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * width;
    const slotAtCursor = ((svgX - left) / (right - left)) * maxSlot;
    const nearest = groupedEntries.reduce<number | null>((bestSlot, [slot]) => (
      bestSlot === null || Math.abs(slot - slotAtCursor) < Math.abs(bestSlot - slotAtCursor) ? slot : bestSlot
    ), null);
    setHoverSlot(nearest);
  };
  const dayLabels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const title = mode === 'mae' ? 'MAE vs índice semanal' : mode === 'mfe' ? 'MFE vs índice semanal' : 'MAE vs MFE vs índice semanal';
  return <div className="lab-chart-card">
    <div className="lab-chart-head"><strong>{title}</strong><span>{points.length.toLocaleString('es-MX')} entradas · UTC</span></div>
    <svg className="lab-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} onMouseMove={handleMove} onMouseLeave={() => setHoverSlot(null)}>
      {[0, .25, .5, .75, 1].map(fraction => <g key={fraction}><line x1={left} x2={right} y1={y(maxValue * fraction)} y2={y(maxValue * fraction)} className="lab-chart-grid" /><text x={left - 8} y={y(maxValue * fraction) + 3} textAnchor="end" className="lab-chart-axis">{(maxValue * fraction).toFixed(3)}%</text></g>)}
      {dayLabels.map((label, index) => <g key={label}><line x1={x(index * slotsPerDay)} x2={x(index * slotsPerDay)} y1={top} y2={bottom} className="lab-chart-day" /><text x={x(index * slotsPerDay) + 4} y={bottom + 22} className="lab-chart-axis">{label}</text></g>)}
      {showMae && <polyline points={series('mae')} className="lab-chart-line lab-chart-mae" />}
      {showMfe && <polyline points={series('mfe')} className="lab-chart-line lab-chart-mfe" />}
      {hovered && <g className="lab-chart-hover" pointerEvents="none">
        <line x1={hoveredX} x2={hoveredX} y1={top} y2={bottom} className="lab-chart-hover-line" />
        {showMae && <circle cx={hoveredX} cy={y(hovered.mae / hovered.count)} r="4" className="lab-chart-hover-mae" />}
        {showMfe && <circle cx={hoveredX} cy={y(hovered.mfe / hovered.count)} r="4" className="lab-chart-hover-mfe" />}
        <rect x={tooltipX} y={top + 4} width={tooltipWidth} height={showMae && showMfe ? 48 : 34} rx="5" className="lab-chart-tooltip" />
        <text x={tooltipX + 10} y={top + 19} className="lab-chart-tooltip-text">{hoveredLabel}</text>
        {showMae && <text x={tooltipX + 10} y={top + 35} className="lab-chart-tooltip-mae">MAE {((hovered.mae / hovered.count)).toFixed(4)}%</text>}
        {showMfe && <text x={tooltipX + (showMae ? 100 : 10)} y={top + 35} className="lab-chart-tooltip-mfe">MFE {((hovered.mfe / hovered.count)).toFixed(4)}%</text>}
      </g>}
      <text x={right - 4} y={top + 12} textAnchor="end" className="lab-chart-legend"><tspan className="lab-chart-mae-text">{showMae ? 'MAE' : ''}</tspan>{showMae && showMfe ? '  ·  ' : ''}<tspan className="lab-chart-mfe-text">{showMfe ? 'MFE' : ''}</tspan></text>
    </svg>
  </div>;
}

export default function LabWindow({ activeSymbol = 'BTCUSDT', broker = 'binance', apiUrl, accessToken, initialBars = [], paperBalance, onRecommendation, onClose }: { activeSymbol?: string; broker?: 'binance' | 'ctrader'; apiUrl?: string; accessToken?: string | null; initialBars?: MarketBar[]; paperBalance?: number; onRecommendation?: (value: LabRecommendations | null) => void; onClose?: () => void }) {
  const [direction, setDirection] = useState<LabDirection>('long');
  const [resolution, setResolution] = useState<LabResolution>(5);
  const [capitalModel, setCapitalModel] = useState<LabCapitalModel>('compound');
  const [horizon, setHorizon] = useState(10);
  const [riskFraction, setRiskFraction] = useState(1);
  const [startingBalance, setStartingBalance] = useState(() => Number(localStorage.getItem('helloworld-paper-balance') ?? 100) || 100);
  const [bars, setBars] = useState<MarketBar[]>(initialBars);
  const [loadedThirtyDays, setLoadedThirtyDays] = useState(false);
  const [rows, setRows] = useState<LabRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Carga 30 días para iniciar el estudio.');
  const [clock, setClock] = useState(() => Date.now());
  const autoLoadStarted = useRef(false);
  const [tableSort, setTableSort] = useState<{ key: 'slot' | 'samples' | 'stop' | 'target' | 'rr' | 'winRate' | 'expectancyR' | 'leverage'; direction: 'asc' | 'desc' }>({ key: 'expectancyR', direction: 'desc' });
  useEffect(() => {
    if (paperBalance != null && Number.isFinite(paperBalance) && paperBalance > 0) setStartingBalance(paperBalance);
  }, [paperBalance]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const studyInterval = resolution === 5 ? '5m' : '1m';
  const fiveMinuteBars = useMemo(() => aggregateBars(bars, 5), [bars]);
  const studyBars = useMemo(() => resolution === 5 ? fiveMinuteBars : bars, [bars, fiveMinuteBars, resolution]);
  const best = rows[0];
  const currentSlot = (() => { const parts = new Intl.DateTimeFormat('en-US', { timeZone: LAB_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(clock); const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find(part => part.type === 'weekday')?.value ?? ''); const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0); const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0); return weekday * (1440 / resolution) + hour * (60 / resolution) + Math.floor(minute / resolution); })();
  const liveRows = useMemo(() => {
    if (!studyBars.length) return { long: [], short: [] };
    const longRows = direction === 'long' ? rows : analyzeLab(studyBars, 'long', horizon, riskFraction, resolution, capitalModel);
    const shortRows = direction === 'short' ? rows : analyzeLab(studyBars, 'short', horizon, riskFraction, resolution, capitalModel);
    return { long: longRows, short: shortRows };
  }, [capitalModel, direction, horizon, resolution, riskFraction, rows, studyBars]);
  const recommendations = useMemo(() => {
    const make = (row?: LabRow): LabRecommendation | null => {
      if (!row) return null;
      const riskAmount = startingBalance * (riskFraction / 100);
      const notional = row.stop > 0 ? riskAmount / (row.stop / 100) : 0;
      const margin = row.leverage > 0 ? notional / row.leverage : 0;
      return { label: row.label, mae: row.stop, mfe: row.target, rr: row.rr, leverage: row.leverage, riskAmount, notional, margin, expectedProfit: notional * (row.target / 100) };
    };
    const long = make(liveRows.long.find(row => row.slot === currentSlot) ?? liveRows.long[0]);
    const short = make(liveRows.short.find(row => row.slot === currentSlot) ?? liveRows.short[0]);
    return long && short ? { long, short } : null;
  }, [currentSlot, liveRows, riskFraction, startingBalance]);
  useEffect(() => {
    onRecommendation?.(recommendations);
  }, [onRecommendation, recommendations]);
  const series = useMemo(() => buildLabSeries(studyBars, direction, horizon, resolution), [direction, horizon, resolution, studyBars]);
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    const difference = left[tableSort.key] - right[tableSort.key];
    return tableSort.direction === 'asc' ? difference : -difference;
  }), [rows, tableSort]);

  function toggleTableSort(key: typeof tableSort.key) {
    setTableSort(current => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'slot' ? 'asc' : 'desc' });
  }

  function sortButton(key: typeof tableSort.key, label: string) {
    const active = tableSort.key === key;
    return <button type="button" className="lab-sort-button" onClick={() => toggleTableSort(key)} aria-label={`Ordenar por ${label}`}>
      {label} {active ? (tableSort.direction === 'asc' ? '↑' : '↓') : '↕'}
    </button>;
  }

  useEffect(() => {
    autoLoadStarted.current = false;
    setLoadedThirtyDays(false);
    setBars(initialBars);
    setRows([]);
    setMessage(`Preparando el estudio para ${activeSymbol}…`);
  }, [activeSymbol]);

  useEffect(() => {
    if (paperBalance != null) return;
    localStorage.setItem('helloworld-paper-balance', String(startingBalance));
    if (!best || !recommendations) return;
    localStorage.setItem('helloworld-paper-assist', JSON.stringify({
      balance: startingBalance, riskPercent: riskFraction, stopPercent: best.stop,
      targetPercent: best.target, leverage: best.leverage, rr: best.rr,
    }));
    window.dispatchEvent(new Event('helloworld-paper-assist-updated'));
  }, [best, recommendations, riskFraction, startingBalance]);

  function analyzeLoaded(nextBars: MarketBar[], nextResolution = resolution, nextModel = capitalModel) {
    const normalized = nextResolution === 5 ? aggregateBars(nextBars, 5) : nextBars;
    setRows(analyzeLab(normalized, direction, horizon, riskFraction, nextResolution, nextModel));
  }

  // Recalculate the complete study when any analysis parameter changes.
  // The chart series already depends on horizon, but the summary cards and
  // recommendation must use the same fresh rows as well.
  useEffect(() => {
    if (!bars.length) return;
    const normalized = resolution === 5 ? aggregateBars(bars, 5) : bars;
    setRows(analyzeLab(normalized, direction, horizon, riskFraction, resolution, capitalModel));
  }, [bars, capitalModel, direction, horizon, resolution, riskFraction]);

  useEffect(() => {
    if (loadedThirtyDays) return;
    void readCachedBars(activeSymbol, studyInterval).then(cached => {
      const available = initialBars.length > 0 ? initialBars : cached;
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
  }, [activeSymbol, initialBars, loadedThirtyDays, studyInterval]);

  async function run() {
    setLoading(true);
    setMessage('Leyendo cache OHLC y completando hasta 30 días…');
    try {
      const loaded = await loadThirtyDays(activeSymbol, studyInterval, { broker, apiUrl, accessToken });
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
      <div><span className="lab-kicker">GOODMORNING RESEARCH</span><h1>MAE·MFE Lab</h1><p>Asistencia en tiempo real · símbolo activo <strong className="lab-symbol-badge">{activeSymbol}</strong></p></div>
      {onClose && <button className="lab-close-button" onClick={onClose} aria-label="Cerrar Lab">×</button>}
      <button className={`lab-load-button${loadedThirtyDays ? ' lab-load-complete' : ''}`} onClick={() => void run()} disabled={loading}>{loading ? 'Analizando…' : loadedThirtyDays ? '30 días cargados' : 'Cargar 30 días'}</button>
    </header>
    <section className="lab-controls" aria-label="Parámetros del estudio">
      <label>Dirección<select value={direction} onChange={event => setDirection(event.target.value as LabDirection)}><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Horizonte (velas {resolution}m)<input type="number" min="1" max="576" value={horizon} onChange={event => setHorizon(Math.max(1, Math.min(576, Number(event.target.value) || 1)))} /></label>
      <label>Balance paper<input type="number" min="1" step="1" value={startingBalance.toFixed(2)} readOnly /></label><label>Riesgo por operación (%)<input type="number" min="0.05" max="10" step="0.05" value={riskFraction} onChange={event => setRiskFraction(Math.max(.05, Math.min(10, Number(event.target.value) || .05)))} /></label>
    </section>
    <div className="lab-tabs" role="tablist" aria-label="Configuración del Lab"><div><span>Resolución</span><button className={resolution === 1 ? 'lab-tab-active' : ''} onClick={() => { setResolution(1); setLoadedThirtyDays(false); autoLoadStarted.current = false; setRows([]); }}>1m</button><button className={resolution === 5 ? 'lab-tab-active' : ''} onClick={() => { setResolution(5); setLoadedThirtyDays(false); autoLoadStarted.current = false; setRows([]); }}>5m</button></div><div><span>Capital</span><button className={capitalModel === 'compound' ? 'lab-tab-active' : ''} onClick={() => { setCapitalModel('compound'); analyzeLoaded(bars, resolution, 'compound'); }}>Compound</button><button className={capitalModel === 'simple' ? 'lab-tab-active' : ''} onClick={() => { setCapitalModel('simple'); analyzeLoaded(bars, resolution, 'simple'); }}>Simple</button></div></div>
    <p className="lab-message">{message}</p>
    {best && <section className="lab-summary"><div><small>MEJOR MOMENTO</small><strong>{best.label} UTC</strong></div><div><small>MAE MÁXIMO</small><strong>{best.stop.toFixed(4)}%</strong></div><div><small>MFE MÁXIMO</small><strong>{best.target.toFixed(4)}%</strong></div><div><small>EXPECTANCY</small><strong>{best.expectancyR.toFixed(3)}R</strong></div><div><small>TP / SL</small><strong>{best.rr.toFixed(2)}:1</strong></div><div><small>LEVERAGE TEÓRICO</small><strong>{best.leverage.toFixed(1)}x</strong></div></section>}
    {series.length > 0 && <section className="lab-charts"><div className="lab-section-label">PERFIL SEMANAL · CADA VELA CONSERVA SU ÍNDICE DE APERTURA</div><LabChart points={series} resolution={resolution} mode="mae" /><LabChart points={series} resolution={resolution} mode="mfe" /><LabChart points={series} resolution={resolution} mode="comparison" /></section>}
    <section className="lab-table-card"><div className="lab-table-title"><div><span className="lab-kicker">OPTIMIZACIÓN POR SLOT</span><h2>TP / SL y leverage recomendado</h2></div><span>{rows.length ? `${rows.length} slots` : 'Sin resultados'}</span></div>{rows.length ? <div className="lab-table-scroll"><table className="lab-table"><thead><tr><th>{sortButton('slot', 'Momento')}</th><th>{sortButton('samples', 'Muestras')}</th><th>{sortButton('stop', 'SL MAE')}</th><th>{sortButton('target', 'TP MFE')}</th><th>{sortButton('rr', 'RR')}</th><th>{sortButton('winRate', 'Win rate')}</th><th>{sortButton('expectancyR', 'Expectancy')}</th><th>{sortButton('leverage', 'Leverage')}</th></tr></thead><tbody>{sortedRows.slice(0, 96).map(row => <tr key={row.slot}><td>{row.label} UTC</td><td>{row.samples}</td><td>{row.stop.toFixed(4)}%</td><td>{row.target.toFixed(4)}%</td><td>{row.rr.toFixed(2)}:1</td><td>{row.winRate.toFixed(1)}%</td><td className={row.expectancyR > 0 ? 'lab-positive' : 'lab-negative'}>{row.expectancyR.toFixed(3)}R</td><td>{row.leverage.toFixed(1)}x</td></tr>)}</tbody></table></div> : <div className="lab-empty">El estudio permanece inactivo para no descargar datos hasta que lo solicites.</div>}</section>
    <footer className="lab-footnote">Fuente: cache OHLC del terminal · gráfico operativo limitado a 7 días · investigación cargada bajo demanda hasta 30 días · {studyBars.length ? `${studyBars.length.toLocaleString('es-MX')} velas ${resolution}m en memoria` : 'sin dataset cargado'}.</footer>
  </main>;
  return onClose ? <div className="lab-modal-backdrop" role="presentation" onClick={onClose}><section className="lab-modal" role="dialog" aria-modal="true" aria-label="GoodMorning Lab" onClick={event => event.stopPropagation()}>{content}</section></div> : content;
}
