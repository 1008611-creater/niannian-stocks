import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { createMarketService, MarketError, normalizeSymbol } from './market.mjs';
import { AuthError, createSupabaseAuthVerifier } from './auth.mjs';
import { WorkspaceError, createWorkspaceStore } from './supabase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4313);
const isProduction = process.env.NODE_ENV === 'production';
const upstashConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const providerConfigured = Boolean(process.env.FMP_API_KEY || process.env.FINNHUB_API_KEY);
const agentServiceUrls = [
  process.env.AGENT_SERVICE_URL,
  process.env.AGENT_PUBLIC_SERVICE_URL,
  'https://tradingagents-production-f7f4.up.railway.app',
].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
const agentConfigured = Boolean(agentServiceUrls.length && process.env.NIANNIAN_AGENT_SERVICE_TOKEN);
const redis = upstashConfigured ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }) : null;
const market = createMarketService({ redis, isProduction });
const rateLimit = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'stocks:ratelimit:market' }) : null;
const agentRateLimit = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(4, '10 m'), prefix: 'stocks:ratelimit:agent' }) : null;
const supabaseAuthConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const verifySupabaseRequest = createSupabaseAuthVerifier({ url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY });
const workspace = createWorkspaceStore({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
const supabaseAuthOrigin = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const alertScanEnabled = isProduction && workspace.enabled && providerConfigured;
const alertScanIntervalMs = Math.max(5 * 60_000, Number(process.env.NIANNIAN_ALERT_SCAN_INTERVAL_MS || 15 * 60_000));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", ...(supabaseAuthOrigin ? [supabaseAuthOrigin] : [])], frameSrc: ["'self'"] } }, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '16kb' }));

function requestIdentity(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.ip;
  return candidate || 'unknown';
}

app.get('/api/health', (_request, response) => response.json({
  ok: true,
  service: 'niannian-stocks',
  environment: isProduction ? 'production' : 'development',
  redis: upstashConfigured ? 'configured' : 'development_fallback',
  market: providerConfigured ? 'configured' : 'not_configured',
  auth: supabaseAuthConfigured ? 'configured' : 'not_configured',
  workspace: workspace.enabled ? 'configured' : 'not_configured',
  agent: agentConfigured ? 'configured' : 'not_configured',
  alerts: alertScanEnabled ? 'enabled' : 'not_configured',
  yahooFallback: false,
}));
app.get('/api/auth/config', (_request, response) => response.json({
  configured: supabaseAuthConfigured,
  ...(supabaseAuthConfigured ? { url: supabaseAuthOrigin, anonKey: process.env.SUPABASE_ANON_KEY } : {}),
}));
app.get('/api/market/research', async (request, response, next) => {
  try {
    const symbol = normalizeSymbol(request.query.symbol);
    if (rateLimit) {
      const quota = await rateLimit.limit(requestIdentity(request));
      response.setHeader('RateLimit-Limit', String(quota.limit));
      response.setHeader('RateLimit-Remaining', String(Math.max(0, quota.remaining)));
      if (!quota.success) throw new MarketError('rate_limited', 429, '刷新过于频繁，请稍后再试。');
    } else if (isProduction) {
      throw new MarketError('service_not_configured', 503, '行情服务尚未完成生产缓存配置。');
    }
    response.setHeader('Cache-Control', 'private, max-age=30');
    response.json(await market.research(symbol));
  } catch (error) { next(error); }
});
app.post('/api/agent/research', async (request, response, next) => {
  try {
    if (!agentConfigured) throw new MarketError('agent_not_configured', 503, '智能研究服务正在配置中。');
    if (!agentRateLimit && isProduction) throw new MarketError('service_not_configured', 503, '智能研究服务尚未完成生产缓存配置。');
    if (agentRateLimit) {
      const quota = await agentRateLimit.limit(requestIdentity(request));
      response.setHeader('RateLimit-Limit', String(quota.limit));
      response.setHeader('RateLimit-Remaining', String(Math.max(0, quota.remaining)));
      if (!quota.success) throw new MarketError('agent_rate_limited', 429, '研究请求较多，请稍后再试。');
    }
    const symbol = normalizeSymbol(request.body?.symbol);
    const question = typeof request.body?.question === 'string' ? request.body.question.trim().slice(0, 700) : '';
    const rawPortfolio = request.body?.portfolio && typeof request.body.portfolio === 'object' ? request.body.portfolio : null;
    const portfolio = rawPortfolio ? {
      totalValue: Number.isFinite(Number(rawPortfolio.totalValue)) ? Number(rawPortfolio.totalValue) : null,
      totalPnlPct: Number.isFinite(Number(rawPortfolio.totalPnlPct)) ? Number(rawPortfolio.totalPnlPct) : null,
      maxWeightPct: Number.isFinite(Number(rawPortfolio.maxWeightPct)) ? Number(rawPortfolio.maxWeightPct) : null,
      riskCount: Math.max(0, Math.min(50, Number(rawPortfolio.riskCount) || 0)),
      missingCount: Math.max(0, Math.min(50, Number(rawPortfolio.missingCount) || 0)),
      positions: Array.isArray(rawPortfolio.positions) ? rawPortfolio.positions.slice(0, 50).map((item) => ({
        symbol: normalizeSymbol(item?.symbol),
        weightPct: Number.isFinite(Number(item?.weightPct)) ? Number(item.weightPct) : null,
        pnlPct: Number.isFinite(Number(item?.pnlPct)) ? Number(item.pnlPct) : null,
        trend: item?.trend === 'bullish' || item?.trend === 'bearish' ? item.trend : null,
        rsi14: Number.isFinite(Number(item?.rsi14)) ? Number(item.rsi14) : null,
        risk: typeof item?.risk === 'string' ? item.risk.slice(0, 24) : '观察',
      })) : [],
    } : null;
    const snapshot = await market.research(symbol);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50_000);
    let upstream;
    try {
      for (const serviceUrl of agentServiceUrls) {
        try {
          upstream = await fetch(new URL('/v1/research', serviceUrl).toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-niannian-agent-token': process.env.NIANNIAN_AGENT_SERVICE_TOKEN },
            body: JSON.stringify({ question, snapshot, workspace: { holdings: [], watchlist: [], portfolio } }),
            signal: controller.signal,
          });
          break;
        } catch {
          // Railway private networking is region-bound; continue to the protected fallback URL.
        }
      }
    } finally { clearTimeout(timer); }
    if (!upstream) {
      throw new MarketError('agent_unavailable', 503, '智能研究服务暂时不可用，请稍后再试。');
    }
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new MarketError(result?.detail?.error || 'agent_unavailable', upstream.status >= 500 ? 503 : 502, result?.detail?.message || '智能研究服务暂时不可用，请稍后再试。');
    response.setHeader('Cache-Control', 'no-store');
    response.json(result);
  } catch (error) { next(error); }
});
app.get('/api/account/workspace', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.workspaceFor(userId));
  } catch (error) { next(error); }
});
app.post('/api/account/workspace/import', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await workspace.importFirstWorkspace(userId, request.body));
  } catch (error) { next(error); }
});
app.post('/api/account/watchlist', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.addWatchlistItem(userId, request.body?.symbol));
  } catch (error) { next(error); }
});
app.delete('/api/account/watchlist/:symbol', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.removeWatchlistItem(userId, request.params.symbol));
  } catch (error) { next(error); }
});
app.post('/api/account/portfolios', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await workspace.createPortfolio(userId, request.body?.name));
  } catch (error) { next(error); }
});
app.post('/api/account/holdings', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.saveHolding(userId, request.body));
  } catch (error) { next(error); }
});
app.delete('/api/account/holdings/:id', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.removeHolding(userId, request.params.id));
  } catch (error) { next(error); }
});
app.get('/api/account/alerts', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.workspaceFor(userId));
  } catch (error) { next(error); }
});
app.post('/api/account/alerts', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await workspace.createAlertRule(userId, request.body));
  } catch (error) { next(error); }
});
app.delete('/api/account/alerts/:id', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.removeAlertRule(userId, request.params.id));
  } catch (error) { next(error); }
});
app.post('/api/account/alerts/notifications/:id/read', async (request, response, next) => {
  try {
    const { userId } = await verifySupabaseRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.markAlertRead(userId, request.params.id));
  } catch (error) { next(error); }
});

