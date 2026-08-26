import type { MarketBar } from './marketData';

export type LabDirection = 'long' | 'short';
export type LabResolution = 1 | 5;
export type LabCapitalModel = 'compound' | 'simple';

export type LabSeriesPoint = {
  slot: number;
  label: string;
  mae: number;
  mfe: number;
};

export type LabRow = {
  slot: number;
  label: string;
  samples: number;
  stop: number;
  target: number;
  rr: number;
  expectancyR: number;
  winRate: number;
  leverage: number;
  capitalFactor: number;
};

type Sample = { slot: number; time: number; adverse: number; favorable: number; row: number };
export const LAB_TIMEZONE = 'America/Mexico_City';
const STOP_PERCENTILES = [75, 80, 85, 90, 95];
const TARGET_PERCENTILES = [25, 30, 40, 50, 60, 75];

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function slotOf(time: number, resolution: LabResolution) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: LAB_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time * 1000));
  const weekday = (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find(part => part.type === 'weekday')?.value ?? ''));
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  const slotsPerDay = 1440 / resolution;
  return weekday * slotsPerDay + hour * (60 / resolution) + Math.floor(minute / resolution);
}

function slotLabel(slot: number, resolution: LabResolution) {
  const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const slotsPerDay = 1440 / resolution;
  const day = Math.floor(slot / slotsPerDay);
  const withinDay = slot % slotsPerDay;
  const totalMinutes = withinDay * resolution;
  return `${weekdays[day] ?? 'DAY'} ${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function samplesFor(bars: MarketBar[], direction: LabDirection, horizon: number, resolution: LabResolution): Sample[] {
  const samples: Sample[] = [];
  for (let row = 0; row + horizon <= bars.length; row += 1) {
    const entry = bars[row].open;
    if (!entry) continue;
    let adverse = 0;
    let favorable = 0;
    let contiguous = true;
    for (let offset = 0; offset < horizon; offset += 1) {
      const bar = bars[row + offset];
      if (offset > 0 && bar.time - bars[row + offset - 1].time !== resolution * 60) { contiguous = false; break; }
      if (direction === 'long') {
        adverse = Math.max(adverse, (entry - bar.low) / entry * 100);
        favorable = Math.max(favorable, (bar.high - entry) / entry * 100);
      } else {
        adverse = Math.max(adverse, (bar.high - entry) / entry * 100);
        favorable = Math.max(favorable, (entry - bar.low) / entry * 100);
      }
    }
    if (contiguous) samples.push({ slot: slotOf(bars[row].time, resolution), time: bars[row].time, adverse, favorable, row });
  }
  return samples;
}

export function buildLabSeries(
  bars: MarketBar[], direction: LabDirection, horizon: number, resolution: LabResolution,
): LabSeriesPoint[] {
  return samplesFor(bars, direction, Math.max(1, Math.floor(horizon)), resolution)
    .map(sample => ({
      slot: sample.slot,
      label: slotLabel(sample.slot, resolution),
      mae: sample.adverse,
      mfe: sample.favorable,
    }));
}

function evaluate(bars: MarketBar[], samples: Sample[], stop: number, target: number, direction: LabDirection, horizon: number) {
  let wins = 0;
  let total = 0;
  for (const sample of samples) {
    const entry = bars[sample.row].open;
    let stopHit = Infinity;
    let targetHit = Infinity;
    for (let offset = 0; offset < horizon; offset += 1) {
      const bar = bars[sample.row + offset];
      const adverse = direction === 'long' ? (entry - bar.low) / entry * 100 : (bar.high - entry) / entry * 100;
      const favorable = direction === 'long' ? (bar.high - entry) / entry * 100 : (entry - bar.low) / entry * 100;
      if (!Number.isFinite(stopHit) && adverse >= stop) stopHit = offset;
      if (!Number.isFinite(targetHit) && favorable >= target) targetHit = offset;
    }
    if (targetHit < stopHit) { wins += 1; total += target / stop; }
    else if (stopHit < targetHit || Number.isFinite(stopHit)) total -= 1;
    else {
      const close = bars[sample.row + horizon - 1].close;
      const terminal = direction === 'long' ? (close - entry) / entry * 100 : (entry - close) / entry * 100;
      total += terminal / stop;
    }
  }
  return { expectancyR: samples.length ? total / samples.length : 0, winRate: samples.length ? wins / samples.length * 100 : 0 };
}

export function analyzeLab(
  bars: MarketBar[], direction: LabDirection, horizon: number, riskFraction: number,
  resolution: LabResolution, capitalModel: LabCapitalModel,
): LabRow[] {
  const samples = samplesFor(bars, direction, Math.max(1, Math.floor(horizon)), resolution);
  const bySlot = new Map<number, Sample[]>();
  for (const sample of samples) bySlot.set(sample.slot, [...(bySlot.get(sample.slot) ?? []), sample]);
  return [...bySlot.entries()].map(([slot, slotSamples]) => {
    let best: LabRow | null = null;
    const stopValues = STOP_PERCENTILES.map(p => percentile(slotSamples.map(sample => sample.adverse), p));
    const targetValues = TARGET_PERCENTILES.map(p => percentile(slotSamples.map(sample => sample.favorable), p));
    for (const stop of stopValues) for (const target of targetValues) {
      if (stop <= 0 || target <= 0) continue;
      const result = evaluate(bars, slotSamples, stop, target, direction, horizon);
      const perTradeFactor = 1 + result.expectancyR * riskFraction;
      const capitalFactor = capitalModel === 'compound'
        ? Math.max(0, perTradeFactor) ** slotSamples.length
        : 1 + result.expectancyR * riskFraction * slotSamples.length;
      const candidate: LabRow = { slot, label: slotLabel(slot, resolution), samples: slotSamples.length, stop, target, rr: target / stop, expectancyR: result.expectancyR, winRate: result.winRate, leverage: riskFraction / (stop / 100), capitalFactor };
      if (!best || candidate.expectancyR > best.expectancyR || (candidate.expectancyR === best.expectancyR && candidate.rr > best.rr)) best = candidate;
    }
    return best;
  }).filter((row): row is LabRow => row !== null).sort((left, right) => right.expectancyR - left.expectancyR);
}
