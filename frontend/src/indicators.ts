export type IndicatorBar = { high: number; low: number; close: number };
// Lightweight Charts accepts several time representations (including its
// branded UTCTimestamp). Keep the utility agnostic to that brand.
export type OhlcBar = { time: any; open: number; high: number; low: number; close: number };
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Returns candles inside a recurring wall-clock window for each calendar day. */
export function calculateDailyTimeWindow(
  bars: OhlcBar[],
  timezone: string,
  startMinute = 7 * 60 + 20,
  endMinute = 7 * 60 + 35,
): boolean[] {
  const active = Array.from({ length: bars.length }, () => false);
  let formatter = timeFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(timezone, formatter);
  }
  bars.forEach((bar, index) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(Number(bar.time) * 1000)).map(part => [part.type, part.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    active[index] = minute >= startMinute && minute < endMinute;
  });
  return active;
}

/** Builds TradingView-style Heikin Ashi candles from the real OHLC series. */
export function calculateHeikinAshi(bars: OhlcBar[]): OhlcBar[] {
  const result: OhlcBar[] = [];
  for (const bar of bars) result.push(calculateHeikinAshiBar(bar, result[result.length - 1]));
  return result;
}

export function calculateHeikinAshiBar(bar: OhlcBar, previous?: OhlcBar): OhlcBar {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = previous ? (previous.open + previous.close) / 2 : (bar.open + bar.close) / 2;
  return { time: bar.time, open, high: Math.max(bar.high, open, close), low: Math.min(bar.low, open, close), close };
}

function calculateRsiState(bars: IndicatorBar[], period = 14) {
  const length = Math.max(2, Math.round(period));
  const values: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const averageGains = Array.from({ length: bars.length }, () => 0);
  const averageLosses = Array.from({ length: bars.length }, () => 0);
  if (bars.length <= length) return { values, averageGains, averageLosses, period: length };
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= length; index += 1) {
    const change = bars[index].close - bars[index - 1].close;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / length;
  let averageLoss = loss / length;
  averageGains[length] = averageGain;
  averageLosses[length] = averageLoss;
  const rsi = () => averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  values[length] = rsi();
  for (let index = length + 1; index < bars.length; index += 1) {
    const change = bars[index].close - bars[index - 1].close;
    averageGain = (averageGain * (length - 1) + Math.max(change, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-change, 0)) / length;
    averageGains[index] = averageGain;
    averageLosses[index] = averageLoss;
    values[index] = rsi();
  }
  return { values, averageGains, averageLosses, period: length };
}

export function calculateRsi(bars: IndicatorBar[], period = 14): Array<number | null> {
  return calculateRsiState(bars, period).values;
}

export function calculateSslChannel(bars: IndicatorBar[], period = 9) {
  const length = Math.max(2, Math.round(period));
  const up: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const down: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const bullish: boolean[] = Array.from({ length: bars.length }, () => false);
  const regimeAge: number[] = Array.from({ length: bars.length }, () => 0);
  let direction = 0;
  let age = 0;
  for (let index = length - 1; index < bars.length; index += 1) {
    const window = bars.slice(index - length + 1, index + 1);
    const high = window.reduce((sum, bar) => sum + bar.high, 0) / length;
    const low = window.reduce((sum, bar) => sum + bar.low, 0) / length;
    const previousDirection = direction;
    if (bars[index].close > high) direction = 1;
    else if (bars[index].close < low) direction = -1;
    if (direction !== 0 && direction !== previousDirection) age = 1;
    else if (direction !== 0) age += 1;
    // Standard SSL Channel: the two averages exchange positions when the
    // regime changes, producing the characteristic bullish/bearish cross.
    up[index] = direction >= 0 ? high : low;
    down[index] = direction >= 0 ? low : high;
    bullish[index] = direction >= 0;
    regimeAge[index] = direction === 0 ? 0 : age;
  }
  return { up, down, bullish, regimeAge };
}

/**
 * Projects favorable entry extensions from the opposite wick of recent candles.
 * A long uses lower wicks (price probing down and recovering); a short uses
 * upper wicks (price probing up and rejecting). The reference is the current
 * candle's open, so the projected level stays fixed while that candle forms.
 */
