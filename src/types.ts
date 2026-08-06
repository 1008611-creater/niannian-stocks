export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
export type Summary = { price: number; change: number; changePct: number; trend: 'bullish' | 'bearish'; rsi14: number | null; volumeRatio: number | null; ma20: number; ma50: number; support20: number; resistance20: number };
export type Portfolio = { id: string; name: string; isDefault: boolean };
export type Holding = { id: string; portfolioId: string; symbol: string; quantity: number; cost: number };
export type MarketEvent = { kind: 'earnings' | 'dividend' | 'split'; date: string; title: string; timing: string; detail: string };
export type AlertKind = 'price_change' | 'rsi_cross' | 'trend_shift';
export type AlertRule = { id: string; symbol: string; kind: AlertKind; threshold: number; enabled: boolean; updated_at: string };
export type AlertNotification = { id: string; alert_rule_id: string; symbol: string; period_key: string; status: 'triggered' | 'sent' | 'failed' | 'read'; value: number; triggered_at: string; delivered_at: string | null; read_at: string | null };
export type Snapshot = {
  snapshotId: string; symbol: string; source: string; updatedAt: string; marketStatus: string; delayLabel: string; candles: Candle[]; summary: Summary;
  backtest: { strategy: { name: string; assumptions: string; version: string }; sample: { start: string; end: string; candleCount: number; benchmark: string }; metrics: { cumulativeReturnPct: number; buyHoldReturnPct: number; maxDrawdownPct: number; annualizedVolatilityPct: number; completedTrades: number }; equity: { time: string; value: number }[] };
  events: MarketEvent[]; eventsStatus: 'available' | 'unavailable' | 'not_configured'; providerPolicy: { yahooFallbackEnabled: boolean; commercialDisplay: string };
};
export type AgentReport = {
  title: string; summary: string; stance: '观察偏多' | '中性观察' | '观察偏空' | '数据不足' | string;
  opportunities: { claim: string; why: string }[]; risks: { claim: string; why: string }[]; nextChecks: string[];
  evidence: { label: string; path: string; value: string }[]; generatedAt: string; snapshotId: string; source: string; updatedAt: string;
  modelProvider?: string; question?: string; fallback?: boolean;
};
