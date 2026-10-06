import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { AuthGuard, AuthProvider, createAuthClient, useAuth, type AuthClient } from '@goodmorning/gm-auth';
import { PwaRuntime } from '@goodmorning/gm-pwa';
import { CandlestickSeries, createChart, type IPriceLine, type Time, type UTCTimestamp } from 'lightweight-charts';
import LabWindow, { type LabRecommendations } from './LabWindow';
import BacktestPanel, { type WickBacktestTrade } from './BacktestPanel';
import { cacheBars } from './marketData';
import { calculateDailyTimeWindow, calculateHeikinAshi, calculateRsi, calculateSslChannel, calculateTrackerCloseReason, calculateTrackerLevels, calculateTrackerSignal, calculateWickExtensions } from './indicators';
import { tradingCosts, tradingCostRate } from './tradingCosts';
import './styles.css';

const defaultApiUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8000'
  : 'https://api.dev.helloworld.goodmorning.mx';
const configuredApiUrl = import.meta.env.VITE_API_URL ?? defaultApiUrl;
const apiUrl = configuredApiUrl === '/api' && window.location.hostname === 'dev.helloworld.goodmorning.mx'
  ? 'https://api.dev.helloworld.goodmorning.mx'
  : configuredApiUrl;
const marketWsUrl = apiUrl.replace(/^http/, 'ws');

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(input, init);
      const text = await response.text();
      let payload: unknown;
      try { payload = text ? JSON.parse(text) : null; } catch { throw new Error(`Respuesta inválida del servidor (${response.status}).`); }
      if (!response.ok) throw new Error((payload as { detail?: string } | null)?.detail ?? `El servidor respondió ${response.status}.`);
      return payload as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No se pudo cargar la información.');
}

// Keep the interactive charts responsive. The Lab keeps its own historical
// dataset; these limits only control what is rendered in the live canvases.
// Keep the complete loaded 1m history in the series. Trimming it back to 240
// bars after loading older data invalidates the logical range and resets zoom.
const MAX_ENTRY_RENDER_BARS = 10080;
const MAX_CONTEXT_RENDER_BARS = 180;
const INITIAL_ENTRY_BARS = 240;

type TrackerExtremePoint = { time: number; price: number; roePercent: number; pnlUsd: number };
type TrackerVirtualOperation = {
  id: string;
  side: 'long' | 'short';
  level: 'H1' | 'H2' | 'L1' | 'L2';
  start: { time: number; price: number };
  end: { time: number; price: number };
  stop: { time: number; price: number };
  target: { time: number; price: number };
  closed: boolean;
  closeReason?: 'TP' | 'SL';
  status: 'OPEN' | 'CLOSED - WIN' | 'CLOSED - FAILED';
  pnl: number;
  resultRoePercent: number;
  notional: number;
  leverage: number;
  fees?: number;
  balanceAfter?: number;
  bodyAveragePercentAtOpen: number;
  bodyAveragePercentAtClose: number;
  finalTargetPercent: number;
  finalTargetRoePercent: number;
  maxRoe: TrackerExtremePoint;
  realMaxRoe: TrackerExtremePoint;
  minRoe: TrackerExtremePoint;
  realMinRoe: TrackerExtremePoint;
};
type TrackerLossLimitSummary = { limit: number; winsKept: number; lossesLimited: number; winCoverage: number; lossCoverage: number; targetDistance: number };

function findBestTrackerLossLimit(operations: TrackerVirtualOperation[]): TrackerLossLimitSummary {
  const wins = operations.filter(operation => operation.status === 'CLOSED - WIN');
  const losses = operations.filter(operation => operation.status === 'CLOSED - FAILED');
  const candidates = [...new Set([0, ...operations.map(operation => Math.max(0, -operation.minRoe.roePercent))])].sort((a, b) => a - b);
  const evaluated = candidates.map(limit => {
    const winsKept = wins.filter(operation => operation.minRoe.roePercent >= -limit).length;
    const lossesLimited = losses.filter(operation => operation.minRoe.roePercent <= -limit).length;
    const winCoverage = wins.length ? winsKept / wins.length : 0;
    const lossCoverage = losses.length ? lossesLimited / losses.length : 0;
    return { limit, winsKept, lossesLimited, winCoverage, lossCoverage, targetDistance: Math.abs(winCoverage - .8) + Math.abs(lossCoverage - .8) };
  });
  const feasible = evaluated.filter(item => item.winCoverage >= .8 && item.lossCoverage >= .8);
  return [...(feasible.length ? feasible : evaluated)].sort((a, b) => a.targetDistance - b.targetDistance || a.limit - b.limit)[0] ?? { limit: 0, winsKept: 0, lossesLimited: 0, winCoverage: 0, lossCoverage: 0, targetDistance: 0 };
}

function applyTrackerLossLimit(operations: TrackerVirtualOperation[], summary: TrackerLossLimitSummary): number[] {
  return operations.map(operation => {
    if (operation.minRoe.roePercent > -summary.limit) return operation.pnl;
    const grossLimitedPnl = -(summary.limit / 100 / Math.max(1, operation.leverage)) * operation.notional;
    return Math.max(operation.pnl, grossLimitedPnl - tradingCosts('binance', operation.notional).total);
  });
}

function runTrackerVisualSimulation(
  bars: Array<{ time: number; open: number; high: number; low: number; close: number }>,
  trackerPeriod: number,
  stopPercent: number,
  targetPercent: number,
  initialBalance: number,
  riskPercent: number,
  leverage: number,
  includeLastBar = false,
): TrackerVirtualOperation[] {
  // In live mode the last candle can still be forming, so leave it out. During
  // replay every candle is historical/closed and must be evaluated immediately.
  const closedBars = includeLastBar ? bars : bars.slice(0, -1);
  const levels = calculateTrackerLevels(closedBars, trackerPeriod);
  const operations: TrackerVirtualOperation[] = [];
  let openOperation: TrackerVirtualOperation | null = null;
  let balance = Math.max(0, initialBalance);
  const stopDistance = Math.max(Math.abs(stopPercent) / 100, 0.000001);
  const targetDistance = Math.abs(targetPercent) / 100;
  const bodyAveragePercent = (index: number) => {
    const sample = closedBars.slice(Math.max(0, index - 4), index + 1);
    if (!sample.length) return 0;
    return sample.reduce((sum, bar) => sum + (bar.open > 0 ? Math.abs(bar.close - bar.open) / bar.open * 100 : 0), 0) / sample.length;
  };
  const extremePoint = (time: number, price: number, entry: number, side: 'long' | 'short', notional: number) => {
    const direction = side === 'long' ? 1 : -1;
    const move = entry > 0 ? ((price - entry) / entry) * direction : 0;
    return { time, price, roePercent: move * Math.max(1, leverage) * 100, pnlUsd: move * notional };
  };
  const createOperation = (index: number, time: number, price: number, side: 'long' | 'short', level: TrackerVirtualOperation['level']) => {
    const riskAmount = balance * Math.max(0, riskPercent) / 100;
    const notional = Math.min(riskAmount / stopDistance, balance * Math.max(1, leverage));
    if (!(notional > 0) || !(price > 0)) return null;
    const direction = side === 'long' ? 1 : -1;
    const stopPrice = price * (1 - direction * stopDistance);
    const targetPrice = price * (1 + direction * targetDistance);
    const point = extremePoint(time, price, price, side, notional);
    return { id: `tracker-visual-${time}-${side}-${operations.length}`, side, level, start: { time, price }, end: { time, price }, stop: { time, price: stopPrice }, target: { time, price: targetPrice }, closed: false, status: 'OPEN' as const, pnl: 0, resultRoePercent: 0, notional, leverage: Math.max(1, leverage), fees: 0, balanceAfter: balance, bodyAveragePercentAtOpen: bodyAveragePercent(index), bodyAveragePercentAtClose: 0, finalTargetPercent: Math.abs(targetPercent), finalTargetRoePercent: Math.abs(targetPercent) * Math.max(1, leverage), maxRoe: point, realMaxRoe: point, minRoe: point, realMinRoe: point };
  };
  const updateExtremes = (operation: TrackerVirtualOperation, bar: { time: number; high: number; low: number; close: number }) => {
    const candidates = [
      { key: 'maxRoe' as const, point: extremePoint(Number(bar.time), operation.side === 'long' ? bar.high : bar.low, operation.start.price, operation.side, operation.notional), favorable: true },
      { key: 'realMaxRoe' as const, point: extremePoint(Number(bar.time), bar.close, operation.start.price, operation.side, operation.notional), favorable: true },
      { key: 'minRoe' as const, point: extremePoint(Number(bar.time), operation.side === 'long' ? bar.low : bar.high, operation.start.price, operation.side, operation.notional), favorable: false },
      { key: 'realMinRoe' as const, point: extremePoint(Number(bar.time), bar.close, operation.start.price, operation.side, operation.notional), favorable: false },
    ];
    let next = { ...operation };
    candidates.forEach(candidate => {
      const current = next[candidate.key];
      const improves = candidate.favorable ? candidate.point.roePercent > current.roePercent : candidate.point.roePercent < current.roePercent;
      if (improves) next = { ...next, [candidate.key]: candidate.point };
    });
    return next;
  };
  const makeSignal = (index: number) => {
    const bar = closedBars[index];
    const level = levels[index];
    return calculateTrackerSignal(bar.close, level);
  };
  for (let index = Math.max(1, Math.round(trackerPeriod)); index < closedBars.length; index += 1) {
    const bar = closedBars[index];
    if (openOperation) {
      openOperation = updateExtremes(openOperation, bar);
      const direction = openOperation.side === 'long' ? 1 : -1;
      const closeRoe = ((bar.close - openOperation.start.price) / openOperation.start.price) * direction;
      const signal = makeSignal(index);
      const rawReason = calculateTrackerCloseReason(openOperation.side, openOperation.start.price, bar.close, stopPercent, targetPercent);
      // A TP is only a WIN after the close also reaches the opposite Tracker
      // side: LONG needs H1/H2, SHORT needs L1/L2.
      const reason = rawReason === 'TP' && (!signal || (openOperation.side === 'long' ? signal.side !== 'short' : signal.side !== 'long')) ? null : rawReason;
      if (reason) {
        // The operation is filled and closed at the completed candle close,
        // never at the projected intrabar SL/TP level.
        const exitPrice = bar.close;
        const grossPnl = ((exitPrice - openOperation.start.price) / openOperation.start.price) * direction * openOperation.notional;
        const fees = tradingCosts('binance', openOperation.notional).total;
        const pnl = grossPnl - fees;
        balance = Math.max(0, balance + pnl);
        const closedOperation = { ...openOperation, end: { time: Number(bar.time), price: exitPrice }, closed: true, closeReason: reason, status: reason === 'TP' ? 'CLOSED - WIN' as const : 'CLOSED - FAILED' as const, pnl, fees, balanceAfter: balance, resultRoePercent: closeRoe * Math.max(1, leverage) * 100, bodyAveragePercentAtClose: bodyAveragePercent(index), finalTargetPercent: Math.abs(closeRoe * 100), finalTargetRoePercent: Math.abs(closeRoe * Math.max(1, leverage) * 100) };
        operations.push(closedOperation);
        openOperation = null;
        if (reason === 'TP') {
          // A WIN reverses immediately at this candle's closing price. The
          // next position is still virtual and remains the only open one.
          openOperation = createOperation(index, Number(bar.time), exitPrice, closedOperation.side === 'long' ? 'short' : 'long', closedOperation.level);
        } else {
          // After a FAIL, evaluate this same closed candle with Tracker. The
          // replacement is not forced to be opposite; Tracker decides its side.
          const retrySignal = signal;
          openOperation = retrySignal
            ? createOperation(index, Number(bar.time), exitPrice, retrySignal.side, retrySignal.level)
            : null;
        }
        continue;
      }
      const currentOperation: TrackerVirtualOperation = openOperation;
      openOperation = { ...currentOperation, end: { time: Number(bar.time), price: bar.close } };
      continue;
    }
    const signal = makeSignal(index);
    if (!signal || !(bar.close > 0)) continue;
    openOperation = createOperation(index, Number(bar.time), bar.close, signal.side, signal.level);
  }
  if (openOperation) operations.push(openOperation);
  return operations;
}
const INITIAL_CONTEXT_BARS = 180;
const MAX_CHART_HISTORY_SECONDS = 2 * 86400;
const FIXED_BINANCE_STOP_PERCENT = 1.00;
const FIXED_BINANCE_TARGET_PERCENT = 1;
// Safe Binance validation profile: use the smallest permitted exposure and
// the lowest leverage. This keeps margin equal to the symbol minimum notional.
const BINANCE_MIN_OPERATION_LEVERAGE = 1;
const BINANCE_MARGIN_RESERVE_USDT = 1;
type BinanceSizingMode = 'minimum' | 'maximum';
type ViewportSnapshot = { bars: number; futureBars: number; yBelow: number; yAbove: number };
type OhlcHover = { time: UTCTimestamp; open: number; high: number; low: number; close: number; x: number; y: number };
type ReplayState = { active: boolean; running: boolean; cursor: number; total: number; start: number };
const ENTRY_VIEWPORT_DEFAULTS: ViewportSnapshot = { bars: 100, futureBars: 0, yBelow: 14, yAbove: 11 };
function renderBars(bars: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>, max: number) {
  return bars.slice(-max);
}
function resolveOhlcHover(param: any, series: any, bars: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>): OhlcHover | null {
  if (!param?.point) return null;
  const seriesBar = param.seriesData?.get(series) as { time?: UTCTimestamp; open?: number; high?: number; low?: number; close?: number } | undefined;
  const logicalIndex = Number.isFinite(Number(param.logical)) ? Math.round(Number(param.logical)) : -1;
  const bar = seriesBar ?? (logicalIndex >= 0 ? bars[logicalIndex] : undefined) ?? (param.time ? bars.find(item => Number(item.time) === Number(param.time)) : undefined);
  if (!bar || bar.time == null || bar.open == null || bar.high == null || bar.low == null || bar.close == null) return null;
  return { time: bar.time, open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), x: Number(param.point.x), y: Number(param.point.y) };
}
function applyDefaultChartViewport(chart: ReturnType<typeof createChart>, data: Array<{ close: number }>, visibleBars: number, futureBars = 20, yBelow = 15, yAbove = 10) {
  if (!data.length) return;
  const lastIndex = data.length - 1;
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, lastIndex - Math.max(0, Math.min(visibleBars - futureBars, data.length)) + 1),
    to: lastIndex + futureBars,
  });
  const close = Number(data[lastIndex].close);
  if (Number.isFinite(close) && close > 0) {
    chart.priceScale('right').setVisibleRange({ from: close * (1 - yBelow / 100), to: close * (1 + yAbove / 100) });
  }
}
function zoomChartOnWheel(chart: ReturnType<typeof createChart>, event: WheelEvent) {
  // Trackpad vertical scrolling behaves like CAD/3D zoom: a fixed step,
  // synchronized X/Y scaling, anchored at the pointer. Keep horizontal
  // two-finger movement available to the chart's native scroll.
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) return;
  const logical = chart.timeScale().getVisibleLogicalRange();
  const price = chart.priceScale('right').getVisibleRange();
  if (!logical || !price) return;
  event.preventDefault();
  event.stopPropagation();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const xRatio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const yRatio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
  // Small fixed steps make trackpad wheel zoom feel controlled instead of
  // jumping several viewport widths with one gesture.
  const factor = event.deltaY < 0 ? 0.96 : 1.04;
  const xAnchor = logical.from + (logical.to - logical.from) * xRatio;
  const yAnchor = price.to - (price.to - price.from) * yRatio;
  const nextLogicalSpan = Math.max(2, (logical.to - logical.from) * factor);
  const nextPriceSpan = Math.max(Number.EPSILON, (price.to - price.from) * factor);
  chart.timeScale().setVisibleLogicalRange({
    from: xAnchor - nextLogicalSpan * xRatio,
    to: xAnchor + nextLogicalSpan * (1 - xRatio),
  });
  chart.priceScale('right').setVisibleRange({
    from: yAnchor - nextPriceSpan * (1 - yRatio),
    to: yAnchor + nextPriceSpan * yRatio,
  });
}
function getChartViewportSnapshot(chart: ReturnType<typeof createChart>, data: Array<{ close: number }>) {
  const logicalRange = chart.timeScale().getVisibleLogicalRange();
  const priceRange = chart.priceScale('right').getVisibleRange();
  const lastIndex = data.length - 1;
  const close = Number(data[lastIndex]?.close);
  if (!logicalRange || !priceRange || lastIndex < 0 || !Number.isFinite(close) || close <= 0) return null;
  return {
    bars: Math.max(1, Math.round(Number(logicalRange.to) - Number(logicalRange.from))),
    futureBars: Math.max(0, Math.round(Number(logicalRange.to) - lastIndex)),
    yBelow: Math.max(0, Math.round((close - Number(priceRange.from)) / close * 100)),
    yAbove: Math.max(0, Math.round((Number(priceRange.to) - close) / close * 100)),
  };
}
function mergeTickBar(bars: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>, time: number, price: number, intervalSeconds: number) {
  const bucket = Math.floor(time / intervalSeconds) * intervalSeconds as UTCTimestamp;
  const current = bars[bars.length - 1];
  if (current?.time === bucket) {
    return [...bars.slice(0, -1), { ...current, high: Math.max(current.high, price), low: Math.min(current.low, price), close: price }];
  }
  return [...bars, { time: bucket, open: price, high: price, low: price, close: price }];
}

type LiveBar = { time: UTCTimestamp; open: number; high: number; low: number; close: number };
type BinanceLivePrice = { symbol: string; price: number; time: number; receivedAt: number };
type EventConditionField = 'price.close' | 'price.open' | 'price.high' | 'price.low' | 'ssl.direction' | 'ssl.up' | 'ssl.down' | 'rsi.value' | 'tracker.h2' | 'tracker.h1' | 'tracker.l1' | 'tracker.l2';
type EventConditionOperator = 'equals' | 'not_equals' | 'less_than' | 'less_or_equal' | 'greater_than' | 'greater_or_equal' | 'crosses_above' | 'crosses_below';
type EventCondition = { field: EventConditionField; operator: EventConditionOperator; value: number | string };
type ChartEventRule = { id: string; symbol: string; name: string; logic: 'AND' | 'OR'; conditions: EventCondition[]; color: string; enabled: boolean; source: 'manual' | 'ai' };
type ChartEventOccurrence = { id: string; ruleId: string; symbol: string; timestamp: number; price: number; title: string; description: string; color: string };

function eventFieldValue(field: EventConditionField, bar: LiveBar, ssl: ReturnType<typeof calculateSslChannel>, rsi: Array<number | null>, tracker: ReturnType<typeof calculateTrackerLevels>, index: number): number | string | null {
  if (field === 'price.close') return bar.close; if (field === 'price.open') return bar.open; if (field === 'price.high') return bar.high; if (field === 'price.low') return bar.low;
  if (field === 'ssl.direction') return ssl.bullish[index] ? 'positive' : 'negative'; if (field === 'ssl.up') return ssl.up[index]; if (field === 'ssl.down') return ssl.down[index]; if (field === 'rsi.value') return rsi[index];
  const level = field.split('.')[1] as 'h2' | 'h1' | 'l1' | 'l2'; return tracker[index]?.[level] ?? null;
}
function eventOperand(value: number | string, bar: LiveBar, ssl: ReturnType<typeof calculateSslChannel>, rsi: Array<number | null>, tracker: ReturnType<typeof calculateTrackerLevels>, index: number) {
  if (typeof value === 'string' && EVENT_FIELDS.some(([field]) => field === value)) return eventFieldValue(value as EventConditionField, bar, ssl, rsi, tracker, index);
  return typeof value === 'number' ? value : Number(value);
}
function eventConditionMatches(condition: EventCondition, bar: LiveBar, previous: LiveBar | undefined, ssl: ReturnType<typeof calculateSslChannel>, rsi: Array<number | null>, tracker: ReturnType<typeof calculateTrackerLevels>, index: number) {
  const current = eventFieldValue(condition.field, bar, ssl, rsi, tracker, index); const previousValue = previous ? eventFieldValue(condition.field, previous, ssl, rsi, tracker, Math.max(0, index - 1)) : null; const target = eventOperand(condition.value, bar, ssl, rsi, tracker, index);
  if (current === null || target === null || (typeof current === 'number' && !Number.isFinite(current)) || (typeof target === 'number' && !Number.isFinite(target))) return false;
  if (condition.field === 'ssl.direction') { const left = String(current).toLowerCase(); const right = String(target).toLowerCase(); return condition.operator === 'equals' ? left === right : condition.operator === 'not_equals' ? left !== right : false; }
  const left = Number(current); const right = Number(target); if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (condition.operator === 'less_than') return left < right; if (condition.operator === 'less_or_equal') return left <= right; if (condition.operator === 'greater_than') return left > right; if (condition.operator === 'greater_or_equal') return left >= right; if (condition.operator === 'equals') return left === right; if (condition.operator === 'not_equals') return left !== right;
  const before = previousValue === null ? left : Number(previousValue); if (!Number.isFinite(before)) return false; return condition.operator === 'crosses_above' ? before <= right && left > right : before >= right && left < right;
}

const EVENT_FIELDS: Array<[EventConditionField, string]> = [['price.close', 'Precio cierre'], ['price.open', 'Precio apertura'], ['price.high', 'Máximo'], ['price.low', 'Mínimo'], ['ssl.direction', 'SSL dirección'], ['ssl.up', 'SSL arriba'], ['ssl.down', 'SSL abajo'], ['rsi.value', 'RSI'], ['tracker.h2', 'Tracker H2'], ['tracker.h1', 'Tracker H1'], ['tracker.l1', 'Tracker L1'], ['tracker.l2', 'Tracker L2']];
const EVENT_OPERATORS: Array<[EventConditionOperator, string]> = [['less_than', '< menor que'], ['less_or_equal', '≤ menor/igual'], ['greater_than', '> mayor que'], ['greater_or_equal', '≥ mayor/igual'], ['equals', '= igual'], ['not_equals', '≠ distinto'], ['crosses_above', 'cruza arriba'], ['crosses_below', 'cruza abajo']];

function EventMarkersPanel({ activeSymbol, apiUrl, accessToken, rules, occurrences, onChange, onDeleteOccurrence, onClose }: { activeSymbol: string; apiUrl: string; accessToken: string | null; rules: ChartEventRule[]; occurrences: ChartEventOccurrence[]; onChange: (rules: ChartEventRule[]) => void; onDeleteOccurrence: (id: string) => void; onClose: () => void }) {
  const [name, setName] = useState('Condición de mercado'); const [field, setField] = useState<EventConditionField>('ssl.direction'); const [operator, setOperator] = useState<EventConditionOperator>('equals'); const [value, setValue] = useState('negative'); const [color, setColor] = useState('#f5b84b'); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const addRule = (rule: ChartEventRule) => onChange([...rules.filter(item => item.id !== rule.id), rule]);
  const toggleRule = (rule: ChartEventRule) => addRule({ ...rule, enabled: !rule.enabled });
  const disableAiRules = () => onChange(rules.map(rule => rule.symbol === activeSymbol && rule.source === 'ai' ? { ...rule, enabled: false } : rule));
  const deleteRule = (rule: ChartEventRule) => { onChange(rules.filter(item => item.id !== rule.id)); onDeleteOccurrence(rule.id); };
  const addManual = () => { if (!name.trim() || !value.trim()) return; addRule({ id: `rule-${Date.now()}`, symbol: activeSymbol, name: name.trim(), logic: 'AND', conditions: [{ field, operator, value: field === 'ssl.direction' ? value.trim().toLowerCase() : Number(value) }], color, enabled: true, source: 'manual' }); setMessage('Regla guardada. Se dibujará un marcador cuando cambie de falso a verdadero.'); };
  const askAi = async () => { if (!accessToken) return; setBusy(true); setMessage('La IA está leyendo el contexto de mercado…'); try { const response = await fetch(`${apiUrl}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ prompt: `Para ${activeSymbol}, crea hasta 5 reglas de eventos para evaluar con el contexto actual. Una regla debe dispararse por transición de falso a verdadero, no por hora. Condiciones flexibles como SSL negativo, precio menor que un nivel, RSI o Tracker. Devuelve SOLO JSON array válido, sin markdown: [{"name":"...","logic":"AND|OR","conditions":[{"field":"price.close|price.open|price.high|price.low|ssl.direction|ssl.up|ssl.down|rsi.value|tracker.h2|tracker.h1|tracker.l1|tracker.l2","operator":"equals|not_equals|less_than|less_or_equal|greater_than|greater_or_equal|crosses_above|crosses_below","value":"negative|positive|número|otro campo"}],"color":"#hex"}]. No inventes timestamps.` }) }); const payload = await response.json() as { content?: string; detail?: string }; if (!response.ok) throw new Error(payload.detail ?? 'La IA no respondió.'); const raw = payload.content?.match(/\[[\s\S]*\]/)?.[0]; const proposed = raw ? JSON.parse(raw) as Array<{ name?: string; logic?: 'AND' | 'OR'; conditions?: EventCondition[]; color?: string }> : []; const parsed = proposed.flatMap((item, index) => { const conditions = Array.isArray(item.conditions) ? item.conditions.filter(condition => EVENT_FIELDS.some(([key]) => key === condition.field) && EVENT_OPERATORS.some(([key]) => key === condition.operator) && condition.value !== undefined).slice(0, 5) : []; return item.name && conditions.length ? [{ id: `ai-rule-${Date.now()}-${index}`, symbol: activeSymbol, name: item.name.slice(0, 80), logic: item.logic === 'OR' ? 'OR' as const : 'AND' as const, conditions, color: /^#[0-9a-f]{6}$/i.test(item.color ?? '') ? item.color as string : '#a78bfa', enabled: true, source: 'ai' as const }] : []; }); if (!parsed.length) throw new Error('La IA no devolvió reglas válidas.'); onChange([...rules, ...parsed]); setMessage(`${parsed.length} regla(s) IA agregada(s).`); } catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudieron crear reglas con IA.'); } finally { setBusy(false); } };
  const symbolRules = rules.filter(rule => rule.symbol === activeSymbol); const symbolOccurrences = occurrences.filter(event => event.symbol === activeSymbol).slice(-20);
  return <div className="event-markers-backdrop" role="presentation" onClick={onClose}><section className="event-markers-panel" role="dialog" aria-modal="true" aria-label="Eventos condicionales" onClick={event => event.stopPropagation()}><div className="event-markers-head"><div><span className="positions-kicker">CHART · EVENTOS</span><h2>Eventos condicionales · {activeSymbol}</h2></div><button type="button" onClick={onClose} aria-label="Cerrar">×</button></div><p className="event-markers-help">Crea reglas con la información presente: SSL negativo, precio bajo un nivel, RSI o Tracker. El marcador aparece solo cuando la condición cruza a verdadera.</p><div className="event-markers-form"><label>Nombre<input value={name} onChange={event => setName(event.target.value)} /></label><label>Campo<select value={field} onChange={event => { const next = event.target.value as EventConditionField; setField(next); if (next === 'ssl.direction') setValue('negative'); }}>{EVENT_FIELDS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Operador<select value={operator} onChange={event => setOperator(event.target.value as EventConditionOperator)}>{EVENT_OPERATORS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Valor<input value={value} onChange={event => setValue(event.target.value)} placeholder="Ej. 0.235 o negative" /></label><label>Color<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label><button type="button" onClick={addManual}>Agregar regla</button><button type="button" className="event-markers-ai" onClick={() => void askAi()} disabled={busy || !accessToken}>{busy ? 'Analizando…' : 'Proponer reglas con IA'}</button></div>{message && <p className="event-markers-message">{message}</p>}<div className="event-markers-list">{symbolRules.map(rule => <div key={rule.id} className="event-marker-row"><span style={{ color: rule.color }}>◆</span><strong>{rule.name}</strong><small>{rule.conditions.map(condition => `${condition.field} ${condition.operator} ${condition.value}`).join(` ${rule.logic} `)} · {rule.source === 'ai' ? 'IA' : 'Manual'}</small><button type="button" onClick={() => onChange(rules.filter(item => item.id !== rule.id))} aria-label={`Eliminar ${rule.name}`}>×</button></div>)}{symbolOccurrences.map(event => <div key={event.id} className="event-marker-row"><span style={{ color: event.color }}>●</span><time>{new Date(event.timestamp * 1000).toLocaleString('es-MX')}</time><strong>{event.title}</strong><small>{event.description}</small><button type="button" onClick={() => onDeleteOccurrence(event.id)} aria-label="Eliminar marcador">×</button></div>)}</div></section></div>;
}

type TradingChatMessage = { role: 'user' | 'assistant'; content: string };
function TradingAgentChat({ activeSymbol, interval, apiUrl, accessToken }: { activeSymbol: string; interval: string; apiUrl: string; accessToken: string | null }) {
  const [open, setOpen] = useState(false); const [input, setInput] = useState(''); const [loading, setLoading] = useState(false); const [conversationId, setConversationId] = useState<string | null>(() => localStorage.getItem('helloworld-agent-conversation')); const [messages, setMessages] = useState<TradingChatMessage[]>([]); const [error, setError] = useState('');
  const send = async () => { const prompt = input.trim(); if (!prompt || loading || !accessToken) return; setInput(''); setError(''); setMessages(current => [...current, { role: 'user', content: prompt }]); setLoading(true); try { const response = await fetch(`${apiUrl}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ prompt: `[Contexto de trading actual: símbolo ${activeSymbol}, intervalo ${interval}. Usa las herramientas de lectura disponibles antes de responder si hace falta.]\n${prompt}`, conversation_id: conversationId }) }); const payload = await response.json() as { conversationId?: string; content?: string; detail?: string; confirmation?: unknown }; if (!response.ok) throw new Error(payload.detail ?? 'La IA no respondió.'); if (payload.conversationId) { setConversationId(payload.conversationId); localStorage.setItem('helloworld-agent-conversation', payload.conversationId); } setMessages(current => [...current, { role: 'assistant', content: payload.content || (payload.confirmation ? 'Preparé una acción. Revisa la confirmación en el flujo de operaciones.' : 'No recibí contenido.') }]); } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo conectar con la IA.'); } finally { setLoading(false); } };
  return <><button className="trading-agent-launcher" type="button" onClick={() => setOpen(true)} aria-label="Abrir asistente de trading" title="Asistente de trading">✦</button>{open && <div className="trading-agent-backdrop" role="presentation" onClick={() => setOpen(false)}><section className="trading-agent-panel" role="dialog" aria-modal="true" aria-label="Asistente de trading" onClick={event => event.stopPropagation()}><div className="trading-agent-head"><div><span className="positions-kicker">GM-AGENT · TRADING</span><h2>Asistente · {activeSymbol}</h2><small>Contexto {interval} · backtest, precio, SSL, RSI y Tracker</small></div><button type="button" onClick={() => setOpen(false)} aria-label="Cerrar">×</button></div><div className="trading-agent-messages">{messages.length === 0 && <p className="trading-agent-empty">Pregúntame por el contexto actual, una regla, una operación paper o un backtest de 7 días.</p>}{messages.map((message, index) => <div key={`${message.role}-${index}`} className={`trading-agent-message ${message.role}`}><b>{message.role === 'user' ? 'Tú' : 'GM Agent'}</b><p>{message.content}</p></div>)}{loading && <p className="trading-agent-loading">Analizando contexto…</p>}</div>{error && <p className="event-markers-message">{error}</p>}<form className="trading-agent-form" onSubmit={event => { event.preventDefault(); void send(); }}><input value={input} onChange={event => setInput(event.target.value)} placeholder="Pregúntale a la IA…" disabled={loading || !accessToken} aria-label="Mensaje para el asistente" /><button type="submit" disabled={loading || !input.trim() || !accessToken}>{loading ? '…' : 'Enviar'}</button></form></section></div>}</>;
}
function upsertLiveBar(bars: LiveBar[], next: LiveBar) {
  const last = bars[bars.length - 1];
  if (!last || next.time > last.time) {
    bars.push(next);
    return true;
  }
  if (last.time === next.time) {
    bars[bars.length - 1] = next;
    return false;
  }
  const index = bars.findIndex(bar => bar.time === next.time);
  if (index >= 0) bars[index] = next;
  return false;
}

function mergeBars(existing: LiveBar[], incoming: LiveBar[]) {
  const byTime = new Map<number, LiveBar>();
  existing.forEach(bar => byTime.set(Number(bar.time), bar));
  incoming.forEach(bar => byTime.set(Number(bar.time), bar));
  return [...byTime.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

function createBinanceKlineStream(symbol: string, interval: string) {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let stopped = false;
  let delay = 1000;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  const controller = {
    set onmessage(handler: (event: MessageEvent) => void) { messageHandler = handler; },
    close() {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
  };
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(`${marketWsUrl}/market/binance/stream/${encodeURIComponent(symbol)}`);
    socket.onopen = () => { delay = 1000; };
    socket.onmessage = event => messageHandler?.(event);
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      reconnectTimer = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };
  connect();
  return controller;
}

type BinanceAccountStreamSubscriber = { onAccount: (account: BinanceAccount) => void; onIntents?: (intents: unknown) => void };
type BinanceAccountStreamEntry = {
  subscribers: Set<BinanceAccountStreamSubscriber>;
  latestAccount?: BinanceAccount;
  latestIntents?: unknown;
  close: () => void;
};
const binanceAccountStreams = new Map<string, BinanceAccountStreamEntry>();

function createBinanceAccountStream(accessToken: string, onAccount: (account: BinanceAccount) => void, onIntents?: (intents: unknown) => void) {
  let entry = binanceAccountStreams.get(accessToken);
  let startStream: (() => void) | null = null;
  if (!entry) {
    const subscribers = new Set<BinanceAccountStreamSubscriber>();
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let watchdogTimer: number | null = null;
    let lastMessageAt = Date.now();
    let stopped = false;
    let delay = 1000;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(`${marketWsUrl}/trading/binance/stream?access_token=${encodeURIComponent(accessToken)}`);
      lastMessageAt = Date.now();
      socket.onopen = () => { delay = 1000; };
      socket.onmessage = event => {
        lastMessageAt = Date.now();
        try {
          const payload = JSON.parse(event.data) as { type?: string; snapshot?: BinanceAccount; execution_intents?: unknown };
          if (payload.snapshot) entry!.latestAccount = payload.snapshot;
          if (payload.execution_intents) entry!.latestIntents = payload.execution_intents;
          subscribers.forEach(subscriber => {
            if (payload.snapshot) subscriber.onAccount(payload.snapshot);
            if (payload.execution_intents) subscriber.onIntents?.(payload.execution_intents);
          });
        } catch { /* Ignore malformed frames and keep the stream alive. */ }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        socket = null;
        if (stopped || subscribers.size === 0) return;
        reconnectTimer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
      if (watchdogTimer === null) {
        watchdogTimer = window.setInterval(() => {
          if (socket && Date.now() - lastMessageAt > 35_000) socket.close();
        }, 5_000);
      }
    };
    entry = {
      subscribers,
      close: () => { stopped = true; if (reconnectTimer !== null) window.clearTimeout(reconnectTimer); if (watchdogTimer !== null) window.clearInterval(watchdogTimer); socket?.close(); socket = null; binanceAccountStreams.delete(accessToken); },
    };
    binanceAccountStreams.set(accessToken, entry);
    startStream = connect;
  }
  const subscriber = { onAccount, onIntents };
  entry.subscribers.add(subscriber);
  // The shared socket may already have received the initial snapshot before
  // this component mounted. Replay it synchronously so tables/cards never
  // disagree about the same live Binance account.
  if (entry.latestAccount) onAccount(entry.latestAccount);
  if (entry.latestIntents) onIntents?.(entry.latestIntents);
  // Start only after the first subscriber is registered, avoiding a race
  // where a very fast snapshot arrives before there is a listener.
  startStream?.();
  return () => {
    entry?.subscribers.delete(subscriber);
    if (entry && entry.subscribers.size === 0) entry.close();
  };
}

// Broker contract limits used by paper trading until live symbol metadata is
// available. The effective paper leverage is always the lower of the Lab
// recommendation and this broker/symbol limit.
const SYMBOL_MAX_LEVERAGE: Record<string, number> = {
  'binance:BTCUSDT': 125, 'binance:ETHUSDT': 100, 'binance:BNBUSDT': 75,
  'binance:SOLUSDT': 100, 'binance:XRPUSDT': 75, 'binance:DOGEUSDT': 75,
  'ctrader:AUDUSD': 30, 'ctrader:XAUUSD': 20, 'ctrader:XAGUSD': 20,
};

function maxLeverageFor(broker: 'binance' | 'ctrader', symbol: string) {
  return SYMBOL_MAX_LEVERAGE[`${broker}:${symbol}`] ?? (broker === 'binance' ? 20 : 10);
}

function formatPaperPrice(price: number) {
  const absolute = Math.abs(price);
  if (absolute > 0 && absolute < 0.001) {
    return price.toExponential(4).replace(/\.?(\d*?[1-9])0+e/, '$1e').replace(/e([+-])0+(\d+)/, 'e$1$2');
  }
  const decimals = absolute >= 1000 ? 2 : absolute >= 1 ? 5 : 8;
  return price.toFixed(decimals).replace(/\.?0+$/, '');
}

function formatBinanceUpdateTime(value?: string | null) {
  if (!value) return '—';
  const updated = new Date(value);
  if (!Number.isFinite(updated.getTime())) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - updated.getTime()) / 1000));
  const time = updated.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
  if (seconds < 60) return `${time} · hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${time} · hace ${minutes} min`;
}

type BinanceSymbolRules = { price_precision: number; quantity_precision: number; tick_size: number; step_size: number; min_qty: number; min_notional: number };
function roundToBinance(value: number, step: number, precision: number) {
  if (!Number.isFinite(value)) return 0;
  const rounded = step > 0 ? Math.floor((value + step * 1e-9) / step) * step : value;
  return Number(rounded.toFixed(Math.max(0, precision)));
}
function roundUpToBinance(value: number, step: number, precision: number) {
  if (!Number.isFinite(value)) return 0;
  const rounded = step > 0 ? Math.ceil((value - step * 1e-9) / step) * step : value;
  return Number(rounded.toFixed(Math.max(0, precision)));
}