export function calculateWickExtensions(bars: OhlcBar[], lookback = 10, multiplier = 1.5) {
  const length = Math.max(2, Math.round(lookback));
  const factor = Math.max(0, Number.isFinite(multiplier) ? multiplier : 1.5);
  const long: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const short: Array<number | null> = Array.from({ length: bars.length }, () => null);

  for (let index = length; index < bars.length; index += 1) {
    const window = bars.slice(index - length, index);
    const lowerAverage = window.reduce((sum, bar) => sum + Math.max(0, Math.min(bar.open, bar.close) - bar.low), 0) / length;
    const upperAverage = window.reduce((sum, bar) => sum + Math.max(0, bar.high - Math.max(bar.open, bar.close)), 0) / length;
    // Do not use the live close here: it changes on every tick and would make
    // the marker chase price. A new level is created only when a new candle
    // opens, using the completed candles in the lookback window.
    const reference = bars[index].open;
    if (reference <= 0) continue;
    long[index] = reference * (1 - (lowerAverage / reference) * factor);
    short[index] = reference * (1 + (upperAverage / reference) * factor);
  }

  return { long, short };
}

/**
 * Calculates the four fixed tracker levels used by the legacy Dash strategy.
 * Each row only inspects the N candles immediately before it, so once a row
 * exists its levels do not change when later candles arrive.
 *
 * H2/L2 are the wick extremes and H1/L1 are the body extremes.
 */
export type TrackerLevel = { h2: number; h1: number; l1: number; l2: number };
export function calculateTrackerLevels(bars: OhlcBar[], lookback = 5): Array<TrackerLevel | null> {
  const length = Math.max(1, Math.round(lookback));
  const levels: Array<TrackerLevel | null> = Array.from({ length: bars.length }, () => null);
  for (let index = length; index < bars.length; index += 1) {
    const window = bars.slice(index - length, index);
    levels[index] = {
      h2: Math.max(...window.map(bar => bar.high)),
      h1: Math.max(...window.map(bar => Math.max(bar.open, bar.close))),
      l1: Math.min(...window.map(bar => Math.min(bar.open, bar.close))),
      l2: Math.min(...window.map(bar => bar.low)),
    };
  }
  return levels;
}

export type IncrementalIndicatorSnapshot = {
  rsi: Array<number | null>;
  ssl: ReturnType<typeof calculateSslChannel>;
  tracker: Array<TrackerLevel | null>;
  wick: ReturnType<typeof calculateWickExtensions>;
  dailyWindow: boolean[];
};

/** Retains prior outputs and appends or refreshes only the current candle. */
export class IncrementalIndicatorSeries {
  private config = '';
  private firstTime: number | null = null;
  private lastBar: OhlcBar | null = null;
  private barTimes: number[] = [];
  private length = 0;
  private averageGains: number[] = [];
  private averageLosses: number[] = [];
  private rsiPeriod = 14;
  private snapshot: IncrementalIndicatorSnapshot | null = null;

