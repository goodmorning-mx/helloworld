export type IndicatorBar = { high: number; low: number; close: number };
// Lightweight Charts accepts several time representations (including its
// branded UTCTimestamp). Keep the utility agnostic to that brand.
export type OhlcBar = { time: any; open: number; high: number; low: number; close: number };

/** Builds TradingView-style Heikin Ashi candles from the real OHLC series. */
export function calculateHeikinAshi(bars: OhlcBar[]): OhlcBar[] {
  let previousOpen = 0;
  let previousClose = 0;
  return bars.map((bar, index) => {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const open = index === 0 ? (bar.open + bar.close) / 2 : (previousOpen + previousClose) / 2;
    const high = Math.max(bar.high, open, close);
    const low = Math.min(bar.low, open, close);
    previousOpen = open;
    previousClose = close;
    return { time: bar.time, open, high, low, close };
  });
}

export function calculateRsi(bars: IndicatorBar[], period = 14): Array<number | null> {
  const length = Math.max(2, Math.round(period));
  const values: Array<number | null> = Array.from({ length: bars.length }, () => null);
  if (bars.length <= length) return values;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= length; index += 1) {
    const change = bars[index].close - bars[index - 1].close;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / length;
  let averageLoss = loss / length;
  const rsi = () => averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  values[length] = rsi();
  for (let index = length + 1; index < bars.length; index += 1) {
    const change = bars[index].close - bars[index - 1].close;
    averageGain = (averageGain * (length - 1) + Math.max(change, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-change, 0)) / length;
    values[index] = rsi();
  }
  return values;
}

export function calculateSslChannel(bars: IndicatorBar[], period = 10) {
  const length = Math.max(2, Math.round(period));
  const up: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const down: Array<number | null> = Array.from({ length: bars.length }, () => null);
  let direction = 0;
  for (let index = length - 1; index < bars.length; index += 1) {
    const window = bars.slice(index - length + 1, index + 1);
    const high = window.reduce((sum, bar) => sum + bar.high, 0) / length;
    const low = window.reduce((sum, bar) => sum + bar.low, 0) / length;
    if (bars[index].close > high) direction = 1;
    else if (bars[index].close < low) direction = -1;
    up[index] = direction >= 0 ? low : high;
    down[index] = direction >= 0 ? high : low;
  }
  return { up, down };
}