type CTraderCandleRow = { timestamp: number; low: number; delta_open: number; delta_high: number; delta_close: number };
function parseCTraderCandles(payload: unknown): Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> {
  const rows = (payload as { data?: CTraderCandleRow[] })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    time: Math.floor(Number(row.timestamp) * 60) as UTCTimestamp,
    low: Number(row.low),
    open: Number(row.low) + Number(row.delta_open),
    high: Number(row.low) + Number(row.delta_high),
    close: Number(row.low) + Number(row.delta_close),
  })).filter(row => Number.isFinite(Number(row.time)) && Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
}

const SESSION_TIMEZONE = 'America/Mexico_City';
const MARKET_SESSIONS = [
  { name: 'Tokyo', open: 18, close: 3, color: '#f59e0b' },
  { name: 'London', open: 2, close: 11, color: '#22c55e' },
  { name: 'New York', open: 7, close: 16, color: '#ef4444' },
  { name: 'Sydney', open: 16, close: 1, color: '#a855f7' },
];
const TIMEZONES = [
  ['Ciudad de México', 'America/Mexico_City'], ['UTC', 'UTC'], ['Nueva York', 'America/New_York'],
  ['Chicago', 'America/Chicago'], ['Los Ángeles', 'America/Los_Angeles'], ['Londres', 'Europe/London'],
  ['Madrid', 'Europe/Madrid'], ['Tokio', 'Asia/Tokyo'], ['Sídney', 'Australia/Sydney'],
] as const;

function timeNumber(time: unknown) {
  if (typeof time === 'number') return time;
  if (time && typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time) {
    const value = time as { year: number; month: number; day: number };
    return Date.UTC(value.year, value.month - 1, value.day) / 1000;
  }
  return 0;
}

function timezoneParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp * 1000));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

/**
 * Converts a wall-clock time in `timezone` to the UTC epoch used by the
 * chart. Lightweight Charts expects numeric times to always be UTC seconds;
 * passing the local hour as a timestamp shifts session lines by the zone
 * offset (for example, 07:00 becomes 13:00 in Mexico City).
 */
function timestampInTimezone(year: number, month: number, day: number, hour: number, timezone: string) {
  const wallClock = Date.UTC(year, month - 1, day, hour, 0, 0);
  const parts = timezoneParts(wallClock / 1000, timezone);
  const representedWallClock = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  const timezoneOffset = representedWallClock - wallClock;
  return Math.round((wallClock - timezoneOffset) / 1000);
}

function chartTimeLabel(time: Time, timezone: string, detailed: boolean) {
  const options: Intl.DateTimeFormatOptions = detailed
    ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: timezone }).format(new Date(timeNumber(time) * 1000));
}

function sessionDateLabel(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone: timezone, weekday: 'long', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const month = (values.month ?? '').replace('.', '').toLowerCase();
  return `${(values.weekday ?? '').toLowerCase()} ${values.hour ?? ''}:${values.minute ?? ''} ${values.day ?? ''} de ${month}`;
}

function useMobilePwa() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px), (display-mode: standalone)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px), (display-mode: standalone)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

function MobileSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="mobile-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <div className="mobile-sheet-head"><h2>{title}</h2><button onClick={onClose} aria-label="Cerrar">×</button></div>
      {children}
    </section>
  </div>;
}

function IndicatorSettingsModal({
  showSessions, showSevenAmMarkers, showRsi, showSsl, showTracker, showWickExtensions, rsiPeriod, rsiLowBand, rsiHighBand, sslPeriod, trackerPeriod, wickPeriod, wickDisplayPeriod, wickMultiplier, onClose, onSessions, onSevenAmMarkers, onRsi, onSsl, onTracker, onWickExtensions, onRsiPeriod, onRsiLowBand, onRsiHighBand, onSslPeriod, onTrackerPeriod, onWickPeriod, onWickDisplayPeriod, onWickMultiplier,
}: { showSessions: boolean; showSevenAmMarkers: boolean; showRsi: boolean; showSsl: boolean; showTracker: boolean; showWickExtensions: boolean; rsiPeriod: number; rsiLowBand: number; rsiHighBand: number; sslPeriod: number; trackerPeriod: number; wickPeriod: number; wickDisplayPeriod: number; wickMultiplier: number; onClose: () => void; onSessions: () => void; onSevenAmMarkers: () => void; onRsi: () => void; onSsl: () => void; onTracker: () => void; onWickExtensions: () => void; onRsiPeriod: (value: number) => void; onRsiLowBand: (value: number) => void; onRsiHighBand: (value: number) => void; onSslPeriod: (value: number) => void; onTrackerPeriod: (value: number) => void; onWickPeriod: (value: number) => void; onWickDisplayPeriod: (value: number) => void; onWickMultiplier: (value: number) => void }) {
  const row = (label: string, description: string, active: boolean, toggle: () => void, period?: number, setPeriod?: (value: number) => void) => <>{<div className="indicator-setting-row"><button className={`indicator-toggle ${active ? 'indicator-toggle-active' : ''}`} onClick={toggle} aria-pressed={active}><span className="indicator-check">{active ? '✓' : ''}</span><span><b>{label}</b><small>{description}</small></span></button>{period !== undefined && setPeriod && <label className="indicator-period">Periodo<input type="number" min="2" max="200" value={period} onChange={event => setPeriod(Math.max(2, Math.min(200, Number(event.target.value) || 2)))} /></label>}</div>}{label === 'Sesiones de mercado' && <div className="indicator-setting-row"><button className={`indicator-toggle ${showSevenAmMarkers ? 'indicator-toggle-active' : ''}`} onClick={onSevenAmMarkers} aria-pressed={showSevenAmMarkers}><span className="indicator-check">{showSevenAmMarkers ? '✓' : ''}</span><span><b>Marcadores 7 AM</b><small>Ventana diaria 07:20–07:35 · Ciudad de México</small></span></button></div>}</>;
  return <div className="indicator-modal-backdrop" role="presentation" onClick={onClose}><section className="indicator-modal" role="dialog" aria-modal="true" aria-label="Indicadores" onClick={event => event.stopPropagation()}><div className="indicator-modal-head"><div><span className="eyebrow">CHART · INDICATORS</span><h2>Indicadores</h2></div><button onClick={onClose} aria-label="Cerrar">×</button></div><p className="indicator-modal-help">Activa los indicadores que se dibujan directamente sobre el precio. La configuración se conserva por usuario.</p>{row('Sesiones de mercado', 'Tokyo, Londres, Nueva York y Sydney', showSessions, onSessions)}{row('RSI', 'Solo marca valores fuera de las bandas', showRsi, onRsi, rsiPeriod, onRsiPeriod)}{showRsi && <div className="indicator-band-row"><label>Low band<input type="number" min="1" max="49" value={rsiLowBand} onChange={event => onRsiLowBand(Math.max(1, Math.min(49, Number(event.target.value) || 1)))} /></label><label>High band<input type="number" min="51" max="99" value={rsiHighBand} onChange={event => onRsiHighBand(Math.max(51, Math.min(99, Number(event.target.value) || 99)))} /></label></div>}{row('SSL Channel', 'Canal dinámico sobre el precio', showSsl, onSsl, sslPeriod, onSslPeriod)}{row('Tracker', 'Price lines H2 · H1 · L1 · L2', showTracker, onTracker)}{showTracker && <div className="indicator-band-row"><label>Periodo (N velas)<input type="number" min="1" max="50" value={trackerPeriod} onChange={event => onTrackerPeriod(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} /></label><span className="indicator-modal-help">Cada vela fija sus niveles usando las N anteriores</span></div>}{row('Extensiones de mechazo', 'Puntos Long/Short según las mechas contrarias', showWickExtensions, onWickExtensions, wickPeriod, onWickPeriod)}{showWickExtensions && <div className="indicator-band-row"><label>Velas visibles<input type="number" min="1" max="300" value={wickDisplayPeriod} onChange={event => onWickDisplayPeriod(Math.max(1, Math.min(300, Number(event.target.value) || 1)))} /></label><label>Multiplicador<input type="number" min="0" max="10" step="0.1" value={wickMultiplier} onChange={event => onWickMultiplier(Math.max(0, Math.min(10, Number(event.target.value) || 0)))} /></label><span className="indicator-modal-help">Muestra los puntos de las velas más recientes</span></div>}<button className="indicator-modal-done" onClick={onClose}>Listo</button></section></div>;
}

function RiskEngineModal({ onClose }: { onClose: () => void }) {
  const [balance, setBalance] = useState(100);
  const [riskPercent, setRiskPercent] = useState(1);
  const [maePercent, setMaePercent] = useState(.2);
  const [mfePercent, setMfePercent] = useState(3);
  const [leverage, setLeverage] = useState(20);
  const [feePercent, setFeePercent] = useState(.04);
  const risk = balance * riskPercent / 100;
  const notional = maePercent > 0 ? risk / (maePercent / 100) : 0;
  const margin = leverage > 0 ? notional / leverage : 0;
  const sl = notional * maePercent / 100;
  const mfe = notional * mfePercent / 100;
  const fees = notional * feePercent / 100 * 2;
  const netWin = mfe - fees;
  const netLoss = sl + fees;
  const field = (label: string, value: number, min: number, max: number, step: number, setValue: (next: number) => void, suffix: string) => <label className="risk-engine-field"><span>{label}<b>{value.toFixed(step < 1 ? 2 : 0)}{suffix}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={event => setValue(Number(event.target.value))} /></label>;
  return <div className="risk-engine-backdrop" role="presentation" onClick={onClose}><section className="risk-engine-modal" role="dialog" aria-modal="true" aria-label="Risk Engine" onClick={event => event.stopPropagation()}><div className="risk-engine-head"><div><span className="positions-kicker">RISK ENGINE · SIMULADOR</span><h2>Relación de riesgo</h2></div><button type="button" onClick={onClose} aria-label="Cerrar">×</button></div><p className="risk-engine-help">Mueve una palanca y observa cómo cambia automáticamente toda la ecuación.</p><div className="risk-engine-controls">{field('Balance', balance, 10, 10000, 10, setBalance, ' USDT')}{field('Riesgo', riskPercent, .1, 5, .1, setRiskPercent, '%')}{field('MAE', maePercent, .05, 5, .05, setMaePercent, '%')}{field('MFE', mfePercent, .1, 20, .1, setMfePercent, '%')}{field('Leverage', leverage, 1, 125, 1, setLeverage, 'x')}{field('Fee por lado', feePercent, 0, .2, .01, setFeePercent, '%')}</div><div className="risk-engine-equation"><span>Riesgo $ <b>{risk.toFixed(2)}</b></span><span>Notional <b>{notional.toFixed(2)}</b></span><span>Margin <b>{margin.toFixed(2)}</b></span><span>Fees ida/vuelta <b>{fees.toFixed(2)}</b></span><span className="risk-engine-loss">Pérdida SL <b>-{netLoss.toFixed(2)}</b></span><span className="risk-engine-profit">Ganancia MFE <b>+{netWin.toFixed(2)}</b></span></div><pre className="risk-engine-formula">{`Notional = Riesgo ÷ MAE\nMargin = Notional ÷ Leverage\nMFE $ = Notional × MFE\nExpectancy depende de MFE, MAE, fees y winrate`}</pre></section></div>;
}

type BinancePosition = {
  symbol?: string; side?: string; quantity?: string; size?: string; entry_price?: string;
  mark_price?: string; unrealized_pnl?: string; liquidation_price?: string;
  notional?: string; isolated_margin?: string; leverage?: string; margin_type?: string; isolated_wallet?: string;
};
type BinanceAccount = {
  enabled?: boolean; healthy?: boolean; stream_connected?: boolean;
  state_seq?: number;
  last_update?: string; last_event?: string; error?: string | null;
  error_kind?: string | null; error_title?: string | null; error_message?: string | null; error_action?: string | null;
  wallet_balance?: string | null; futures_balance?: string | number | null; available_balance?: string | null;
  total_unrealized_pnl?: string | null; positions?: BinancePosition[];
  events?: Array<{ time?: string; type?: string; symbol?: string; status?: string }>;
};
function acceptBinanceAccount(current: BinanceAccount | null, next: BinanceAccount): BinanceAccount {
  // Frames on one WebSocket arrive in order. A backend redeploy resets the
  // process-local state_seq, so rejecting a lower sequence here can preserve
  // an old balance forever after reconnecting to the new monitor instance.
  return { ...next, state_seq: next.state_seq ?? current?.state_seq };
}
type BinanceExecutionIntent = { id?: string; symbol?: string; side?: string; quantity?: number | string; entry_time?: number | string; entry_price?: number; stop_loss?: number; take_profit?: number; status?: string; created_at?: string };
type BinanceSymbolConfig = { configured?: boolean; symbol?: string; margin_type?: string | null; leverage?: number | null; isolated_balance?: number | null; futures_balance?: number | string | null; error?: string | null };
type CTraderAccount = {
  enabled?: boolean; configured?: boolean; healthy?: boolean; stream_connected?: boolean;
  account_id?: number | string | null; trader_login?: number | string | null; balance?: number | null; money_digits?: number | null; broker?: string | null;
  symbols?: string[]; error_kind?: string | null;
  accounts?: Array<{ account_id: number; broker?: string; is_live?: boolean }>;
  error_title?: string | null; error_message?: string | null; error_action?: string | null;
  last_tick?: { symbol?: string; bid?: number; ask?: number; price?: number; time?: number } | null;
};

function BalanceSummary({ paperBalance, revision = 0 }: { paperBalance: number; revision?: number }) {
  const auth = useAuth();
  const [binance, setBinance] = useState<BinanceAccount | null>(null);
  const [ctrader, setCtrader] = useState<CTraderAccount | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const headers: Record<string, string> = auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {};
      const ctraderResponse = await fetch(`${apiUrl}/trading/ctrader`, { headers, credentials: 'include' });
      if (!active) return;
      if (ctraderResponse.ok) setCtrader(await ctraderResponse.json() as CTraderAccount);
    };
    void load();
    const closeStream = auth.accessToken ? createBinanceAccountStream(auth.accessToken, account => {
      if (active) setBinance(current => acceptBinanceAccount(current, account));
    }) : () => undefined;
    return () => { active = false; closeStream(); };
  }, [auth.accessToken, revision]);
  return <section className="balances-panel" aria-label="Balances"><div className="positions-panel-head"><div><span className="positions-kicker">ACCOUNT SUMMARY</span><h2>Balances</h2></div></div><div className="balances-table-wrap"><table className="balances-table"><thead><tr><th>Cuenta</th><th>Balance</th><th>Estado</th></tr></thead><tbody><tr><td>Paper</td><td>{paperBalance.toFixed(2)} USD</td><td><span className="stream-badge stream-good">Simulado</span></td></tr><tr><td>Binance</td><td>{binance?.futures_balance ?? '—'}</td><td><span className={`stream-badge ${binance?.healthy ? 'stream-good' : 'stream-bad'}`}>{binance?.healthy ? 'Saludable' : 'Sin conexión'}</span></td></tr><tr><td>cTrader</td><td>{ctrader?.balance == null ? '—' : `${ctrader.balance.toFixed(ctrader.money_digits ?? 2)} USD`}</td><td><span className={`stream-badge ${ctrader?.healthy ? 'stream-good' : 'stream-bad'}`}>{ctrader?.healthy ? 'Saludable' : 'Sin conexión'}</span></td></tr></tbody></table></div></section>;
}

function ProfileModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const auth = useAuth();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [status, setStatus] = useState<{ configured: boolean; masked_api_key?: string | null; updated_at?: string | null } | null>(null);
  const [ctraderAccessToken, setCtraderAccessToken] = useState('');
  const [ctraderRefreshToken, setCtraderRefreshToken] = useState('');
  const [ctraderAccountId, setCtraderAccountId] = useState('');
  const [ctraderStatus, setCtraderStatus] = useState<{ configured: boolean; enabled?: boolean; account_id?: string | null; accounts?: Array<{ account_id: number; broker?: string; is_live?: boolean }>; updated_at?: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const headers: Record<string, string> = auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {};

  useEffect(() => {
    let active = true;
    fetch(`${apiUrl}/trading/binance/credentials`, { headers, credentials: 'include' })
      .then(async response => { if (!response.ok) throw new Error('No se pudo consultar tu perfil.'); return response.json() as Promise<{ configured: boolean; masked_api_key?: string | null; updated_at?: string | null }>; })
      .then(payload => { if (active) setStatus(payload); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'No se pudo consultar tu perfil.'); })
      .finally(() => { if (active) setLoading(false); });
    fetch(`${apiUrl}/trading/ctrader/credentials`, { headers, credentials: 'include' })
      .then(async response => { if (!response.ok) throw new Error('No se pudo consultar cTrader.'); return response.json() as Promise<typeof ctraderStatus>; })
      .then(payload => { if (active) setCtraderStatus(payload); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [auth.accessToken]);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/binance/credentials`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }) });
      const payload = await response.json() as { detail?: string; message?: string; configured?: boolean; masked_api_key?: string };
      if (!response.ok) throw new Error(payload.detail ?? 'No se pudieron guardar las credenciales.');
      setStatus(payload as typeof status); setApiKey(''); setApiSecret(''); setMessage('Credenciales guardadas. El monitor comenzará a validar la conexión.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron guardar las credenciales.'); }
    finally { setSaving(false); }
  }

  async function remove() {
    setRemoving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/binance/credentials`, { method: 'DELETE', headers, credentials: 'include' });
      if (!response.ok) throw new Error('No se pudieron eliminar las credenciales.');
      setStatus({ configured: false }); setMessage('Credenciales eliminadas.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron eliminar las credenciales.'); }
    finally { setRemoving(false); }
  }

  async function saveCtrader(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/ctrader/credentials`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ access_token: ctraderAccessToken, refresh_token: ctraderRefreshToken, account_id: Number(ctraderAccountId) || 0 }) });
      const payload = await response.json() as { detail?: string; message?: string; configured?: boolean; account_id?: string; accounts?: Array<{ account_id: number; broker?: string; is_live?: boolean }> };
      if (!response.ok) throw new Error(payload.detail ?? 'No se pudieron guardar las credenciales cTrader.');
      setCtraderStatus(payload as typeof ctraderStatus); setCtraderAccessToken(''); setCtraderRefreshToken(''); setCtraderAccountId(''); setMessage(payload.message ?? 'Credenciales cTrader guardadas.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron guardar las credenciales cTrader.'); }
    finally { setSaving(false); }
  }

  async function removeCtrader() {
    setRemoving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/ctrader/credentials`, { method: 'DELETE', headers, credentials: 'include' });
      if (!response.ok) throw new Error('No se pudieron eliminar las credenciales cTrader.');
      setCtraderStatus({ configured: false }); setMessage('Credenciales cTrader eliminadas.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron eliminar las credenciales cTrader.'); }
    finally { setRemoving(false); }
  }

  async function connectCtrader() {
    setSaving(true); setError('');
    try {
      const response = await fetch(`${apiUrl}/trading/ctrader/oauth/url`, { headers, credentials: 'include' });
      const payload = await response.json() as { url?: string; detail?: string };
      if (!response.ok || !payload.url) throw new Error(payload.detail ?? 'No se pudo iniciar la autorización cTrader.');
      window.location.assign(payload.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo iniciar la autorización cTrader.');
      setSaving(false);
    }
  }

  return <div className="profile-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title" onClick={event => event.stopPropagation()}>
      <div className="profile-modal-head"><div><span className="positions-kicker">CUENTA</span><h2 id="profile-title">Perfil</h2></div><button onClick={onClose} aria-label="Cerrar">×</button></div>
      <div className="profile-identity"><span className="profile-avatar profile-avatar-large">{(auth.identity?.name ?? auth.identity?.email ?? 'U').slice(0, 1).toUpperCase()}</span><div><strong>{auth.identity?.name ?? 'Usuario'}</strong><small>{auth.identity?.email ?? ''}</small></div></div>
      <div className="profile-section"><span className="positions-kicker">BINANCE · FUTURES</span><p className="profile-note">Tus claves son por usuario, se cifran en el backend y nunca se muestran de nuevo. Usa una key sin permisos de retiro y limita su IP.</p>{loading ? <p className="profile-muted">Consultando configuración…</p> : status?.configured ? <p className="profile-configured">Configurada · {status.masked_api_key}</p> : <p className="profile-muted">Aún no hay credenciales configuradas.</p>}</div>
      <form className="profile-form" onSubmit={save}><label className="profile-field"><span>API key</span><input type="text" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" placeholder={status?.configured ? 'Reemplazar API key' : 'Pega tu API key'} required /></label><label className="profile-field"><span>API secret</span><input type="password" value={apiSecret} onChange={event => setApiSecret(event.target.value)} autoComplete="new-password" placeholder="Pega tu API secret" required /></label>{error && <p className="profile-error" role="alert">{error}</p>}{message && <p className="profile-success" role="status">{message}</p>}<div className="profile-actions"><button className="profile-save" type="submit" disabled={saving || removing}>{saving ? 'Guardando…' : 'Guardar credenciales'}</button>{status?.configured && <button className="profile-remove" type="button" onClick={() => void remove()} disabled={saving || removing}>{removing ? 'Eliminando…' : 'Eliminar claves'}</button>}</div></form>
      <div className="profile-section profile-broker-section"><span className="positions-kicker">cTRADER · FOREX</span><p className="profile-note">El client ID y secreto de la aplicación permanecen en el backend. Aquí sólo se guardan tus tokens OAuth y el account ID, cifrados por usuario.</p>{!ctraderStatus?.enabled ? <p className="profile-muted">cTrader aún no está habilitado en este entorno.</p> : ctraderStatus.configured ? <p className="profile-configured">Configurada · cuenta {ctraderStatus.account_id ?? '—'}</p> : <p className="profile-muted">Aún no hay una cuenta cTrader configurada.</p>}</div>
      <div className="profile-actions"><button className="profile-save" type="button" onClick={() => void connectCtrader()} disabled={saving || removing || !ctraderStatus?.enabled}>{saving ? 'Abriendo cTrader…' : 'Conectar con cTrader'}</button></div>
      <p className="profile-note">También puedes pegar tokens manualmente:</p><form className="profile-form" onSubmit={saveCtrader}><label className="profile-field"><span>Access token</span><input type="password" value={ctraderAccessToken} onChange={event => setCtraderAccessToken(event.target.value)} autoComplete="off" placeholder="Pega tu access token" /></label><label className="profile-field"><span>Refresh token</span><input type="password" value={ctraderRefreshToken} onChange={event => setCtraderRefreshToken(event.target.value)} autoComplete="off" placeholder="Pega tu refresh token" /></label><label className="profile-field"><span>Account ID <small>(opcional; se autodetecta)</small></span><input type="number" value={ctraderAccountId} onChange={event => setCtraderAccountId(event.target.value)} placeholder="Se seleccionará la primera cuenta autorizada" /></label>{ctraderStatus?.accounts?.length ? <p className="profile-configured">Cuentas detectadas: {ctraderStatus.accounts.map(account => `${account.broker || 'cTrader'} · ${account.is_live ? 'Live' : 'Demo'} · ${account.account_id}`).join(' · ')}</p> : null}{error && <p className="profile-error" role="alert">{error}</p>}{message && <p className="profile-success" role="status">{message}</p>}<div className="profile-actions"><button className="profile-save" type="submit" disabled={saving || removing || !ctraderStatus?.enabled}>{saving ? 'Guardando…' : 'Guardar tokens manualmente'}</button>{ctraderStatus?.configured && <button className="profile-remove" type="button" onClick={() => void removeCtrader()} disabled={saving || removing}>{removing ? 'Eliminando…' : 'Eliminar cTrader'}</button>}</div></form>
    </section>
  </div>;
}

function BinanceAccountPanel({ revision = 0 }: { revision?: number }) {
  const auth = useAuth();
  const [account, setAccount] = useState<BinanceAccount | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const closeStream = auth.accessToken ? createBinanceAccountStream(auth.accessToken, payload => {
      if (active) { setAccount(current => acceptBinanceAccount(current, payload)); setLoading(false); }
    }) : () => undefined;
    return () => { active = false; closeStream(); };
  }, [auth.accessToken, revision]);
  const online = Boolean(account?.healthy && account?.stream_connected);
  return <section className="binance-account-panel" aria-label="Estado de Binance">
    <div className="binance-panel-head"><div><span className="positions-kicker">BINANCE · CUENTA</span><h2>Estado de Binance</h2></div><span className={`stream-badge ${online ? 'stream-good' : 'stream-bad'}`}>{loading ? 'Consultando…' : online ? 'Saludable · User Stream' : 'Sin conexión'}</span></div>
    {account?.error && <div className="binance-error" role="status"><strong>{account.error_title ?? 'Binance no está disponible'}</strong><span>{account.error_message ?? account.error}</span>{account.error_action && <small>Qué hacer: {account.error_action}</small>}<em>El monitor seguirá reintentando automáticamente.</em></div>}
    <div className="binance-metrics"><div><small>Saldo Futures</small><strong>{account?.futures_balance ?? '—'}</strong></div><div><small>Wallet</small><strong>{account?.wallet_balance ?? '—'}</strong></div><div><small>Disponible</small><strong>{account?.available_balance ?? '—'}</strong></div><div><small>PNL no realizado</small><strong>{account?.total_unrealized_pnl ?? '—'}</strong></div><div><small>Última actualización</small><strong>{formatBinanceUpdateTime(account?.last_update)}</strong></div></div>
    <h3>Posiciones de Binance</h3>
    <div className="positions-table-scroll"><table className="positions-table binance-table"><thead><tr><th>Símbolo</th><th>Lado</th><th>Cantidad</th><th>Entrada</th><th>Mark</th><th>UPNL</th></tr></thead><tbody>{account?.positions?.length ? account.positions.map((position, index) => <tr key={`${position.symbol}-${index}`}><td>{position.symbol ?? '—'}</td><td className={position.side === 'LONG' ? 'value-positive' : 'value-negative'}>{position.side ?? '—'}</td><td>{position.quantity ?? '—'}</td><td>{position.entry_price ?? '—'}</td><td>{position.mark_price ?? '—'}</td><td>{position.unrealized_pnl ?? '—'}</td></tr>) : <tr><td colSpan={6}>Sin posiciones abiertas</td></tr>}</tbody></table></div>
    <h3>Últimos eventos del User Stream</h3>
    <div className="binance-events">{account?.events?.length ? account.events.slice(-5).reverse().map((event, index) => <div key={`${event.time}-${index}`}><span>{event.time ? new Date(event.time).toLocaleTimeString() : '—'}</span>{event.type ?? 'evento'} · {event.symbol ?? ''} · {event.status ?? ''}</div>) : 'Sin eventos recientes'}</div>
  </section>;
}