  update(bars: OhlcBar[], options: { rsiPeriod: number; sslPeriod: number; trackerPeriod: number; wickPeriod: number; wickMultiplier: number; timezone: string }): IncrementalIndicatorSnapshot {
    const config = JSON.stringify(options);
    const firstTime = bars.length ? Number(bars[0].time) : null;
    const last = bars[bars.length - 1] ?? null;
    if (this.snapshot && this.config === config && this.firstTime !== firstTime && firstTime !== null) {
      const dropped = this.barTimes.indexOf(firstTime);
      const oldRemainder = this.length - dropped;
      if (dropped > 0 && bars.length >= oldRemainder && bars.length <= oldRemainder + 1) {
        this.snapshot.rsi.splice(0, dropped);
        this.snapshot.ssl.up.splice(0, dropped);
        this.snapshot.ssl.down.splice(0, dropped);
        this.snapshot.ssl.bullish.splice(0, dropped);
        this.snapshot.ssl.regimeAge.splice(0, dropped);
        this.snapshot.tracker.splice(0, dropped);
        this.snapshot.wick.long.splice(0, dropped);
        this.snapshot.wick.short.splice(0, dropped);
        this.snapshot.dailyWindow.splice(0, dropped);
        this.averageGains.splice(0, dropped);
        this.averageLosses.splice(0, dropped);
        this.barTimes.splice(0, dropped);
        this.length = oldRemainder;
        this.firstTime = firstTime;
      }
    }
    if (!this.snapshot || this.config !== config || this.firstTime !== firstTime || bars.length < this.length || bars.length > this.length + 1) {
      this.rebuild(bars, options, config, firstTime, last);
      return this.snapshot!;
    }
    if (!last) return this.snapshot;
    const appended = bars.length === this.length + 1;
    const changed = !this.lastBar || this.lastBar.time !== last.time || this.lastBar.open !== last.open || this.lastBar.high !== last.high || this.lastBar.low !== last.low || this.lastBar.close !== last.close;
    if (!appended && !changed) return this.snapshot;
    if (appended) {
      this.snapshot.rsi.push(null);
      this.snapshot.ssl.up.push(null);
      this.snapshot.ssl.down.push(null);
      this.snapshot.ssl.bullish.push(false);
      this.snapshot.ssl.regimeAge.push(0);
      this.snapshot.tracker.push(null);
      this.snapshot.wick.long.push(null);
      this.snapshot.wick.short.push(null);
      this.snapshot.dailyWindow.push(false);
      this.averageGains.push(0);
      this.averageLosses.push(0);
      this.length += 1;
    }
    this.updateTail(bars, options);
    this.lastBar = { ...last };
    if (this.barTimes.length < bars.length) this.barTimes.push(Number(last.time));
    else this.barTimes[bars.length - 1] = Number(last.time);
    return this.snapshot;
  }

  private rebuild(bars: OhlcBar[], options: { rsiPeriod: number; sslPeriod: number; trackerPeriod: number; wickPeriod: number; wickMultiplier: number; timezone: string }, config: string, firstTime: number | null, last: OhlcBar | null) {
    const rsiState = calculateRsiState(bars, options.rsiPeriod);
    this.snapshot = {
      rsi: rsiState.values,
      ssl: calculateSslChannel(bars, options.sslPeriod),
      tracker: calculateTrackerLevels(bars, options.trackerPeriod),
      wick: calculateWickExtensions(bars, options.wickPeriod, options.wickMultiplier),
      dailyWindow: calculateDailyTimeWindow(bars, options.timezone),
    };
    this.averageGains = rsiState.averageGains;
    this.averageLosses = rsiState.averageLosses;
    this.rsiPeriod = rsiState.period;
    this.config = config;
    this.firstTime = firstTime;
    this.lastBar = last ? { ...last } : null;
    this.barTimes = bars.map(bar => Number(bar.time));
    this.length = bars.length;
  }

