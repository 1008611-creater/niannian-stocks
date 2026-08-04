import { createHash } from 'node:crypto';

const SYMBOL = /^[A-Z.]{1,10}$/;
const DAY = 86_400_000;
const CANDLE_TTL_SECONDS = 60;
const PROVIDER_TIMEOUT_MS = 10_000;

export class MarketError extends Error {
  constructor(code, status = 502, message = '行情暂时不可用，请稍后重试。') {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeSymbol(input) {
  const symbol = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (!SYMBOL.test(symbol)) throw new MarketError('invalid_symbol', 400, '请输入 1–10 位美股代码，只能使用英文字母和点号。');
  return symbol;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function safeCandles(rows) {
  const candles = rows.filter((candle) => candle.time && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite));
  if (candles.length < 60) throw new MarketError('provider_payload_invalid', 502);
  return candles.sort((a, b) => a.time.localeCompare(b.time));
}

async function requestJson(url, headers = {}) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new MarketError('provider_unavailable');
  }
  if (response.status === 429) throw new MarketError('provider_quota_exceeded', 429, '行情数据源达到当前额度，请稍后刷新。');
  if (!response.ok) throw new MarketError('provider_unavailable');
  try {
    return await response.json();
  } catch {
    throw new MarketError('provider_payload_invalid');
  }
}

async function getFmpCandles(symbol, apiKey) {
  if (!apiKey) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 220 * DAY);
  const url = new URL('https://financialmodelingprep.com/stable/historical-price-eod/full');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('from', start.toISOString().slice(0, 10));
  url.searchParams.set('to', end.toISOString().slice(0, 10));
  url.searchParams.set('apikey', apiKey);
  const payload = await requestJson(url, { Accept: 'application/json', 'User-Agent': 'niannian-stocks/0.1' });
  if (!Array.isArray(payload)) throw new MarketError('provider_payload_invalid');
  return safeCandles(payload.map((row) => ({
    time: typeof row?.date === 'string' ? row.date.slice(0, 10) : '', open: Number(row?.open), high: Number(row?.high),
    low: Number(row?.low), close: Number(row?.close), volume: Number(row?.volume),
  })));
}

async function getFinnhubCandles(symbol, apiKey) {
  if (!apiKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const url = new URL('https://finnhub.io/api/v1/stock/candle');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('resolution', 'D');
  url.searchParams.set('from', String(now - 220 * 86_400));
  url.searchParams.set('to', String(now));
  url.searchParams.set('token', apiKey);
  const payload = await requestJson(url, { Accept: 'application/json', 'User-Agent': 'niannian-stocks/0.1' });
  if (payload?.s === 'no_data') throw new MarketError('invalid_symbol', 404, '未找到该股票的可用日线数据。');
  if (payload?.s !== 'ok' || !Array.isArray(payload.t)) throw new MarketError('provider_payload_invalid');
  return safeCandles(payload.t.map((unix, index) => ({
    time: new Date(unix * 1000).toISOString().slice(0, 10), open: Number(payload.o?.[index]), high: Number(payload.h?.[index]),
    low: Number(payload.l?.[index]), close: Number(payload.c?.[index]), volume: Number(payload.v?.[index]),
  })));
}

function calculateRsi(candles, period = 14) {
  if (candles.length <= period) return null;
  let gains = 0; let losses = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const move = candles[i].close - candles[i - 1].close;
    gains += Math.max(move, 0); losses += Math.max(-move, 0);
  }
  return losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
}

