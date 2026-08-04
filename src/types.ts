export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
export type Summary = { price: number; change: number; changePct: number; trend: 'bullish' | 'bearish'; rsi14: number | null; volumeRatio: number | null; ma20: number; ma50: number; support20: number; resistance20: number };
export type Holding = { id: string; symbol: string; quantity: number; cost: number };
export type Snapshot = {
  snapshotId: string; symbol: string; source: string; updatedAt: string; marketStatus: string; delayLabel: string; candles: Candle[]; summary: Summary;
  backtest: { strategy: { name: string; assumptions: string; version: string }; sample: { start: string; end: string; candleCount: number; benchmark: string }; metrics: { cumulativeReturnPct: number; buyHoldReturnPct: number; maxDrawdownPct: number; annualizedVolatilityPct: number; completedTrades: number }; equity: { time: string; value: number }[] };
  events: unknown[]; eventsStatus: string; providerPolicy: { yahooFallbackEnabled: boolean; commercialDisplay: string };
};