  private updateTail(bars: OhlcBar[], options: { rsiPeriod: number; sslPeriod: number; trackerPeriod: number; wickPeriod: number; wickMultiplier: number; timezone: string }) {
    const snapshot = this.snapshot!;
    const index = bars.length - 1;
    const bar = bars[index];
    const period = this.rsiPeriod;
    if (index === period) {
      let gain = 0;
      let loss = 0;
      for (let current = 1; current <= period; current += 1) {
        const change = bars[current].close - bars[current - 1].close;
        gain += Math.max(change, 0);
        loss += Math.max(-change, 0);
      }
      this.averageGains[index] = gain / period;
      this.averageLosses[index] = loss / period;
      snapshot.rsi[index] = this.averageLosses[index] === 0 ? 100 : 100 - (100 / (1 + this.averageGains[index] / this.averageLosses[index]));
    } else if (index > period) {
      const change = bar.close - bars[index - 1].close;
      this.averageGains[index] = (this.averageGains[index - 1] * (period - 1) + Math.max(change, 0)) / period;
      this.averageLosses[index] = (this.averageLosses[index - 1] * (period - 1) + Math.max(-change, 0)) / period;
      snapshot.rsi[index] = this.averageLosses[index] === 0 ? 100 : 100 - (100 / (1 + this.averageGains[index] / this.averageLosses[index]));
    } else if (index >= 0) snapshot.rsi[index] = null;

    const sslPeriod = Math.max(2, Math.round(options.sslPeriod));
    if (index >= sslPeriod - 1) {
      let high = 0;
      let low = 0;
      for (let current = index - sslPeriod + 1; current <= index; current += 1) {
        high += bars[current].high;
        low += bars[current].low;
      }
      high /= sslPeriod;
      low /= sslPeriod;
      const previousAge = index > 0 ? snapshot.ssl.regimeAge[index - 1] : 0;
      const previousDirection = previousAge === 0 ? 0 : snapshot.ssl.bullish[index - 1] ? 1 : -1;
      let direction = previousDirection;
      if (bar.close > high) direction = 1;
      else if (bar.close < low) direction = -1;
      const age = direction === 0 ? 0 : direction !== previousDirection ? 1 : previousAge + 1;
      snapshot.ssl.up[index] = direction >= 0 ? high : low;
      snapshot.ssl.down[index] = direction >= 0 ? low : high;
      snapshot.ssl.bullish[index] = direction >= 0;
      snapshot.ssl.regimeAge[index] = age;
    }

    const trackerPeriod = Math.max(1, Math.round(options.trackerPeriod));
    if (index >= trackerPeriod) {
      let h2 = -Infinity;
      let h1 = -Infinity;
      let l1 = Infinity;
      let l2 = Infinity;
      for (let current = index - trackerPeriod; current < index; current += 1) {
        const sample = bars[current];
        h2 = Math.max(h2, sample.high);
        h1 = Math.max(h1, sample.open, sample.close);
        l1 = Math.min(l1, sample.open, sample.close);
        l2 = Math.min(l2, sample.low);
      }
      snapshot.tracker[index] = { h2, h1, l1, l2 };
    }

    const wickPeriod = Math.max(2, Math.round(options.wickPeriod));
    if (index >= wickPeriod && bar.open > 0) {
      let lower = 0;
      let upper = 0;
      for (let current = index - wickPeriod; current < index; current += 1) {
        const sample = bars[current];
        lower += Math.max(0, Math.min(sample.open, sample.close) - sample.low);
        upper += Math.max(0, sample.high - Math.max(sample.open, sample.close));
      }
      const factor = Math.max(0, Number.isFinite(options.wickMultiplier) ? options.wickMultiplier : 1.5);
      snapshot.wick.long[index] = bar.open * (1 - (lower / wickPeriod / bar.open) * factor);
      snapshot.wick.short[index] = bar.open * (1 + (upper / wickPeriod / bar.open) * factor);
    }
    snapshot.dailyWindow[index] = calculateDailyTimeWindow([bar], options.timezone)[0] ?? false;
  }
}

export type TrackerSignal = { side: 'long' | 'short'; level: 'H1' | 'H2' | 'L1' | 'L2' };

/** Canonical exclusive Tracker ladder shared by replay/backtesting and the
 * backend worker contract. */
export function calculateTrackerSignal(close: number, levels: TrackerLevel | null): TrackerSignal | null {
  if (!levels) return null;
  if (close >= levels.h1 && close >= levels.h2) return { side: 'short', level: 'H2' };
  if (close >= levels.h1 && close < levels.h2) return { side: 'short', level: 'H1' };
  if (close <= levels.l1 && close > levels.l2) return { side: 'long', level: 'L1' };
  if (close <= levels.l2 && close <= levels.l1) return { side: 'long', level: 'L2' };
  return null;
}

/** Decide exits from the completed candle close. SL wins if both thresholds
 * could be satisfied, matching the conservative execution contract. */
export function calculateTrackerCloseReason(side: 'long' | 'short', entryPrice: number, close: number, stopPercent: number, targetPercent: number): 'TP' | 'SL' | null {
  if (!(entryPrice > 0)) return null;
  const direction = side === 'long' ? 1 : -1;
  const closeRoe = ((close - entryPrice) / entryPrice) * direction;
  if (closeRoe <= -Math.abs(stopPercent) / 100) return 'SL';
  if (closeRoe >= Math.abs(targetPercent) / 100) return 'TP';
  return null;
}