function buildSummary(candles) {
  const latest = candles.at(-1); const previous = candles.at(-2);
  const recent20 = candles.slice(-20);
  const ma20 = average(recent20.map((item) => item.close));
  const ma50 = average(candles.slice(-50).map((item) => item.close));
  const priorVolume = candles.slice(-6, -1).map((item) => item.volume).filter((value) => value > 0);
  const volumeRatio = priorVolume.length ? latest.volume / average(priorVolume) : null;
  const rsi14 = calculateRsi(candles);
  return {
    price: round(latest.close), change: round(latest.close - previous.close), changePct: round(((latest.close - previous.close) / previous.close) * 100),
    trend: ma20 > ma50 ? 'bullish' : 'bearish', rsi14: rsi14 === null ? null : round(rsi14, 1),
    volumeRatio: volumeRatio === null ? null : round(volumeRatio), ma20: round(ma20), ma50: round(ma50),
    support20: round(Math.min(...recent20.map((item) => item.low))), resistance20: round(Math.max(...recent20.map((item) => item.high))),
  };
}

function buildBacktest(candles, symbol) {
  const initialCapital = 100_000; const tradeCostRate = 0.0005; const slippageRate = 0.0005;
  let cash = initialCapital; let shares = 0; let pending = ''; let targetInMarket = false; let openTrade = null;
  const equity = []; const trades = [];
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    if (pending === 'buy' && cash > 0) {
      const filledAt = candle.open * (1 + slippageRate); const commission = cash * tradeCostRate;
      shares = (cash - commission) / filledAt; openTrade = { date: candle.time, price: filledAt, capital: cash, index: i }; cash = 0;
    } else if (pending === 'sell' && shares > 0 && openTrade) {
      const filledAt = candle.open * (1 - slippageRate); const gross = shares * filledAt; const commission = gross * tradeCostRate; const proceeds = gross - commission;
      trades.push({ symbol, entryDate: openTrade.date, exitDate: candle.time, entryPrice: round(openTrade.price), exitPrice: round(filledAt),
        returnPct: round(((proceeds / openTrade.capital) - 1) * 100), pnl: round(proceeds - openTrade.capital), holdingDays: Math.max(1, i - openTrade.index), open: false });
      cash = proceeds; shares = 0; openTrade = null;
    }
    pending = '';
    equity.push({ time: candle.time, value: round(cash + shares * candle.close) });
    if (i < 49 || i === candles.length - 1) continue;
    const inMarket = average(candles.slice(i - 19, i + 1).map((item) => item.close)) > average(candles.slice(i - 49, i + 1).map((item) => item.close));
    if (inMarket !== targetInMarket) { pending = inMarket ? 'buy' : 'sell'; targetInMarket = inMarket; }
  }
  if (shares > 0 && openTrade) {
    const latest = candles.at(-1); const gross = shares * latest.close * (1 - slippageRate); const proceeds = gross * (1 - tradeCostRate);
    trades.push({ symbol, entryDate: openTrade.date, exitDate: latest.time, entryPrice: round(openTrade.price), exitPrice: round(latest.close * (1 - slippageRate)),
      returnPct: round(((proceeds / openTrade.capital) - 1) * 100), pnl: round(proceeds - openTrade.capital), holdingDays: Math.max(1, candles.length - 1 - openTrade.index), open: true });
  }
  let peak = initialCapital; let maxDrawdown = 0;
  equity.forEach((point) => { peak = Math.max(peak, point.value); maxDrawdown = Math.min(maxDrawdown, point.value / peak - 1); });
  const returns = equity.slice(1).map((point, index) => point.value / equity[index].value - 1);
  const mean = average(returns); const variance = returns.length > 1 ? average(returns.map((item) => (item - mean) ** 2)) : 0; const deviation = Math.sqrt(variance);
  const completed = trades.filter((item) => !item.open); const wins = completed.filter((item) => item.pnl > 0);
  return {
    strategy: { id: 'sma_20_50_long_only_v2', name: 'MA20 / MA50 趋势研究策略', version: 'v2', assumptions: '收盘确认，下一交易日开盘模拟成交；单边滑点 0.05%，单边交易成本 0.05%，不含税费。' },
    sample: { start: candles[0].time, end: candles.at(-1).time, candleCount: candles.length, benchmark: '买入并持有' },
    metrics: { initialCapital, cumulativeReturnPct: round((equity.at(-1).value / initialCapital - 1) * 100), buyHoldReturnPct: round((candles.at(-1).close / candles[0].close - 1) * 100), maxDrawdownPct: round(maxDrawdown * 100), winRatePct: completed.length ? round((wins.length / completed.length) * 100) : null, sharpeRatio: deviation ? round((mean / deviation) * Math.sqrt(252)) : null, annualizedVolatilityPct: round(deviation * Math.sqrt(252) * 100), completedTrades: completed.length },
    equity, trades: trades.reverse(),
  };
}