let alertScanRunning = false;
async function runAlertScan() {
  if (!alertScanEnabled || alertScanRunning) return;
  alertScanRunning = true;
  try { console.log('alert-scan', await workspace.scanAlertRules((symbol) => market.research(symbol))); }
  catch (error) { console.error('alert-scan-error', error?.message || 'unknown'); }
  finally { alertScanRunning = false; }
}
if (alertScanEnabled) {
  const timer = setInterval(() => void runAlertScan(), alertScanIntervalMs);
  timer.unref?.();
  setTimeout(() => void runAlertScan(), 30_000).unref?.();
}
app.use(express.static(resolve(here, '..', 'dist'), { index: 'index.html', maxAge: isProduction ? '1h' : 0, etag: true }));
app.get('*splat', (request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(resolve(here, '..', 'dist', 'index.html'), (error) => { if (error) next(error); });
});
app.use((_request, response) => response.status(404).json({ error: 'not_found', message: '未找到该接口。' }));
app.use((error, _request, response, _next) => {
  if (error instanceof MarketError) return response.status(error.status).json({ error: error.code, message: error.message, retryable: error.status >= 429 });
  if (error instanceof AuthError || error instanceof WorkspaceError) return response.status(error.status).json({ error: error.code, message: error.message, retryable: error.status >= 500 });
  console.error('stocks-server-error', error?.message || 'unknown');
  return response.status(500).json({ error: 'internal_error', message: '服务暂时不可用，请稍后重试。', retryable: true });
});
app.listen(port, '0.0.0.0', () => console.log(`Niannian Stocks serving on :${port}`));
