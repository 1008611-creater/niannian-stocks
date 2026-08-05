import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { createMarketService, MarketError, normalizeSymbol } from './market.mjs';
import { AuthError, createClerkVerifier } from './auth.mjs';
import { WorkspaceError, createWorkspaceStore } from './supabase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4313);
const isProduction = process.env.NODE_ENV === 'production';
const upstashConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const providerConfigured = Boolean(process.env.FMP_API_KEY || process.env.FINNHUB_API_KEY);
const agentConfigured = Boolean(process.env.AGENT_SERVICE_URL && process.env.NIANNIAN_AGENT_SERVICE_TOKEN);
const redis = upstashConfigured ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }) : null;
const market = createMarketService({ redis, isProduction });
const rateLimit = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'stocks:ratelimit:market' }) : null;
const agentRateLimit = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(4, '10 m'), prefix: 'stocks:ratelimit:agent' }) : null;
const verifyClerkRequest = createClerkVerifier({ issuerDomain: process.env.CLERK_JWT_ISSUER_DOMAIN });
const workspace = createWorkspaceStore({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], scriptSrc: ["'self'", 'https://clerk.stocks.cauai.fun'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https://clerk.stocks.cauai.fun'], connectSrc: ["'self'", 'https://clerk.stocks.cauai.fun'], frameSrc: ['https://clerk.stocks.cauai.fun'] } }, crossOriginEmbedderPolicy: false }));
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
  clerk: process.env.CLERK_JWT_ISSUER_DOMAIN ? 'configured' : 'not_configured',
  workspace: workspace.enabled ? 'configured' : 'not_configured',
  agent: agentConfigured ? 'configured' : 'not_configured',
  yahooFallback: false,
}));
app.get('/api/auth/config', (_request, response) => response.json({
  configured: Boolean(process.env.CLERK_JWT_ISSUER_DOMAIN && process.env.CLERK_PUBLISHABLE_KEY),
  ...(process.env.CLERK_JWT_ISSUER_DOMAIN && process.env.CLERK_PUBLISHABLE_KEY ? { frontendApi: process.env.CLERK_JWT_ISSUER_DOMAIN, publishableKey: process.env.CLERK_PUBLISHABLE_KEY } : {}),
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
    const { userId } = await verifyClerkRequest(request);
    if (!agentConfigured) throw new MarketError('agent_not_configured', 503, '智能研究服务正在配置中。');
    if (!agentRateLimit && isProduction) throw new MarketError('service_not_configured', 503, '智能研究服务尚未完成生产缓存配置。');
    if (agentRateLimit) {
      const quota = await agentRateLimit.limit(userId);
      response.setHeader('RateLimit-Limit', String(quota.limit));
      response.setHeader('RateLimit-Remaining', String(Math.max(0, quota.remaining)));
      if (!quota.success) throw new MarketError('agent_rate_limited', 429, '研究请求较多，请稍后再试。');
    }
    const symbol = normalizeSymbol(request.body?.symbol);
    const question = typeof request.body?.question === 'string' ? request.body.question.trim().slice(0, 700) : '';
    const [snapshot, cloud] = await Promise.all([
      market.research(symbol),
      workspace.enabled ? workspace.workspaceFor(userId) : Promise.resolve({ holdings: [], watchlist: [] }),
    ]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50_000);
    let upstream;
    try {
      upstream = await fetch(new URL('/v1/research', process.env.AGENT_SERVICE_URL).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-niannian-agent-token': process.env.NIANNIAN_AGENT_SERVICE_TOKEN },
        body: JSON.stringify({ question, snapshot, workspace: { holdings: cloud.holdings, watchlist: cloud.watchlist } }),
        signal: controller.signal,
      });
    } catch {
      throw new MarketError('agent_unavailable', 503, '智能研究服务暂时不可用，请稍后再试。');
    } finally { clearTimeout(timer); }
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new MarketError(result?.detail?.error || 'agent_unavailable', upstream.status >= 500 ? 503 : 502, result?.detail?.message || '智能研究服务暂时不可用，请稍后再试。');
    response.setHeader('Cache-Control', 'no-store');
    response.json(result);
  } catch (error) { next(error); }
});
app.get('/api/account/workspace', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.workspaceFor(userId));
  } catch (error) { next(error); }
});
app.post('/api/account/workspace/import', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await workspace.importFirstWorkspace(userId, request.body));
  } catch (error) { next(error); }
});
app.post('/api/account/watchlist', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.addWatchlistItem(userId, request.body?.symbol));
  } catch (error) { next(error); }
});
app.delete('/api/account/watchlist/:symbol', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.removeWatchlistItem(userId, request.params.symbol));
  } catch (error) { next(error); }
});
app.post('/api/account/portfolios', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await workspace.createPortfolio(userId, request.body?.name));
  } catch (error) { next(error); }
});
app.post('/api/account/holdings', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.saveHolding(userId, request.body));
  } catch (error) { next(error); }
});
app.delete('/api/account/holdings/:id', async (request, response, next) => {
  try {
    const { userId } = await verifyClerkRequest(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json(await workspace.removeHolding(userId, request.params.id));
  } catch (error) { next(error); }
});
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