function CTraderAccountPanel({ revision = 0 }: { revision?: number }) {
  const auth = useAuth();
  const [account, setAccount] = useState<CTraderAccount | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/trading/ctrader`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' });
        if (!response.ok) throw new Error(`cTrader ${response.status}`);
        const payload = await response.json() as CTraderAccount;
        if (active) setAccount(payload);
      } catch {
        if (active) setAccount({ enabled: true, healthy: false, error_kind: 'UNAVAILABLE', error_title: 'cTrader no está disponible', error_message: 'No fue posible consultar el monitor cTrader.' });
      } finally { if (active) setLoading(false); }
    };
    void load();
    const closeStream = auth.accessToken ? createBinanceAccountStream(auth.accessToken, payload => {
      if (active) setAccount(payload);
    }) : () => undefined;
    return () => { active = false; closeStream(); };
  }, [auth.accessToken, revision]);
  const online = Boolean(account?.healthy && account?.stream_connected);
  return <section className="binance-account-panel ctrader-account-panel" aria-label="Estado de cTrader">
    <div className="binance-panel-head"><div><span className="positions-kicker">cTRADER · FOREX</span><h2>Estado de cTrader</h2></div><span className={`stream-badge ${online ? 'stream-good' : 'stream-bad'}`}>{loading ? 'Consultando…' : online ? 'Saludable · Stream' : 'Sin conexión'}</span></div>
    {account?.error_message && <div className="binance-error" role="status"><strong>{account.error_title ?? 'cTrader no está disponible'}</strong><span>{account.error_message}</span>{account.error_action && <small>Qué hacer: {account.error_action}</small>}<em>El monitor seguirá reintentando automáticamente.</em></div>}
    <div className="binance-metrics"><div><small>Cuenta broker</small><strong>{account?.trader_login ?? '—'}</strong></div><div><small>ID interno cTrader</small><strong>{account?.account_id ?? '—'}</strong></div><div><small>Balance cTrader</small><strong>{account?.balance == null ? '—' : `${account.balance.toFixed(account.money_digits ?? 2)} USD`}</strong></div><div><small>Símbolos cTrader</small><strong>{account?.symbols?.length ?? 0}</strong></div><div><small>Stream</small><strong>{online ? 'Activo' : '—'}</strong></div></div>
    <h3>Símbolos forex disponibles</h3><div className="binance-events">{account?.symbols?.length ? account.symbols.join(' · ') : 'Configura una cuenta cTrader desde Perfil.'}</div>
  </section>;
}

function Access() {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);

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

function storedAuthTokens() {
  const local = localStorage.getItem('gm-auth-tokens');
  const session = sessionStorage.getItem('gm-auth-tokens');
  const raw = local ?? session;
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as { access_token: string; refresh_token: string };
    if (!local) localStorage.setItem('gm-auth-tokens', JSON.stringify(tokens));
    return { tokens, storage: localStorage };
  } catch {
    return null;
  }
}

function accessTokenExpiresAt(token: string) {
  try {
    const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
    if (!encoded) return null;
    const payload = JSON.parse(atob(encoded.padEnd(encoded.length + (4 - encoded.length % 4) % 4, '='))) as { exp?: number };
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

function AuthSessionKeeper({ client }: { client: AuthClient }) {
  const auth = useAuth();
  const refreshing = useRef(false);
  const refreshFailures = useRef(0);
  useEffect(() => {
    const check = async () => {
      const stored = storedAuthTokens();
      if (!stored || refreshing.current) return;
      const now = Date.now();
      const expiresAt = accessTokenExpiresAt(stored.tokens.access_token);
      const lastRefresh = Number(localStorage.getItem('gm-auth-last-refresh') ?? 0);
      const expiredOrNearExpiry = expiresAt !== null && expiresAt - now / 1000 <= 300;
      const tokenWithoutExpiryNeedsCheck = expiresAt === null && now - lastRefresh >= 10 * 60_000;
      if (!expiredOrNearExpiry && !tokenWithoutExpiryNeedsCheck) return;
      refreshing.current = true;
      try {
        const next = await client.refresh(stored.tokens.refresh_token);
        const serialized = JSON.stringify(next);
        // Always persist refreshed credentials durably. This also repairs a
        // session that was accidentally kept in sessionStorage after login.
        localStorage.setItem('gm-auth-tokens', serialized);
        sessionStorage.removeItem('gm-auth-tokens');
        localStorage.setItem('gm-auth-last-refresh', String(now));
        refreshFailures.current = 0;
        if (next.access_token !== auth.accessToken) window.location.reload();
      } catch {
        refreshFailures.current += 1;
        // A transient network failure must not log the user out. If an
        // already expired token fails repeatedly, return to login cleanly
        // instead of leaving the workspace in a stuck skeleton state.
        if (expiresAt !== null && expiresAt <= now / 1000 && refreshFailures.current >= 3) {
          localStorage.removeItem('gm-auth-tokens');
          sessionStorage.removeItem('gm-auth-tokens');
          localStorage.removeItem('gm-auth-last-refresh');
          window.location.reload();
        }
      } finally {
        refreshing.current = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    const onWake = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onWake); window.removeEventListener('online', onWake); document.removeEventListener('visibilitychange', onWake); };
  }, [auth.accessToken, client]);
  return null;
}

function CTraderOAuthCallback() {
  const auth = useAuth();
  const [message, setMessage] = useState('Completando autorización cTrader…');
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) { setMessage('cTrader no devolvió un código de autorización.'); return; }
    fetch(`${apiUrl}/trading/ctrader/oauth/exchange`, { method: 'POST', headers: { ...(auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}), 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ code }) })
      .then(async response => { const payload = await response.json() as { detail?: string; message?: string }; if (!response.ok) throw new Error(payload.detail ?? 'No se pudo completar la autorización cTrader.'); return payload; })
      .then(payload => { setMessage(payload.message ?? 'cTrader autorizado. Detectando cuentas…'); window.setTimeout(() => window.location.assign('/'), 1200); })
      .catch(reason => setMessage(reason instanceof Error ? reason.message : 'No se pudo completar la autorización cTrader.'));
  }, [auth.accessToken]);
  return <main className="access-shell"><section className="login-card"><h1>helloworld</h1><p className="profile-success">{message}</p></section></main>;
}

function Workspace() {
  const auth = useAuth();
  const mobilePwa = useMobilePwa();
  const [showProfile, setShowProfile] = useState(false);
  const [showRiskEngine, setShowRiskEngine] = useState(false);
  const [showPnlCalendar, setShowPnlCalendar] = useState(false);
  const [pnlCalendarMonth, setPnlCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [profileRevision, setProfileRevision] = useState(0);
  const [labRecommendations, setLabRecommendations] = useState<LabRecommendations | null>(null);
  const [labResolution, setLabResolutionState] = useState<1 | 5>(5);
  const ignoreLabFiveUntilRef = useRef(0);
  const setLabResolution = (value: 1 | 5) => {
    // Lab can emit the previous recommendation while the new resolution is
    // loading. Do not let that stale 5m result undo a user's 1m selection.
    if (value === 1) ignoreLabFiveUntilRef.current = Date.now() + 900;
    if (value === 5 && Date.now() < ignoreLabFiveUntilRef.current) return;
    setLabResolutionState(value);
  };
  useEffect(() => {
    const clearStaleGuard = (event: Event) => {
      if ((event.target as HTMLElement).closest('.live-lab-controls')) ignoreLabFiveUntilRef.current = 0;
    };
    document.addEventListener('pointerdown', clearStaleGuard, true);
    return () => document.removeEventListener('pointerdown', clearStaleGuard, true);
  }, []);
  const chartContainer = useRef<HTMLDivElement>(null);
  const overviewChartContainer = useRef<HTMLDivElement>(null);
  const overviewChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const overviewCandlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const overviewCandleDataRef = useRef<Array<{ time: UTCTimestamp; close: number }>>([]);
  const overviewBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const overviewLoadingOlderRef = useRef(false);
  const overviewStage = useRef<HTMLDivElement>(null);
  const chartStage = useRef<HTMLDivElement>(null);
  const labSection = useRef<HTMLElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const candleBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const replayAllBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const replayRef = useRef<ReplayState>({ active: false, running: false, cursor: -1, total: 0, start: -1 });
  const [replayState, setReplayState] = useState<ReplayState>({ active: false, running: false, cursor: -1, total: 0, start: -1 });
  const [entryOhlcHover, setEntryOhlcHover] = useState<OhlcHover | null>(null);
  const [overviewOhlcHover, setOverviewOhlcHover] = useState<OhlcHover | null>(null);
  const binanceLivePriceRef = useRef<BinanceLivePrice | null>(null);
  const productionDrawingsRef = useRef<Drawing[]>([]);
  const productionOnlyRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const candleDataRef = useRef<Array<{ time: UTCTimestamp; close: number }>>([]);
  const [symbol, setSymbol] = useState(() => localStorage.getItem('helloworld-selected-symbol') ?? 'BTCUSDT');
  const [binanceRules, setBinanceRules] = useState<BinanceSymbolRules | null>(null);
  const [binanceSymbolConfig, setBinanceSymbolConfig] = useState<BinanceSymbolConfig | null>(null);
  const [binanceLeverageDraft, setBinanceLeverageDraft] = useState('');
  const [binanceLeverageBusy, setBinanceLeverageBusy] = useState(false);
  const [binanceLeverageError, setBinanceLeverageError] = useState('');
  const [binanceCloseBusy, setBinanceCloseBusy] = useState<string | null>(null);
  const [pendingBinanceTp, setPendingBinanceTp] = useState<{ symbol: string; price: number } | null>(null);
  const pendingBinanceTpRef = useRef<{ symbol: string; price: number } | null>(null);
  const [binanceProductionAvailable, setBinanceProductionAvailable] = useState(false);
  const [productionWorkerRunning, setProductionWorkerRunning] = useState(false);
  const [executionMode, setExecutionMode] = useState<'paper' | 'production'>('paper');
  const [binanceSizingMode, setBinanceSizingMode] = useState<BinanceSizingMode>(() => localStorage.getItem('helloworld-binance-sizing-mode') === 'maximum' ? 'maximum' : 'minimum');
  const [binanceStopPercent, setBinanceStopPercent] = useState(() => Number(localStorage.getItem('helloworld-binance-stop-percent') ?? FIXED_BINANCE_STOP_PERCENT) || FIXED_BINANCE_STOP_PERCENT);
  const [binanceTargetPercent, setBinanceTargetPercent] = useState(() => Number(localStorage.getItem('helloworld-binance-target-percent') ?? FIXED_BINANCE_TARGET_PERCENT) || FIXED_BINANCE_TARGET_PERCENT);
  const [tpOptimizationResult, setTpOptimizationResult] = useState<{ targetPercent: number; equity: number; lossLimit: number; wins: number; losses: number } | null>(null);
  const [riskBalancePreview, setRiskBalancePreview] = useState<number | null>(null);
  const [binanceLiveAccount, setBinanceLiveAccount] = useState<BinanceAccount | null>(null);
  const [binanceExecutionIntents, setBinanceExecutionIntents] = useState<BinanceExecutionIntent[]>([]);
  const [broker, setBroker] = useState<'binance' | 'ctrader'>('binance');
  const [interval, setInterval] = useState<'1s' | '1m' | '3m' | '5m' | '15m'>('5m');
  // Default snapshot for the 5m workspace viewport.
  const [viewportBars, setViewportBars] = useState(37);
  const [viewportFutureBars, setViewportFutureBars] = useState(12);
  const [viewportYBelow, setViewportYBelow] = useState(22);
  const [viewportYAbove, setViewportYAbove] = useState(3);
  const [entryViewportSnapshot, setEntryViewportSnapshot] = useState<ViewportSnapshot>(ENTRY_VIEWPORT_DEFAULTS);
  const [overviewViewportSnapshot, setOverviewViewportSnapshot] = useState<ViewportSnapshot>({ bars: 37, futureBars: 12, yBelow: 22, yAbove: 3 });
  const syncViewportSnapshot = (chart: ReturnType<typeof createChart>, data: Array<{ close: number }>, setSnapshot: React.Dispatch<React.SetStateAction<ViewportSnapshot>>) => {
    const snapshot = getChartViewportSnapshot(chart, data);
    if (!snapshot) return;
    setSnapshot(current => current.bars === snapshot.bars && current.futureBars === snapshot.futureBars && current.yBelow === snapshot.yBelow && current.yAbove === snapshot.yAbove ? current : snapshot);
  };
  const entryInterval = '1m' as const;
  const brokerSymbols = broker === 'ctrader' ? ['AUDUSD', 'XAUUSD', 'XAGUSD'] : ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const [timezone, setTimezone] = useState('America/Mexico_City');
  const [showSessions, setShowSessions] = useState(true);
  const [showSevenAmMarkers, setShowSevenAmMarkers] = useState(() => localStorage.getItem('helloworld-indicator-seven-am') !== 'false');
  const [showRsi, setShowRsi] = useState(() => localStorage.getItem('helloworld-indicator-rsi') === 'true');
  const [showSsl, setShowSsl] = useState(() => localStorage.getItem('helloworld-indicator-ssl') === 'true');
  const [showTracker, setShowTracker] = useState(() => localStorage.getItem('helloworld-indicator-tracker') === 'true');
  const [showWickExtensions, setShowWickExtensions] = useState(() => localStorage.getItem('helloworld-indicator-wick-extensions') === 'true');
  const [wickBacktestTrades, setWickBacktestTrades] = useState<WickBacktestTrade[]>([]);
  const [trackerVirtualOperations, setTrackerVirtualOperations] = useState<TrackerVirtualOperation[]>([]);
  const [trackerEquityHover, setTrackerEquityHover] = useState<{ x: number; y: number; equity: number; time: number; side: string; status: string } | null>(null);
  const [showHeikinAshi, setShowHeikinAshi] = useState(() => localStorage.getItem('helloworld-heikin-ashi') === 'true');
  const [rsiPeriod, setRsiPeriod] = useState(() => Number(localStorage.getItem('helloworld-rsi-period') ?? 14) || 14);
  const [rsiLowBand, setRsiLowBand] = useState(() => Number(localStorage.getItem('helloworld-rsi-low-band') ?? 30) || 30);
  const [rsiHighBand, setRsiHighBand] = useState(() => Number(localStorage.getItem('helloworld-rsi-high-band') ?? 70) || 70);
  const [sslPeriod, setSslPeriod] = useState(() => Number(localStorage.getItem('helloworld-ssl-period') ?? 9) || 9);
  const [sslRegimeWindow, setSslRegimeWindow] = useState(() => Number(localStorage.getItem('helloworld-ssl-regime-window') ?? 5) || 5);
  const [trackerPeriod, setTrackerPeriod] = useState(() => Number(localStorage.getItem('helloworld-tracker-period') ?? 5) || 5);
  const [wickPeriod, setWickPeriod] = useState(() => Number(localStorage.getItem('helloworld-wick-period') ?? 10) || 10);
  const [wickDisplayPeriod, setWickDisplayPeriod] = useState(() => {
    const stored = localStorage.getItem('helloworld-wick-display-period');
    // Migrate the old display window to the new default.
    return stored === null || stored === '10' || stored === '30' ? 300 : Math.max(1, Math.min(300, Number(stored) || 300));
  });
  const [wickMultiplier, setWickMultiplier] = useState(() => Number(localStorage.getItem('helloworld-wick-multiplier') ?? 1.5) || 1.5);
  const [showIndicatorSettings, setShowIndicatorSettings] = useState(false);
  const [indicatorHover, setIndicatorHover] = useState<{ canvas: ChartCanvas; x: number; y: number; label: string } | null>(null);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [overviewSize, setOverviewSize] = useState({ width: 1, height: 1 });
  const [tool, setTool] = useState<'line' | 'ruler' | 'long' | 'short' | 'zoom' | 'pan' | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [trackerRevision, setTrackerRevision] = useState(0);
  const viewportRefreshPendingRef = useRef(false);
  const overviewRefreshPendingRef = useRef(false);
  const lastPaperVisualUpdateRef = useRef(0);
  const binancePnlFrameRef = useRef<number | null>(null);
  const binancePnlPriceRef = useRef<{ symbol: string; price: number; time: number } | null>(null);
  const queueBinancePnlUpdate = (next: { symbol: string; price: number; time: number }) => {
    binancePnlPriceRef.current = next;
    if (binancePnlFrameRef.current !== null) return;
    binancePnlFrameRef.current = requestAnimationFrame(() => {
      binancePnlFrameRef.current = null;
      const live = binancePnlPriceRef.current;
      if (!live) return;
      setBinanceLiveAccount(current => {
        if (!current?.positions?.length) return current;
        const positions = current.positions.map(position => {
          if (position.symbol !== live.symbol) return position;
          const quantity = Number(position.quantity ?? 0);
          const entry = Number(position.entry_price ?? 0);
          const pnl = entry > 0 ? quantity * (live.price - entry) : Number(position.unrealized_pnl ?? 0);
          return { ...position, mark_price: String(live.price), unrealized_pnl: String(pnl) };
        });
        const total = positions.reduce((sum, position) => sum + Number(position.unrealized_pnl ?? 0), 0);
        return { ...current, positions, total_unrealized_pnl: String(total), last_update: new Date(live.time * 1000).toISOString() };
      });
    });
  };
  const scheduleViewportRefresh = () => {
    if (viewportRefreshPendingRef.current) return;
    viewportRefreshPendingRef.current = true;
    requestAnimationFrame(() => {
      viewportRefreshPendingRef.current = false;
      setViewportRevision(value => value + 1);
    });
  };
  const scheduleOverviewRefresh = () => {
    if (overviewRefreshPendingRef.current) return;
    overviewRefreshPendingRef.current = true;
    requestAnimationFrame(() => {
      overviewRefreshPendingRef.current = false;
      setOverviewRevision(value => value + 1);
    });
  };
  const setReplaySnapshot = (next: ReplayState) => {
    replayRef.current = next;
    setReplayState(next);
  };
  const renderReplayPrefix = (cursor: number) => {
    const all = replayAllBarsRef.current;
    if (!all.length || cursor < 0) return;
    const chart = chartRef.current;
    const previousLogicalRange = chart?.timeScale().getVisibleLogicalRange() ?? null;
    const previousPriceRange = chart?.priceScale('right').getVisibleRange() ?? null;
    const previousRenderedBars = renderBars(all, MAX_ENTRY_RENDER_BARS);
    const previousLastIndex = previousRenderedBars.length - 1;
    const logicalSpan = previousLogicalRange
      ? Math.max(2, Number(previousLogicalRange.to) - Number(previousLogicalRange.from))
      : null;
    const futureBars = previousLogicalRange
      ? Math.max(0, Number(previousLogicalRange.to) - previousLastIndex)
      : 0;
    const prefix = all.slice(0, cursor + 1);
    candleBarsRef.current = prefix;
    candleDataRef.current = prefix.map(({ time, close }) => ({ time, close }));
    const visible = renderBars(prefix, MAX_ENTRY_RENDER_BARS);
    candlesRef.current?.setData(showHeikinAshi ? calculateHeikinAshi(visible) : visible);
    // setData may let lightweight-charts recalculate the viewport. Keep the
    // user's zoom instead: the replay cursor becomes the new right edge while
    // preserving the previous number of visible bars, future space and Y range.
    if (chart && visible.length && logicalSpan != null) {
      const nextLastIndex = visible.length - 1;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, nextLastIndex + futureBars - logicalSpan),
        to: nextLastIndex + futureBars,
      });
      if (previousPriceRange) chart.priceScale('right').setVisibleRange(previousPriceRange);
    }
    setTrackerRevision(value => value + 1);
    setViewportRevision(value => value + 1);
  };
  const startReplayAt = (index: number) => {
    const all = replayAllBarsRef.current.length ? replayAllBarsRef.current : candleBarsRef.current;
    const start = Math.max(0, Math.min(Math.round(index), all.length - 1));
    if (all.length === 0 || start < 0) return;
    replayAllBarsRef.current = [...all];
    const next = { active: true, running: false, cursor: start, total: all.length, start };
    setReplaySnapshot(next);
    renderReplayPrefix(start);
  };
  const advanceReplay = (delta = 1) => {
    const current = replayRef.current;
    if (!current.active) return;
    const nextCursor = Math.max(current.start, Math.min(current.total - 1, current.cursor + delta));
    const next = { ...current, cursor: nextCursor, running: delta > 0 && nextCursor < current.total - 1 ? current.running : false };
    setReplaySnapshot(next);
    renderReplayPrefix(nextCursor);
  };
  const stopReplay = () => {
    const all = replayAllBarsRef.current;
    replayRef.current = { active: false, running: false, cursor: -1, total: 0, start: -1 };
    setReplayState(replayRef.current);
    if (all.length) {
      candleBarsRef.current = all;
      candleDataRef.current = all.map(({ time, close }) => ({ time, close }));
      const visible = renderBars(all, MAX_ENTRY_RENDER_BARS);
      candlesRef.current?.setData(showHeikinAshi ? calculateHeikinAshi(visible) : visible);
      setTrackerRevision(value => value + 1);
      setViewportRevision(value => value + 1);
    }
    replayAllBarsRef.current = [];
  };
  useEffect(() => {
    if (!replayState.active || !replayState.running) return;
    const timer = window.setInterval(() => advanceReplay(1), 700);
    return () => window.clearInterval(timer);
  }, [replayState.active, replayState.running]);
  type ChartPoint = { time: UTCTimestamp; price: number };
  type ChartCanvas = 'entry' | 'context';
  type Drawing = { id?: string; symbol?: string; type: 'line' | 'ruler' | 'long' | 'short' | 'zoom'; start: ChartPoint; end: ChartPoint; stop?: ChartPoint; target?: ChartPoint; chart?: ChartCanvas; paper?: boolean; real?: boolean; backtest?: boolean; closed?: boolean; closeReason?: 'TP' | 'SL' | 'MANUAL'; status?: 'OPEN' | 'CLOSED - WIN' | 'CLOSED - FAILED'; riskPercent?: number; quantity?: number; notional?: number; margin?: number; pnl?: number; resultRoePercent?: number; leverage?: number; fees?: number; balanceAfter?: number; bodyAveragePercentAtOpen?: number; bodyAveragePercentAtClose?: number; finalTargetPercent?: number; finalTargetRoePercent?: number; maxRoe?: TrackerExtremePoint; realMaxRoe?: TrackerExtremePoint; minRoe?: TrackerExtremePoint; realMinRoe?: TrackerExtremePoint };
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [chartEventRules, setChartEventRules] = useState<ChartEventRule[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('helloworld-chart-event-rules') ?? '[]') as unknown;
      return Array.isArray(stored) ? stored.filter(item => item && typeof item === 'object') as ChartEventRule[] : [];
    } catch { return []; }
  });
  const [chartEventOccurrences, setChartEventOccurrences] = useState<ChartEventOccurrence[]>(() => {
    try { const stored = JSON.parse(localStorage.getItem('helloworld-chart-event-occurrences') ?? '[]') as unknown; return Array.isArray(stored) ? stored as ChartEventOccurrence[] : []; } catch { return []; }
  });
  const [chartEventsPaused, setChartEventsPaused] = useState(() => localStorage.getItem('helloworld-chart-events-paused') === 'true');
  useEffect(() => { localStorage.setItem('helloworld-chart-events-paused', String(chartEventsPaused)); }, [chartEventsPaused]);
  useEffect(() => { localStorage.setItem('helloworld-chart-event-rules', JSON.stringify(chartEventRules)); }, [chartEventRules]);
  useEffect(() => { localStorage.setItem('helloworld-chart-event-occurrences', JSON.stringify(chartEventOccurrences.slice(-200))); }, [chartEventOccurrences]);
  useEffect(() => {
    const bars = candleBarsRef.current; if (chartEventsPaused || bars.length < 3 || !chartEventRules.length) return;
    const source = renderBars(bars, Math.max(MAX_ENTRY_RENDER_BARS, 300)); const indicatorBars = source.map(({ high, low, close }) => ({ high, low, close }));
    const ssl = calculateSslChannel(indicatorBars, sslPeriod); const rsi = calculateRsi(indicatorBars, rsiPeriod); const tracker = calculateTrackerLevels(source, trackerPeriod);
    const existing = new Set(chartEventOccurrences.map(event => event.id)); const next: ChartEventOccurrence[] = [];
    chartEventRules.filter(rule => rule.symbol === symbol && rule.enabled).forEach(rule => source.forEach((bar, index) => {
      if (index === 0) return; const matches = rule.conditions.map(condition => eventConditionMatches(condition, bar, source[index - 1], ssl, rsi, tracker, index)); const active = rule.logic === 'OR' ? matches.some(Boolean) : matches.every(Boolean); const previousMatches = rule.conditions.map(condition => eventConditionMatches(condition, source[index - 1], source[index - 2], ssl, rsi, tracker, Math.max(0, index - 1))); const previouslyActive = rule.logic === 'OR' ? previousMatches.some(Boolean) : previousMatches.every(Boolean); const id = `${rule.id}-${Number(bar.time)}`;
      if (active && !previouslyActive && !existing.has(id)) next.push({ id, ruleId: rule.id, symbol, timestamp: Number(bar.time), price: bar.close, title: rule.name, description: rule.conditions.map(condition => `${condition.field} ${condition.operator} ${condition.value}`).join(` ${rule.logic} `), color: rule.color });
    }));
    if (next.length) setChartEventOccurrences(current => [...current, ...next].slice(-200));
  }, [chartEventRules, chartEventsPaused, symbol, rsiPeriod, sslPeriod, trackerPeriod, trackerRevision, viewportRevision]);
  const [showEventMarkers, setShowEventMarkers] = useState(false);
  const [drawingStart, setDrawingStart] = useState<ChartPoint | null>(null);
  const [drawingEnd, setDrawingEnd] = useState<ChartPoint | null>(null);
  const [resizeStart, setResizeStart] = useState<{ index: number; endpoint: 'start' | 'end' | 'stop' | 'target'; source?: 'paper' | 'binance' } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<number | null>(null);
  const [selectedDrawings, setSelectedDrawings] = useState<number[]>([]);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [drawingCanvas, setDrawingCanvas] = useState<ChartCanvas>('entry');
  const [trackerOperationHover, setTrackerOperationHover] = useState<{ id: string; x: number; y: number; label: string; roePercent: number; pnlUsd: number; time: number } | null>(null);
  const [moveStart, setMoveStart] = useState<{ index: number; point: ChartPoint; drawing: Drawing } | null>(null);
  const panStartRef = useRef<{ canvas: ChartCanvas; x: number; y: number; xLogicalPerPixel: number; startPrice: number; xRange: { from: number; to: number }; priceRange: { from: number; to: number } } | null>(null);
  const [mobileSheet, setMobileSheet] = useState<'indicators' | 'tools' | null>(null);
  const [, setActivePositionIndex] = useState<number | null>(null);
  const activePositionIndexRef = useRef<number | null>(null);
  const nativePriceLinesRef = useRef<Array<{ series: ReturnType<ReturnType<typeof createChart>['addSeries']>; line: IPriceLine }>>([]);
  const trackerPriceLinesRef = useRef<Array<{ line: IPriceLine; canvas: ChartCanvas; level: 'h2' | 'h1' | 'l1' | 'l2'; price: number }>>([]);
  const paperReadyRef = useRef(false);
  const [paperReady, setPaperReady] = useState(false);
  const [paperSyncError, setPaperSyncError] = useState('');
  const [visibleClosedId, setVisibleClosedId] = useState<string | null>(null);
  const [paperTab, setPaperTab] = useState<'open' | 'closed'>('open');
  const [paperStatsSymbol, setPaperStatsSymbol] = useState('ALL');
  const [paperStatsFrom, setPaperStatsFrom] = useState('');
  const [paperStatsTo, setPaperStatsTo] = useState('');
  const [showPaperSettings, setShowPaperSettings] = useState(false);
  const [paperInitialBalance, setPaperInitialBalance] = useState(() => { const value = Number(localStorage.getItem('helloworld-paper-balance') ?? 100); return Number.isFinite(value) && value >= 1 ? value : 100; });
  const [depositAmount, setDepositAmount] = useState('');
  const [paperRiskPercent, setPaperRiskPercent] = useState(() => Number(JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}').riskPercent ?? 1) || 1);
  type ActiveMarketSymbol = { symbol: string; last_price: number; change_pct: number; movement_pct: number; range_pct: number; quote_volume: number; trades: number; score: number; max_leverage: number | null; horizon: number; interval: string; variation_sum_pct: number; variation_average_pct: number };
  const [activeMarketSymbols, setActiveMarketSymbols] = useState<ActiveMarketSymbol[]>([]);
  const [marketReviewTimes, setMarketReviewTimes] = useState<Record<string, string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('helloworld-market-review-times') ?? '{}') as unknown;
      return stored && typeof stored === 'object' ? stored as Record<string, string> : {};
    } catch {
      return {};
    }
  });
  const [marketReviewClock, setMarketReviewClock] = useState(() => Date.now());
  const [activeMarketLoading, setActiveMarketLoading] = useState(false);
  const [activeMarketError, setActiveMarketError] = useState('');
  const [productionWorkerError, setProductionWorkerError] = useState('');
  const selectableSymbols = [...new Set([...brokerSymbols, ...activeMarketSymbols.map(candidate => candidate.symbol)])];

  useEffect(() => {
    let interval = 0;
    const timeout = window.setTimeout(() => {
      setMarketReviewClock(Date.now());
      interval = window.setInterval(() => setMarketReviewClock(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => { window.clearTimeout(timeout); if (interval) window.clearInterval(interval); };
  }, []);

  const updateMarketReviewTime = (candidateSymbol: string, reviewTime: string) => {
    setMarketReviewTimes(current => {
      const next = { ...current };
      if (reviewTime) next[candidateSymbol] = reviewTime;
      else delete next[candidateSymbol];
      localStorage.setItem('helloworld-market-review-times', JSON.stringify(next));
      return next;
    });
  };
  const getMarketReviewState = (reviewTime: string) => {
    if (!reviewTime) return '';
    const [hours, minutes] = reviewTime.split(':').map(Number);
    const now = new Date(marketReviewClock);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const scheduledMinutes = hours * 60 + minutes;
    let delta = scheduledMinutes - currentMinutes;
    if (delta < -720) delta += 1440;
    if (delta > 720) delta -= 1440;
    return delta === 0 ? 'due' : delta > 0 ? 'waiting' : 'overdue';
  };

  useEffect(() => {
    if (broker !== 'binance') { setBinanceProductionAvailable(false); setExecutionMode('paper'); return; }
    let active = true;
    const loadRuntime = () => fetch(`${apiUrl}/trading/binance/runtime`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : undefined, credentials: 'include' })
      .then(response => response.ok ? response.json() as Promise<{ real_trading_enabled?: boolean }> : Promise.reject(new Error()))
      .then(runtime => { if (active) { setBinanceProductionAvailable(runtime.real_trading_enabled === true); if (runtime.real_trading_enabled !== true) setExecutionMode('paper'); } })
      .catch(() => { if (active) { setBinanceProductionAvailable(false); setExecutionMode('paper'); } });
    void loadRuntime();
    const timer = window.setInterval(loadRuntime, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.accessToken, broker]);

  useEffect(() => {
    if (broker !== 'binance' || !auth.accessToken) { setBinanceExecutionIntents([]); return; }
    let active = true;
    const loadInitial = () => fetch(`${apiUrl}/trading/binance/execution-intents`, { headers: { Authorization: `Bearer ${auth.accessToken}` }, credentials: 'include' })
      .then(response => response.ok ? response.json() as Promise<typeof binanceExecutionIntents> : Promise.reject(new Error('intents unavailable')))
      .then(intents => { if (active) setBinanceExecutionIntents(Array.isArray(intents) ? intents : []); })
      .catch(() => { if (active) setBinanceExecutionIntents([]); });
    void loadInitial();
    return () => { active = false; };
  }, [auth.accessToken, broker]);

  useEffect(() => {
    localStorage.setItem('helloworld-selected-symbol', symbol);
  }, [symbol]);

  useEffect(() => {
    if (broker !== 'binance') { setBinanceRules(null); return; }
    let active = true;
    fetch(`${apiUrl}/market/binance/symbol-info/${encodeURIComponent(symbol)}`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : undefined, credentials: 'include' })
      .then(response => response.ok ? response.json() as Promise<BinanceSymbolRules & { symbol: string }> : Promise.reject(new Error('No se pudieron cargar las reglas del símbolo.')))
      .then(rules => { if (active) setBinanceRules(rules); })
      .catch(() => { if (active) setBinanceRules(null); });
    return () => { active = false; };
  }, [auth.accessToken, broker, symbol]);

  useEffect(() => {
    if (broker !== 'binance' || !auth.accessToken) { setBinanceLiveAccount(null); return; }
    let active = true;
    const closeStream = createBinanceAccountStream(auth.accessToken, account => {
      if (active) setBinanceLiveAccount(current => acceptBinanceAccount(current, account));
    }, intents => {
      if (active && Array.isArray(intents)) setBinanceExecutionIntents(intents as BinanceExecutionIntent[]);
    });
    return () => { active = false; closeStream(); };
  }, [auth.accessToken, broker]);

  const applyBinanceLeverage = async () => {
    const leverage = Number(binanceLeverageDraft);
    if (broker !== 'binance' || binanceLeverageBusy || !Number.isInteger(leverage) || leverage < 1 || leverage > 125) return;
    setBinanceLeverageBusy(true);
    setBinanceLeverageError('');
    try {
      const response = await fetch(`${apiUrl}/trading/binance/symbol-config/${encodeURIComponent(symbol)}/leverage`, { method: 'POST', headers: { ...(auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}), 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ leverage }) });
      const payload = await response.json() as BinanceSymbolConfig & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? 'Binance no pudo cambiar el leverage.');
      setBinanceSymbolConfig(payload);
      setBinanceLeverageDraft(payload.leverage != null ? String(payload.leverage) : '');
    } catch (reason) {
      setBinanceLeverageError(reason instanceof Error ? reason.message : 'No se pudo cambiar el leverage en Binance.');
    } finally {
      setBinanceLeverageBusy(false);
    }
  };

  useEffect(() => {
    if (broker !== 'binance') { setBinanceSymbolConfig(null); setBinanceLeverageDraft(''); return; }
    let active = true;
    let applyingIsolated = false;
    const load = () => fetch(`${apiUrl}/trading/binance/symbol-config/${encodeURIComponent(symbol)}`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : undefined, credentials: 'include' })
      .then(response => response.ok ? response.json() as Promise<BinanceSymbolConfig> : Promise.reject(new Error('No se pudo cargar la configuración del símbolo.')))
      .then(async config => {
        if (active) { setBinanceSymbolConfig(config); setBinanceLeverageDraft(config.leverage != null ? String(config.leverage) : ''); }
        if (!active || applyingIsolated || !config.configured || config.margin_type !== 'CROSSED') return;
        applyingIsolated = true;
        try {
          const updated = await fetchJson<BinanceSymbolConfig>(`${apiUrl}/trading/binance/symbol-config/${encodeURIComponent(symbol)}/margin-type`, { method: 'POST', headers: { ...(auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}), 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ margin_type: 'ISOLATED' }) });
          if (active) setBinanceSymbolConfig(updated);
        } catch (error) {
          console.warn('No se pudo activar margen aislado para el símbolo', symbol, error);
        } finally { applyingIsolated = false; }
      })
      .catch(() => { if (active) setBinanceSymbolConfig(null); });
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.accessToken, broker, symbol]);

  useEffect(() => {
    localStorage.setItem('helloworld-indicator-rsi', String(showRsi));
    localStorage.setItem('helloworld-indicator-seven-am', String(showSevenAmMarkers));
    localStorage.setItem('helloworld-indicator-ssl', String(showSsl));
    localStorage.setItem('helloworld-indicator-tracker', String(showTracker));
    localStorage.setItem('helloworld-indicator-wick-extensions', String(showWickExtensions));
    localStorage.setItem('helloworld-heikin-ashi', String(showHeikinAshi));
    localStorage.setItem('helloworld-rsi-period', String(rsiPeriod));
    localStorage.setItem('helloworld-rsi-low-band', String(rsiLowBand));
    localStorage.setItem('helloworld-rsi-high-band', String(rsiHighBand));
    localStorage.setItem('helloworld-ssl-period', String(sslPeriod));
    localStorage.setItem('helloworld-ssl-regime-window', String(sslRegimeWindow));
    localStorage.setItem('helloworld-tracker-period', String(trackerPeriod));
    localStorage.setItem('helloworld-wick-period', String(wickPeriod));
    localStorage.setItem('helloworld-wick-display-period', String(wickDisplayPeriod));
    localStorage.setItem('helloworld-wick-multiplier', String(wickMultiplier));
    setViewportRevision(value => value + 1);
    setOverviewRevision(value => value + 1);
  }, [showRsi, showSevenAmMarkers, showSsl, showTracker, showWickExtensions, showHeikinAshi, rsiPeriod, rsiLowBand, rsiHighBand, sslPeriod, sslRegimeWindow, trackerPeriod, wickPeriod, wickDisplayPeriod, wickMultiplier]);

  useEffect(() => {
    const syncAssist = () => {
      const balance = Number(localStorage.getItem('helloworld-paper-balance') ?? 100);
      const raw = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { riskPercent?: number };
      if (Number.isFinite(balance) && balance >= 1) setPaperInitialBalance(balance);
      if (Number.isFinite(raw.riskPercent) && (raw.riskPercent ?? 0) > 0) setPaperRiskPercent(raw.riskPercent as number);
    };
    window.addEventListener('helloworld-paper-assist-updated', syncAssist);
    return () => window.removeEventListener('helloworld-paper-assist-updated', syncAssist);
  }, []);

  useEffect(() => {
    if (broker !== 'binance') {
      setActiveMarketSymbols([]);
      setActiveMarketError('');
      return;
    }
    let active = true;
    const loadActiveMarkets = async () => {
      setActiveMarketLoading(true);
      try {
        const payload = await fetchJson<{ symbols?: ActiveMarketSymbol[] }>(`${apiUrl}/market/binance/active-symbols?limit=20&min_movement_pct=0.5&horizon=10&interval=5m`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : undefined, credentials: 'include' });
        if (active) {
          setActiveMarketSymbols(Array.isArray(payload.symbols) ? payload.symbols : []);
          setActiveMarketError('');
        }
      } catch (error) {
        if (active) setActiveMarketError(error instanceof Error ? error.message : 'No se pudo cargar el ranking de mercado.');
      } finally {
        if (active) setActiveMarketLoading(false);
      }
    };
    void loadActiveMarkets();
    const timer = window.setInterval(() => void loadActiveMarkets(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.accessToken, broker]);

  useEffect(() => {
    const removeSelected = (event: KeyboardEvent) => {
      if ((event.key !== 'Delete' && event.key !== 'Backspace') || selectedDrawings.length === 0) return;
      event.preventDefault();
      setDrawings(current => current.filter((_, index) => !selectedDrawings.includes(index)));
      setSelectedDrawings([]);
      setSelectedDrawing(null);
      activePositionIndexRef.current = null;
      setActivePositionIndex(null);
    };
    window.addEventListener('keydown', removeSelected);
    return () => window.removeEventListener('keydown', removeSelected);
  }, [selectedDrawings]);

  useEffect(() => {
    if (!auth.accessToken) return;
    let active = true;
    paperReadyRef.current = false;
    setPaperReady(false);
    fetchJson<Array<{
        id: string; symbol: string; side: 'long' | 'short'; chart: ChartCanvas;
        entry_time: number; entry_price: number; current_time: number; current_price: number;
        stop_time: number; stop_price: number; target_time: number; target_price: number;
        risk_percent?: number | null; quantity?: number | null; notional?: number | null; margin?: number | null; pnl?: number | null;
        status: 'OPEN' | 'CLOSED - WIN' | 'CLOSED - FAILED'; close_reason?: 'TP' | 'SL' | 'MANUAL' | null; updated_at?: string;
      }>>(`${apiUrl}/trading/paper/operations`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      credentials: 'include',
    }).then(operations => {
      if (!active) return;
      const restored = operations.map(operation => ({
        id: operation.id,
        symbol: operation.symbol,
        type: operation.side,
        paper: true,
        chart: operation.chart,
        start: { time: operation.entry_time as UTCTimestamp, price: operation.entry_price },
        end: { time: operation.current_time as UTCTimestamp, price: operation.current_price },
        stop: { time: operation.stop_time as UTCTimestamp, price: operation.stop_price },
        target: { time: operation.target_time as UTCTimestamp, price: operation.target_price },
        closed: operation.status !== 'OPEN',
        status: operation.status,
        closeReason: operation.close_reason ?? undefined,
        riskPercent: operation.risk_percent ?? undefined,
        quantity: operation.quantity ?? undefined,
        notional: operation.notional ?? undefined,
        margin: operation.margin ?? undefined,
        pnl: operation.pnl ?? undefined,
      } satisfies Drawing));
      setDrawings(current => [...current.filter(drawing => !drawing.paper), ...restored]);
      const activeIndex = restored.findIndex(operation => !operation.closed);
      // Closed trades stay in Paper history, but never render over the live chart.
      setVisibleClosedId(null);
      activePositionIndexRef.current = activeIndex >= 0 ? activeIndex : null;
      setActivePositionIndex(activePositionIndexRef.current);
      paperReadyRef.current = true;
      setPaperReady(true);
      setPaperSyncError('');
    }).catch(reason => {
      if (!active) return;
      setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudieron cargar las paper operations.');
    });
    return () => { active = false; };
  }, [auth.accessToken]);

  useEffect(() => {
    if (!auth.accessToken || !paperReadyRef.current) return;
    const operations = drawings.filter(drawing => drawing.paper && drawing.id && (drawing.type === 'long' || drawing.type === 'short'));
    const timer = window.setTimeout(() => {
      void Promise.all(operations.map(async drawing => {
        const response = await fetch(`${apiUrl}/trading/paper/operations/${drawing.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            symbol: drawing.symbol ?? symbol,
            side: drawing.type,
            chart: drawing.chart === 'context' ? 'context' : 'entry',
            entry_time: Number(drawing.start.time), entry_price: drawing.start.price,
            current_time: Number(drawing.end.time), current_price: drawing.end.price,
            stop_time: Number(drawing.stop?.time ?? drawing.end.time), stop_price: drawing.stop?.price ?? drawing.start.price,
            target_time: Number(drawing.target?.time ?? drawing.end.time), target_price: drawing.target?.price ?? drawing.end.price,
            risk_percent: drawing.riskPercent ?? null, quantity: drawing.quantity ?? null, notional: drawing.notional ?? null,
            margin: drawing.margin ?? null, pnl: drawing.pnl ?? null,
            status: drawing.status ?? (drawing.closed ? 'CLOSED - FAILED' : 'OPEN'),
            close_reason: drawing.closeReason ?? null,
          }),
        });
        if (!response.ok) throw new Error('No se pudo guardar una paper operation.');
      })).catch(reason => setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudo guardar una paper operation.'));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [drawings, auth.accessToken, paperReady, symbol]);

  const trackerLabel = (level: 'h2' | 'h1' | 'l1' | 'l2', price: number, close?: number) => {
    if ((level !== 'h2' && level !== 'l2') || !close || close <= 0) return level.toUpperCase();
    const distance = (price - close) / close * 100;
    return `${level.toUpperCase()} ${distance >= 0 ? '+' : ''}${distance.toFixed(3)}%`;
  };

  const updateTrackerLabels = (canvas: ChartCanvas, close: number) => {
    if (!showTracker || !Number.isFinite(close) || close <= 0) return;
    trackerPriceLinesRef.current.forEach(item => {
      if (item.canvas === canvas) item.line.applyOptions({ title: trackerLabel(item.level, item.price, close) });
    });
  };

  useEffect(() => {
    void trackerRevision;
    nativePriceLinesRef.current.forEach(({ series, line }) => series.removePriceLine(line));
    nativePriceLinesRef.current = [];
    trackerPriceLinesRef.current = [];
    const addLines = (canvas: ChartCanvas, series: ReturnType<ReturnType<typeof createChart>['addSeries']> | null) => {
      if (!series) return;
      // Binance positions are live exchange state and must remain visible in
      // the chart regardless of whether the paper/production panel toggle is
      // currently selected. Paper drawings are kept alongside them so the
      // user can compare both layers without losing the real SL/TP.
      const operationDrawings = productionOnlyRef.current
        ? productionDrawingsRef.current
        : [...drawings, ...productionDrawingsRef.current];
      operationDrawings.forEach((drawing, index) => {
        if (!drawing.paper || (drawing.type !== 'long' && drawing.type !== 'short')) return;
        if (drawing.symbol && drawing.symbol !== symbol) return;
        if (drawing.closed) return;
        // A paper position is shared by both chart views.
        const targetPrice = drawing.target?.price ?? drawing.end.price;
        const stopPrice = drawing.stop?.price;
        if (stopPrice === undefined) return;
        const targetLine = series.createPriceLine({
          id: `${drawing.real ? 'binance' : 'paper'}-${index}-tp-${canvas}`,
          price: targetPrice,
          color: '#3b82f6',
          lineWidth: 3,
          lineStyle: 2,
          lineVisible: true,
          axisLabelVisible: true,
          title: 'TP',
          axisLabelColor: '#2563eb',
          axisLabelTextColor: '#eff6ff',
        });
        const stopLine = series.createPriceLine({
          id: `${drawing.real ? 'binance' : 'paper'}-${index}-sl-${canvas}`,
          price: stopPrice,
          color: '#ef4444',
          lineWidth: 4,
          lineStyle: 2,
          lineVisible: true,
          axisLabelVisible: true,
          title: 'SL',
          axisLabelColor: '#dc2626',
          axisLabelTextColor: '#fff1f2',
        });
        nativePriceLinesRef.current.push({ series, line: targetLine }, { series, line: stopLine });
      });
      if (!showTracker) return;
      const sourceBars = canvas === 'entry' ? candleBarsRef.current : overviewBarsRef.current;
      const trackerWindow = sourceBars.slice(-(trackerPeriod + 1));
      const trackerValues = calculateTrackerLevels(trackerWindow, trackerPeriod);
      const latest = trackerValues[trackerValues.length - 1];
      if (!latest) return;
      (['h2', 'h1', 'l1', 'l2'] as const).forEach(level => {
        const line = series.createPriceLine({
          id: `tracker-${level}-${canvas}`,
          price: latest[level],
          color: '#f59e0b',
          lineWidth: 2,
          lineStyle: 0,
          lineVisible: true,
          axisLabelVisible: true,
          title: trackerLabel(level, latest[level], sourceBars[sourceBars.length - 1]?.close),
          axisLabelColor: '#f59e0b',
          axisLabelTextColor: '#080a0d',
        });
        nativePriceLinesRef.current.push({ series, line });
        trackerPriceLinesRef.current.push({ line, canvas, level, price: latest[level] });
      });
    };
    addLines('entry', candlesRef.current);
    if (!mobilePwa) addLines('context', overviewCandlesRef.current);
    return () => {
      nativePriceLinesRef.current.forEach(({ series, line }) => series.removePriceLine(line));
      nativePriceLinesRef.current = [];
      trackerPriceLinesRef.current = [];
    };
  }, [drawings, binanceLiveAccount, binanceExecutionIntents, pendingBinanceTp, executionMode, broker, symbol, interval, mobilePwa, visibleClosedId, showTracker, trackerPeriod, trackerRevision]);

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
    if (mobilePwa || !overviewStage.current) return;
    const updateSize = () => overviewStage.current && setOverviewSize({ width: overviewStage.current.clientWidth, height: overviewStage.current.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(overviewStage.current);
    return () => observer.disconnect();
  }, [mobilePwa]);

  useEffect(() => {
    if (!chartContainer.current) return;
    activePositionIndexRef.current = null;
    setActivePositionIndex(null);
    const chart = createChart(chartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true), priceFormatter: formatPaperPrice },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      // Vertical trackpad wheel is handled below so X and Y zoom together.
      handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: true },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e', priceFormat: { type: 'price', precision: binanceRules?.price_precision ?? 8, minMove: binanceRules?.tick_size || 0.00000001 } });
    chartRef.current = chart;
    candlesRef.current = candles;
    const wheelHandler = (event: WheelEvent) => zoomChartOnWheel(chart, event);
    chartContainer.current.addEventListener('wheel', wheelHandler, { passive: false });
    const crosshairHandler = (param: any) => setEntryOhlcHover(resolveOhlcHover(param, candles, candleBarsRef.current));
    const clickHandler = (param: any) => {
      if (replayRef.current.active || !param?.time) return;
      const index = candleBarsRef.current.findIndex(bar => Number(bar.time) === Number(param.time));
      if (index >= 0) startReplayAt(index);
    };
    chart.subscribeCrosshairMove(crosshairHandler);
    chart.subscribeClick(clickHandler);
    let hasChartData = false;
    let initializingViewport = false;
    const setDataPreservingRange = (data: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>) => {
      // A fast stream can arrive before the historical response. Never
      // restore lightweight-charts' provisional empty range on first load.
      const visibleRange = hasChartData ? chart.timeScale().getVisibleLogicalRange() : null;
      candles.setData(data);
      if (visibleRange) chart.timeScale().setVisibleLogicalRange(visibleRange);
      hasChartData = true;
    };
    let active = true;
    const refreshDrawings = () => {
      if (initializingViewport) return;
      syncViewportSnapshot(chart, candleBarsRef.current, setEntryViewportSnapshot);
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (logicalRange && logicalRange.from < 80 && !loadingOlderRef.current && candleBarsRef.current.length > 0) {
        const oldest = Number(candleBarsRef.current[0].time);
        const historyCutoff = Math.floor(Date.now() / 1000) - MAX_CHART_HISTORY_SECONDS;
        if (oldest > historyCutoff) {
          loadingOlderRef.current = true;
          const previousRange = { from: logicalRange.from, to: logicalRange.to };
          const dayStart = Math.max(historyCutoff, oldest - 86400);
          const fetchChunk = (endTime: number, limit: number) => fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${entryInterval}&limit=${limit}&endTime=${Math.max(historyCutoff * 1000, endTime * 1000 - 1)}`).then(response => response.json());
          fetchChunk(oldest, 1000).then(firstRows => {
              if (!active || !Array.isArray(firstRows)) return [];
              const first = firstRows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
              const remaining = Math.max(0, Math.round((oldest - dayStart) / 60) - first.length);
              return remaining > 0 && first.length > 0 ? fetchChunk(Number(first[0].time), Math.min(1000, remaining)).then(secondRows => first.concat(Array.isArray(secondRows) ? secondRows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })) : []).sort((left, right) => Number(left.time) - Number(right.time))) : first;
            }).then(older => {
              if (!active || older.length === 0) return;
              candleBarsRef.current = [...older, ...candleBarsRef.current].filter((bar, index, all) => index === 0 || bar.time !== all[index - 1].time);
              candleBarsRef.current = candleBarsRef.current.filter(bar => Number(bar.time) >= historyCutoff);
              void cacheBars(symbol, entryInterval, candleBarsRef.current);
              candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
              const visibleBars = renderBars(candleBarsRef.current, MAX_ENTRY_RENDER_BARS);
              setDataPreservingRange(showHeikinAshi ? calculateHeikinAshi(visibleBars) : visibleBars);
              chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + older.length, to: previousRange.to + older.length });
              setViewportRevision(value => value + 1);
            })
            .catch(() => undefined)
            .finally(() => { loadingOlderRef.current = false; });
        }
      }
      setViewportRevision(value => value + 1);
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshDrawings);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshDrawings);
    candleDataRef.current = [];
    candleBarsRef.current = [];
    if (broker === 'ctrader') {
      let polling = 0;
      // A cTrader weekend can contain no candles in the last 24 hours. Keep
      // the entry chart useful without making the worker request an oversized
      // history window.
      const loadCTrader = () => fetch(`${apiUrl}/trading/ctrader/candles/${encodeURIComponent(symbol)}?interval=${entryInterval}&days=1`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`cTrader ${response.status}`)))
        .then(payload => {
          if (!active) return;
          const parsed = parseCTraderCandles(payload);
          if (!parsed.length) return;
          const hadBars = candleBarsRef.current.length > 0;
          candleBarsRef.current = hadBars ? mergeBars(candleBarsRef.current, parsed) : parsed;
          candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
          const visibleBars = renderBars(candleBarsRef.current, MAX_ENTRY_RENDER_BARS);
          if (!polling) initializingViewport = true;
          if (hadBars && !showHeikinAshi) candles.update(candleBarsRef.current[candleBarsRef.current.length - 1]);
          else setDataPreservingRange(showHeikinAshi ? calculateHeikinAshi(visibleBars) : visibleBars);
          if (!polling) {
            applyDefaultChartViewport(chart, visibleBars, ENTRY_VIEWPORT_DEFAULTS.bars, ENTRY_VIEWPORT_DEFAULTS.futureBars, ENTRY_VIEWPORT_DEFAULTS.yBelow, ENTRY_VIEWPORT_DEFAULTS.yAbove);
            syncViewportSnapshot(chart, visibleBars, setEntryViewportSnapshot);
            requestAnimationFrame(() => { if (active) initializingViewport = false; });
          }
          polling += 1;
          setTrackerRevision(value => value + 1);
          if (polling === 1) setViewportRevision(value => value + 1);
        })
        .catch(() => undefined);
      void loadCTrader();
      const pollTick = () => fetch(`${apiUrl}/trading/ctrader/tick/${encodeURIComponent(symbol)}`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
        .then(response => response.ok ? response.json() as Promise<{ tick?: { price?: number; time?: number } }> : Promise.reject(new Error('tick unavailable')))
        .then(payload => {
          if (!active || replayRef.current.active || !payload.tick?.price || !payload.tick.time) return;
          const previousBarTime = candleBarsRef.current[candleBarsRef.current.length - 1]?.time;
          candleBarsRef.current = mergeTickBar(candleBarsRef.current, Number(payload.tick.time), Number(payload.tick.price), 60);
          const liveBar = candleBarsRef.current[candleBarsRef.current.length - 1];
          const lastCandleData = candleDataRef.current[candleDataRef.current.length - 1];
          if (lastCandleData?.time === liveBar.time) lastCandleData.close = liveBar.close;
          else candleDataRef.current.push({ time: liveBar.time, close: liveBar.close });
          if (showHeikinAshi) setDataPreservingRange(calculateHeikinAshi(renderBars(candleBarsRef.current, MAX_ENTRY_RENDER_BARS)));
          else candles.update(liveBar);
          updateTrackerLabels('entry', liveBar.close);
          scheduleViewportRefresh();
          if (candleBarsRef.current[candleBarsRef.current.length - 1]?.time !== previousBarTime) setTrackerRevision(value => value + 1);
        }).catch(() => undefined);
      const candleTimer = window.setInterval(() => void loadCTrader(), 30_000);
      const tickTimer = window.setInterval(pollTick, 1_000);
      void pollTick();
      return () => { active = false; window.clearInterval(candleTimer); window.clearInterval(tickTimer); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshDrawings); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshDrawings); chart.unsubscribeCrosshairMove(crosshairHandler); chart.unsubscribeClick(clickHandler); chartContainer.current?.removeEventListener('wheel', wheelHandler); setEntryOhlcHover(null); chartRef.current = null; candlesRef.current = null; candleDataRef.current = []; candleBarsRef.current = []; loadingOlderRef.current = false; chart.remove(); };
    }
    // The chart/history uses Binance Futures, so the live stream must use the
    // Futures WebSocket too. Spot streams can silently stop for Futures-only
    // scanner symbols after a symbol switch.
    const stream = createBinanceKlineStream(symbol, entryInterval);
    fetch(`${apiUrl}/market/binance/candles/${encodeURIComponent(symbol)}?interval=${entryInterval}&limit=${INITIAL_ENTRY_BARS}`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
      .then(response => response.json())
      .then(payload => {
        const rows = (payload as { bars?: Array<{ time: number; open: number; high: number; low: number; close: number }> }).bars;
        if (!active || !Array.isArray(rows)) return;
        const parsed = rows.map(row => ({ time: Number(row.time) as UTCTimestamp, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
        const hadLiveBars = candleBarsRef.current.length > 0;
        candleBarsRef.current = hadLiveBars ? mergeBars(candleBarsRef.current, parsed) : parsed;
        void cacheBars(symbol, entryInterval, parsed);
        candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
        const visibleBars = renderBars(candleBarsRef.current, MAX_ENTRY_RENDER_BARS);
        initializingViewport = true;
        setDataPreservingRange(showHeikinAshi ? calculateHeikinAshi(visibleBars) : visibleBars);
        if (!hadLiveBars || !chart.timeScale().getVisibleLogicalRange()) applyDefaultChartViewport(chart, visibleBars, ENTRY_VIEWPORT_DEFAULTS.bars, ENTRY_VIEWPORT_DEFAULTS.futureBars, ENTRY_VIEWPORT_DEFAULTS.yBelow, ENTRY_VIEWPORT_DEFAULTS.yAbove);
        syncViewportSnapshot(chart, visibleBars, setEntryViewportSnapshot);
        requestAnimationFrame(() => { if (active) initializingViewport = false; });
        setTrackerRevision(value => value + 1);
        setViewportRevision(value => value + 1);
      })
      .catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      if (replayRef.current.active) return;
      const message = JSON.parse(event.data) as { type?: string; symbol?: string; price?: number; time?: number; interval?: string; bar?: { time: number; open: number; high: number; low: number; close: number } };
      if (message.type === 'mark_price' && message.price && message.time) {
        queueBinancePnlUpdate({ symbol, price: Number(message.price), time: Number(message.time) });
        return;
      }
      if (message.type === 'trade' && message.price && message.time) {
        binanceLivePriceRef.current = { symbol, price: Number(message.price), time: Number(message.time), receivedAt: Date.now() };
        const liveBars = mergeTickBar(candleBarsRef.current, Number(message.time), Number(message.price), 60);
        const liveBar = liveBars[liveBars.length - 1];
        if (liveBar) {
          candleBarsRef.current = mergeTickBar(candleBarsRef.current, Number(message.time), Number(message.price), 60);
          candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
          if (showHeikinAshi) setDataPreservingRange(calculateHeikinAshi(renderBars(candleBarsRef.current, MAX_ENTRY_RENDER_BARS)));
          else candles.update(liveBar);
          updateTrackerLabels('entry', liveBar.close);
          scheduleViewportRefresh();
        }
        return;
      }
      if (message.type !== 'kline' || message.interval !== entryInterval || !message.bar) return;
      const candle = message.bar;
      const rawNext = { time: Number(candle.time) as UTCTimestamp, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) };
      const sharedLive = binanceLivePriceRef.current;
      const useSharedPrice = sharedLive?.symbol === symbol && Date.now() - sharedLive.receivedAt < 10_000;
      const next = useSharedPrice ? { ...rawNext, high: Math.max(rawNext.high, sharedLive.price), low: Math.min(rawNext.low, sharedLive.price), close: sharedLive.price } : rawNext;
      const isNewBar = upsertLiveBar(candleBarsRef.current, next);
      void cacheBars(symbol, entryInterval, [next]);
      const lastCandleData = candleDataRef.current[candleDataRef.current.length - 1];
      if (lastCandleData?.time === next.time) lastCandleData.close = next.close;
      else if (isNewBar) candleDataRef.current.push({ time: next.time, close: next.close });
      if (showHeikinAshi) setDataPreservingRange(calculateHeikinAshi(renderBars(candleBarsRef.current, MAX_ENTRY_RENDER_BARS)));
      else candles.update(next);
      updateTrackerLabels('entry', next.close);
      // The rolling impulse average follows the active candle in real time;
      // requestAnimationFrame coalesces bursts without repainting per tick.
      scheduleViewportRefresh();
      // PNL and paper labels remain responsive, but do not force a React tree
      // reconciliation for every upstream kline update.
      if (isNewBar) setTrackerRevision(value => value + 1);
      const now = performance.now();
      if (now - lastPaperVisualUpdateRef.current < 250 && !isNewBar) return;
      lastPaperVisualUpdateRef.current = now;
      setDrawings(current => {
        let anyOpen = false;
        const updated = current.map(drawing => {
          if (drawing.closed || !drawing.paper || (drawing.symbol && drawing.symbol !== symbol) || (drawing.type !== 'long' && drawing.type !== 'short')) return drawing;
          anyOpen = true;
          const direction = drawing.type === 'long' ? 1 : -1;
          const targetPrice = drawing.target?.price ?? drawing.end.price;
          const stopPrice = drawing.stop?.price ?? drawing.start.price;
          // A candle can touch a level with its wick and close back inside
          // the range. Use the live candle extremes, not only its close.
          // The current candle may have started before the operation. Its
          // accumulated high/low must not evaluate movement that happened
          // before entry; use only the post-entry live price on that bar.
          const sameEntryBar = Number(next.time) === Number(drawing.start.time);
          const evaluationHigh = sameEntryBar ? (useSharedPrice ? sharedLive.price : next.close) : next.high;
          const evaluationLow = sameEntryBar ? (useSharedPrice ? sharedLive.price : next.close) : next.low;
          const targetTouched = direction === 1 ? evaluationHigh >= targetPrice : evaluationLow <= targetPrice;
          const stopTouched = direction === 1 ? evaluationLow <= stopPrice : evaluationHigh >= stopPrice;
          // If a completed candle touched both levels and the intrabar path
          // is unknowable, resolve conservatively as a stop-out.
          const hitStop = stopTouched;
          const hitTarget = !hitStop && targetTouched;
          const closeReason: 'TP' | 'SL' | undefined = hitTarget ? 'TP' : hitStop ? 'SL' : undefined;
          const executionPrice = closeReason === 'TP' ? targetPrice : closeReason === 'SL' ? stopPrice : next.close;
          const status: Drawing['status'] = closeReason === 'TP' ? 'CLOSED - WIN' : closeReason === 'SL' ? 'CLOSED - FAILED' : 'OPEN';
          const stopDistance = Math.abs(drawing.start.price - stopPrice);
          const stopPercent = drawing.start.price > 0 ? stopDistance / drawing.start.price : 0;
          const fallbackNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
          const notional = Number.isFinite(drawing.notional) && (drawing.notional ?? 0) > 0
            ? drawing.notional as number
            : Math.min(fallbackNotional, paperInitialBalance * paperLeverage);
          const grossPnl = ((executionPrice - drawing.start.price) / drawing.start.price) * direction * notional;
          const costs = tradingCosts(broker, notional);
          const realizedPnl = closeReason ? grossPnl - costs.total : drawing.pnl;
          if (closeReason) setVisibleClosedId(null);
          return {
            ...drawing,
            end: { time: next.time, price: executionPrice },
            target: drawing.target ? { ...drawing.target, time: next.time } : undefined,
            stop: drawing.stop ? { ...drawing.stop, time: next.time } : undefined,
            closed: Boolean(closeReason),
            closeReason,
            status,
            notional,
            margin: drawing.margin ?? (paperLeverage > 0 ? notional / paperLeverage : 0),
            pnl: realizedPnl,
          };
        });
        if (!anyOpen) {
          activePositionIndexRef.current = null;
          setActivePositionIndex(null);
        }
        return updated;
      });
    };
    return () => {
      active = false;
      stream.close();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshDrawings);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshDrawings);
      chartContainer.current?.removeEventListener('wheel', wheelHandler);
      chart.unsubscribeCrosshairMove(crosshairHandler);
      chart.unsubscribeClick(clickHandler);
      setEntryOhlcHover(null);
      chartRef.current = null;
      candlesRef.current = null;
      candleDataRef.current = [];
      candleBarsRef.current = [];
      loadingOlderRef.current = false;
      chart.remove();
    };
  }, [auth.accessToken, broker, symbol, showHeikinAshi]);

  useEffect(() => {
    if (!binanceRules) return;
    candlesRef.current?.applyOptions({ priceFormat: { type: 'price', precision: binanceRules.price_precision, minMove: binanceRules.tick_size || 0.00000001 } });
  }, [binanceRules]);

  useEffect(() => {
    const defaults = interval === '1m'
      ? { bars: 100, futureBars: 0, yBelow: 14, yAbove: 11 }
      : { bars: 37, futureBars: 12, yBelow: 22, yAbove: 3 };
    setViewportBars(defaults.bars);
    setViewportFutureBars(defaults.futureBars);
    setViewportYBelow(defaults.yBelow);
    setViewportYAbove(defaults.yAbove);
    requestAnimationFrame(() => {
      if (overviewChartRef.current && overviewBarsRef.current.length > 0) applyDefaultChartViewport(overviewChartRef.current, overviewBarsRef.current, defaults.bars, defaults.futureBars, defaults.yBelow, defaults.yAbove);
    });
  }, [interval]);

  useEffect(() => {
    if (mobilePwa || !overviewChartContainer.current) return;
    const chart = createChart(overviewChartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true), priceFormatter: formatPaperPrice },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: true },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e', priceFormat: { type: 'price', precision: binanceRules?.price_precision ?? 8, minMove: binanceRules?.tick_size || 0.00000001 } });
    overviewChartRef.current = chart;
    overviewCandlesRef.current = candles;
    const wheelHandler = (event: WheelEvent) => zoomChartOnWheel(chart, event);
    overviewChartContainer.current.addEventListener('wheel', wheelHandler, { passive: false });
    const crosshairHandler = (param: any) => setOverviewOhlcHover(resolveOhlcHover(param, candles, overviewBarsRef.current));
    const clickHandler = (param: any) => {
      if (replayRef.current.active || !param?.time || !candleBarsRef.current.length) return;
      const clickedTime = Number(param.time);
      let nearest = 0;
      candleBarsRef.current.forEach((bar, index) => { if (Math.abs(Number(bar.time) - clickedTime) < Math.abs(Number(candleBarsRef.current[nearest].time) - clickedTime)) nearest = index; });
      startReplayAt(nearest);
    };
    chart.subscribeCrosshairMove(crosshairHandler);
    chart.subscribeClick(clickHandler);
    let hasChartData = false;
    let initializingViewport = false;
    const setDataPreservingRange = (data: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>) => {
      const visibleRange = hasChartData ? chart.timeScale().getVisibleLogicalRange() : null;
      candles.setData(data);
      if (visibleRange) chart.timeScale().setVisibleLogicalRange(visibleRange);
      hasChartData = true;
    };
    const refreshOverview = () => {
      if (initializingViewport) return;
      syncViewportSnapshot(chart, overviewBarsRef.current, setOverviewViewportSnapshot);
      setOverviewRevision(value => value + 1);
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (!logicalRange || logicalRange.from >= 50 || overviewLoadingOlderRef.current || overviewBarsRef.current.length === 0) return;
      const oldest = Number(overviewBarsRef.current[0].time);
        const historyCutoff = Math.floor(Date.now() / 1000) - MAX_CHART_HISTORY_SECONDS;
        if (oldest <= historyCutoff) return;
      overviewLoadingOlderRef.current = true;
      const previousRange = { from: logicalRange.from, to: logicalRange.to };
      const previousBarCount = overviewBarsRef.current.length;
      const secondsPerBar = interval === '1s' ? 1 : interval === '1m' ? 60 : interval === '3m' ? 180 : interval === '5m' ? 300 : 900;
        const dayStart = Math.max(historyCutoff, oldest - 86400);
      const expected = Math.ceil((oldest - dayStart) / secondsPerBar);
      const fetchChunk = (endTime: number, limit: number) => fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${Math.max(historyCutoff * 1000, endTime * 1000 - 1)}`).then(response => response.json());
      const loadDay = async () => {
        const rows: any[] = [];
        let cursor = oldest;
        while (rows.length < expected && cursor > dayStart && active) {
          const batch = await fetchChunk(cursor, Math.min(1000, expected - rows.length));
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.unshift(...batch);
          cursor = Number(batch[0][0]) / 1000;
          if (batch.length < 1000) break;
        }
        return rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })).filter(bar => Number(bar.time) >= dayStart && Number(bar.time) < oldest).sort((left, right) => Number(left.time) - Number(right.time));
      };
      void loadDay().then(older => {
        if (!active || older.length === 0) return;
        overviewBarsRef.current = [...older, ...overviewBarsRef.current].filter((bar, index, all) => index === 0 || bar.time !== all[index - 1].time).filter(bar => Number(bar.time) >= historyCutoff);
        void cacheBars(symbol, interval, overviewBarsRef.current);
        overviewCandleDataRef.current = overviewBarsRef.current.map(({ time, close }) => ({ time, close }));
        const visibleBars = renderBars(overviewBarsRef.current, MAX_CONTEXT_RENDER_BARS);
        candles.setData(showHeikinAshi ? calculateHeikinAshi(visibleBars) : visibleBars);
        const previousRenderStart = Math.max(0, previousBarCount - MAX_CONTEXT_RENDER_BARS);
        const nextRenderStart = Math.max(0, overviewBarsRef.current.length - MAX_CONTEXT_RENDER_BARS);
        const renderOffset = previousRenderStart - nextRenderStart;
        chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + renderOffset, to: previousRange.to + renderOffset });
        setOverviewRevision(value => value + 1);
      }).catch(() => undefined).finally(() => { overviewLoadingOlderRef.current = false; });
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshOverview);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshOverview);
    let active = true;
    if (broker === 'ctrader') {
      let polling = 0;
      const loadCTrader = () => fetch(`${apiUrl}/trading/ctrader/candles/${encodeURIComponent(symbol)}?interval=${interval === '1s' ? '1m' : interval}&days=1`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`cTrader ${response.status}`)))
        .then(payload => {
          if (!active) return;
          const parsed = parseCTraderCandles(payload);
          if (!parsed.length) return;
          const hadBars = overviewBarsRef.current.length > 0;
          overviewBarsRef.current = hadBars ? mergeBars(overviewBarsRef.current, parsed) : parsed;
          overviewCandleDataRef.current = overviewBarsRef.current.map(({ time, close }) => ({ time, close }));
          const visibleBars = renderBars(overviewBarsRef.current, MAX_CONTEXT_RENDER_BARS);
          if (!polling) initializingViewport = true;
          if (hadBars && !showHeikinAshi) candles.update(overviewBarsRef.current[overviewBarsRef.current.length - 1]);
          else setDataPreservingRange(showHeikinAshi ? calculateHeikinAshi(visibleBars) : visibleBars);
          if (!polling) {
            applyDefaultChartViewport(chart, visibleBars, viewportBars, viewportFutureBars, viewportYBelow, viewportYAbove);
            syncViewportSnapshot(chart, visibleBars, setOverviewViewportSnapshot);
            requestAnimationFrame(() => { if (active) initializingViewport = false; });
          }
          polling += 1;
          setTrackerRevision(value => value + 1);
          if (polling === 1) setOverviewRevision(value => value + 1);
        })
        .catch(() => undefined);
      void loadCTrader();
      const pollTick = () => fetch(`${apiUrl}/trading/ctrader/tick/${encodeURIComponent(symbol)}`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
        .then(response => response.ok ? response.json() as Promise<{ tick?: { price?: number; time?: number } }> : Promise.reject(new Error('tick unavailable')))
        .then(payload => {
          if (!active || !payload.tick?.price || !payload.tick.time) return;
          const previousBarTime = overviewBarsRef.current[overviewBarsRef.current.length - 1]?.time;
          overviewBarsRef.current = mergeTickBar(overviewBarsRef.current, Number(payload.tick.time), Number(payload.tick.price), interval === '1s' ? 60 : interval === '1m' ? 60 : interval === '3m' ? 180 : interval === '5m' ? 300 : 900);
          const liveBar = overviewBarsRef.current[overviewBarsRef.current.length - 1];
          const lastCandleData = overviewCandleDataRef.current[overviewCandleDataRef.current.length - 1];
          if (lastCandleData?.time === liveBar.time) lastCandleData.close = liveBar.close;
          else overviewCandleDataRef.current.push({ time: liveBar.time, close: liveBar.close });
          if (showHeikinAshi) setDataPreservingRange(calculateHeikinAshi(renderBars(overviewBarsRef.current, MAX_CONTEXT_RENDER_BARS)));
          else candles.update(liveBar);
          updateTrackerLabels('context', liveBar.close);
          scheduleOverviewRefresh();
          if (overviewBarsRef.current[overviewBarsRef.current.length - 1]?.time !== previousBarTime) setTrackerRevision(value => value + 1);
        }).catch(() => undefined);
      const candleTimer = window.setInterval(() => void loadCTrader(), 30_000);
      const tickTimer = window.setInterval(pollTick, 1_000);
      void pollTick();
      return () => { active = false; window.clearInterval(candleTimer); window.clearInterval(tickTimer); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshOverview); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverview); chart.unsubscribeCrosshairMove(crosshairHandler); chart.unsubscribeClick(clickHandler); overviewChartContainer.current?.removeEventListener('wheel', wheelHandler); setOverviewOhlcHover(null); overviewChartRef.current = null; overviewCandlesRef.current = null; overviewCandleDataRef.current = []; overviewBarsRef.current = []; overviewLoadingOlderRef.current = false; chart.remove(); };
    }
    const stream = createBinanceKlineStream(symbol, interval);
    const gatewayInterval = interval === '1s' ? '1m' : interval;
    fetch(`${apiUrl}/market/binance/candles/${encodeURIComponent(symbol)}?interval=${gatewayInterval}&limit=${INITIAL_CONTEXT_BARS}`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
      .then(response => response.json())
      .then(payload => {
        const rows = (payload as { bars?: Array<{ time: number; open: number; high: number; low: number; close: number }> }).bars;
        if (!active || !Array.isArray(rows)) return;
        const parsed = rows.map(row => ({ time: Number(row.time) as UTCTimestamp, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
        const hadLiveBars = overviewBarsRef.current.length > 0;
        overviewBarsRef.current = hadLiveBars ? mergeBars(overviewBarsRef.current, parsed) : parsed;
        void cacheBars(symbol, interval, parsed);
        overviewCandleDataRef.current = overviewBarsRef.current.map(({ time, close }) => ({ time, close }));
        const visibleBars = renderBars(overviewBarsRef.current, MAX_CONTEXT_RENDER_BARS);
        initializingViewport = true;
        setDataPreservingRange(showHeikinAshi ? calculateHeikinAshi(visibleBars) : visibleBars);
        applyDefaultChartViewport(chart, visibleBars, viewportBars, viewportFutureBars, viewportYBelow, viewportYAbove);
        syncViewportSnapshot(chart, visibleBars, setOverviewViewportSnapshot);
        requestAnimationFrame(() => { if (active) initializingViewport = false; });
        setTrackerRevision(value => value + 1);
      }).catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      if (replayRef.current.active) return;
      const message = JSON.parse(event.data) as { type?: string; symbol?: string; price?: number; time?: number; interval?: string; bar?: { time: number; open: number; high: number; low: number; close: number } };
      if (message.type === 'trade' && message.price && message.time) {
        binanceLivePriceRef.current = { symbol, price: Number(message.price), time: Number(message.time), receivedAt: Date.now() };
        const liveBars = mergeTickBar(overviewBarsRef.current, Number(message.time), Number(message.price), gatewayInterval === '1m' ? 60 : gatewayInterval === '3m' ? 180 : gatewayInterval === '5m' ? 300 : 900);
        const liveBar = liveBars[liveBars.length - 1];
        if (liveBar) {
          overviewBarsRef.current = mergeTickBar(overviewBarsRef.current, Number(message.time), Number(message.price), gatewayInterval === '1m' ? 60 : gatewayInterval === '3m' ? 180 : gatewayInterval === '5m' ? 300 : 900);
          overviewCandleDataRef.current = overviewBarsRef.current.map(({ time, close }) => ({ time, close }));
          if (showHeikinAshi) setDataPreservingRange(calculateHeikinAshi(renderBars(overviewBarsRef.current, MAX_CONTEXT_RENDER_BARS)));
          else candles.update(liveBar);
          updateTrackerLabels('context', liveBar.close);
          scheduleOverviewRefresh();
        }
        return;
      }
      if (message.type !== 'kline' || message.interval !== gatewayInterval || !message.bar) return;
      const candle = message.bar;
      const next = { time: Number(candle.time) as UTCTimestamp, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) };
      const isNewBar = upsertLiveBar(overviewBarsRef.current, next);
      void cacheBars(symbol, interval, [next]);
      const lastCandleData = overviewCandleDataRef.current[overviewCandleDataRef.current.length - 1];
      if (lastCandleData?.time === next.time) lastCandleData.close = next.close;
      else if (isNewBar) overviewCandleDataRef.current.push({ time: next.time, close: next.close });
      if (showHeikinAshi) setDataPreservingRange(calculateHeikinAshi(renderBars(overviewBarsRef.current, MAX_CONTEXT_RENDER_BARS)));
      else candles.update(next);
      updateTrackerLabels('context', next.close);
      scheduleOverviewRefresh();
      if (isNewBar) setTrackerRevision(value => value + 1);
    };
    return () => { active = false; stream.close(); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshOverview); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverview); chart.unsubscribeCrosshairMove(crosshairHandler); chart.unsubscribeClick(clickHandler); overviewChartContainer.current?.removeEventListener('wheel', wheelHandler); setOverviewOhlcHover(null); overviewChartRef.current = null; overviewCandlesRef.current = null; overviewCandleDataRef.current = []; overviewBarsRef.current = []; overviewLoadingOlderRef.current = false; chart.remove(); };
  }, [auth.accessToken, broker, symbol, interval, timezone, mobilePwa, showHeikinAshi]);

  useEffect(() => {
    if (!binanceRules || mobilePwa) return;
    overviewCandlesRef.current?.applyOptions({ priceFormat: { type: 'price', precision: binanceRules.price_precision, minMove: binanceRules.tick_size || 0.00000001 } });
  }, [binanceRules, mobilePwa]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    setViewportRevision(value => value + 1);
  }, [timezone]);

  function pointFromEvent(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function chartContext(canvas: ChartCanvas) {
    return canvas === 'context'
      ? { chart: overviewChartRef.current, candles: overviewCandlesRef.current }
      : { chart: chartRef.current, candles: candlesRef.current };
  }

  function chartPointFromEvent(event: PointerEvent<HTMLElement>, canvas: ChartCanvas = 'entry') {
    const point = pointFromEvent(event);
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const time = chart.timeScale().coordinateToTime(point.x);
    const price = candles.coordinateToPrice(point.y);
    if (time === null || price === null) return null;
    return { time: time as UTCTimestamp, price };
  }

  function screenPoint(point: ChartPoint, canvas: ChartCanvas = 'entry') {
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const bars = canvas === 'context' ? overviewBarsRef.current : candleBarsRef.current;
    let x = chart.timeScale().timeToCoordinate(point.time);
    // A paper position is opened on the 1m stream but is also drawn on the
    // 5m chart. Its live timestamp will often not exist as an exact 5m item;
    // project it to the nearest loaded candle instead of dropping the drawing.
    if (x === null && bars.length > 0) {
      const nearest = bars.reduce((best, bar) => Math.abs(Number(bar.time) - Number(point.time)) < Math.abs(Number(best.time) - Number(point.time)) ? bar : best, bars[0]);
      x = chart.timeScale().timeToCoordinate(nearest.time);
    }
    const y = candles.priceToCoordinate(point.price);
    return x === null || y === null ? null : { x, y };
  }

  function drawingHandles(drawing: Drawing, index: number, canvas: ChartCanvas = 'entry') {
    const start = screenPoint(drawing.start, canvas);
    const end = screenPoint(drawing.end, canvas);
    if (!start || !end) return [];
    if (drawing.type === 'line') return [
      { ...start, index, endpoint: 'start' as const, role: 'default' as const },
      { ...end, index, endpoint: 'end' as const, role: 'default' as const },
    ];
    if (drawing.type === 'ruler') {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      return [
        { x: left, y: top, index, endpoint: 'start' as const, role: 'default' as const },
        { x: right, y: top, index, endpoint: 'end' as const, role: 'default' as const },
        { x: left, y: bottom, index, endpoint: 'start' as const, role: 'default' as const },
        { x: right, y: bottom, index, endpoint: 'end' as const, role: 'default' as const },
      ];
    }
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
    if (!stop) return [];
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    if (drawing.paper && drawing.target) {
      const target = screenPoint(drawing.target, canvas);
      if (!target) return [];
      return [
        { x: left, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: right, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: left, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
        { x: right, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      ];
    }
    if (drawing.backtest && drawing.target) {
      const target = drawing.closed && drawing.status === 'CLOSED - WIN'
        ? end
        : screenPoint(drawing.target, canvas);
      const visualStop = drawing.closed && drawing.status === 'CLOSED - FAILED'
        ? end
        : stop;
      if (!target || !visualStop) return [];
      return [
        { x: left, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: right, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: left, y: visualStop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
        { x: right, y: visualStop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      ];
    }
    return [
      { x: left, y: end.y, index, endpoint: 'end' as const, role: 'target' as const },
      { x: right, y: end.y, index, endpoint: 'end' as const, role: 'target' as const },
      { x: left, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      { x: right, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
    ];
  }

  function handleAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      if (drawings[index].paper && drawings[index].closed) continue;
      if ((canvas === 'context' && drawings[index].chart !== 'context') || (canvas === 'entry' && drawings[index].chart === 'context')) continue;
      const candidates = drawingHandles(drawings[index], index, canvas).filter(candidate => !drawings[index].paper || candidate.endpoint === 'target' || candidate.endpoint === 'stop');
      const handle = candidates.find(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12);
      if (handle) return handle;
    }
    return null;
  }

  function priceLineAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      if (!drawing.paper || drawing.closed || (drawing.type !== 'long' && drawing.type !== 'short')) continue;
      if ((canvas === 'context' && drawing.chart !== 'context') || (canvas === 'entry' && drawing.chart === 'context')) continue;
      const { candles } = chartContext(canvas);
      const targetY = drawing.target && candles ? candles.priceToCoordinate(drawing.target.price) : null;
      const stopY = drawing.stop && candles ? candles.priceToCoordinate(drawing.stop.price) : null;
      if (targetY !== null && targetY !== undefined && Math.abs(point.y - targetY) <= 12) return { index, endpoint: 'target' as const };
      if (stopY !== null && stopY !== undefined && Math.abs(point.y - stopY) <= 12) return { index, endpoint: 'stop' as const };
    }
    return null;
  }

  function startPriceLineDrag(event: PointerEvent<SVGLineElement>, index: number, endpoint: 'target' | 'stop', canvas: ChartCanvas, source: 'paper' | 'binance' = 'paper') {
    event.preventDefault();
    event.stopPropagation();
    setDrawingCanvas(canvas);
    setResizeStart({ index, endpoint, source });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function renderPriceLineHitAreas(canvas: ChartCanvas) {
    const { candles } = chartContext(canvas);
    if (!candles) return null;
    const height = canvas === 'context' ? overviewSize.height : stageSize.height;
    const width = canvas === 'context' ? overviewSize.width : stageSize.width;
    const paperHitAreas = productionOnly ? [] : drawings;
    const productionHitAreas = productionOnly ? productionDrawings : [];
    return <><g className="price-indicator-layer">{renderPriceIndicators(canvas)}</g><g className="price-line-hit-areas">{paperHitAreas.map((drawing, index) => {
      if (!drawing.paper || drawing.closed || (drawing.type !== 'long' && drawing.type !== 'short')) return null;
      if (drawing.symbol && drawing.symbol !== symbol) return null;
      // A paper position is shared by both chart views.
      const targetY = drawing.target ? candles.priceToCoordinate(drawing.target.price) : null;
      const stopY = drawing.stop ? candles.priceToCoordinate(drawing.stop.price) : null;
      return <g key={`price-hit-${index}`}><line x1="0" y1={targetY ?? -100} x2={width} y2={targetY ?? -100} className="price-line-hit-target" pointerEvents="stroke" onPointerDown={event => startPriceLineDrag(event, index, 'target', canvas)} /><line x1="0" y1={stopY ?? -100} x2={width} y2={stopY ?? -100} className="price-line-hit-stop" pointerEvents="stroke" onPointerDown={event => startPriceLineDrag(event, index, 'stop', canvas)} /></g>;
    })}{productionHitAreas.map((drawing, index) => {
      if (!drawing.real || drawing.closed || (drawing.type !== 'long' && drawing.type !== 'short')) return null;
      if (drawing.symbol && drawing.symbol !== symbol) return null;
      const targetY = drawing.target ? candles.priceToCoordinate(drawing.target.price) : null;
      return <g key={`binance-price-hit-${index}`}><line x1="0" y1={targetY ?? -100} x2={width} y2={targetY ?? -100} className="price-line-hit-target" pointerEvents="stroke" onPointerDown={event => startPriceLineDrag(event, index, 'target', canvas, 'binance')} /></g>;
    })}</g></>;
  }

  function renderSessionIndicator() {
    if (!showSessions || !chartRef.current) return renderChartEventMarkers('entry');
    const range = chartRef.current.timeScale().getVisibleRange();
    if (!range) return renderChartEventMarkers('entry');
    const from = timeNumber(range.from) - 2 * 86400;
    const to = timeNumber(range.to) + 2 * 86400;
    const events: Array<{ x: number; color: string; label: string; date: string }> = [];
    for (let day = new Date(from * 1000); day.getTime() / 1000 <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      const year = day.getUTCFullYear();
      const month = day.getUTCMonth() + 1;
      const date = day.getUTCDate();
      MARKET_SESSIONS.forEach(session => {
        [[session.open, 'Open'], [session.close, 'Close']].forEach(([hour, type]) => {
          if (session.name === 'New York' && type === 'Close') return;
          const eventTime = timestampInTimezone(year, month, date, Number(hour), SESSION_TIMEZONE);
          const x = chartRef.current?.timeScale().timeToCoordinate(eventTime as UTCTimestamp);
          if (x !== null && x !== undefined) events.push({ x, color: session.color, label: `${session.name} ${type}`, date: sessionDateLabel(eventTime, timezone) });
        });
      });
    }
    return <><g className="session-indicator">{events.map((event, index) => <g key={`${event.label}-${event.x}-${index}`}><line x1={event.x} y1="0" x2={event.x} y2={stageSize.height} stroke={event.color} className="session-line" /><text x={event.x + 4} y="18" fill={event.color} className="session-label"><tspan x={event.x + 4} dy="0">{event.label}</tspan><tspan x={event.x + 4} dy="26">{event.date}</tspan></text></g>)}</g>{renderChartEventMarkers('entry')}</>;
  }

  function renderPriceIndicators(canvas: ChartCanvas) {
    void viewportRevision;
    const chart = canvas === 'entry' ? chartRef.current : overviewChartRef.current;
    const candles = canvas === 'entry' ? candlesRef.current : overviewCandlesRef.current;
    const rawBars = canvas === 'entry' ? candleBarsRef.current : overviewBarsRef.current;
    const bars = renderBars(rawBars, canvas === 'entry' ? MAX_ENTRY_RENDER_BARS : MAX_CONTEXT_RENDER_BARS);
    const width = canvas === 'entry' ? stageSize.width : overviewSize.width;
    const height = canvas === 'entry' ? stageSize.height : overviewSize.height;
    if (!chart || !candles || !bars.length || (!showRsi && !showSsl && !showTracker && !showWickExtensions && !showSevenAmMarkers)) return null;
    const rsi = showRsi ? calculateRsi(bars, rsiPeriod) : [];
    const ssl = showSsl ? calculateSslChannel(bars, sslPeriod) : { up: [], down: [], bullish: [] };
    // Wick direction is always filtered by SSL, even when the SSL lines are
    // hidden. A positive regime permits Long points; a negative regime
    // permits Short points only.
    const wickSsl = calculateSslChannel(bars, sslPeriod);
    const wickLookback = wickPeriod;
    const wickStart = Math.max(0, bars.length - (wickDisplayPeriod + wickLookback));
    const wickBars = bars.slice(wickStart);
    const wickExtensions = showWickExtensions ? calculateWickExtensions(wickBars, wickLookback, wickMultiplier) : { long: [], short: [] };
    const wickVisibleStart = Math.max(0, bars.length - wickDisplayPeriod);
    const trackerLevels = showTracker ? calculateTrackerLevels(bars, trackerPeriod) : [];
    const sevenAmWindow = calculateDailyTimeWindow(bars, SESSION_TIMEZONE);
    const toPoint = (value: number | null, index: number) => {
      if (value === null || value === undefined) return null;
      const x = chart.timeScale().timeToCoordinate(bars[index].time);
      const y = candles.priceToCoordinate(value);
      return x === null || x === undefined || y === null || y === undefined ? null : { x, y };
    };
    const path = (values: Array<number | null>) => {
      let started = false;
      return values.map((value, index) => {
      const point = toPoint(value, index);
      if (!point) return '';
      const command = started ? 'L' : 'M';
      started = true;
      return `${command} ${point.x} ${point.y}`;
      }).filter(Boolean).join(' ');
    };
    const rsiMarkers = rsi.map((value, index) => {
      if (value === null || (value > rsiLowBand && value < rsiHighBand)) return null;
      const point = toPoint(bars[index].close, index);
      if (!point) return null;
      return <circle key={`rsi-${canvas}-${bars[index].time}`} cx={point.x} cy={point.y} r="5" className="rsi-marker" pointerEvents="all" onPointerEnter={() => setIndicatorHover({ canvas, x: point.x, y: point.y, label: `RSI(${rsiPeriod}) ${value.toFixed(2)}` })} onPointerLeave={() => setIndicatorHover(null)}><title>RSI({rsiPeriod}): {value.toFixed(2)}</title></circle>;
    });
    const wickMarkers = bars.slice(wickVisibleStart).map((bar, visibleIndex) => {
      const index = wickVisibleStart + visibleIndex;
      const wickIndex = index - wickStart;
      const longPoint = toPoint(wickExtensions.long[wickIndex], index);
      const shortPoint = toPoint(wickExtensions.short[wickIndex], index);
      const longCrossed = wickExtensions.long[wickIndex] !== null && bar.low <= Number(wickExtensions.long[wickIndex]);
      const shortCrossed = wickExtensions.short[wickIndex] !== null && bar.high >= Number(wickExtensions.short[wickIndex]);
      const timeLabel = new Date(Number(bar.time) * 1000).toLocaleString('es-MX', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
      return <g key={`wick-${canvas}-${bar.time}`} className="wick-extension-markers">
        {longPoint && longCrossed && wickSsl.bullish[index] && wickSsl.regimeAge[index] >= 2 && wickSsl.regimeAge[index] <= sslRegimeWindow && <circle cx={longPoint.x} cy={longPoint.y} r="4.5" className="wick-extension-marker wick-extension-long" pointerEvents="all" onPointerEnter={() => setIndicatorHover({ canvas, x: longPoint.x, y: longPoint.y, label: `Long ${wickMultiplier.toFixed(1)}x · SSL N${wickSsl.regimeAge[index]} · ${timeLabel}` })} onPointerLeave={() => setIndicatorHover(null)}><title>Long: mecha cruzó el nivel · SSL positivo · régimen N{wickSsl.regimeAge[index]}</title></circle>}
        {shortPoint && shortCrossed && wickSsl.bullish[index] === false && wickSsl.regimeAge[index] >= 2 && wickSsl.regimeAge[index] <= sslRegimeWindow && <circle cx={shortPoint.x} cy={shortPoint.y} r="4.5" className="wick-extension-marker wick-extension-short" pointerEvents="all" onPointerEnter={() => setIndicatorHover({ canvas, x: shortPoint.x, y: shortPoint.y, label: `Short ${wickMultiplier.toFixed(1)}x · SSL N${wickSsl.regimeAge[index]} · ${timeLabel}` })} onPointerLeave={() => setIndicatorHover(null)}><title>Short: mecha cruzó el nivel · SSL negativo · régimen N{wickSsl.regimeAge[index]}</title></circle>}
      </g>;
    });
    const trackerMarkers = canvas === 'entry' && showTracker ? bars.map((bar, index) => {
      if (index >= bars.length - 1) return null;
      const level = trackerLevels[index];
      if (!level) return null;
      const signal = bar.close >= level.h1 && bar.close >= level.h2
        ? { side: 'SHORT', level: 'H2' }
        : bar.close >= level.h1 && bar.close < level.h2
          ? { side: 'SHORT', level: 'H1' }
          : bar.close <= level.l1 && bar.close > level.l2
            ? { side: 'LONG', level: 'L1' }
            : bar.close <= level.l2 && bar.close <= level.l1
              ? { side: 'LONG', level: 'L2' }
              : null;
      if (!signal) return null;
      const point = toPoint(bar.close, index);
      if (!point) return null;
      return <circle key={`tracker-signal-${bar.time}`} cx={point.x} cy={point.y} r="5" className={`tracker-signal tracker-signal-${signal.side.toLowerCase()}`}><title>Tracker {signal.side} · {signal.level} · cierre {formatPaperPrice(bar.close)}</title></circle>;
    }) : [];
    return <g className={`price-indicators price-indicators-${canvas}`}>
      {showSevenAmMarkers && <g className="seven-am-marker-layer">{bars.map((bar, index) => {
        if (!sevenAmWindow[index]) return null;
        const point = toPoint(bar.close, index);
        return point ? <circle key={`seven-am-${canvas}-${bar.time}`} cx={point.x} cy={point.y} r="6" className="ny-interest-marker"><title>Ventana 7 AM · {chartTimeLabel(bar.time, SESSION_TIMEZONE, true)}</title></circle> : null;
      })}</g>}
      {showSsl && <><path d={path(ssl.up)} className="ssl-channel ssl-channel-up" /><path d={path(ssl.down)} className="ssl-channel ssl-channel-down" /></>}
      {showRsi && <g className="rsi-markers">{rsiMarkers}</g>}
      {showTracker && <g className="tracker-signal-layer">{trackerMarkers}</g>}
      {showWickExtensions && <g className="wick-extension-layer">{wickMarkers}</g>}
      {indicatorHover?.canvas === canvas && <g className="indicator-hover-label" pointerEvents="none"><rect x={Math.max(4, Math.min(width - 160, indicatorHover.x + 10))} y={Math.max(8, Math.min(height - 32, indicatorHover.y - 28))} width="150" height="24" rx="4" /><text x={Math.max(14, Math.min(width - 150, indicatorHover.x + 20))} y={Math.max(24, Math.min(height - 16, indicatorHover.y - 12))}>{indicatorHover.label}</text></g>}
    </g>;
  }

  function renderInterestMarkers() {
    return null;
  }

  function renderChartEventMarkers(canvas: ChartCanvas) {
    if (chartEventsPaused) return null;
    const chart = canvas === 'context' ? overviewChartRef.current : chartRef.current;
    const candles = canvas === 'context' ? overviewCandlesRef.current : candlesRef.current;
    const bars = canvas === 'context' ? overviewBarsRef.current : candleBarsRef.current;
    const height = canvas === 'context' ? overviewSize.height : stageSize.height;
    if (!chart || !candles || !bars.length || !chartEventOccurrences.length) return null;
    const visibleBars = renderBars(bars, canvas === 'context' ? MAX_CONTEXT_RENDER_BARS : MAX_ENTRY_RENDER_BARS);
    const markers = chartEventOccurrences.filter(event => event.symbol === symbol).flatMap(event => {
      const bar = visibleBars.reduce((closest, candidate) => Math.abs(Number(candidate.time) - event.timestamp) < Math.abs(Number(closest.time) - event.timestamp) ? candidate : closest, visibleBars[0]);
      const x = chart.timeScale().timeToCoordinate(bar.time);
      const y = candles.priceToCoordinate(bar.close);
      return x === null || x === undefined || y === null || y === undefined ? [] : [{ event, x, y: Math.max(20, Math.min(height - 20, y)) }];
    });
    return <g className="chart-event-markers">{markers.map(({ event, x, y }) => <g key={`${canvas}-${event.id}`} className="chart-event-marker" pointerEvents="all"><line x1={x} y1="0" x2={x} y2={height} stroke={event.color} /><circle cx={x} cy={y} r="6" fill={event.color} /><path d={`M ${x - 5} ${y - 13} L ${x + 5} ${y - 13} L ${x} ${y - 5} Z`} fill={event.color} /><text x={x + 8} y={Math.max(16, y - 15)} fill={event.color}>{event.title}</text><title>{`${event.title} · ${new Date(event.timestamp * 1000).toLocaleString('es-MX')}${event.description ? ` · ${event.description}` : ''}`}</title></g>)}</g>;
  }

  function renderOverviewSessions() {
    void overviewRevision;
    if (!showSessions || !overviewChartRef.current) return renderChartEventMarkers('context');
    const range = overviewChartRef.current.timeScale().getVisibleRange();
    if (!range) return renderChartEventMarkers('context');
    const from = timeNumber(range.from) - 2 * 86400;
    const to = timeNumber(range.to) + 2 * 86400;
    const events: Array<{ x: number; color: string; label: string; date: string }> = [];
    for (let day = new Date(from * 1000); day.getTime() / 1000 <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      MARKET_SESSIONS.forEach(session => [[session.open, 'Open'], [session.close, 'Close']].forEach(([hour, type]) => {
        if (session.name === 'New York' && type === 'Close') return;
        const eventTime = timestampInTimezone(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(hour), SESSION_TIMEZONE);
        const x = overviewChartRef.current?.timeScale().timeToCoordinate(eventTime as UTCTimestamp);
        if (x !== null && x !== undefined) events.push({ x, color: session.color, label: `${session.name} ${type}`, date: sessionDateLabel(eventTime, timezone) });
      }));
    }
    return <><g className="session-indicator">{events.map((event, index) => <g key={`${event.label}-${event.x}-${index}`}><line x1={event.x} y1="0" x2={event.x} y2={overviewSize.height} stroke={event.color} className="session-line" /><text x={event.x + 4} y="18" fill={event.color} className="session-label"><tspan x={event.x + 4} dy="0">{event.label}</tspan><tspan x={event.x + 4} dy="26">{event.date}</tspan></text></g>)}</g>{renderChartEventMarkers('context')}</>;
  }

  function renderOverviewInterestMarkers() {
    return null;
  }

  function drawingAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      if (drawing.paper) continue;
      if ((canvas === 'context' && drawing.chart !== 'context') || (canvas === 'entry' && drawing.chart === 'context')) continue;
      const start = screenPoint(drawing.start, canvas);
      const end = screenPoint(drawing.end, canvas);
      if (!start || !end) continue;
      if (drawing.type === 'ruler') {
        const left = Math.min(start.x, end.x) - 8;
        const right = Math.max(start.x, end.x) + 8;
        const top = Math.min(start.y, end.y) - 8;
        const bottom = Math.max(start.y, end.y) + 8;
        if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return index;
      } else if (drawing.type === 'line') {
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const distance = Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / length;
        if (distance <= 10) return index;
      } else {
        const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
        const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
        if (stop && point.x >= Math.min(start.x, end.x) - 8 && point.x <= Math.max(start.x, end.x) + 8 && point.y >= Math.min(start.y, end.y, stop.y) - 8 && point.y <= Math.max(start.y, end.y, stop.y) + 8) return index;
      }
    }
    return null;
  }

  function startDrawing(event: PointerEvent<HTMLElement>, canvas: ChartCanvas = 'entry') {
    if ((event.target as HTMLElement).closest('.price-line-hit-target, .price-line-hit-stop')) return;
    if ((event.target as HTMLElement).closest('button')) return;
    setDrawingCanvas(canvas);
    const point = pointFromEvent(event);
    if (tool === 'pan') {
      const { chart, candles } = chartContext(canvas);
      const xRange = chart?.timeScale().getVisibleLogicalRange();
      const priceRange = chart?.priceScale('right').getVisibleRange();
      const xLogical = chart?.timeScale().coordinateToLogical(point.x);
      const xLogicalNext = chart?.timeScale().coordinateToLogical(point.x + 1);
      const yPrice = candles?.coordinateToPrice(point.y);
      if (chart && candles && xLogical !== null && xLogical !== undefined && xLogicalNext !== null && xLogicalNext !== undefined && yPrice !== null && yPrice !== undefined && xRange && priceRange) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        panStartRef.current = { canvas, x: point.x, y: point.y, xLogicalPerPixel: Number(xLogicalNext) - Number(xLogical), startPrice: yPrice, xRange, priceRange };
      }
      return;
    }
    if (tool === 'zoom') {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setLassoStart(point);
      setLassoEnd(point);
      return;
    }
    const handle = handleAt(point, canvas);
    if (handle) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizeStart({ index: handle.index, endpoint: handle.endpoint });
      if (!drawings[handle.index].paper) setSelectedDrawing(handle.index);
      return;
    }
    const priceLine = priceLineAt(point, canvas);
    if (priceLine) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizeStart(priceLine);
      return;
    }
    if (!tool) {
      const hit = drawingAt(point, canvas);
      setSelectedDrawing(hit);
      setSelectedDrawings(hit === null ? [] : [hit]);
      if (hit !== null) {
        const chartPoint = chartPointFromEvent(event, canvas);
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
    const chartPoint = chartPointFromEvent(event, canvas);
    if (chartPoint) {
      setDrawingStart(chartPoint);
      setDrawingEnd(chartPoint);
    }
  }

  function updateDrawing(event: PointerEvent<HTMLElement>) {
    if (lassoStart) {
      setLassoEnd(pointFromEvent(event));
      return;
    }
    if (panStartRef.current) {
      const point = pointFromEvent(event);
      const pan = panStartRef.current;
      const { chart, candles } = chartContext(pan.canvas);
      const currentPrice = candles?.coordinateToPrice(point.y);
      if (chart && currentPrice !== null && currentPrice !== undefined) {
        const xDelta = -(point.x - pan.x) * pan.xLogicalPerPixel;
        const yDelta = pan.startPrice - Number(currentPrice);
        // Apply both axes from the original range in one pass. Reading the
        // already-shifted range here causes diagonal drags to oscillate.
        chart.timeScale().setVisibleLogicalRange({ from: pan.xRange.from + xDelta, to: pan.xRange.to + xDelta });
        chart.priceScale('right').setVisibleRange({ from: pan.priceRange.from + yDelta, to: pan.priceRange.to + yDelta });
      }
      return;
    }
    if (moveStart) {
      const point = chartPointFromEvent(event, drawingCanvas);
      if (!point) return;
      const timeDelta = Number(point.time) - Number(moveStart.point.time);
      const priceDelta = point.price - moveStart.point.price;
      const shift = (value: ChartPoint): ChartPoint => ({ time: (Number(value.time) + timeDelta) as UTCTimestamp, price: value.price + priceDelta });
      setDrawings(current => current.map((drawing, index) => index === moveStart.index ? { ...drawing, start: shift(moveStart.drawing.start), end: shift(moveStart.drawing.end), stop: moveStart.drawing.stop ? shift(moveStart.drawing.stop) : undefined } : drawing));
      return;
    }
    if (resizeStart) {
      const point = pointFromEvent(event);
      const { candles } = chartContext(drawingCanvas);
      const price = candles?.coordinateToPrice(point.y);
      if (price === null || price === undefined) return;
      const resize = resizeStart;
      if (resize.source === 'binance' && resize.endpoint === 'target') {
        const drawing = productionDrawings[resize.index];
        if (!drawing || !drawing.symbol || !drawing.stop) return;
        const boundedPrice = drawing.type === 'long' ? Math.max(price, drawing.stop.price) : Math.min(price, drawing.stop.price);
        const next = { symbol: drawing.symbol, price: boundedPrice };
        pendingBinanceTpRef.current = next;
        setPendingBinanceTp(next);
        return;
      }
      setDrawings(current => current.map((drawing, index) => {
        if (index !== resize.index || drawing.closed) return drawing;
        if (resize.endpoint === 'target' && drawing.paper && drawing.target && drawing.stop) {
          const boundedPrice = drawing.type === 'long' ? Math.max(price, drawing.stop.price) : Math.min(price, drawing.stop.price);
          return { ...drawing, target: { ...drawing.target, price: boundedPrice } };
        }
        if (resize.endpoint === 'stop' && drawing.stop) {
          const boundary = drawing.paper && drawing.target ? drawing.target.price : drawing.start.price;
          const boundedPrice = drawing.type === 'long' ? Math.min(price, boundary) : Math.max(price, boundary);
          return { ...drawing, stop: { ...drawing.stop, price: boundedPrice } };
        }
        return drawing;
      }));
      return;
    }
    if (!tool || !drawingStart || resizeStart) return;
    const point = chartPointFromEvent(event, drawingCanvas);
    if (point) setDrawingEnd(point);
  }

  function finishDrawing(event: PointerEvent<HTMLElement>) {
    if (lassoStart) {
      const end = pointFromEvent(event);
      const left = Math.min(lassoStart.x, end.x);
      const right = Math.max(lassoStart.x, end.x);
      const top = Math.min(lassoStart.y, end.y);
      const bottom = Math.max(lassoStart.y, end.y);
      if (tool === 'zoom') {
        const { chart, candles } = chartContext(drawingCanvas);
        const from = chart?.timeScale().coordinateToLogical(left);
        const to = chart?.timeScale().coordinateToLogical(right);
        const yTop = candles?.coordinateToPrice(top);
        const yBottom = candles?.coordinateToPrice(bottom);
        if (chart && from !== null && from !== undefined && to !== null && to !== undefined && yTop !== null && yTop !== undefined && yBottom !== null && yBottom !== undefined && Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(yTop) && Number.isFinite(yBottom)) {
          chart.timeScale().setVisibleLogicalRange({ from: Math.min(Number(from), Number(to)), to: Math.max(Number(from), Number(to)) });
          chart.priceScale('right').setVisibleRange({ from: Math.min(Number(yTop), Number(yBottom)), to: Math.max(Number(yTop), Number(yBottom)) });
        }
        setLassoStart(null);
        setLassoEnd(null);
        setTool(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        return;
      }
      const matches = drawings.map((drawing, index) => ({ drawing, index })).filter(({ drawing }) => {
        if (drawing.paper || (drawingCanvas === 'context' && drawing.chart !== 'context') || (drawingCanvas === 'entry' && drawing.chart === 'context')) return false;
        const points = [drawing.start, drawing.end, ...(drawing.stop ? [drawing.stop] : []), ...(drawing.target ? [drawing.target] : [])].map(point => screenPoint(point, drawingCanvas));
        return points.some(point => point !== null && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom);
      }).map(({ index }) => index);
      setSelectedDrawings(matches);
      setSelectedDrawing(matches[0] ?? null);
      setLassoStart(null);
      setLassoEnd(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (panStartRef.current) {
      panStartRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (moveStart) {
      updateDrawing(event);
      setMoveStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (resizeStart) {
      updateDrawing(event);
      setResizeStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!tool || tool === 'pan' || !drawingStart) return;
    event.preventDefault();
    event.stopPropagation();
    const end = chartPointFromEvent(event, drawingCanvas);
    if (!end) return;
    const positionEnd = tool === 'long'
      ? { ...end, price: Math.max(end.price, drawingStart.price) }
      : tool === 'short'
        ? { ...end, price: Math.min(end.price, drawingStart.price) }
        : end;
    const stopPrice = drawingStart.price - (positionEnd.price - drawingStart.price) / 4;
    const stop = tool === 'long' || tool === 'short' ? { time: positionEnd.time, price: stopPrice } : undefined;
    setDrawings(current => [...current, { type: tool, chart: drawingCanvas, start: drawingStart, end: positionEnd, stop }]);
    setDrawingStart(null);
    setDrawingEnd(null);
    setTool(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function openSimulatedPosition(type: 'long' | 'short') {
    if (!auth.accessToken || !paperReadyRef.current) {
      setPaperSyncError('La cuenta paper todavía está cargando.');
      return;
    }
    // A new operation replaces the active visual focus; do not keep the last
    // closed operation pinned on the chart while the new one is created.
    setVisibleClosedId(null);
    const latest = candleDataRef.current[candleDataRef.current.length - 1];
    if (!latest) return;
    const marketPrice = broker === 'binance' ? (binanceLivePriceRef.current?.price ?? latest.close) : latest.close;
    const entry = broker === 'binance' && binanceRules?.tick_size
      ? roundToBinance(marketPrice, binanceRules.tick_size, binanceRules.price_precision)
      : latest.close;
    const direction = type === 'long' ? 1 : -1;
    const recommendation = labRecommendations?.[type];
    const storedAssist = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { stopPercent?: number; targetPercent?: number };
    const stopDistance = broker === 'binance'
      ? binanceStopPercent / 100
      : recommendation?.mae
        ? recommendation.mae / 100
        : Number.isFinite(storedAssist.stopPercent) && (storedAssist.stopPercent ?? 0) > 0
          ? (storedAssist.stopPercent as number) / 100
          : 0.00087;
    const targetDistance = broker === 'binance'
      ? binanceTargetPercent / 100
      : recommendation?.mfe ? recommendation.mfe / 100 : Number.isFinite(storedAssist.targetPercent) && (storedAssist.targetPercent ?? 0) > 0 ? (storedAssist.targetPercent as number) / 100 : stopDistance * 4;
    const rawTarget = entry * (1 + direction * targetDistance);
    const rawStop = entry * (1 - direction * stopDistance);
    const target = broker === 'binance' && binanceRules?.tick_size ? roundToBinance(rawTarget, binanceRules.tick_size, binanceRules.price_precision) : rawTarget;
    const stop = broker === 'binance' && binanceRules?.tick_size ? roundToBinance(rawStop, binanceRules.tick_size, binanceRules.price_precision) : rawStop;
    const intervalSeconds = 60;
    const futureTime = (Number(latest.time) + intervalSeconds * 5) as UTCTimestamp;
    const riskPercent = Number((JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { riskPercent?: number }).riskPercent) || paperRiskPercent;
    const riskAmount = paperInitialBalance * riskPercent / 100;
    const stopPercent = Math.abs(entry - stop) / entry;
    // Binance risk is defined by the price excursion (MAE). Fees and
    // slippage are settled separately in PNL; they must not shrink the
    // crypto exposure target. cTrader keeps its existing fee-aware sizing.
    const sizingStop = broker === 'binance' ? stopPercent : stopPercent + tradingCostRate(broker);
    const riskBoundNotional = sizingStop > 0 ? riskAmount / sizingStop : 0;
    const operationLeverage = Math.min(recommendation?.leverage ?? paperLeverage, brokerMaxLeverage);
    const maximumBinanceLeverage = maxLeverageFor('binance', symbol);
    const requestedBinanceLeverage = binanceSizingMode === 'maximum'
      ? Math.floor(Math.max(BINANCE_MIN_OPERATION_LEVERAGE, maximumBinanceLeverage))
      : BINANCE_MIN_OPERATION_LEVERAGE;
    const effectiveLeverage = broker === 'binance'
      ? Math.min(requestedBinanceLeverage, maximumBinanceLeverage)
      : operationLeverage;
    // Minimum mode uses Binance's minimum notional. Maximum mode sizes the
    // position up to the 1% balance budget, including estimated round-trip
    // fees/slippage, while respecting the available margin and leverage.
    const binanceAvailableBalance = Number(binanceLiveAccount?.available_balance ?? binanceSymbolConfig?.futures_balance ?? 0);
    const binanceRiskBudget = riskBalanceForSizing * riskPercent / 100;
    const binanceCostRate = tradingCostRate('binance');
    const riskBoundBinanceNotional = (stopPercent + binanceCostRate) > 0 ? binanceRiskBudget / (stopPercent + binanceCostRate) : 0;
    const usableBinanceMargin = binanceAvailableBalance > 0 ? Math.max(0, binanceAvailableBalance - BINANCE_MARGIN_RESERVE_USDT) : 0;
    const maximumAffordableNotional = usableBinanceMargin * effectiveLeverage;
    const requestedNotional = broker === 'binance' && binanceRules
      ? binanceSizingMode === 'minimum'
        ? binanceRules.min_notional
        : Math.min(Math.max(binanceRules.min_notional, riskBoundBinanceNotional), maximumAffordableNotional || Math.max(binanceRules.min_notional, riskBoundBinanceNotional))
      : Math.min(riskBoundNotional, paperInitialBalance * effectiveLeverage);
    const quantity = broker === 'binance' && binanceRules
      ? (() => {
        const roundedUp = roundUpToBinance(requestedNotional / entry, binanceRules.step_size, binanceRules.quantity_precision);
        const roundedDown = roundToBinance(requestedNotional / entry, binanceRules.step_size, binanceRules.quantity_precision);
        const roundedUpMargin = effectiveLeverage > 0 ? roundedUp * entry / effectiveLeverage : 0;
        return binanceAvailableBalance > 0 && roundedUpMargin > usableBinanceMargin ? roundedDown : roundedUp;
      })()
      : (entry > 0 ? requestedNotional / entry : 0);
    const notional = quantity * entry;
    if (broker === 'binance' && binanceRules && (quantity < binanceRules.min_qty || notional < binanceRules.min_notional)) {
      setPaperSyncError(`La operación mínima de ${symbol} requiere ${binanceRules.min_notional.toFixed(2)} USDT de notional.`);
      return;
    }
    const margin = effectiveLeverage > 0 ? notional / effectiveLeverage : 0;
    if (broker === 'binance' && binanceAvailableBalance > 0 && margin > usableBinanceMargin + 1e-8) {
      setPaperSyncError(`El margin calculado (${margin.toFixed(4)} USDT) supera el margin utilizable (${usableBinanceMargin.toFixed(4)} USDT); se reserva ${BINANCE_MARGIN_RESERVE_USDT.toFixed(2)} USDT.`);
      return;
    }
    let paperEntry = entry;
    let paperStop = stop;
    let paperTarget = target;
    let paperNotional = notional;
    let paperMargin = margin;
    if (broker === 'binance' && executionMode === 'production') {
      try {
        const realResponse = await fetch(`${apiUrl}/trading/binance/real/operations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            symbol,
            side: type.toUpperCase(),
            quantity,
            stop_loss: stop,
            take_profit: target,
            stop_percent: binanceStopPercent,
            target_percent: binanceTargetPercent,
            leverage: effectiveLeverage,
            confirmed: true,
          }),
        });
        const realPayload = await realResponse.json() as { detail?: string; entry?: { avgPrice?: string; price?: string } };
        if (!realResponse.ok) throw new Error(realPayload.detail ?? 'Binance rechazó la orden real.');
        const averageOpen = Number(realPayload.entry?.avgPrice ?? realPayload.entry?.price ?? 0);
        if (averageOpen > 0 && binanceRules?.tick_size) {
          paperEntry = roundToBinance(averageOpen, binanceRules.tick_size, binanceRules.price_precision);
          paperStop = roundToBinance(paperEntry * (1 - direction * stopDistance), binanceRules.tick_size, binanceRules.price_precision);
          paperTarget = roundToBinance(paperEntry * (1 + direction * targetDistance), binanceRules.tick_size, binanceRules.price_precision);
          paperNotional = quantity * paperEntry;
          paperMargin = effectiveLeverage > 0 ? paperNotional / effectiveLeverage : 0;
        }
      } catch (reason) {
        setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudo abrir la operación real en Binance.');
        return;
      }
      // In production the Binance position is rendered directly from the
      // account stream. Do not create a second Paper database operation.
      setPaperSyncError('');
      return;
    }
    const response = await fetch(`${apiUrl}/trading/paper/operations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      credentials: 'include',
    body: JSON.stringify({ symbol, side: type, chart: 'entry', entry_time: Number(latest.time), entry_price: paperEntry, current_time: Number(latest.time), current_price: paperEntry, stop_time: Number(futureTime), stop_price: paperStop, target_time: Number(futureTime), target_price: paperTarget, risk_percent: riskPercent, quantity, notional: paperNotional, margin: paperMargin, pnl: 0, status: 'OPEN', close_reason: null }),
    });
    if (!response.ok) {
      setPaperSyncError('No se pudo guardar la paper operation.');
      return;
    }
    const saved = await response.json() as { id: string };
    const position: Drawing = {
      id: saved.id, symbol, type, paper: true, status: 'OPEN', quantity,
      start: { time: latest.time, price: paperEntry },
      end: { time: latest.time, price: paperEntry },
      stop: { time: futureTime, price: paperStop },
      target: { time: futureTime, price: paperTarget },
      riskPercent, notional: paperNotional, margin: paperMargin, pnl: 0,
    };
    setDrawings(current => {
      const next = [...current, position];
      setVisibleClosedId(null);
      activePositionIndexRef.current = next.length - 1;
      setActivePositionIndex(next.length - 1);
      setSelectedDrawing(null);
      return next;
    });
    setPaperSyncError('');
  }

  async function closeBinancePosition(position: BinancePosition) {
    if (!auth.accessToken || !position.symbol || binanceCloseBusy) return;
    if (!window.confirm(`¿Cerrar la posición REAL de ${position.symbol} en Binance?`)) return;
    setBinanceCloseBusy(position.symbol);
    setPaperSyncError('');
    try {
      const response = await fetch(`${apiUrl}/trading/binance/real/operations/${encodeURIComponent(position.symbol)}/close`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ confirmed: true }),
      });
      const payload = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? 'Binance no pudo cerrar la posición.');
      setBinanceLiveAccount(current => current ? { ...current, positions: (current.positions ?? []).filter(item => item.symbol !== position.symbol) } : current);
      setPaperSyncError('');
    } catch (reason) {
      setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudo cerrar la posición real.');
    } finally {
      setBinanceCloseBusy(null);
    }
  }

  async function confirmBinanceTakeProfit() {
    const draft = pendingBinanceTpRef.current;
    if (!draft || !auth.accessToken) return;
    try {
      const response = await fetch(`${apiUrl}/trading/binance/real/operations/${encodeURIComponent(draft.symbol)}/take-profit`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ take_profit: draft.price, confirmed: true }),
      });
      const payload = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? 'Binance no pudo actualizar el TP.');
      pendingBinanceTpRef.current = null;
      setPendingBinanceTp(null);
      setPaperSyncError('');
    } catch (reason) {
      setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudo actualizar el TP real.');
    }
  }

  async function closePaperPosition(position: Drawing) {
    if (!position.id || position.closed || !auth.accessToken) return;
    const direction = position.type === 'long' ? 1 : -1;
    const priceChange = ((position.end.price - position.start.price) / position.start.price) * direction;
    const status = priceChange >= 0 ? 'CLOSED - WIN' : 'CLOSED - FAILED';
    const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
    const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
    const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
      ? position.notional as number
      : Math.min(stopPercent > 0 ? paperRiskAmount / stopPercent : 0, paperInitialBalance * paperLeverage);
    const grossPnl = priceChange * notional;
    const costs = tradingCosts(broker, notional);
    const pnl = grossPnl - costs.total;
    const response = await fetch(`${apiUrl}/trading/paper/operations/${position.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        symbol: position.symbol ?? symbol,
        side: position.type,
        chart: position.chart === 'context' ? 'context' : 'entry',
        entry_time: Number(position.start.time), entry_price: position.start.price,
        current_time: Number(position.end.time), current_price: position.end.price,
        stop_time: Number(position.stop?.time ?? position.end.time), stop_price: position.stop?.price ?? position.start.price,
        target_time: Number(position.target?.time ?? position.end.time), target_price: position.target?.price ?? position.end.price,
        risk_percent: position.riskPercent ?? paperRiskPercent, quantity: position.quantity ?? (position.start.price > 0 ? notional / position.start.price : 0), notional, margin: position.margin ?? (paperLeverage > 0 ? notional / paperLeverage : 0), pnl,
        status, close_reason: 'MANUAL',
      }),
    });
    if (!response.ok) {
      setPaperSyncError('No se pudo cerrar la paper position.');
      return;
    }
    setDrawings(current => current.map(drawing => drawing.id === position.id ? { ...drawing, closed: true, status, closeReason: 'MANUAL', notional, margin: position.margin ?? (paperLeverage > 0 ? notional / paperLeverage : 0), pnl } : drawing));
    setVisibleClosedId(null);
    setActivePositionIndex(null);
    setSelectedDrawing(null);
    setPaperTab('closed');
  }

  async function deletePaperPosition(position: Drawing) {
    if (!position.id || !position.closed || !auth.accessToken) return;
    const response = await fetch(`${apiUrl}/trading/paper/operations/${position.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${auth.accessToken}` }, credentials: 'include',
    });
    if (!response.ok) {
      setPaperSyncError('No se pudo borrar la paper operation cerrada.');
      return;
    }
    setDrawings(current => current.filter(drawing => drawing.id !== position.id));
    if (visibleClosedId === position.id) setVisibleClosedId(null);
  }

  function chooseTool(key: 'line' | 'ruler' | 'long' | 'short' | 'zoom' | 'pan') {
    setTool(tool === key ? null : key);
  }

  function captureChartViewport(canvas: ChartCanvas) {
    const { chart } = chartContext(canvas);
    const data = canvas === 'entry' ? candleBarsRef.current : overviewBarsRef.current;
    if (chart && data.length > 0) syncViewportSnapshot(chart, data, canvas === 'entry' ? setEntryViewportSnapshot : setOverviewViewportSnapshot);
  }

  function finishDrawingAndCapture(event: PointerEvent<HTMLElement>, canvas: ChartCanvas) {
    finishDrawing(event);
    requestAnimationFrame(() => captureChartViewport(canvas));
  }

  const productionPositions = (binanceLiveAccount?.positions ?? []).filter(position => Math.abs(Number(position.quantity ?? 0)) > 0);
  const productionDrawings: Drawing[] = productionPositions.map((position, index) => {
    const quantity = Number(position.quantity ?? 0);
    const type: 'long' | 'short' = quantity >= 0 ? 'long' : 'short';
    const matchingIntent = binanceExecutionIntents.find(item => item.symbol === position.symbol && item.side === (type === 'long' ? 'LONG' : 'SHORT'))
      ?? binanceExecutionIntents.find(item => item.symbol === position.symbol);
    const entry = Number(matchingIntent?.entry_price ?? position.entry_price ?? 0);
    const current = Number(position.mark_price ?? 0) || binanceLivePriceRef.current?.price || entry;
    const lastTime = candleBarsRef.current[candleBarsRef.current.length - 1]?.time ?? (Math.floor(Date.now() / 1000) as UTCTimestamp);
    // The exchange position is authoritative for existence. Keep the latest
    // matching intent even when it temporarily carries ERROR/CLOSING, so an
    // already-open real position never loses its visual SL/TP levels.
    const intent = matchingIntent && matchingIntent.stop_loss && matchingIntent.take_profit ? matchingIntent : binanceExecutionIntents.find(item => item.symbol === position.symbol && item.side === (type === 'long' ? 'LONG' : 'SHORT') && item.stop_loss && item.take_profit)
      ?? binanceExecutionIntents.find(item => item.symbol === position.symbol && item.stop_loss && item.take_profit);
    const parsedEntryTime = Number(matchingIntent?.entry_time ?? 0);
    const entryTime = parsedEntryTime > 0 ? parsedEntryTime as UTCTimestamp : lastTime;
    const stop = Number(intent?.stop_loss ?? entry * (1 - (type === 'long' ? 1 : -1) * FIXED_BINANCE_STOP_PERCENT / 100));
    const draftTarget = pendingBinanceTp && pendingBinanceTp.symbol === position.symbol ? pendingBinanceTp.price : undefined;
    const target = Number(draftTarget ?? intent?.take_profit ?? entry * (1 + (type === 'long' ? 1 : -1) * FIXED_BINANCE_TARGET_PERCENT / 100));
    return { id: `binance-real-${position.symbol}-${index}`, symbol: position.symbol, type, paper: true, real: true, status: 'OPEN', quantity: Math.abs(quantity), start: { time: entryTime, price: entry }, end: { time: lastTime, price: current }, stop: { time: lastTime, price: stop }, target: { time: lastTime, price: target }, notional: Math.abs(quantity) * entry, margin: Number(position.isolated_wallet ?? 0) || Math.abs(quantity) * entry / BINANCE_MIN_OPERATION_LEVERAGE, pnl: Number(position.unrealized_pnl ?? 0), riskPercent: binanceStopPercent };
  });
      const paperPositions = drawings.filter(drawing => drawing.paper && (drawing.type === 'long' || drawing.type === 'short'));
  const assist = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { leverage?: number };
  const theoreticalPaperLeverage = Number.isFinite(assist.leverage) && (assist.leverage ?? 0) > 0 ? (assist.leverage as number) : 10;
  const brokerMaxLeverage = maxLeverageFor(broker, symbol);
  const paperLeverage = Math.min(theoreticalPaperLeverage, brokerMaxLeverage);
  const paperRiskAmount = paperInitialBalance * paperRiskPercent / 100;
  const paperPnl = (position: Drawing) => {
    if (position.real && Number.isFinite(position.pnl)) return position.pnl as number;
    const maxLoss = Math.max(0, paperRiskAmount);
    if (position.closed && Number.isFinite(position.pnl)) return position.pnl as number;
    const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
    const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
    const calculatedNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
    const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
      ? position.notional as number
      : Math.min(calculatedNotional, paperInitialBalance * paperLeverage);
    const direction = position.type === 'long' ? 1 : -1;
    const grossPnl = ((position.end.price - position.start.price) / position.start.price) * direction * notional;
    const costs = tradingCosts(broker, notional);
    return Math.max(-maxLoss - costs.total, grossPnl - costs.total);
  };
  const realizedPnl = paperPositions.filter(position => position.closed).reduce((sum, position) => sum + paperPnl(position), 0);
  const unrealizedPnl = paperPositions.filter(position => !position.closed).reduce((sum, position) => sum + paperPnl(position), 0);
  const paperCosts = paperPositions.reduce((sum, position) => {
    const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
    const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
    const calculatedNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
    const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
      ? position.notional as number
      : Math.min(calculatedNotional, paperInitialBalance * paperLeverage);
    return sum + tradingCosts(broker, notional).total;
  }, 0);
  const paperEquity = paperInitialBalance + realizedPnl + unrealizedPnl;
  const productionOnly = broker === 'binance' && executionMode === 'production';
  productionDrawingsRef.current = productionDrawings;
  productionOnlyRef.current = productionOnly;
  const displayedBinanceClosedIntents = paperTab === 'closed' ? binanceExecutionIntents.filter(intent => intent.status === 'CLOSED') : [];
  const closedBinanceDrawings: Drawing[] = displayedBinanceClosedIntents.map((intent, index) => ({
    id: `binance-history-${intent.id ?? index}`, symbol: intent.symbol, type: String(intent.side ?? '').toLowerCase() === 'long' ? 'long' : 'short',
    paper: true, real: true, closed: true, status: 'CLOSED - WIN', quantity: Number(intent.quantity ?? 0),
    start: { time: Math.floor(Date.now() / 1000) as UTCTimestamp, price: 0 }, end: { time: Math.floor(Date.now() / 1000) as UTCTimestamp, price: 0 },
    stop: { time: Math.floor(Date.now() / 1000) as UTCTimestamp, price: Number(intent.stop_loss ?? 0) }, target: { time: Math.floor(Date.now() / 1000) as UTCTimestamp, price: Number(intent.take_profit ?? 0) },
  }));
  const displayedPaperPositions = [...(productionOnly ? [] : paperPositions), ...closedBinanceDrawings].filter(position => paperTab === 'open' ? !position.closed : position.closed);
  const displayedBinancePositions = paperTab === 'open'
    ? (binanceLiveAccount?.positions ?? []).filter(position => Math.abs(Number(position.quantity ?? 0)) > 0)
    : [];
  const calendarDayKey = (timestamp: UTCTimestamp) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Number(timestamp) * 1000));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const pnlByCalendarDay = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>();
  paperPositions.filter(position => position.closed).forEach(position => {
    const key = calendarDayKey(position.end.time);
    const current = pnlByCalendarDay.get(key) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
    const pnl = paperPnl(position);
    current.pnl += pnl;
    current.trades += 1;
    if (pnl >= 0) current.wins += 1; else current.losses += 1;
    pnlByCalendarDay.set(key, current);
  });
  const calendarMonthKey = `${pnlCalendarMonth.year}-${String(pnlCalendarMonth.month + 1).padStart(2, '0')}`;
  const calendarMonthPnl = Array.from(pnlByCalendarDay.entries()).filter(([key]) => key.startsWith(`${calendarMonthKey}-`)).reduce((sum, [, value]) => sum + value.pnl, 0);
  const calendarMonthTrades = Array.from(pnlByCalendarDay.entries()).filter(([key]) => key.startsWith(`${calendarMonthKey}-`)).reduce((sum, [, value]) => sum + value.trades, 0);
  const calendarMonthWins = Array.from(pnlByCalendarDay.entries()).filter(([key]) => key.startsWith(`${calendarMonthKey}-`)).reduce((sum, [, value]) => sum + value.wins, 0);
  const calendarMonthDays = new Date(pnlCalendarMonth.year, pnlCalendarMonth.month + 1, 0).getDate();
  const calendarFirstDay = (new Date(pnlCalendarMonth.year, pnlCalendarMonth.month, 1).getDay() + 6) % 7;
  const calendarMonthLabel = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(new Date(pnlCalendarMonth.year, pnlCalendarMonth.month, 15));
  const changeCalendarMonth = (delta: number) => setPnlCalendarMonth(current => {
    const next = new Date(current.year, current.month + delta, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });
  const pnlCalendarModal = showPnlCalendar && <div className="pnl-calendar-backdrop" role="presentation" onClick={() => setShowPnlCalendar(false)}><section className="pnl-calendar-modal" role="dialog" aria-modal="true" aria-labelledby="pnl-calendar-title" onClick={event => event.stopPropagation()}><div className="pnl-calendar-head"><div><span className="positions-kicker">PAPER · PNL LEDGER</span><h2 id="pnl-calendar-title">Calendario PNL</h2><p>Resultado neto por día · {timezone === 'America/Mexico_City' ? 'Ciudad de México' : timezone}</p></div><button type="button" onClick={() => setShowPnlCalendar(false)} aria-label="Cerrar calendario">×</button></div><div className="pnl-calendar-summary"><div><small>PNL del mes</small><strong className={calendarMonthPnl >= 0 ? 'value-positive' : 'value-negative'}>{calendarMonthPnl >= 0 ? '+' : ''}{calendarMonthPnl.toFixed(2)} USDT</strong></div><div><small>Operaciones cerradas</small><strong>{calendarMonthTrades}</strong></div><div><small>Win rate</small><strong>{calendarMonthTrades ? `${((calendarMonthWins / calendarMonthTrades) * 100).toFixed(1)}%` : '—'}</strong></div></div><div className="pnl-calendar-toolbar"><button type="button" onClick={() => changeCalendarMonth(-1)} aria-label="Mes anterior">‹</button><strong>{calendarMonthLabel.charAt(0).toUpperCase() + calendarMonthLabel.slice(1)}</strong><button type="button" onClick={() => changeCalendarMonth(1)} aria-label="Mes siguiente">›</button><button type="button" onClick={() => { const now = new Date(); setPnlCalendarMonth({ year: now.getFullYear(), month: now.getMonth() }); }}>Hoy</button></div><div className="pnl-calendar-grid pnl-calendar-weekdays">{['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <span key={day}>{day}</span>)}</div><div className="pnl-calendar-grid">{Array.from({ length: calendarFirstDay }, (_, index) => <div key={`empty-${index}`} className="pnl-calendar-day pnl-calendar-empty" />)}{Array.from({ length: calendarMonthDays }, (_, index) => { const day = index + 1; const key = `${calendarMonthKey}-${String(day).padStart(2, '0')}`; const result = pnlByCalendarDay.get(key); const dayClass = result ? result.pnl >= 0 ? 'pnl-calendar-profit' : 'pnl-calendar-loss' : 'pnl-calendar-neutral'; return <div key={key} className={`pnl-calendar-day ${dayClass}`}><b>{day}</b>{result ? <><strong>{result.pnl >= 0 ? '+' : ''}{result.pnl.toFixed(2)}</strong><small>{result.trades} {result.trades === 1 ? 'operación' : 'operaciones'}</small></> : <small>—</small>}</div>; })}</div></section></div>;
  const recentClosedPositions = paperPositions.filter(position => position.closed).sort((left, right) => Number(right.end.time) - Number(left.end.time)).slice(0, 5);
  const recentClosedPanel = paperTab === 'open' && recentClosedPositions.length > 0 && <div className="recent-closed-panel"><div className="recent-closed-head"><strong>Últimas 5 cerradas</strong><small>Más recientes por hora de cierre</small></div><div className="positions-table-scroll"><table className="positions-table recent-closed-table"><thead><tr><th>Instrumento</th><th>Lado</th><th>Cierre</th><th>PNL neto</th></tr></thead><tbody>{recentClosedPositions.map((position, index) => { const positionSymbol = position.symbol ?? symbol; const pnl = paperPnl(position); return <tr key={`${position.id ?? position.start.time}-${index}`}><td><button type="button" className="paper-symbol-link" onClick={() => { setSymbol(positionSymbol); localStorage.setItem('helloworld-selected-symbol', positionSymbol); }}>{positionSymbol}</button></td><td><span className={`position-side ${position.type}`}>{position.type.toUpperCase()}</span></td><td>{chartTimeLabel(position.end.time, timezone, true)}</td><td className={pnl >= 0 ? 'value-positive' : 'value-negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(8)} USDT</td></tr>; })}</tbody></table></div></div>;
  const paperStatsSource = paperPositions.filter(position => position.closed && !position.real);
  const paperStatsPositions = paperStatsSource.filter(position => {
    const positionDay = calendarDayKey(position.end.time);
    return (paperStatsSymbol === 'ALL' || (position.symbol ?? symbol) === paperStatsSymbol) && (!paperStatsFrom || positionDay >= paperStatsFrom) && (!paperStatsTo || positionDay <= paperStatsTo);
  });
  const paperStatsPnls = paperStatsPositions.map(position => paperPnl(position));
  const paperStatsWins = paperStatsPnls.filter(pnl => pnl > 0);
  const paperStatsLosses = paperStatsPnls.filter(pnl => pnl < 0);
  const paperStatsGrossWins = paperStatsWins.reduce((sum, pnl) => sum + pnl, 0);
  const paperStatsGrossLosses = paperStatsLosses.reduce((sum, pnl) => sum + pnl, 0);
  const paperStatsNet = paperStatsPnls.reduce((sum, pnl) => sum + pnl, 0);
  const paperStatsAverageWin = paperStatsWins.length ? paperStatsGrossWins / paperStatsWins.length : 0;
  const paperStatsAverageLoss = paperStatsLosses.length ? paperStatsGrossLosses / paperStatsLosses.length : 0;
  const paperStatsProfitFactor = paperStatsGrossLosses < 0 ? paperStatsGrossWins / Math.abs(paperStatsGrossLosses) : paperStatsGrossWins > 0 ? Infinity : 0;
  const paperStatsExpectancy = paperStatsPnls.length ? paperStatsNet / paperStatsPnls.length : 0;
  const paperStatsOrdered = [...paperStatsPositions].sort((left, right) => Number(left.end.time) - Number(right.end.time));
  const paperStatsStart = paperStatsOrdered[0]?.end.time;
  const paperStatsEnd = paperStatsOrdered[paperStatsOrdered.length - 1]?.end.time;
  const paperStatsDate = (time: Time | undefined) => time === undefined ? '—' : chartTimeLabel(time, timezone, true);
  const paperStatsDrawdown = [...paperStatsPositions].sort((left, right) => Number(left.end.time) - Number(right.end.time)).reduce((state, position) => {
    state.equity += paperPnl(position);
    state.peak = Math.max(state.peak, state.equity);
    state.drawdown = Math.max(state.drawdown, state.peak - state.equity);
    return state;
  }, { equity: 0, peak: 0, drawdown: 0 }).drawdown;
  const paperStatsSymbols = [...new Set(paperStatsSource.map(position => position.symbol ?? symbol))].sort();
  const formatStatsPnl = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} USDT`;
  const paperStatsPanel = <section className="paper-stats-panel" aria-label="Estadísticas Paper de trading"><div className="paper-stats-head"><div><span className="positions-kicker">PAPER · TRADING STATS</span><h2>Estadísticas Paper de Trading</h2><p>Solo operaciones Paper cerradas · usa estos datos para validar la estrategia antes de aumentar el risk %.</p></div><div className="paper-stats-filters"><label>Símbolo<select value={paperStatsSymbol} onChange={event => setPaperStatsSymbol(event.target.value)}><option value="ALL">Todos</option>{paperStatsSymbols.map(option => <option key={option}>{option}</option>)}</select></label><label>Desde<input type="date" value={paperStatsFrom} onChange={event => setPaperStatsFrom(event.target.value)} /></label><label>Hasta<input type="date" value={paperStatsTo} onChange={event => setPaperStatsTo(event.target.value)} /></label><button type="button" onClick={() => { setPaperStatsSymbol('ALL'); setPaperStatsFrom(''); setPaperStatsTo(''); }}>Limpiar</button></div></div><div className="paper-stats-period"><div><small>Inicio del backtesting</small><strong>{paperStatsDate(paperStatsStart)}</strong></div><div><small>Final del backtesting</small><strong>{paperStatsDate(paperStatsEnd)}</strong></div></div><div className="paper-stats-grid"><div><small>Operaciones</small><strong>{paperStatsPositions.length}</strong></div><div><small>Win rate</small><strong className={paperStatsWins.length ? 'value-positive' : ''}>{paperStatsPositions.length ? `${(paperStatsWins.length / paperStatsPositions.length * 100).toFixed(1)}%` : '—'}</strong></div><div><small>PNL neto</small><strong className={paperStatsNet >= 0 ? 'value-positive' : 'value-negative'}>{paperStatsPositions.length ? formatStatsPnl(paperStatsNet) : '—'}</strong></div><div><small>Profit factor</small><strong>{paperStatsPositions.length ? (Number.isFinite(paperStatsProfitFactor) ? paperStatsProfitFactor.toFixed(2) : '∞') : '—'}</strong></div><div><small>Prom. ganadora</small><strong className="value-positive">{paperStatsWins.length ? formatStatsPnl(paperStatsAverageWin) : '—'}</strong></div><div><small>Prom. perdedora</small><strong className="value-negative">{paperStatsLosses.length ? formatStatsPnl(paperStatsAverageLoss) : '—'}</strong></div><div><small>Expectativa</small><strong className={paperStatsExpectancy >= 0 ? 'value-positive' : 'value-negative'}>{paperStatsPositions.length ? formatStatsPnl(paperStatsExpectancy) : '—'}</strong></div><div><small>Drawdown máx.</small><strong className="value-negative">{paperStatsPositions.length ? `-${paperStatsDrawdown.toFixed(2)} USDT` : '—'}</strong></div></div></section>;
  const wickBacktestPanel = <BacktestPanel activeSymbol={symbol} apiUrl={apiUrl} accessToken={auth.accessToken} getBars={() => candleBarsRef.current} scannerSymbols={activeMarketSymbols.map(candidate => candidate.symbol)} wickPeriod={wickPeriod} wickMultiplier={wickMultiplier} stopPercent={binanceStopPercent} targetPercent={binanceTargetPercent} initialBalance={paperInitialBalance} riskPercent={paperRiskPercent} leverage={paperLeverage} broker={broker} sslPeriod={sslPeriod} regimeWindow={sslRegimeWindow} displayBars={wickDisplayPeriod} barRevision={trackerRevision} onWickTrades={setWickBacktestTrades} />;
  const labAssistPanel = labRecommendations && <section className="live-lab-assist" aria-label="Recomendaciones MAE MFE en tiempo real"><div className="live-lab-assist-head"><div><span className="positions-kicker">MAE·MFE LIVE ASSIST</span><h2>Recomendación de la vela actual</h2><p className="live-lab-meta">Horizonte: {labRecommendations.horizon} velas · Vela actual: {labRecommendations.long.label} · Intervalo: {labRecommendations.resolution}m</p></div><div className="live-lab-controls"><button type="button" className={labResolution === 1 ? 'live-lab-time-active' : ''} onClick={() => setLabResolution(1)}>1m</button><button type="button" className={labResolution === 5 ? 'live-lab-time-active' : ''} onClick={() => setLabResolution(5)}>5m</button></div></div><div className="live-lab-direction-grid">{(['long', 'short'] as const).map(type => { const recommendation = labRecommendations[type]; return <article key={type} className={`live-lab-direction ${type}`}><h3>{type === 'long' ? 'LONG' : 'SHORT'}</h3><div className="live-lab-assist-grid"><div><small>MAE</small><strong className="value-negative">-{recommendation.mae.toFixed(4)}%</strong></div><div><small>MFE</small><strong className="value-positive">+{recommendation.mfe.toFixed(4)}%</strong></div><div><small>R:R</small><strong>{recommendation.rr.toFixed(2)}:1</strong></div><div><small>Leverage sugerido</small><strong>{recommendation.leverage.toFixed(1)}x</strong></div><div><small>Riesgo máximo</small><strong>{recommendation.riskAmount.toFixed(2)} USD</strong></div><div><small>Notional sugerido</small><strong>{recommendation.notional.toFixed(2)} USD</strong></div><div><small>Margen teórico</small><strong>{recommendation.margin.toFixed(2)} USD</strong></div><div><small>TP esperado</small><strong className="value-positive">+{recommendation.expectedProfit.toFixed(2)} USD</strong></div></div></article>; })}</div></section>;
  const positionsTable = <section className="positions-panel" aria-label="Posiciones abiertas">
    <div className="positions-panel-head"><div><span className="positions-kicker">TRADING</span><h2>Paper operations</h2></div><div className="paper-actions"><span className="paper-risk-indicator">Riesgo {paperRiskPercent.toFixed(2)}%</span><button type="button" className="paper-settings-button" onClick={() => setShowPaperSettings(true)} aria-label="Ajustar Paper">⚙</button><span className="paper-badge">PAPER</span></div></div>{paperSyncError && <p className="paper-sync-error" role="status">{paperSyncError}</p>}<div className="paper-tabs" role="tablist" aria-label="Operaciones"><button role="tab" aria-selected={paperTab === 'open'} className={paperTab === 'open' ? 'paper-tab-active' : ''} onClick={() => setPaperTab('open')}>Abiertas <b>{paperPositions.filter(position => !position.closed).length + displayedBinancePositions.length}</b></button><button role="tab" aria-selected={paperTab === 'closed'} className={paperTab === 'closed' ? 'paper-tab-active' : ''} onClick={() => setPaperTab('closed')}>Cerradas <b>{paperPositions.filter(position => position.closed).length}</b></button></div>
    <div className="paper-balance-grid"><div><small>Balance paper</small><strong>{paperEquity.toFixed(2)} USD</strong></div><div><small>Leverage máximo · {symbol}</small><strong>{brokerMaxLeverage.toFixed(0)}x</strong></div><div><small>Leverage paper efectivo</small><strong>{paperLeverage.toFixed(1)}x</strong></div><div><small>Costos comisión + slippage</small><strong>{paperCosts.toFixed(2)} USD</strong></div><div><small>PNL realizado</small><strong>{realizedPnl.toFixed(2)} USD</strong></div><div><small>PNL abierto</small><strong>{unrealizedPnl.toFixed(2)} USD</strong></div></div>
    {displayedPaperPositions.length === 0 && displayedBinancePositions.length === 0 ? <p className="positions-empty">{paperTab === 'open' ? 'No hay operaciones abiertas.' : 'No hay operaciones cerradas.'}</p> : <div className="positions-table-scroll"><table className="positions-table"><thead><tr><th>Instrumento</th><th>Cuenta</th><th>Lado</th><th>Size</th><th>Entrada</th><th>Actual</th><th>SL %</th><th>TP %</th><th>Leverage</th><th>Margen</th><th>Notional</th><th>Fee</th><th>R:R</th><th>PNL</th><th>ROE</th><th>Acción</th></tr></thead><tbody>{displayedBinancePositions.map((position, index) => {
      const signedQuantity = Number(position.quantity ?? 0);
      const quantity = Math.abs(signedQuantity);
      const entry = Number(position.entry_price ?? 0);
      const mark = Number(position.mark_price ?? 0);
      const pnl = Number(position.unrealized_pnl ?? 0);
      const notional = Math.abs(Number(position.notional ?? 0)) || quantity * mark || quantity * entry;
      const side = signedQuantity >= 0 ? 'LONG' : 'SHORT';
      const intent = binanceExecutionIntents.find(item => item.symbol === position.symbol && ['ENTRY_SUBMITTED', 'ENTRY_FILLED', 'PROTECTED'].includes(item.status ?? ''));
      const stop = Number(intent?.stop_loss ?? 0);
      const target = Number(intent?.take_profit ?? 0);
      const stopPercent = entry > 0 && stop > 0 ? Math.abs(stop - entry) / entry * 100 : null;
      const targetPercent = entry > 0 && target > 0 ? Math.abs(target - entry) / entry * 100 : null;
      const leverage = Number(position.leverage ?? 0) || (position.symbol === symbol ? (binanceSymbolConfig?.leverage ?? BINANCE_MIN_OPERATION_LEVERAGE) : BINANCE_MIN_OPERATION_LEVERAGE);
      const exchangeMargin = Number(position.isolated_margin ?? 0);
      const margin = exchangeMargin > 0 ? exchangeMargin : leverage > 0 ? notional / leverage : 0;
      const fees = notional > 0 ? tradingCosts('binance', notional).total : 0;
      const rr = stopPercent && targetPercent ? targetPercent / stopPercent : null;
      const roe = margin > 0 ? pnl / margin * 100 : 0;
      return <tr key={`binance-${position.symbol}-${index}`}><td><button type="button" className="paper-symbol-link" onClick={() => { if (position.symbol) { setSymbol(position.symbol); localStorage.setItem('helloworld-selected-symbol', position.symbol); } }}>{position.symbol ?? '—'}</button></td><td><span className="operation-source source-binance">BINANCE</span></td><td className={side === 'LONG' ? 'value-positive' : 'value-negative'}>{side}</td><td>{position.size ?? position.quantity ?? '—'}</td><td>{entry > 0 ? formatPaperPrice(entry) : '—'}</td><td>{mark > 0 ? formatPaperPrice(mark) : '—'}</td><td>{stopPercent == null ? '—' : `-${stopPercent.toFixed(4)}%`}</td><td>{targetPercent == null ? '—' : `+${targetPercent.toFixed(4)}%`}</td><td>{leverage}x</td><td>{margin > 0 ? `${margin.toFixed(2)} USDT` : '—'}</td><td>{notional > 0 ? `${notional.toFixed(2)} USDT` : '—'}</td><td>{fees > 0 ? `${fees.toFixed(4)} USDT est.` : '—'}</td><td>{rr == null ? '—' : `${rr.toFixed(2)}:1`}</td><td className={pnl >= 0 ? 'value-positive' : 'value-negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(8)} USDT</td><td className={roe >= 0 ? 'value-positive' : 'value-negative'}>{roe >= 0 ? '+' : ''}{roe.toFixed(4)}%</td><td><button type="button" className="paper-edit-button" disabled={binanceCloseBusy !== null} onClick={() => void closeBinancePosition(position)}>{binanceCloseBusy === position.symbol ? 'Cerrando…' : 'Cerrar Binance'}</button></td></tr>;
    })}{displayedPaperPositions.map((position, index) => {
      if (position.real && position.closed) {
        const historyStop = Number(position.stop?.price ?? 0);
        const historyTarget = Number(position.target?.price ?? 0);
        const historyRr = historyStop > 0 && historyTarget > 0 ? Math.abs(historyTarget - historyStop) / Math.abs(historyStop) : null;
        return <tr key={`${position.id ?? position.start.time}-${index}`}><td>{position.symbol ?? '—'}</td><td><span className="operation-source source-binance">BINANCE</span></td><td><span className={`position-side ${position.type}`}>{position.type.toUpperCase()}</span></td><td>{position.quantity ?? '—'}</td><td>—</td><td>—</td><td>{historyStop > 0 ? 'Configurado' : '—'}</td><td>{historyTarget > 0 ? 'Programático' : '—'}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>{historyRr == null ? '—' : `${historyRr.toFixed(2)}:1`}</td><td>—</td><td>—</td><td><span className="operation-readonly">Historial Binance</span></td></tr>;
      }
      const direction = position.type === 'long' ? 1 : -1;
      const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
      const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
      const calculatedNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
      const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
        ? position.notional as number
        : Math.min(calculatedNotional, paperInitialBalance * paperLeverage);
      const margin = position.margin != null && position.margin > 0 ? position.margin : (paperLeverage > 0 ? notional / paperLeverage : 0);
      // Each operation keeps its own margin/notional. Do not display the
      // currently selected symbol's leverage for historical positions.
      const leverage = margin > 0 ? notional / margin : paperLeverage;
      const priceChange = ((position.end.price - position.start.price) / position.start.price) * direction;
      const pnl = paperPnl(position);
      const costs = position.real ? { total: 0 } : tradingCosts(broker, notional);
      const roe = (pnl / margin) * 100;
      const targetPrice = position.target?.price ?? position.end.price;
      const stopPercentDisplay = ((position.stop ? position.stop.price : position.start.price) - position.start.price) / position.start.price * direction * 100;
      const targetPercentDisplay = (targetPrice - position.start.price) / position.start.price * direction * 100;
      const riskDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
      const rewardDistance = Math.abs(targetPrice - position.start.price);
      const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
      const drawingIndex = drawings.findIndex(drawing => drawing.id === position.id);
      const positionSymbol = position.symbol ?? symbol;
      return <tr key={`${position.id ?? position.start.time}-${index}`}><td><button type="button" className="paper-symbol-link" onClick={() => { setSymbol(positionSymbol); localStorage.setItem('helloworld-selected-symbol', positionSymbol); }}>{positionSymbol}</button></td><td><span className={`operation-source ${position.real ? 'source-binance' : 'source-paper'}`}>{position.real ? 'BINANCE · PAPER' : 'PAPER'}</span></td><td><span className={`position-side ${position.type}`}>{position.type.toUpperCase()}</span></td><td>{formatPaperPrice(position.start.price)}</td><td>{formatPaperPrice(position.end.price)}</td><td className="value-negative">{stopPercentDisplay.toFixed(4)}%</td><td className="value-positive">+{targetPercentDisplay.toFixed(4)}%</td><td>{leverage.toFixed(1)}x</td><td>{margin.toFixed(2)} USDT</td><td>{notional.toFixed(2)} USDT</td><td>{position.real ? '—' : `${costs.total.toFixed(2)} USDT`}</td><td>{rr.toFixed(2)}:1</td><td className={pnl >= 0 ? 'value-positive' : 'value-negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(8)} USDT</td><td className={roe >= 0 ? 'value-positive' : 'value-negative'}>{roe >= 0 ? '+' : ''}{roe.toFixed(8)}%</td><td>{position.real ? <span className="operation-readonly">Espejo Binance</span> : <button className="paper-edit-button" type="button" disabled={drawingIndex < 0} onClick={() => void (position.closed ? deletePaperPosition(position) : closePaperPosition(position))}>{position.closed ? 'Borrar' : 'Cerrar posición'}</button>}</td></tr>;
    })}</tbody></table></div>}{showPaperSettings && <div className="paper-settings-backdrop" role="presentation" onClick={() => setShowPaperSettings(false)}><section className="paper-settings-modal" role="dialog" aria-modal="true" aria-label="Ajustes Paper" onClick={event => event.stopPropagation()}><div className="paper-settings-head"><h2>Ajustes Paper</h2><button type="button" onClick={() => setShowPaperSettings(false)} aria-label="Cerrar">×</button></div><label>Depósito<input type="number" min="1" step="0.01" placeholder="Agregar USD" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} /><button type="button" className="paper-deposit-button" onClick={() => { const amount = Number(depositAmount); if (!Number.isFinite(amount) || amount <= 0) return; const next = paperInitialBalance + amount; setPaperInitialBalance(next); localStorage.setItem('helloworld-paper-balance', String(next)); window.dispatchEvent(new Event('helloworld-paper-assist-updated')); setDepositAmount(''); }}>Depositar</button></label><label>Riesgo por operación (%)<input type="number" min="0.05" max="10" step="0.05" value={paperRiskPercent} onChange={event => { const value = Math.max(.05, Math.min(10, Number(event.target.value) || .05)); setPaperRiskPercent(value); const current = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}'); localStorage.setItem('helloworld-paper-assist', JSON.stringify({ ...current, balance: paperInitialBalance, riskPercent: value })); }} /></label></section></div>}
  </section>;

  const renderDrawing = (drawing: Drawing, index: number | string, canvas: ChartCanvas = 'entry') => {
    void viewportRevision;
    // Production charts show only the live Binance adapter; persisted Paper
    // rows from older sessions must not create duplicate visual operations.
    if (productionOnly && drawing.paper && !drawing.real) return null;
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    // Paper operations originate on the live 1m stream but are rendered on
    // both charts. Reuse the same timestamp projection as the hit testing
    // layer so a missing exact 5m timestamp cannot hide the whole position.
    const start = screenPoint(drawing.start, canvas);
    const end = screenPoint(drawing.end, canvas);
    if (!start || !end) return null;
    const handles = drawingHandles(drawing, typeof index === 'number' ? index : -1, canvas);
    let handleNodes = handles.filter(handle => !drawing.paper || handle.endpoint === 'target' || (handle.endpoint === 'stop' && !drawing.real)).map((handle, handleIndex) => <circle key={handleIndex} cx={handle.x} cy={handle.y} r="7" className={`drawing-handle ${handle.role === 'stop' ? 'handle-stop' : handle.role === 'target' ? 'handle-target' : drawing.type === 'ruler' ? 'handle-ruler' : ''}`} />);
    const pricePercent = ((drawing.end.price - drawing.start.price) / drawing.start.price) * 100;
    const selectedClass = typeof index === 'number' && (selectedDrawing === index || selectedDrawings.includes(index)) ? 'drawing-selected' : undefined;
    if (drawing.type === 'line') return <g key={index} className={selectedClass}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="drawing-line" /><text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 8} className="drawing-label">{pricePercent >= 0 ? '+' : ''}{pricePercent.toFixed(2)}%</text>{handleNodes}</g>;
    if (drawing.type === 'ruler') {
      const minutes = Math.round(Math.abs(Number(drawing.end.time) - Number(drawing.start.time)) / 60);
      const priceDelta = Math.abs(drawing.end.price - drawing.start.price);
      const movePercent = drawing.start.price > 0 ? Math.abs((drawing.end.price - drawing.start.price) / drawing.start.price * 100) : 0;
      const measuredSide = drawing.end.price >= drawing.start.price ? 'LONG' : 'SHORT';
      const preview = binancePreview.find(item => item.side === measuredSide);
      const mfeUsd = preview ? preview.notional * movePercent / 100 : 0;
      const stopPrice = drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
      const stopPoint = screenPoint({ time: drawing.end.time, price: stopPrice }, canvas);
      const stopPercent = drawing.start.price > 0 ? Math.abs(stopPrice - drawing.start.price) / drawing.start.price * 100 : 0;
      const slUsd = preview ? preview.notional * stopPercent / 100 : 0;
      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const width = Math.max(1, Math.abs(end.x - start.x));
      return <g key={index} className={selectedClass}><rect x={left} y={top} width={width} height={Math.max(1, Math.abs(end.y - start.y))} className="measurement-box" />{stopPoint && <><rect x={left} y={Math.min(start.y, stopPoint.y)} width={width} height={Math.max(1, Math.abs(start.y - stopPoint.y))} className="measurement-risk-zone" /><line x1={left} y1={stopPoint.y} x2={left + width} y2={stopPoint.y} className="measurement-stop-line" /><text x={left + 8} y={stopPoint.y + (stopPoint.y >= start.y ? 16 : -7)} className="measurement-stop-label">SL -{stopPercent.toFixed(2)}% · -{slUsd.toFixed(4)} USDT</text></>}{<text x={left + 8} y={top + 18} className="measurement-label">{minutes} min · {priceDelta.toFixed(2)} · {pricePercent >= 0 ? '+' : ''}{pricePercent.toFixed(2)}% · MFE +{mfeUsd.toFixed(4)} USDT</text>}{handleNodes}</g>;
    }
    const left = Math.min(start.x, end.x);
    const width = Math.max(1, Math.abs(end.x - start.x));
    const profitTop = drawing.type === 'long' ? Math.min(start.y, end.y) : start.y;
    const riskTop = drawing.type === 'long' ? start.y : Math.min(start.y, end.y);
    const profitHeight = Math.abs(start.y - end.y);
    const riskHeight = Math.abs(start.y - end.y);
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
    if (!stop) return null;
    const targetPrice = drawing.target?.price ?? drawing.end.price;
    const targetPoint = drawing.target ? screenPoint(drawing.target, canvas) : end;
    if (!targetPoint) return null;
    const winExitPoint = drawing.backtest && drawing.closed && drawing.status === 'CLOSED - WIN' ? end : targetPoint;
    const failedExitPoint = drawing.backtest && drawing.closed && drawing.status === 'CLOSED - FAILED' ? end : stop;
    const targetPercent = ((targetPrice - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1);
    const riskPercent = ((stopPrice - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1);
    const riskDistance = Math.abs(drawing.start.price - stopPrice);
    const rewardDistance = Math.abs((drawing.target?.price ?? drawing.end.price) - drawing.start.price);
    const stopPercentAbs = drawing.start.price > 0 ? riskDistance / drawing.start.price : 0;
    const fallbackNotional = stopPercentAbs > 0 ? paperRiskAmount / stopPercentAbs : 0;
    const paperNotional = drawing.notional && drawing.notional > 0
      ? drawing.notional
      : Math.min(fallbackNotional, paperInitialBalance * paperLeverage);
    const feeAmount = drawing.paper && !drawing.real ? tradingCosts(broker, paperNotional).total : 0;
    // Keep the market result and execution cost visible as separate values.
    // The risk engine sizes Binance from MAE only; fees are intentionally not
    // hidden inside the SL/TP amount or used to reduce the notional.
    const slAmount = Math.abs(riskPercent / 100 * paperNotional);
    const tpAmount = Math.abs(targetPercent / 100 * paperNotional);
    const feeLabel = drawing.paper ? ` · -${feeAmount.toFixed(4)} Fee` : '';
    const livePnl = drawing.real && Number.isFinite(drawing.pnl)
      ? drawing.pnl as number
      : drawing.closed && Number.isFinite(drawing.pnl)
        ? drawing.pnl as number
      : ((drawing.end.price - drawing.start.price) / drawing.start.price) * (drawing.type === 'long' ? 1 : -1) * paperNotional - feeAmount;
    const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    const targetLabel = `${targetPercent >= 0 ? '+' : ''}${targetPercent.toFixed(8)}%`;
    const riskLabel = `${riskPercent >= 0 ? '+' : ''}${riskPercent.toFixed(8)}%`;
    const targetTop = Math.min(start.y, winExitPoint.y);
    const targetHeight = Math.abs(start.y - winExitPoint.y);
    const stopTop = Math.min(start.y, failedExitPoint.y);
    const stopHeight = Math.abs(start.y - failedExitPoint.y);
    const paperClass = drawing.paper ? `paper-position ${drawing.real ? 'real-position' : ''} ${drawing.type === 'long' ? 'paper-long' : 'paper-short'}` : '';
    const paperStatusLabel = drawing.closed ? (drawing.status === 'CLOSED - WIN' ? '✓ Win' : '✕ Failed') : 'Open';
    const paperStatusClass = drawing.closed ? (drawing.status === 'CLOSED - WIN' ? 'paper-operation-win' : 'paper-operation-failed') : 'paper-operation-open';
    const resultLabelClass = drawing.status === 'CLOSED - WIN' ? 'tracker-result-win' : drawing.status === 'CLOSED - FAILED' ? 'tracker-result-failed' : '';
    const trackerExtremeMarkers = drawing.backtest && canvas === 'entry'
      ? ([
        ['MAXROE', drawing.maxRoe, 'tracker-extreme-max'],
        ['REALMAXROE', drawing.realMaxRoe, 'tracker-extreme-real-max'],
        ['MINROE', drawing.minRoe, 'tracker-extreme-min'],
        ['REALMINROE', drawing.realMinRoe, 'tracker-extreme-real-min'],
      ] as const).flatMap(([label, point, markerClass]) => {
        if (!point) return [];
        const screen = screenPoint({ time: point.time as UTCTimestamp, price: point.price }, canvas);
        if (!screen) return [];
        const operationId = String(drawing.id ?? index);
        return [<circle key={`${operationId}-${label}`} cx={screen.x} cy={screen.y} r="5" className={`tracker-extreme-point ${markerClass}`} pointerEvents="all" onPointerEnter={() => setTrackerOperationHover({ id: operationId, x: screen.x, y: screen.y, label, roePercent: point.roePercent, pnlUsd: point.pnlUsd, time: point.time })} onPointerLeave={() => setTrackerOperationHover(null)}><title>{label} · ROE {point.roePercent >= 0 ? '+' : ''}{point.roePercent.toFixed(2)}% · PNL {point.pnlUsd >= 0 ? '+' : ''}{point.pnlUsd.toFixed(4)} USDT</title></circle>];
      })
      : [];
    const operationId = String(drawing.id ?? index);
    const resultRoe = drawing.resultRoePercent ?? 0;
    const resultPnl = drawing.pnl ?? 0;
    const resultLabel = drawing.closed ? (drawing.status === 'CLOSED - WIN' ? 'WIN' : 'FAIL') : 'OPEN';
    const trackerTooltip = trackerOperationHover?.id === operationId ? <g className="tracker-operation-tooltip" pointerEvents="none"><rect x={Math.max(6, Math.min(stageSize.width - 216, trackerOperationHover.x + 10))} y={Math.max(6, trackerOperationHover.y - 62)} width="206" height="52" rx="5" /><text x={Math.max(16, Math.min(stageSize.width - 206, trackerOperationHover.x + 20))} y={Math.max(21, trackerOperationHover.y - 43)}>{trackerOperationHover.label} · ROE {trackerOperationHover.roePercent >= 0 ? '+' : ''}{trackerOperationHover.roePercent.toFixed(2)}%</text><text x={Math.max(16, Math.min(stageSize.width - 206, trackerOperationHover.x + 20))} y={Math.max(39, trackerOperationHover.y - 25)}>PNL {trackerOperationHover.pnlUsd >= 0 ? '+' : ''}{trackerOperationHover.pnlUsd.toFixed(4)} USDT</text><text x={Math.max(16, Math.min(stageSize.width - 206, trackerOperationHover.x + 20))} y={Math.max(56, trackerOperationHover.y - 8)}>{chartTimeLabel(trackerOperationHover.time as Time, timezone, true)}</text></g> : null;
    const trackerMetricRows: Array<[string, TrackerExtremePoint]> = drawing.maxRoe ? ([
      ['maxroe', drawing.maxRoe],
      ['realmaxroe', drawing.realMaxRoe ?? drawing.maxRoe],
      ['minroe', drawing.minRoe ?? drawing.maxRoe],
      ['realminroe', drawing.realMinRoe ?? drawing.maxRoe],
    ] as Array<[string, TrackerExtremePoint]>) : [];
    const trackerSummaryTooltip = trackerOperationHover?.id === operationId && trackerMetricRows.length ? <g className="tracker-operation-summary-tooltip" pointerEvents="none"><rect x={Math.max(6, Math.min(stageSize.width - 258, trackerOperationHover.x + 10))} y={Math.max(6, trackerOperationHover.y - 116)} width="248" height="106" rx="5" /><text x={Math.max(16, Math.min(stageSize.width - 248, trackerOperationHover.x + 20))} y={Math.max(20, trackerOperationHover.y - 98)}>TRACKER · {drawing.type.toUpperCase()} · {resultLabel}</text>{trackerMetricRows.map(([label, point], row) => <text key={label} x={Math.max(16, Math.min(stageSize.width - 248, trackerOperationHover.x + 20))} y={Math.max(37 + row * 17, trackerOperationHover.y - 80 + row * 17)}>{label.toUpperCase()}  {point.roePercent >= 0 ? '+' : ''}{point.roePercent.toFixed(2)}% · {point.pnlUsd >= 0 ? '+' : ''}{point.pnlUsd.toFixed(4)} USDT</text>)}</g> : null;
    const trackerLeverage = Math.max(1, drawing.leverage ?? paperLeverage);
    const trackerResultTheme = drawing.status === 'CLOSED - WIN' ? 'tracker-summary-win' : drawing.status === 'CLOSED - FAILED' ? 'tracker-summary-failed' : 'tracker-summary-open';
    const trackerOperationFee = drawing.fees ?? tradingCosts('binance', drawing.notional ?? 0).total;
    const trackerOperationBalance = drawing.balanceAfter;
    const trackerResultSummaryTooltip = trackerOperationHover?.id === operationId && trackerMetricRows.length ? <g className={`tracker-operation-result-tooltip ${trackerResultTheme}`} pointerEvents="none"><rect x={Math.max(6, Math.min(stageSize.width - 278, trackerOperationHover.x + 10))} y={Math.max(6, trackerOperationHover.y - 178)} width="268" height="168" rx="6" /><text x={Math.max(16, Math.min(stageSize.width - 268, trackerOperationHover.x + 20))} y={Math.max(20, trackerOperationHover.y - 160)}>TRACKER · {drawing.type.toUpperCase()} · {resultLabel}</text><text x={Math.max(16, Math.min(stageSize.width - 268, trackerOperationHover.x + 20))} y={Math.max(37, trackerOperationHover.y - 142)}>LEVERAGE  {trackerLeverage.toFixed(1)}x</text>{trackerMetricRows.map(([label, point], row) => <text key={label} x={Math.max(16, Math.min(stageSize.width - 268, trackerOperationHover.x + 20))} y={Math.max(54 + row * 17, trackerOperationHover.y - 124 + row * 17)}>{label.toUpperCase()}  {point.roePercent >= 0 ? '+' : ''}{point.roePercent.toFixed(2)}% · {point.pnlUsd >= 0 ? '+' : ''}{point.pnlUsd.toFixed(4)} USDT</text>)}<text x={Math.max(16, Math.min(stageSize.width - 268, trackerOperationHover.x + 20))} y={Math.max(123, trackerOperationHover.y - 56)}>RESULT  {resultRoe >= 0 ? '+' : ''}{resultRoe.toFixed(2)}% · {resultPnl >= 0 ? '+' : ''}{resultPnl.toFixed(4)} USDT</text><text x={Math.max(16, Math.min(stageSize.width - 268, trackerOperationHover.x + 20))} y={Math.max(140, trackerOperationHover.y - 39)}>FEE  -{trackerOperationFee.toFixed(4)} USDT</text>{trackerOperationBalance != null && <text x={Math.max(16, Math.min(stageSize.width - 268, trackerOperationHover.x + 20))} y={Math.max(157, trackerOperationHover.y - 22)}>BALANCE  {trackerOperationBalance.toFixed(4)} USDT</text>}</g> : null;
    if (drawing.backtest && canvas === 'entry' && drawing.maxRoe) {
      const resultHit = <rect key={`${operationId}-result-hover`} x={left} y={targetTop} width={Math.max(width, 120)} height="28" fill="transparent" pointerEvents="all" onPointerEnter={() => setTrackerOperationHover({ id: operationId, x: left + 8, y: targetTop + 18, label: resultLabel, roePercent: resultRoe, pnlUsd: resultPnl, time: Number(drawing.end.time) })} onPointerLeave={() => setTrackerOperationHover(null)} />;
      const operationHoverHit = <rect key={`${operationId}-operation-hover`} x={left} y={Math.min(targetTop, stopTop)} width={Math.max(width, 120)} height={Math.max(32, Math.abs(stopTop - targetTop) + Math.max(targetHeight, stopHeight))} fill="transparent" pointerEvents="all" onPointerEnter={() => setTrackerOperationHover({ id: operationId, x: left + 8, y: Math.min(targetTop, stopTop) + 12, label: 'OPERACIÓN', roePercent: resultRoe, pnlUsd: resultPnl, time: Number(drawing.end.time) })} onPointerLeave={() => setTrackerOperationHover(null)} />;
      handleNodes = [...handleNodes, ...trackerExtremeMarkers, operationHoverHit, resultHit, ...(trackerTooltip ? [trackerTooltip] : []), ...(trackerSummaryTooltip ? [trackerSummaryTooltip] : []), ...(trackerResultSummaryTooltip ? [trackerResultSummaryTooltip] : [])];
    }
    return <g key={index} className={`${selectedClass ?? ''} ${paperClass}`}>{drawing.paper && canvas === 'context' && <><line x1={start.x} y1={0} x2={start.x} y2={overviewSize.height} className="paper-opening-index" /><text x={start.x + 6} y={18} className="paper-opening-label">Apertura · {chartTimeLabel(drawing.start.time, timezone, false)}</text></>}<rect x={left} y={targetTop} width={width} height={targetHeight} className={targetPercent >= 0 ? 'position-profit' : 'position-risk'} /><rect x={left} y={stopTop} width={width} height={stopHeight} className={riskPercent <= 0 ? 'position-risk' : 'position-profit'} /><line x1={left} y1={start.y} x2={left + width} y2={start.y} className="position-entry" /><line x1={left} y1={end.y} x2={left + width} y2={end.y} className="paper-current-price" />{drawing.paper && <><text x={left + 8} y={Math.max(14, start.y - 8)} className={`paper-operation-label ${paperStatusClass}`}>{drawing.real ? 'BINANCE · REAL' : `Paper Operation · ${paperStatusLabel}`}</text><text x={left + 8} y={targetPoint.y - 10} className="paper-target-label">TP {targetLabel} · +{tpAmount.toFixed(2)} USDT{feeLabel}</text><text x={left + 8} y={stop.y + 18} className="paper-stop-label">SL {riskLabel} · -{slAmount.toFixed(2)} USDT{feeLabel}</text><text x={left + width + 8} y={end.y - 8} className={`paper-current-label ${livePnl >= 0 ? 'paper-current-profit' : 'paper-current-loss'}`}>PNL {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)} USDT</text></>}{!drawing.paper && drawing.backtest && <><text x={left + 8} y={targetTop + 18} className={`position-label ${resultLabelClass}`}>{drawing.status === 'CLOSED - WIN' ? 'WIN' : 'FAIL'} · PNL {drawing.pnl != null ? `${drawing.pnl >= 0 ? '+' : ''}${drawing.pnl.toFixed(2)} USDT` : ''}</text><text x={left + 8} y={targetTop + 34} className={`position-label ${resultLabelClass}`}>TP FINAL +{(drawing.finalTargetPercent ?? targetPercent).toFixed(2)}%</text><text x={left + 8} y={targetTop + 48} className={`position-label ${resultLabelClass}`}>N AP {drawing.bodyAveragePercentAtOpen?.toFixed(3) ?? '—'}%</text><text x={left + 8} y={targetTop + 62} className={`position-label ${resultLabelClass}`}>N CIERRE {drawing.bodyAveragePercentAtClose?.toFixed(3) ?? '—'}%</text></>}{!drawing.paper && !drawing.backtest && <><text x={left + 8} y={targetTop + 18} className="position-label">TP {targetLabel}</text><text x={left + 8} y={stopTop + 18} className="position-label">SL {riskLabel}</text><text x={left + 8} y={Math.max(targetTop, stopTop) + 34} className="position-label">R:R {rr.toFixed(2)}:1</text></>}{drawing.real ? null : drawing.paper ? handleNodes : handleNodes}</g>;
  };

  const liveReferencePrice = binanceLivePriceRef.current?.price ?? candleBarsRef.current[candleBarsRef.current.length - 1]?.close ?? 0;
  const binanceOnline = broker === 'binance' && executionMode === 'production' && Boolean(binanceLiveAccount?.healthy && binanceLiveAccount?.stream_connected);
  const availableRiskBalance = binanceOnline
    ? Number(binanceLiveAccount?.available_balance ?? binanceSymbolConfig?.futures_balance ?? 0)
    : paperEquity;
  const riskBalanceForSizing = availableRiskBalance;
  const activeRiskPercent = Number((JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { riskPercent?: number }).riskPercent) || paperRiskPercent;
  const binancePreview = broker === 'binance' && binanceRules && liveReferencePrice > 0 ? (['LONG', 'SHORT'] as const).map(side => {
    const direction = side === 'LONG' ? 1 : -1;
    const entry = roundToBinance(liveReferencePrice, binanceRules.tick_size, binanceRules.price_precision);
    const stop = roundToBinance(entry * (1 - direction * binanceStopPercent / 100), binanceRules.tick_size, binanceRules.price_precision);
    const targetPercent = binanceTargetPercent;
    const target = roundToBinance(entry * (1 + direction * targetPercent / 100), binanceRules.tick_size, binanceRules.price_precision);
    const availableBalance = binanceOnline
      ? Number(binanceLiveAccount?.available_balance ?? binanceSymbolConfig?.futures_balance ?? 0)
      : paperEquity;
    const maximumLeverage = maxLeverageFor('binance', symbol);
    const recommendedLeverage = binanceSizingMode === 'maximum'
      ? Math.floor(Math.max(BINANCE_MIN_OPERATION_LEVERAGE, maximumLeverage))
      : BINANCE_MIN_OPERATION_LEVERAGE;
    const leverage = Math.min(recommendedLeverage, maximumLeverage);
    const marginMultiplier = leverage > 0 ? recommendedLeverage / leverage : 1;
    const riskBudget = riskBalanceForSizing * activeRiskPercent / 100;
    const riskBoundNotional = (binanceStopPercent / 100 + tradingCostRate('binance')) > 0 ? riskBudget / (binanceStopPercent / 100 + tradingCostRate('binance')) : 0;
    const desiredNotional = binanceSizingMode === 'minimum' ? binanceRules.min_notional : Math.max(binanceRules.min_notional, riskBoundNotional);
    const usableMargin = availableBalance > 0 ? Math.max(0, availableBalance - BINANCE_MARGIN_RESERVE_USDT) : 0;
    const affordableNotional = usableMargin * leverage;
    const requestedNotional = binanceSizingMode === 'maximum' && affordableNotional > 0 ? Math.min(desiredNotional, affordableNotional) : desiredNotional;
    const roundedUpQuantity = roundUpToBinance(requestedNotional / entry, binanceRules.step_size, binanceRules.quantity_precision);
    const roundedDownQuantity = roundToBinance(requestedNotional / entry, binanceRules.step_size, binanceRules.quantity_precision);
    const quantity = availableBalance > 0 && roundedUpQuantity * entry / leverage > usableMargin ? roundedDownQuantity : roundedUpQuantity;
    const notional = quantity * entry;
    const fees = tradingCosts('binance', notional).total;
    const slAmount = quantity * Math.abs(entry - stop);
    const tpAmount = quantity * Math.abs(target - entry);
    return { side, entry, stop, target, targetPercent, quantity, notional, fees, leverage, marginMultiplier, slAmount, tpAmount, margin: leverage > 0 ? notional / leverage : 0 };
  }) : [];
  useEffect(() => {
    if (!showTracker) {
      setTrackerVirtualOperations([]);
      return;
    }
    const source = renderBars(candleBarsRef.current, Math.max(300, Math.round(trackerPeriod) + 1));
    setTrackerVirtualOperations(runTrackerVisualSimulation(source, trackerPeriod, binanceStopPercent, binanceTargetPercent, paperInitialBalance, paperRiskPercent, paperLeverage, replayState.active));
  }, [showTracker, trackerPeriod, binanceStopPercent, binanceTargetPercent, paperInitialBalance, paperRiskPercent, paperLeverage, symbol, trackerRevision, replayState.active]);
  const backtestVisualDrawings: Drawing[] = (showTracker ? [] : wickBacktestTrades).map(trade => ({
    id: trade.id,
    symbol,
    type: trade.side,
    paper: false,
    backtest: true,
    closed: true,
    status: (trade.pnl >= 0 ? 'CLOSED - WIN' : 'CLOSED - FAILED') as Drawing['status'],
    start: { time: trade.entryTime as UTCTimestamp, price: trade.entryPrice },
    end: { time: trade.exitTime as UTCTimestamp, price: trade.exitPrice },
    stop: { time: trade.exitTime as UTCTimestamp, price: trade.stopPrice },
    target: { time: trade.exitTime as UTCTimestamp, price: trade.targetPrice },
    pnl: trade.pnl,
    notional: trade.notional,
  })).concat((showTracker ? trackerVirtualOperations : []).filter(operation => operation.status === 'CLOSED - WIN' || (replayState.active && !operation.closed)).map(operation => ({
    id: operation.id,
    symbol,
    type: operation.side,
    paper: false,
    backtest: true,
    closed: operation.closed,
    closeReason: operation.closeReason,
    status: operation.status as Drawing['status'],
    start: { time: operation.start.time as UTCTimestamp, price: operation.start.price },
    end: { time: operation.end.time as UTCTimestamp, price: operation.end.price },
    stop: { time: operation.end.time as UTCTimestamp, price: operation.stop.price },
    target: { time: operation.end.time as UTCTimestamp, price: operation.target.price },
    pnl: operation.pnl,
    notional: operation.notional,
    leverage: operation.leverage,
    fees: operation.fees ?? tradingCosts('binance', operation.notional).total,
    balanceAfter: operation.balanceAfter,
    resultRoePercent: operation.resultRoePercent,
    bodyAveragePercentAtOpen: operation.bodyAveragePercentAtOpen,
    bodyAveragePercentAtClose: operation.bodyAveragePercentAtClose,
    finalTargetPercent: operation.finalTargetPercent,
    finalTargetRoePercent: operation.finalTargetRoePercent,
    maxRoe: operation.maxRoe,
    realMaxRoe: operation.realMaxRoe,
    minRoe: operation.minRoe,
    realMinRoe: operation.realMinRoe,
  })));
  const renderOhlcOverlay = (hover: OhlcHover | null) => hover ? <div className="chart-ohlc-overlay" aria-label="Datos OHLC de la vela seleccionada"><span className="chart-ohlc-time">{chartTimeLabel(hover.time, timezone, true)}</span><span>O <b>{formatPaperPrice(hover.open)}</b></span><span>H <b className="chart-ohlc-high">{formatPaperPrice(hover.high)}</b></span><span>L <b className="chart-ohlc-low">{formatPaperPrice(hover.low)}</b></span><span>C <b>{formatPaperPrice(hover.close)}</b></span></div> : null;
  const chartStageView = <div ref={chartStage} className={`chart-stage ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={startDrawing} onPointerMoveCapture={updateDrawing} onPointerUpCapture={event => finishDrawingAndCapture(event, 'entry')} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); panStartRef.current = null; setResizeStart(null); setLassoStart(null); setLassoEnd(null); }}><div className="chart-viewport-snapshot" aria-label="Snapshot del viewport de entrada">X {entryViewportSnapshot.bars} · Futuro {entryViewportSnapshot.futureBars} · Y− {entryViewportSnapshot.yBelow}% · Y+ {entryViewportSnapshot.yAbove}%</div>
    {pendingBinanceTp && <div className="binance-tp-confirm" role="status"><span>Nuevo TP {pendingBinanceTp.symbol}: {formatPaperPrice(pendingBinanceTp.price)}</span><button type="button" onClick={() => void confirmBinanceTakeProfit()}>Confirmar TP</button><button type="button" onClick={() => { pendingBinanceTpRef.current = null; setPendingBinanceTp(null); }} aria-label="Cancelar cambio de TP">Cancelar</button></div>}{renderOhlcOverlay(entryOhlcHover)}
    <div ref={chartContainer} className="candlestick-chart" /><svg className="drawing-overlay" viewBox={`0 0 ${stageSize.width} ${stageSize.height}`} preserveAspectRatio="none" aria-hidden="true">{renderSessionIndicator()}{renderInterestMarkers()}{renderPriceLineHitAreas('entry')}{[...drawings, ...productionDrawings, ...backtestVisualDrawings].map((drawing, index) => (!drawing.paper || !drawing.closed || drawing.id === visibleClosedId) && (!drawing.paper || !drawing.symbol || drawing.symbol === symbol) && (drawing.chart !== 'context' || drawing.paper) ? renderDrawing(drawing, index, 'entry') : null)}{tool && tool !== 'pan' && drawingStart && drawingEnd && drawingCanvas === 'entry' && renderDrawing({ type: tool, chart: 'entry', start: drawingStart, end: drawingEnd }, 'preview', 'entry')}{lassoStart && lassoEnd && drawingCanvas === 'entry' && <rect x={Math.min(lassoStart.x, lassoEnd.x)} y={Math.min(lassoStart.y, lassoEnd.y)} width={Math.abs(lassoStart.x - lassoEnd.x)} height={Math.abs(lassoStart.y - lassoEnd.y)} className="selection-lasso" />}</svg><div className="chart-bottom-controls"><span className="timezone-icon" aria-hidden="true">◷</span><select className="timezone-select" value={timezone} onChange={event => setTimezone(event.target.value)} aria-label="Zona horaria">{TIMEZONES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="floating-order-buttons" aria-label="Abrir operación simulada"><button className="open-long-button" disabled={!paperReady} onClick={() => void openSimulatedPosition('long')}>▲ <span>Abrir Long</span><small>{binancePreview.find(preview => preview.side === 'LONG') ? `SL -${binanceStopPercent.toFixed(2)}% · TP +${binancePreview.find(preview => preview.side === 'LONG')!.targetPercent.toFixed(2)}% · N ${binancePreview.find(preview => preview.side === 'LONG')!.notional.toFixed(2)} · M ${binancePreview.find(preview => preview.side === 'LONG')!.margin.toFixed(4)} · ${binancePreview.find(preview => preview.side === 'LONG')!.leverage}x` : labRecommendations ? `${labRecommendations.long.label} · R:R ${labRecommendations.long.rr.toFixed(2)}:1` : 'Calculando recomendación…'}</small></button><button className="open-short-button" disabled={!paperReady} onClick={() => void openSimulatedPosition('short')}>▼ <span>Abrir Short</span><small>{binancePreview.find(preview => preview.side === 'SHORT') ? `SL -${binanceStopPercent.toFixed(2)}% · TP +${binancePreview.find(preview => preview.side === 'SHORT')!.targetPercent.toFixed(2)}% · N ${binancePreview.find(preview => preview.side === 'SHORT')!.notional.toFixed(2)} · M ${binancePreview.find(preview => preview.side === 'SHORT')!.margin.toFixed(4)} · ${binancePreview.find(preview => preview.side === 'SHORT')!.leverage}x` : labRecommendations ? `${labRecommendations.short.label} · R:R ${labRecommendations.short.rr.toFixed(2)}:1` : 'Calculando recomendación…'}</small></button></div>
  </div>;

  const avatarLabel = (auth.identity?.name ?? auth.identity?.email ?? 'U').slice(0, 1).toUpperCase();
  const profileButton = <><button className="profile-avatar" onClick={() => setShowProfile(true)} aria-label="Abrir perfil" title="Perfil">{avatarLabel}</button>{showIndicatorSettings && <IndicatorSettingsModal showSessions={showSessions} showSevenAmMarkers={showSevenAmMarkers} showRsi={showRsi} showSsl={showSsl} showTracker={showTracker} showWickExtensions={showWickExtensions} rsiPeriod={rsiPeriod} rsiLowBand={rsiLowBand} rsiHighBand={rsiHighBand} sslPeriod={sslPeriod} trackerPeriod={trackerPeriod} wickPeriod={wickPeriod} wickDisplayPeriod={wickDisplayPeriod} wickMultiplier={wickMultiplier} onClose={() => setShowIndicatorSettings(false)} onSessions={() => setShowSessions(value => !value)} onSevenAmMarkers={() => setShowSevenAmMarkers(value => !value)} onRsi={() => setShowRsi(value => !value)} onSsl={() => setShowSsl(value => !value)} onTracker={() => setShowTracker(value => !value)} onWickExtensions={() => setShowWickExtensions(value => !value)} onRsiPeriod={setRsiPeriod} onRsiLowBand={setRsiLowBand} onRsiHighBand={setRsiHighBand} onSslPeriod={setSslPeriod} onTrackerPeriod={setTrackerPeriod} onWickPeriod={setWickPeriod} onWickDisplayPeriod={setWickDisplayPeriod} onWickMultiplier={setWickMultiplier} />}</>;
  const labButton = <button className="indicator-bar-button" onClick={() => setShowIndicatorSettings(true)} aria-label="Configurar indicadores" title="Indicadores">◌</button>;
  const riskEngineButton = <button className="indicator-bar-button" onClick={() => setShowRiskEngine(true)} aria-label="Abrir Risk Engine" title="Risk Engine">⚖</button>;
  const pnlCalendarButton = <button className="indicator-bar-button" onClick={() => setShowPnlCalendar(true)} aria-label="Abrir calendario PNL" title="Calendario PNL">▦</button>;
  const eventMarkersButton = <><button className={`indicator-bar-button ${chartEventRules.some(event => event.symbol === symbol) ? 'indicator-toggle-active' : ''}`} onClick={() => setShowEventMarkers(true)} aria-label="Abrir eventos condicionales" title="Eventos condicionales">✦</button><button className={`indicator-bar-button ${chartEventsPaused ? 'event-rules-paused' : ''}`} onClick={() => setChartEventsPaused(value => !value)} aria-pressed={chartEventsPaused} aria-label={chartEventsPaused ? 'Mostrar recomendaciones' : 'Ocultar recomendaciones'} title={chartEventsPaused ? 'Mostrar recomendaciones' : 'Ocultar recomendaciones'}>{chartEventsPaused ? '▶' : '✕'}</button></>;
  const trainingTodayKey = calendarDayKey(Math.floor(Date.now() / 1000) as UTCTimestamp);
  const trainingOperations = paperPositions.filter(position => calendarDayKey(position.end.time) === trainingTodayKey);
  const trainingPnl = trainingOperations.filter(position => position.closed).reduce((sum, position) => sum + paperPnl(position), 0);
  const trainingProgress = Math.max(0, Math.min(1, trainingPnl / 40));
  const productionPreviewData = binancePreview.find(preview => preview.side === 'LONG');
  const productionPnl = productionPositions.reduce((sum, position) => sum + Number(position.unrealized_pnl ?? 0), 0);
  const riskPreviewBalance = riskBalanceForSizing;
  const riskPreviewUsd = riskPreviewBalance * activeRiskPercent / 100;
  const targetSlUsd = riskPreviewUsd;
  const targetTpUsd = binanceStopPercent > 0 ? riskPreviewUsd * binanceTargetPercent / binanceStopPercent : 0;
  const toggleProductionWorker = async () => {
    setProductionWorkerError('');
    const headers = { ...(auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}), 'Content-Type': 'application/json' };
    try {
      if (productionWorkerRunning) {
        const response = await fetch(`${apiUrl}/trading/production/workers/${encodeURIComponent(symbol)}`, { method: 'DELETE', headers, credentials: 'include' });
        if (!response.ok) throw new Error((await response.json() as { detail?: string }).detail ?? 'No se pudo detener el worker.');
        setProductionWorkerRunning(false);
        setExecutionMode('paper');
        return;
      }
      const mode = binanceProductionAvailable ? 'live' : 'paper';
      if (mode === 'live' && !window.confirm('Producción enviará órdenes reales a Binance. ¿Continuar?')) return;
      const response = await fetch(`${apiUrl}/trading/production/workers`, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ symbol, mode, interval: '1m', tracker_period: trackerPeriod, stop_percent: binanceStopPercent, target_percent: binanceTargetPercent, quantity: productionPreviewData?.quantity ?? 0, confirmed: mode === 'live' }) });
      if (!response.ok) throw new Error((await response.json() as { detail?: string }).detail ?? 'No se pudo iniciar el worker de producción.');
      setProductionWorkerRunning(true);
      setExecutionMode(mode === 'live' ? 'production' : 'paper');
    } catch (error) {
      setProductionWorkerError(error instanceof Error ? error.message : 'No se pudo cambiar el modo de ejecución.');
    }
  };
  const adjustRiskBalance = (delta: number) => setRiskBalancePreview(Math.max(.01, Number((riskPreviewBalance + delta).toFixed(4))));
  const adjustRiskPercent = (delta: number) => {
    const next = Math.max(.05, Math.min(100, Number((activeRiskPercent + delta).toFixed(2))));
    const current = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}');
    localStorage.setItem('helloworld-paper-assist', JSON.stringify({ ...current, riskPercent: next }));
    setPaperRiskPercent(next);
  };
  const adjustRiskUsd = (delta: number) => {
    const nextRiskUsd = Math.max(.01, Number((riskPreviewUsd + delta).toFixed(4)));
    const nextPercent = Math.max(.05, Math.min(100, Number((nextRiskUsd / riskPreviewBalance * 100).toFixed(2))));
    const current = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}');
    localStorage.setItem('helloworld-paper-assist', JSON.stringify({ ...current, riskPercent: nextPercent }));
    setPaperRiskPercent(nextPercent);
  };
  const adjustProtectionPercent = (kind: 'sl' | 'tp', delta: number) => {
    const setter = kind === 'sl' ? setBinanceStopPercent : setBinanceTargetPercent;
    const current = kind === 'sl' ? binanceStopPercent : binanceTargetPercent;
    const next = Math.max(.05, Math.min(20, Number((current + delta).toFixed(2))));
    setter(next);
    localStorage.setItem(kind === 'sl' ? 'helloworld-binance-stop-percent' : 'helloworld-binance-target-percent', String(next));
  };
  const optimizeTrackerTarget = () => {
    const source = renderBars(candleBarsRef.current, Math.max(300, Math.round(trackerPeriod) + 1));
    if (!showTracker || source.length <= trackerPeriod) return;
    let best: { targetPercent: number; equity: number; lossLimit: number; wins: number; losses: number } | null = null;
    for (let step = 1; step <= 200; step += 1) {
      const targetPercent = Number((step / 10).toFixed(2));
      const operations = runTrackerVisualSimulation(source, trackerPeriod, binanceStopPercent, targetPercent, paperInitialBalance, paperRiskPercent, paperLeverage).filter(operation => operation.closed);
      const lossLimit = findBestTrackerLossLimit(operations);
      const adjustedPnls = applyTrackerLossLimit(operations, lossLimit);
      const equity = paperInitialBalance + adjustedPnls.reduce((sum, pnl) => sum + pnl, 0);
      const wins = operations.filter(operation => operation.status === 'CLOSED - WIN').length;
      const losses = operations.filter(operation => operation.status === 'CLOSED - FAILED').length;
      if (!best || equity > best.equity || (equity === best.equity && targetPercent < best.targetPercent)) best = { targetPercent, equity, lossLimit: lossLimit.limit, wins, losses };
    }
    if (!best) return;
    setBinanceTargetPercent(best.targetPercent);
    localStorage.setItem('helloworld-binance-target-percent', String(best.targetPercent));
    setTrackerLossLimitEnabled(true);
    setTpOptimizationResult(best);
    setTrackerRevision(value => value + 1);
  };
  const productionOrderPreview = broker === 'binance'
    ? <span className={`production-order-preview ${productionPositions.length > 0 ? 'production-preview-active' : ''}`} aria-label="Preview de la próxima operación Binance"><span className="preview-mode"><small>MODO</small><strong>{binanceSizingMode === 'minimum' ? 'MÍNIMO' : 'MÁXIMO'}</strong></span><span className="preview-risk"><small>BALANCE <button type="button" className="preview-adjust-button" onClick={() => adjustRiskBalance(.1)} aria-label="Aumentar balance">↑</button><button type="button" className="preview-adjust-button" onClick={() => adjustRiskBalance(-.1)} aria-label="Disminuir balance">↓</button></small><strong>{riskPreviewBalance.toFixed(4)} USDT</strong></span><span className="preview-risk"><small>RISK % <button type="button" className="preview-adjust-button" onClick={() => adjustRiskPercent(.1)} aria-label="Aumentar riesgo porcentual">↑</button><button type="button" className="preview-adjust-button" onClick={() => adjustRiskPercent(-.1)} aria-label="Disminuir riesgo porcentual">↓</button></small><strong>{activeRiskPercent.toFixed(2)}%</strong></span><span className="preview-risk"><small>RISK $ <button type="button" className="preview-adjust-button" onClick={() => adjustRiskUsd(.01)} aria-label="Aumentar riesgo en dólares">↑</button><button type="button" className="preview-adjust-button" onClick={() => adjustRiskUsd(-.01)} aria-label="Disminuir riesgo en dólares">↓</button></small><strong>{riskPreviewUsd.toFixed(4)} USDT</strong></span><span><small>MARGIN</small><strong>{productionPreviewData ? `${productionPreviewData.margin.toFixed(4)} USDT` : '—'}</strong></span><span><small>MULTIPLICADOR</small><strong>{productionPreviewData ? `×${productionPreviewData.marginMultiplier.toFixed(2)}` : '—'}</strong></span><span><small>NOTIONAL</small><strong>{productionPreviewData ? `${productionPreviewData.notional.toFixed(4)} USDT` : '—'}</strong></span><span><small>LEVERAGE</small><strong>{productionPreviewData ? `${productionPreviewData.leverage}x` : '—'}</strong></span><span><small>FEE</small><strong>{productionPreviewData ? `${productionPreviewData.fees.toFixed(4)} USDT` : '—'}</strong></span><span className="preview-sl"><small>SL <button type="button" className="preview-adjust-button" onClick={() => adjustProtectionPercent('sl', .05)} aria-label="Aumentar SL">↑</button><button type="button" className="preview-adjust-button" onClick={() => adjustProtectionPercent('sl', -.05)} aria-label="Disminuir SL">↓</button></small><strong>−{binanceStopPercent.toFixed(2)}% · REAL −{productionPreviewData ? productionPreviewData.slAmount.toFixed(4) : '—'} $</strong><em>OBJ −{targetSlUsd.toFixed(4)} $</em></span><span className="preview-tp"><small>TP <button type="button" className="preview-adjust-button" onClick={() => adjustProtectionPercent('tp', .05)} aria-label="Aumentar TP">↑</button><button type="button" className="preview-adjust-button" onClick={() => adjustProtectionPercent('tp', -.05)} aria-label="Disminuir TP">↓</button><button type="button" className="preview-optimize-button" onClick={optimizeTrackerTarget} disabled={!showTracker} title="Probar TP de 0.10% a 20.00% con límite de pérdidas" aria-label="Optimizar TP">↗</button></small><strong>+{binanceTargetPercent.toFixed(2)}% · REAL +{productionPreviewData ? productionPreviewData.tpAmount.toFixed(4) : '—'} $</strong><em>OBJ +{targetTpUsd.toFixed(4)} $</em>{tpOptimizationResult && <i className="tp-optimizer-result">BEST {tpOptimizationResult.targetPercent.toFixed(2)}% · EQ {tpOptimizationResult.equity.toFixed(2)} · LIM −{tpOptimizationResult.lossLimit.toFixed(2)}%</i>}</span><span className="preview-pnl"><small>PNL</small><strong>{productionPositions.length > 0 ? `${productionPnl >= 0 ? '+' : ''}${productionPnl.toFixed(4)} USDT` : '—'}</strong></span></span>
    : null;
  const previewControls = <div className="preview-controls"><button type="button" className={`binance-sizing-toggle ${binanceSizingMode === 'maximum' ? 'binance-sizing-maximum' : ''}`} onClick={() => setBinanceSizingMode(current => { const next = current === 'minimum' ? 'maximum' : 'minimum'; localStorage.setItem('helloworld-binance-sizing-mode', next); return next; })} aria-label="Cambiar modo de sizing Binance" title="Alternar modo mínimo/máximo">{binanceSizingMode === 'minimum' ? 'MÍN' : 'MÁX'}</button><button type="button" className={`production-mode-icon ${productionWorkerRunning ? 'production-mode-active' : ''}`} onClick={() => void toggleProductionWorker()} aria-label="Iniciar o detener worker Paper/Producción" title={productionWorkerRunning ? 'Detener worker' : binanceProductionAvailable ? 'Iniciar Producción' : 'Iniciar Paper'}>◉</button></div>;
  const productionPositionLabel = productionPositions.length > 0
    ? productionPositions.map(position => {
      const pnl = Number(position.unrealized_pnl ?? 0);
      const side = Number(position.quantity ?? 0) >= 0 ? 'LONG' : 'SHORT';
      return `${position.symbol ?? '—'} ${side} · PNL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`;
    }).join(' · ')
    : '';
  const scannerStatusBar = broker === 'binance' ? <div className="header-market-scanner" aria-label="Market scanner Binance">{[...activeMarketSymbols].sort((a, b) => { const priority = { due: 0, overdue: 1, waiting: 2, '': 3 }; const stateA = getMarketReviewState(marketReviewTimes[a.symbol] ?? ''); const stateB = getMarketReviewState(marketReviewTimes[b.symbol] ?? ''); return priority[stateA as keyof typeof priority] - priority[stateB as keyof typeof priority] || b.variation_sum_pct - a.variation_sum_pct; }).map(candidate => { const variation = candidate.variation_sum_pct; const reviewTime = marketReviewTimes[candidate.symbol] ?? ''; const reviewState = getMarketReviewState(reviewTime); return <article key={candidate.symbol} className={`header-market-item ${candidate.symbol === symbol ? 'active' : ''} ${reviewTime ? `has-review-time review-${reviewState}` : ''}`}><button type="button" className="header-market-main" onClick={() => { setLabRecommendations(null); setSymbol(candidate.symbol); }}><b>{candidate.symbol}</b><span className={variation >= 0 ? 'ticker-up' : 'ticker-down'}>{variation >= 0 ? '▲' : '▼'} {Math.abs(variation).toFixed(2)}%</span></button><label className="header-market-review" title="Próxima revisión"><input type="time" value={reviewTime} onChange={event => updateMarketReviewTime(candidate.symbol, event.target.value)} aria-label={`Próxima revisión de ${candidate.symbol}`} />{reviewState === 'overdue' && <button type="button" className="header-market-reset" onClick={event => { event.stopPropagation(); updateMarketReviewTime(candidate.symbol, ''); }} aria-label={`Eliminar revisión de ${candidate.symbol}`} title="Eliminar revisión vencida">↻</button>}</label></article>; })}</div> : null;
  const statusBarMessage = paperSyncError || binanceLeverageError || activeMarketError || productionWorkerError;
  const binanceReady = binanceOnline;
  const binanceStatusClass = binanceReady
    ? executionMode === 'production' ? 'broker-production-connected' : 'broker-paper-ready'
    : 'broker-not-ready';
  const adjustTrackerPeriod = (delta: number) => {
    setTrackerPeriod(current => {
      const next = Math.max(1, Math.min(50, current + delta));
      localStorage.setItem('helloworld-tracker-period', String(next));
      return next;
    });
    setTrackerRevision(value => value + 1);
  };
  const adjustWickPeriod = (delta: number) => setWickPeriod(current => { const next = Math.max(1, Math.min(50, current + delta)); localStorage.setItem('helloworld-wick-period', String(next)); return next; });
  const adjustWickDisplayPeriod = (delta: number) => setWickDisplayPeriod(current => { const next = Math.max(1, Math.min(300, current + delta)); localStorage.setItem('helloworld-wick-display-period', String(next)); return next; });
  const adjustWickMultiplier = (delta: number) => setWickMultiplier(current => { const next = Math.max(0, Math.min(10, Number((current + delta).toFixed(1)))); localStorage.setItem('helloworld-wick-multiplier', String(next)); return next; });
  const quickArrows = (label: string, value: string | number, onUp: () => void, onDown: () => void, description: string) => <span className="quick-indicator-control"><span>{label}</span><button type="button" className="level-adjust-button" onClick={onUp} aria-label={`Aumentar ${description}`}>↑</button><b>{value}</b><button type="button" className="level-adjust-button" onClick={onDown} aria-label={`Disminuir ${description}`}>↓</button></span>;
  const adjustSslRegimeWindow = (delta: number) => setSslRegimeWindow(current => { const next = Math.max(2, Math.min(20, current + delta)); localStorage.setItem('helloworld-ssl-regime-window', String(next)); return next; });
  const adjustSslPeriod = (delta: number) => setSslPeriod(current => { const next = Math.max(2, Math.min(200, current + delta)); localStorage.setItem('helloworld-ssl-period', String(next)); return next; });
  const levelAdjustControls = <div className="level-adjust-controls" aria-label="Ajustar niveles e indicadores">{quickArrows('LEVELS N', trackerPeriod, () => adjustTrackerPeriod(1), () => adjustTrackerPeriod(-1), 'período de niveles')}{quickArrows('SSL P', sslPeriod, () => adjustSslPeriod(1), () => adjustSslPeriod(-1), 'período del indicador SSL')}{quickArrows('SSL N', sslRegimeWindow, () => adjustSslRegimeWindow(1), () => adjustSslRegimeWindow(-1), 'ventana de régimen SSL')}{quickArrows('WICK N', wickPeriod, () => adjustWickPeriod(1), () => adjustWickPeriod(-1), 'período de mechazos')}{quickArrows('SHOW', wickDisplayPeriod, () => adjustWickDisplayPeriod(1), () => adjustWickDisplayPeriod(-1), 'velas visibles')}{quickArrows('×', wickMultiplier.toFixed(1), () => adjustWickMultiplier(.1), () => adjustWickMultiplier(-.1), 'multiplicador de mechazos')}</div>;
  const replayControls = <div className={`replay-controls ${replayState.active ? 'replay-active' : ''}`} aria-label="Repetición vela a vela"><button type="button" onClick={() => replayState.active ? setReplaySnapshot({ ...replayState, running: !replayState.running }) : undefined} disabled={!replayState.active} title="Reproducir o pausar la repetición">{replayState.running ? 'Ⅱ' : '▶'}</button><button type="button" onClick={() => advanceReplay(-1)} disabled={!replayState.active || replayState.cursor <= replayState.start} title="Vela anterior">‹</button><button type="button" onClick={() => advanceReplay(1)} disabled={!replayState.active || replayState.cursor >= replayState.total - 1} title="Siguiente vela">›</button><button type="button" onClick={stopReplay} disabled={!replayState.active} title="Salir de repetición">×</button><small>{replayState.active ? `REPLAY ${replayState.cursor + 1}/${replayState.total}` : 'CLICK EN VELA · REPLAY'}</small></div>;
  const desktopHeader = <div className="symbol-bar"><select className={`broker-select ${broker === 'binance' ? binanceStatusClass : ''}`} value={broker} onChange={event => { const next = event.target.value as 'binance' | 'ctrader'; setBroker(next); setSymbol(next === 'ctrader' ? 'AUDUSD' : 'BTCUSDT'); }} aria-label="Broker"><option value="binance">Binance</option><option value="ctrader">cTrader</option></select><select className="symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">
    {selectableSymbols.map(option => <option key={option}>{option}</option>)}
  </select><select className="interval-select" value={interval} onChange={event => setInterval(event.target.value as typeof interval)} aria-label="Intervalo de contexto">{(['1s', '1m', '3m', '5m', '15m'] as const).map(value => <option key={value} value={value}>{value}</option>)}</select>{scannerStatusBar}{broker === 'binance' && <>{productionPositionLabel && <span className={`production-position-summary ${productionPositions.some(position => Number(position.unrealized_pnl ?? 0) >= 0) ? 'production-profit' : 'production-loss'}`}>{productionPositionLabel}</span>}</>}{statusBarMessage && <span className="header-status-error" role="status" title={statusBarMessage}>⚠ {statusBarMessage}</span>}<div className="chart-tools" aria-label="Herramientas del gráfico">
    {labButton}{riskEngineButton}{pnlCalendarButton}{eventMarkersButton}<button className={`indicator-bar-button ${showHeikinAshi ? 'indicator-toggle-active' : ''}`} onClick={() => setShowHeikinAshi(value => !value)} aria-pressed={showHeikinAshi} aria-label="Alternar Heikin Ashi" title="Heikin Ashi">HA</button><button className={!tool ? 'tool-active' : ''} onClick={() => setTool(null)} aria-label="Seleccionar y navegar" title="Seleccionar y navegar">↖</button>
    {([['line', '╱', 'Línea'], ['ruler', '▥', 'Regla'], ['long', 'L', 'Long'], ['short', 'S', 'Short'], ['zoom', '⌗', 'Zoom lazo'], ['pan', '✋', 'Pan']] as const).map(([key, icon, label]) => <button key={key} className={tool === key ? 'tool-active' : ''} onClick={() => chooseTool(key)} aria-label={label} title={label}>{icon}</button>)}
    <button onClick={() => setDrawings(current => current.filter(drawing => drawing.paper))} aria-label="Borrar dibujos" title="Borrar dibujos">×</button>{levelAdjustControls}
  </div>{profileButton}{showRiskEngine && <RiskEngineModal onClose={() => setShowRiskEngine(false)} />}{showEventMarkers && <EventMarkersPanel activeSymbol={symbol} apiUrl={apiUrl} accessToken={auth.accessToken} rules={chartEventRules} occurrences={chartEventOccurrences} onChange={setChartEventRules} onDeleteOccurrence={id => setChartEventOccurrences(current => current.filter(event => event.id !== id))} onClose={() => setShowEventMarkers(false)} />}<button className="logout-button" onClick={() => void auth.logout()} aria-label="Cerrar sesión">Salir</button></div>;

    const scannerStatus = (candidateSymbol: string) => {
      const operation = trainingOperations.filter(position => position.symbol === candidateSymbol).sort((a, b) => Number(b.start.time) - Number(a.start.time))[0];
      if (!operation) return { label: 'NOT OPENED', className: 'scanner-status-not-opened' };
      if (!operation.closed) return { label: 'IN PROGRESS', className: 'scanner-status-in-progress' };
      return { label: 'DONE', className: 'scanner-status-done' };
    };
  const marketScanner = broker === 'binance' ? <section className="market-overview" aria-label="Resumen de operación Binance"><div className="market-scanner-training"><div className="training-card-content"><span className="positions-kicker">TRAINING OPERATOR · PNL NETO DIARIO</span><strong>${trainingPnl.toFixed(2)} / $40.00</strong><div className="training-progress-track"><span style={{ width: `${trainingProgress * 100}%` }} /></div><small>{trainingPnl >= 40 ? 'Meta diaria completada' : `Faltan $${Math.max(0, 40 - trainingPnl).toFixed(2)}`}</small></div><div className="binance-balance-card"><span className="positions-kicker">BINANCE · BALANCE</span><strong>{binanceLiveAccount?.futures_balance != null ? `${Number(binanceLiveAccount.futures_balance).toFixed(2)} USDT` : '—'}</strong><small>Disponible {binanceLiveAccount?.available_balance != null ? `${Number(binanceLiveAccount.available_balance).toFixed(2)} USDT` : '—'}</small><small>PNL abierto {binanceLiveAccount?.total_unrealized_pnl != null ? `${Number(binanceLiveAccount.total_unrealized_pnl) >= 0 ? '+' : ''}${Number(binanceLiveAccount.total_unrealized_pnl).toFixed(4)} USDT` : '—'}</small></div><div className="replay-card"><span className="positions-kicker">REPLAY · VELA A VELA</span>{replayControls}</div></div><div className="market-preview-slot"><div className="market-preview-card">{previewControls}{productionOrderPreview}</div></div></section> : null;
  const tradingAgent = <TradingAgentChat activeSymbol={symbol} interval={interval} apiUrl={apiUrl} accessToken={auth.accessToken} />;

  const toolOptions = [['line', '╱', 'Línea'], ['ruler', '▥', 'Medir'], ['long', 'L', 'Long'], ['short', 'S', 'Short'], ['zoom', '⌗', 'Zoom lazo'], ['pan', '✋', 'Pan']] as const;
  const trackerClosedOperations = trackerVirtualOperations.filter(operation => operation.closed);
  const [trackerLossLimitEnabled, setTrackerLossLimitEnabled] = useState(false);
  const trackerLossLimitAnalysis = findBestTrackerLossLimit(trackerClosedOperations);
  const trackerAdjustedOutcome = (operation: TrackerVirtualOperation) => {
    const crossedLimitedStop = trackerLossLimitEnabled && operation.minRoe.roePercent <= -trackerLossLimitAnalysis.limit;
    if (!crossedLimitedStop) return { status: operation.status, pnl: operation.pnl, resultRoePercent: operation.resultRoePercent, limited: false };
    const grossLimitedPnl = -(trackerLossLimitAnalysis.limit / 100 / Math.max(1, operation.leverage)) * operation.notional;
    const pnl = Math.max(operation.pnl, grossLimitedPnl - tradingCosts('binance', operation.notional).total);
    return { status: 'CLOSED - FAILED' as const, pnl, resultRoePercent: -trackerLossLimitAnalysis.limit, limited: true };
  };
  const trackerDisplayedOutcomes = trackerClosedOperations.map(trackerAdjustedOutcome);
  const trackerWins = trackerDisplayedOutcomes.filter(outcome => outcome.status === 'CLOSED - WIN').length;
  const trackerLosses = trackerDisplayedOutcomes.filter(outcome => outcome.status === 'CLOSED - FAILED').length;
  const trackerSettled = trackerWins + trackerLosses;
  const trackerWinRate = trackerSettled > 0 ? trackerWins / trackerSettled * 100 : 0;
  const trackerAverageWinRoe = trackerWins > 0 ? trackerDisplayedOutcomes.filter(outcome => outcome.status === 'CLOSED - WIN').reduce((sum, outcome) => sum + outcome.resultRoePercent, 0) / trackerWins : 0;
  const trackerAverageLossRoe = trackerLosses > 0 ? trackerDisplayedOutcomes.filter(outcome => outcome.status === 'CLOSED - FAILED').reduce((sum, outcome) => sum + outcome.resultRoePercent, 0) / trackerLosses : 0;
  const trackerAverageWinValue = trackerWins > 0 ? trackerDisplayedOutcomes.filter(outcome => outcome.status === 'CLOSED - WIN').reduce((sum, outcome) => sum + outcome.pnl, 0) / trackerWins : 0;
  const trackerAverageLossValue = trackerLosses > 0 ? trackerDisplayedOutcomes.filter(outcome => outcome.status === 'CLOSED - FAILED').reduce((sum, outcome) => sum + outcome.pnl, 0) / trackerLosses : 0;
  const trackerStepBars = candleBarsRef.current.slice(-(trackerPeriod + 1));
  const trackerStepPercent = trackerStepBars.length > trackerPeriod ? trackerStepBars.slice(1).reduce((sum, bar, index) => {
    const previousClose = trackerStepBars[index].close;
    return previousClose > 0 ? sum + Math.abs(bar.close - previousClose) / previousClose * 100 : sum;
  }, 0) : null;
  const trackerStepStatus = trackerStepPercent == null ? 'Sin datos' : trackerStepPercent < 2 ? 'Bajo · <2%' : trackerStepPercent > 4 ? 'Alto · >4%' : 'En rango · 2–4%';
  const trackerAverageWin = { toFixed: (_digits?: number) => `${trackerAverageWinRoe.toFixed(2)}% · +${trackerAverageWinValue.toFixed(4)}` };
  const trackerAverageLoss = { toFixed: (_digits?: number) => `${(trackerLossLimitEnabled ? trackerDisplayedAverageLossRoe : trackerAverageLossRoe).toFixed(2)}% · ${(trackerLossLimitEnabled ? trackerDisplayedAverageLossValue : trackerAverageLossValue).toFixed(4)}` };
  let trackerEquity = paperInitialBalance;
  const trackerEquityPoints = [{ equity: trackerEquity, time: 0, side: '', status: 'INICIO' }, ...trackerClosedOperations.map(operation => {
    trackerEquity += operation.pnl;
    return { equity: trackerEquity, time: Number(operation.end.time), side: operation.side.toUpperCase(), status: operation.status === 'CLOSED - WIN' ? 'WIN' : 'FAIL' };
  })];
  const trackerEquityValues = trackerEquityPoints.map(point => point.equity);
  const trackerEquityMin = Math.min(...trackerEquityValues, paperInitialBalance);
  const trackerEquityMax = Math.max(...trackerEquityValues, paperInitialBalance);
  const trackerEquityPadding = Math.max((trackerEquityMax - trackerEquityMin) * .12, 1);
  const trackerChartMin = trackerEquityMin - trackerEquityPadding;
  const trackerChartMax = trackerEquityMax + trackerEquityPadding;
  const trackerChartWidth = 900;
  const trackerChartHeight = 170;
  const trackerChartPadding = { top: 12, right: 14, bottom: 22, left: 42 };
  const trackerEquityCoordinates = trackerEquityPoints.map((point, index) => {
    const x = trackerChartPadding.left + (index / Math.max(1, trackerEquityPoints.length - 1)) * (trackerChartWidth - trackerChartPadding.left - trackerChartPadding.right);
    const y = trackerChartPadding.top + (1 - (point.equity - trackerChartMin) / Math.max(.000001, trackerChartMax - trackerChartMin)) * (trackerChartHeight - trackerChartPadding.top - trackerChartPadding.bottom);
    return { ...point, x, y };
  });
  const trackerEquityPointsSvg = trackerEquityCoordinates.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const [trackerSummarySort, setTrackerSummarySort] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const trackerAdjustedPnls = trackerClosedOperations.map(operation => {
    return trackerLossLimitEnabled ? trackerAdjustedOutcome(operation).pnl : operation.pnl;
  });
  const trackerDisplayedAverageLossValue = trackerLosses ? trackerDisplayedOutcomes.reduce((sum, outcome) => outcome.status === 'CLOSED - FAILED' ? sum + outcome.pnl : sum, 0) / trackerLosses : 0;
  const trackerDisplayedAverageLossRoe = trackerLosses ? trackerDisplayedOutcomes.reduce((sum, outcome) => outcome.status === 'CLOSED - FAILED' ? sum + outcome.resultRoePercent : sum, 0) / trackerLosses : 0;
  let trackerAdjustedEquity = paperInitialBalance;
  const trackerAdjustedEquityPoints = [{ equity: trackerAdjustedEquity }, ...trackerAdjustedPnls.map(pnl => { trackerAdjustedEquity += pnl; return { equity: trackerAdjustedEquity }; })];
  const trackerDisplayedEquity = trackerLossLimitEnabled ? trackerAdjustedEquity : trackerEquity;
  const trackerDisplayedPnl = trackerDisplayedEquity - paperInitialBalance;
  const trackerDisplayedEquityValues = trackerLossLimitEnabled ? trackerAdjustedEquityPoints.map(point => point.equity) : trackerEquityValues;
  const trackerMaxBalance = Math.max(...trackerDisplayedEquityValues, paperInitialBalance);
  const trackerMinBalance = Math.min(...trackerDisplayedEquityValues, paperInitialBalance);
  const trackerAdjustedEquityCoordinates = trackerAdjustedEquityPoints.map((point, index) => {
    const x = trackerChartPadding.left + (index / Math.max(1, trackerAdjustedEquityPoints.length - 1)) * (trackerChartWidth - trackerChartPadding.left - trackerChartPadding.right);
    const y = trackerChartPadding.top + (1 - (point.equity - trackerChartMin) / Math.max(.000001, trackerChartMax - trackerChartMin)) * (trackerChartHeight - trackerChartPadding.top - trackerChartPadding.bottom);
    return { ...point, x, y };
  });
  const trackerAdjustedEquityPointsSvg = trackerAdjustedEquityCoordinates.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const trackerSortValue = (operation: TrackerVirtualOperation): string | number => {
    if (trackerSummarySort.key === 'side') return operation.side;
    if (trackerSummarySort.key === 'level') return operation.level;
    if (trackerSummarySort.key === 'maxroe') return operation.maxRoe.roePercent;
    if (trackerSummarySort.key === 'realmaxroe') return operation.realMaxRoe.roePercent;
    if (trackerSummarySort.key === 'minroe') return operation.minRoe.roePercent;
    if (trackerSummarySort.key === 'realminroe') return operation.realMinRoe.roePercent;
    if (trackerSummarySort.key === 'result') return trackerAdjustedOutcome(operation).resultRoePercent;
    return trackerClosedOperations.indexOf(operation);
  };
  const trackerSortedOperations = [...trackerClosedOperations].sort((left, right) => {
    const leftValue = trackerSortValue(left);
    const rightValue = trackerSortValue(right);
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
    return (trackerSummarySort.direction === 'desc' ? -1 : 1) * comparison;
  });
  const trackerTableHeaders = [['index', '#'], ['side', 'Lado'], ['level', 'Nivel'], ['maxroe', 'MAXROE'], ['realmaxroe', 'REALMAXROE'], ['minroe', 'MINROE'], ['realminroe', 'REALMINROE'], ['result', 'WIN/FAIL · RESULTADO']] as const;
  const trackerSummaryHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = trackerSummaryHost.current;
    if (!showTracker || !host) return;
    const tablePanel = document.createElement('div');
    tablePanel.className = 'tracker-operations-summary';
    const title = document.createElement('div');
    title.className = 'tracker-equity-title';
    title.innerHTML = '<span>Resumen de operaciones</span><small>orden cronológico · primeras arriba</small>';
    tablePanel.appendChild(title);
    const controls = document.createElement('div');
    controls.className = 'tracker-loss-limit-controls';
    const limitButton = document.createElement('button');
    limitButton.type = 'button';
    limitButton.className = trackerLossLimitEnabled ? 'tracker-loss-limit-button tracker-loss-limit-active' : 'tracker-loss-limit-button';
    limitButton.textContent = trackerLossLimitEnabled ? 'Quitar límite' : 'Limitar pérdidas';
    limitButton.title = 'Calcular el mejor umbral y superponer una curva con las pérdidas limitadas';
    limitButton.addEventListener('click', () => setTrackerLossLimitEnabled(value => !value));
    controls.appendChild(limitButton);
    const analysis = document.createElement('small');
    analysis.className = 'tracker-loss-limit-analysis';
    analysis.textContent = `Umbral MINROE ${trackerLossLimitAnalysis.limit >= 0 ? '-' : ''}${Math.abs(trackerLossLimitAnalysis.limit).toFixed(2)}% · WIN ${(trackerLossLimitAnalysis.winCoverage * 100).toFixed(1)}% · FAIL limitadas ${(trackerLossLimitAnalysis.lossCoverage * 100).toFixed(1)}% · Equity limitada ${trackerAdjustedEquity.toFixed(4)} USDT`;
    controls.appendChild(analysis);
    tablePanel.appendChild(controls);
    const scroll = document.createElement('div');
    scroll.className = 'tracker-operations-table-scroll';
    const table = document.createElement('table');
    table.className = 'tracker-operations-table';
    const head = table.createTHead().insertRow();
    trackerTableHeaders.forEach(([key, label]) => {
      const cell = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tracker-sort-button';
      button.textContent = `${label}${trackerSummarySort.key === key ? trackerSummarySort.direction === 'desc' ? ' ↓' : ' ↑' : ' ↕'}`;
      button.title = `Ordenar ${label} ${trackerSummarySort.key === key && trackerSummarySort.direction === 'desc' ? 'de menor a mayor' : 'de mayor a menor'}`;
      button.addEventListener('click', () => setTrackerSummarySort(current => current.key === key ? { key, direction: current.direction === 'desc' ? 'asc' : 'desc' } : { key, direction: 'desc' }));
      cell.appendChild(button);
      head.appendChild(cell);
    });
    const body = table.createTBody();
    trackerSortedOperations.forEach((operation, index) => {
      const originalIndex = trackerClosedOperations.indexOf(operation);
      const displayedOutcome = trackerDisplayedOutcomes[originalIndex];
      const displayedPnl = displayedOutcome.pnl;
      const displayedRoe = displayedOutcome.resultRoePercent;
      const pointLabel = (point: TrackerExtremePoint) => `${point.roePercent >= 0 ? '+' : ''}${point.roePercent.toFixed(2)}% · ${point.pnlUsd >= 0 ? '+' : ''}${point.pnlUsd.toFixed(4)} USDT`;
      const row = body.insertRow();
      row.className = displayedOutcome.status === 'CLOSED - WIN' ? 'tracker-operation-row-win' : 'tracker-operation-row-failed';
      [String(index + 1), operation.side.toUpperCase(), operation.level, pointLabel(operation.maxRoe), pointLabel(operation.realMaxRoe), pointLabel(operation.minRoe), pointLabel(operation.realMinRoe), `${displayedOutcome.status === 'CLOSED - WIN' ? 'WIN' : 'FAIL'}${displayedOutcome.limited ? ' · LIMITADA' : ''} · ${displayedRoe >= 0 ? '+' : ''}${displayedRoe.toFixed(2)}% · ${displayedPnl >= 0 ? '+' : ''}${displayedPnl.toFixed(4)} USDT`].forEach(value => { row.insertCell().textContent = value; });
    });
    scroll.appendChild(table);
    tablePanel.appendChild(scroll);
    host.appendChild(tablePanel);
    return () => tablePanel.remove();
  }, [showTracker, trackerClosedOperations, timezone, trackerSummarySort, trackerLossLimitEnabled, trackerLossLimitAnalysis.limit, trackerLossLimitAnalysis.winCoverage, trackerLossLimitAnalysis.lossCoverage, trackerAdjustedEquity]);
  const trackerFactorSeries = trackerClosedOperations.filter(operation => operation.status === 'CLOSED - WIN' && operation.bodyAveragePercentAtOpen > 0).map(operation => ({
    time: Number(operation.end.time),
    tpFactor: operation.finalTargetPercent / operation.bodyAveragePercentAtOpen,
    volatilityRatio: operation.bodyAveragePercentAtClose / operation.bodyAveragePercentAtOpen,
  }));
  const trackerFactorChartWidth = 900;
  const trackerFactorChartHeight = 220;
  const trackerFactorChartPadding = { top: 22, right: 18, bottom: 28, left: 48 };
  const trackerFactorMax = Math.max(1, ...trackerFactorSeries.flatMap(point => [point.tpFactor, point.volatilityRatio])) * 1.12;
  const trackerFactorPoint = (value: number, index: number) => ({
    x: trackerFactorChartPadding.left + (index / Math.max(1, trackerFactorSeries.length - 1)) * (trackerFactorChartWidth - trackerFactorChartPadding.left - trackerFactorChartPadding.right),
    y: trackerFactorChartPadding.top + (1 - value / trackerFactorMax) * (trackerFactorChartHeight - trackerFactorChartPadding.top - trackerFactorChartPadding.bottom),
  });
  const trackerTpFactorPoints = trackerFactorSeries.map((point, index) => trackerFactorPoint(point.tpFactor, index));
  const trackerVolatilityRatioPoints = trackerFactorSeries.map((point, index) => trackerFactorPoint(point.volatilityRatio, index));
  const trackerRawSeries = trackerClosedOperations.filter(operation => operation.status === 'CLOSED - WIN');
  const trackerRawMax = Math.max(1, ...trackerRawSeries.flatMap(operation => [operation.finalTargetPercent, operation.bodyAveragePercentAtOpen, operation.bodyAveragePercentAtClose])) * 1.12;
  const trackerRawPoint = (value: number, index: number) => ({
    x: trackerFactorChartPadding.left + (index / Math.max(1, trackerRawSeries.length - 1)) * (trackerFactorChartWidth - trackerFactorChartPadding.left - trackerFactorChartPadding.right),
    y: trackerFactorChartPadding.top + (1 - value / trackerRawMax) * (trackerFactorChartHeight - trackerFactorChartPadding.top - trackerFactorChartPadding.bottom),
  });
  const trackerRawTpPoints = trackerRawSeries.map((operation, index) => trackerRawPoint(operation.finalTargetPercent, index));
  const trackerRawOpenPoints = trackerRawSeries.map((operation, index) => trackerRawPoint(operation.bodyAveragePercentAtOpen, index));
  const trackerRawClosePoints = trackerRawSeries.map((operation, index) => trackerRawPoint(operation.bodyAveragePercentAtClose, index));
  const trackerFactorPanel = showTracker ? <section className="tracker-factor-panel" aria-label="Relación temporal de volatilidad y TP"><div className="tracker-equity-title"><span>Relación temporal · WIN</span><small>TP / N AP · N CIERRE / N AP</small></div>{trackerFactorSeries.length ? <svg className="tracker-factor-chart" viewBox={`0 0 ${trackerFactorChartWidth} ${trackerFactorChartHeight}`} role="img" aria-label="Factores de TP y volatilidad de operaciones ganadoras"><line x1={trackerFactorChartPadding.left} y1={trackerFactorChartHeight - trackerFactorChartPadding.bottom} x2={trackerFactorChartWidth - trackerFactorChartPadding.right} y2={trackerFactorChartHeight - trackerFactorChartPadding.bottom} className="tracker-factor-axis" /><polyline points={trackerTpFactorPoints.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} className="tracker-factor-tp-line" /><polyline points={trackerVolatilityRatioPoints.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} className="tracker-factor-volatility-line" />{trackerFactorSeries.map((point, index) => <g key={`${point.time}-${index}`}><circle cx={trackerTpFactorPoints[index].x} cy={trackerTpFactorPoints[index].y} r="4" className="tracker-factor-tp-dot"><title>{new Date(point.time * 1000).toLocaleString('es-MX', { timeZone: timezone })} · TP/N AP {point.tpFactor.toFixed(2)}x</title></circle><circle cx={trackerVolatilityRatioPoints[index].x} cy={trackerVolatilityRatioPoints[index].y} r="4" className="tracker-factor-volatility-dot"><title>{new Date(point.time * 1000).toLocaleString('es-MX', { timeZone: timezone })} · N cierre/N AP {point.volatilityRatio.toFixed(2)}x</title></circle></g>)}</svg> : <p className="tracker-equity-empty">Aún no hay suficientes WIN para graficar la relación.</p>}<div className="tracker-factor-legend"><span><i className="tracker-factor-tp-swatch" /> TP / N AP</span><span><i className="tracker-factor-volatility-swatch" /> N CIERRE / N AP</span></div></section> : null;
  const trackerRawFactorPanel = showTracker ? <section className="tracker-factor-panel" aria-label="Valores absolutos de volatilidad y TP"><div className="tracker-equity-title"><span>Valores absolutos · WIN</span><small>porcentaje real de cada operación</small></div>{trackerRawSeries.length ? <svg className="tracker-factor-chart" viewBox={`0 0 ${trackerFactorChartWidth} ${trackerFactorChartHeight}`} role="img" aria-label="Valores absolutos de TP y volatilidad"><line x1={trackerFactorChartPadding.left} y1={trackerFactorChartHeight - trackerFactorChartPadding.bottom} x2={trackerFactorChartWidth - trackerFactorChartPadding.right} y2={trackerFactorChartHeight - trackerFactorChartPadding.bottom} className="tracker-factor-axis" /><polyline points={trackerRawTpPoints.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} className="tracker-factor-tp-line" /><polyline points={trackerRawOpenPoints.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} className="tracker-factor-open-line" /><polyline points={trackerRawClosePoints.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} className="tracker-factor-volatility-line" />{trackerRawSeries.map((operation, index) => <g key={`raw-${operation.id}`}><circle cx={trackerRawTpPoints[index].x} cy={trackerRawTpPoints[index].y} r="4" className="tracker-factor-tp-dot"><title>TP FINAL {operation.finalTargetPercent.toFixed(3)}%</title></circle><circle cx={trackerRawOpenPoints[index].x} cy={trackerRawOpenPoints[index].y} r="4" className="tracker-factor-open-dot"><title>N AP {operation.bodyAveragePercentAtOpen.toFixed(3)}%</title></circle><circle cx={trackerRawClosePoints[index].x} cy={trackerRawClosePoints[index].y} r="4" className="tracker-factor-volatility-dot"><title>N CIERRE {operation.bodyAveragePercentAtClose.toFixed(3)}%</title></circle></g>)}</svg> : <p className="tracker-equity-empty">Aún no hay WIN para graficar.</p>}<div className="tracker-factor-legend"><span><i className="tracker-factor-tp-swatch" /> TP FINAL</span><span><i className="tracker-factor-open-swatch" /> N AP</span><span><i className="tracker-factor-volatility-swatch" /> N CIERRE</span></div></section> : null;
  const trackerFactorTable = showTracker && trackerRawSeries.length ? <section className="tracker-factor-table-panel" aria-label="Valores numéricos de volatilidad y TP"><div className="tracker-equity-title"><span>Valores numéricos · WIN</span><small>orden cronológico</small></div><div className="tracker-factor-table-scroll"><table className="tracker-factor-table"><thead><tr><th>#</th><th>Cierre</th><th>TP ROE %</th><th>LEV.</th><th>TP PRECIO %</th><th>N AP %</th><th>N CIERRE %</th><th>TP / N AP</th><th>N CIERRE / N AP</th></tr></thead><tbody>{trackerRawSeries.map((operation, index) => { const tpFactor = operation.bodyAveragePercentAtOpen > 0 ? operation.finalTargetPercent / operation.bodyAveragePercentAtOpen : 0; const volatilityRatio = operation.bodyAveragePercentAtOpen > 0 ? operation.bodyAveragePercentAtClose / operation.bodyAveragePercentAtOpen : 0; return <tr key={`factor-row-${operation.id}`}><td>{index + 1}</td><td>{new Date(Number(operation.end.time) * 1000).toLocaleString('es-MX', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' })}</td><td>{operation.finalTargetRoePercent.toFixed(3)}%</td><td>{operation.leverage.toFixed(1)}x</td><td>{operation.finalTargetPercent.toFixed(3)}%</td><td>{operation.bodyAveragePercentAtOpen.toFixed(3)}%</td><td>{operation.bodyAveragePercentAtClose.toFixed(3)}%</td><td>{tpFactor.toFixed(2)}x</td><td>{volatilityRatio.toFixed(2)}x</td></tr>; })}</tbody></table></div></section> : null;
  const trackerEquityPanel = showTracker ? <section className="tracker-stats-panel" aria-label="Estadísticas del indicador Tracker"><div className="tracker-stats-head"><div><span className="positions-kicker">TRACKER · 1M · SIMULACIÓN</span><h2>Estadísticas Tracker</h2><p>Operaciones virtuales del indicador · balance inicial {paperInitialBalance.toFixed(2)} USDT</p></div><div className="tracker-final-metrics"><div><small>Resultado final</small><strong className={trackerDisplayedPnl >= 0 ? 'tracker-equity-positive' : 'tracker-equity-negative'}>{trackerDisplayedPnl >= 0 ? '+' : ''}{trackerDisplayedPnl.toFixed(4)} USDT</strong></div><div><small>Balance máximo</small><strong>{trackerMaxBalance.toFixed(4)} USDT</strong></div><div><small>Balance mínimo</small><strong>{trackerMinBalance.toFixed(4)} USDT</strong></div><div className={trackerStepPercent == null ? '' : trackerStepPercent < 2 ? 'tracker-step-low' : trackerStepPercent > 4 ? 'tracker-step-high' : 'tracker-step-in-range'} title={"Suma de cambios absolutos entre cierres en las últimas " + trackerPeriod + " velas de 1 minuto. " + trackerStepStatus}><small>% Step · {trackerPeriod} × 1m</small><strong>{trackerStepPercent == null ? '—' : trackerStepPercent.toFixed(2) + '%'}</strong><small>{trackerStepStatus}</small></div></div></div><div className="tracker-stats-grid"><div><small>Total operaciones</small><strong>{trackerVirtualOperations.length}</strong></div><div><small>Wins</small><strong className="tracker-stat-win">{trackerWins}</strong></div><div><small>Losses</small><strong className="tracker-stat-loss">{trackerLosses}</strong></div><div><small>Win rate</small><strong>{trackerSettled ? `${trackerWinRate.toFixed(1)}%` : '—'}</strong></div><div><small>Avg win</small><strong className="tracker-stat-win">{trackerWins ? "+" + trackerAverageWin.toFixed(4) + " USDT" : "—"}</strong></div><div><small>Avg loss</small><strong className="tracker-stat-loss">{trackerLosses ? trackerAverageLoss.toFixed(4) + " USDT" : "—"}</strong></div><div><small>Equity final</small><strong>{trackerDisplayedEquity.toFixed(4)} USDT</strong></div></div><div className="tracker-equity-wrap"><div className="tracker-equity-title"><span>Curva de equity simulada</span><small>{trackerClosedOperations.length} operaciones liquidadas</small></div>{trackerClosedOperations.length ? <svg className="tracker-equity-chart" viewBox={`0 0 ${trackerChartWidth} ${trackerChartHeight}`} role="img" aria-label="Curva de equity simulada"><line x1={trackerChartPadding.left} y1={trackerChartPadding.top + (1 - (paperInitialBalance - trackerChartMin) / Math.max(.000001, trackerChartMax - trackerChartMin)) * (trackerChartHeight - trackerChartPadding.top - trackerChartPadding.bottom)} x2={trackerChartWidth - trackerChartPadding.right} y2={trackerChartPadding.top + (1 - (paperInitialBalance - trackerChartMin) / Math.max(.000001, trackerChartMax - trackerChartMin)) * (trackerChartHeight - trackerChartPadding.top - trackerChartPadding.bottom)} className="tracker-equity-baseline" /><polyline points={trackerEquityPointsSvg} className={trackerEquity >= paperInitialBalance ? 'tracker-equity-line tracker-equity-line-positive' : 'tracker-equity-line tracker-equity-line-negative'} />{trackerLossLimitEnabled && <polyline points={trackerAdjustedEquityPointsSvg} className="tracker-adjusted-equity-line" />}{trackerEquityCoordinates.map((point, index) => index === 0 ? <circle key="tracker-equity-start" cx={point.x} cy={point.y} r="5" className="tracker-equity-dot" /> : <circle key={`tracker-equity-${point.time}-${index}`} cx={point.x} cy={point.y} r="7" className="tracker-equity-hover-point" onPointerEnter={() => setTrackerEquityHover({ x: point.x, y: point.y, equity: point.equity, time: point.time, side: point.side, status: point.status })} onPointerLeave={() => setTrackerEquityHover(null)}><title>{new Date(point.time * 1000).toLocaleString('es-MX', { timeZone: timezone })} · Balance {point.equity.toFixed(4)} USDT</title></circle>)}{trackerEquityHover && <g className="tracker-equity-tooltip" pointerEvents="none"><rect x={Math.max(6, Math.min(trackerChartWidth - 196, trackerEquityHover.x + 10))} y={Math.max(6, trackerEquityHover.y - 62)} width="190" height="52" rx="5" /><text x={Math.max(16, Math.min(trackerChartWidth - 186, trackerEquityHover.x + 20))} y={Math.max(21, trackerEquityHover.y - 43)}>Cierre {new Date(trackerEquityHover.time * 1000).toLocaleString('es-MX', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' })}</text><text x={Math.max(16, Math.min(trackerChartWidth - 186, trackerEquityHover.x + 20))} y={Math.max(38, trackerEquityHover.y - 26)}>Balance {trackerEquityHover.equity.toFixed(4)} USDT · {trackerEquityHover.side}</text><text x={Math.max(16, Math.min(trackerChartWidth - 186, trackerEquityHover.x + 20))} y={Math.max(55, trackerEquityHover.y - 9)}>{trackerEquityHover.status}</text></g>}</svg> : <p className="tracker-equity-empty">Aún no hay operaciones cerradas para graficar.</p>}<div ref={trackerSummaryHost} /></div></section> : null;
  const chartsRow = <div className="charts-row"><section ref={overviewStage} className={`secondary-chart ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={event => startDrawing(event, 'context')} onPointerMoveCapture={updateDrawing} onPointerUpCapture={event => finishDrawingAndCapture(event, 'context')} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); panStartRef.current = null; setResizeStart(null); setLassoStart(null); setLassoEnd(null); }}><div className="chart-panel-label">{interval.toUpperCase()} · CONTEXTO · {symbol}</div><div className="chart-viewport-snapshot" aria-label="Snapshot del viewport de contexto">X {overviewViewportSnapshot.bars} · Futuro {overviewViewportSnapshot.futureBars} · Y− {overviewViewportSnapshot.yBelow}% · Y+ {overviewViewportSnapshot.yAbove}%</div><div ref={overviewChartContainer} className="overview-chart" />{renderOhlcOverlay(overviewOhlcHover)}<svg className="overview-overlay" viewBox={`0 0 ${overviewSize.width} ${overviewSize.height}`} preserveAspectRatio="none" aria-hidden="true">{renderOverviewSessions()}{renderOverviewInterestMarkers()}{renderPriceLineHitAreas('context')}{[...drawings, ...productionDrawings, ...backtestVisualDrawings].map((drawing, index) => (!drawing.paper || !drawing.closed || drawing.id === visibleClosedId) && (!drawing.paper || !drawing.symbol || drawing.symbol === symbol) && (drawing.chart === 'context' || drawing.paper) ? renderDrawing(drawing, index, 'context') : null)}{tool && tool !== 'pan' && drawingStart && drawingEnd && drawingCanvas === 'context' && renderDrawing({ type: tool, chart: 'context', start: drawingStart, end: drawingEnd }, 'preview', 'context')}{lassoStart && lassoEnd && drawingCanvas === 'context' && <rect x={Math.min(lassoStart.x, lassoEnd.x)} y={Math.min(lassoStart.y, lassoEnd.y)} width={Math.abs(lassoStart.x - lassoEnd.x)} height={Math.abs(lassoStart.y - lassoEnd.y)} className="selection-lasso" />}</svg></section><section className="primary-chart"><div className="chart-panel-label">{entryInterval.toUpperCase()} · AJUSTE DE ENTRADA</div>{chartStageView}</section></div>;

  return mobilePwa ? <main className="trading-shell pwa-shell">
    <header className="pwa-mobile-header"><div><span className="pwa-brand">helloworld</span><span className="pwa-market">{broker.toUpperCase()} · {entryInterval.toUpperCase()} ENTRADA · {interval.toUpperCase()} CONTEXTO</span></div><select className="pwa-symbol-select" value={broker} onChange={event => { const next = event.target.value as 'binance' | 'ctrader'; setBroker(next); setSymbol(next === 'ctrader' ? 'AUDUSD' : 'BTCUSDT'); }} aria-label="Broker"><option value="binance">Binance</option><option value="ctrader">cTrader</option></select><select className="pwa-symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">{selectableSymbols.map(option => <option key={option}>{option}</option>)}</select>{profileButton}</header>
    <section className="pwa-chart-wrap">{chartStageView}</section>{trackerEquityPanel}{trackerFactorPanel}{trackerRawFactorPanel}{trackerFactorTable}{positionsTable}{wickBacktestPanel}{paperStatsPanel}{recentClosedPanel}{labAssistPanel}<BalanceSummary paperBalance={paperEquity} revision={profileRevision} /><BinanceAccountPanel revision={profileRevision} /><CTraderAccountPanel revision={profileRevision} />{tradingAgent}
    <nav className="pwa-bottom-nav" aria-label="Controles PWA"><button onClick={() => setTool(null)} className={!tool ? 'pwa-nav-active' : ''}>↖<span>Seleccionar</span></button><button onClick={() => setMobileSheet('indicators')} className={showSessions ? 'pwa-nav-active' : ''}>◉<span>Indicadores</span></button><button onClick={() => setShowHeikinAshi(value => !value)} className={showHeikinAshi ? 'pwa-nav-active' : ''}>HA<span>Heikin Ashi</span></button><button onClick={() => setMobileSheet('tools')} className={tool ? 'pwa-nav-active' : ''}>⌁<span>Herramientas</span></button><button onClick={() => void auth.logout()}>⇥<span>Salir</span></button></nav>
    {mobileSheet === 'indicators' && <MobileSheet title="Indicadores" onClose={() => setMobileSheet(null)}><button className={`mobile-option ${showSessions ? 'option-active' : ''}`} onClick={() => setShowSessions(value => !value)}><span><b>Sesiones de mercado</b><small>Tokyo, Londres, Nueva York y Sydney</small></span><i>{showSessions ? '✓' : ''}</i></button><label className="mobile-field">Intervalo<select value={interval} onChange={event => setInterval(event.target.value as typeof interval)}>{(['1s', '1m', '3m', '5m', '15m'] as const).map(value => <option key={value}>{value}</option>)}</select></label><label className="mobile-field">Zona horaria<select value={timezone} onChange={event => setTimezone(event.target.value)}>{TIMEZONES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></label></MobileSheet>}
    {mobileSheet === 'tools' && <MobileSheet title="Herramientas" onClose={() => setMobileSheet(null)}><div className="mobile-tool-grid"><button className={!tool ? 'option-active' : ''} onClick={() => { setTool(null); setMobileSheet(null); }}>↖<span>Seleccionar</span></button>{toolOptions.map(([key, icon, label]) => <button key={key} className={tool === key ? 'option-active' : ''} onClick={() => { chooseTool(key); setMobileSheet(null); }}>{icon}<span>{label}</span></button>)}<button onClick={() => { setDrawings(current => current.filter(drawing => drawing.paper)); activePositionIndexRef.current = null; setActivePositionIndex(null); }}>×<span>Borrar dibujos</span></button></div></MobileSheet>}
    {showProfile && <ProfileModal onClose={() => setShowProfile(false)} onSaved={() => setProfileRevision(value => value + 1)} />}{pnlCalendarModal}
  </main> : <main className="trading-shell">{desktopHeader}{marketScanner}{chartsRow}{trackerEquityPanel}{trackerFactorPanel}{trackerRawFactorPanel}{trackerFactorTable}{positionsTable}{wickBacktestPanel}{paperStatsPanel}{recentClosedPanel}{labAssistPanel}<BalanceSummary paperBalance={paperEquity} revision={profileRevision} /><BinanceAccountPanel revision={profileRevision} /><CTraderAccountPanel revision={profileRevision} /><section ref={labSection} className="lab-layout-section"><LabWindow key={`${broker}:${symbol}`} activeSymbol={symbol} broker={broker} apiUrl={apiUrl} accessToken={auth.accessToken} initialBars={candleBarsRef.current} paperBalance={paperEquity} resolutionOverride={labResolution} onRecommendation={value => { setLabRecommendations(value); if (value) setLabResolution(value.resolution); }} /></section>{showProfile && <ProfileModal onClose={() => setShowProfile(false)} onSaved={() => setProfileRevision(value => value + 1)} />}{pnlCalendarModal}{tradingAgent}</main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  const labRoute = window.location.pathname === '/lab';
  const ctraderCallbackRoute = window.location.pathname === '/ctrader/callback';
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.14', serviceWorkerUrl: '/sw.js?v=0.1.14', updateIntervalMs: 60_000 }}><AuthProvider client={client}><AuthSessionKeeper client={client} /><AuthGuard fallback={<Access />}>{ctraderCallbackRoute ? <CTraderOAuthCallback /> : labRoute ? <LabWindow /> : <Workspace />}</AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