function marketState(latestCandleTime) {
  const now = new Date(); const weekday = now.getUTCDay();
  const isWeekday = weekday > 0 && weekday < 6; const current = now.toISOString().slice(0, 10);
  return { marketStatus: isWeekday ? 'eod_or_delayed' : 'market_closed', delayLabel: latestCandleTime === current ? '日线数据可能延迟，非交易级实时行情。' : '当前显示最近一个完整交易日的日线数据。' };
}

export function createMarketService({ redis, isProduction }) {
  const memory = new Map();
  const inflight = new Map();
  async function cacheGet(key) {
    if (redis) return redis.get(key);
    return memory.get(key)?.value ?? null;
  }
  async function cacheSet(key, value) {
    if (redis) return redis.set(key, value, { ex: CANDLE_TTL_SECONDS });
    memory.set(key, { value, expiresAt: Date.now() + CANDLE_TTL_SECONDS * 1000 });
    setTimeout(() => memory.delete(key), CANDLE_TTL_SECONDS * 1000).unref();
    return 'OK';
  }
  async function waitForSnapshot(key) {
    for (const waitMs of [150, 250, 400, 700]) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const snapshot = await cacheGet(key);
      if (snapshot && typeof snapshot === 'object') return snapshot;
    }
    return null;
  }
  return {
    async research(rawSymbol) {
      const symbol = normalizeSymbol(rawSymbol); const key = `stocks:research:v1:${symbol}`;
      const cached = await cacheGet(key);
      if (cached && typeof cached === 'object') return { ...cached, cache: 'hit' };
      const running = inflight.get(key);
      if (running) return running;
      const request = (async () => {
        const lockKey = `${key}:lock`;
        const lock = redis ? await redis.set(lockKey, '1', { nx: true, ex: 12 }) : 'local';
        if (!lock) {
          const sharedSnapshot = await waitForSnapshot(key);
          if (sharedSnapshot) return { ...sharedSnapshot, cache: 'shared' };
          throw new MarketError('request_in_progress', 503, '行情快照正在更新，请稍后重试。');
        }
        try {
          const fmp = await getFmpCandles(symbol, process.env.FMP_API_KEY).catch((error) => error instanceof MarketError ? error : null);
          const finnhub = fmp ? null : await getFinnhubCandles(symbol, process.env.FINNHUB_API_KEY).catch((error) => error instanceof MarketError ? error : null);
          const candles = fmp || finnhub;
          if (!candles) {
            if (isProduction) throw new MarketError('provider_unavailable', 502, '当前没有可用的商业行情数据源。');
            throw new MarketError('provider_unavailable');
          }
          const source = fmp ? 'FMP' : 'Finnhub'; const updatedAt = new Date().toISOString(); const summary = buildSummary(candles); const backtest = buildBacktest(candles, symbol);
          const payload = { snapshotId: createHash('sha256').update(`${symbol}:${source}:${candles.at(-1).time}:${candles.at(-1).close}`).digest('hex').slice(0, 16), symbol, source, updatedAt, cache: 'miss', ...marketState(candles.at(-1).time), candles, summary, backtest, events: [], eventsStatus: 'not_configured', providerPolicy: { yahooFallbackEnabled: false, commercialDisplay: '当前候选不使用 Yahoo 回退；请在正式商业规模上线前确认数据供应商展示授权范围。' } };
          await cacheSet(key, payload);
          return payload;
        } finally {
          if (redis && lock) await redis.del(lockKey).catch(() => undefined);
        }
      })();
      inflight.set(key, request);
      try { return await request; } finally { inflight.delete(key); }
    },
  };
}
