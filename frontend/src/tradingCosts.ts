export type TradingBroker = 'binance' | 'ctrader';

export type TradingCosts = {
  commission: number;
  slippage: number;
  total: number;
};

export function tradingCostRate(broker: TradingBroker) {
  return broker === 'ctrader' ? 0.00016 : 0.0014;
}

/** Round-trip estimates used by Paper and the MAE/MFE assist. */
export function tradingCosts(broker: TradingBroker, notional: number): TradingCosts {
  const safeNotional = Math.max(0, Number(notional) || 0);
  if (broker === 'ctrader') {
    // cTrader/Forex: USD 6 per standard lot (100,000 units), round-trip.
    const commission = safeNotional / 100_000 * 6;
    const slippage = safeNotional * 0.01 / 100;
    return { commission, slippage, total: commission + slippage };
  }
  // Binance futures: taker commission 0.10% + estimated slippage 0.04%.
  const commission = safeNotional * 0.10 / 100;
  const slippage = safeNotional * 0.04 / 100;
  return { commission, slippage, total: commission + slippage };
}
