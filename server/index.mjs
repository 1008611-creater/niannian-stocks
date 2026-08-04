import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { createMarketService, MarketError, normalizeSymbol } from './market.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4313);
const isProduction = process.env.NODE_ENV === 'production';
const upstashConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = upstashConfigured ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }) : null;
const market = createMarketService({ redis, isProduction });
const rateLimit = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'stocks:ratelimit:market' }) : null;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } }, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '16kb' }));

function requestIdentity(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.ip;
  return candidate || 'unknown';
}

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'niannian-stocks', redis: upstashConfigured ? 'configured' : 'development_fallback' }));
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
app.use(express.static(resolve(here, '..', 'dist'), { index: 'index.html', maxAge: isProduction ? '1h' : 0, etag: true }));
app.get('*splat', (request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(resolve(here, '..', 'dist', 'index.html'), (error) => { if (error) next(error); });
});
app.use((_request, response) => response.status(404).json({ error: 'not_found', message: '未找到该接口。' }));
app.use((error, _request, response, _next) => {
  if (error instanceof MarketError) return response.status(error.status).json({ error: error.code, message: error.message, retryable: error.status >= 429 });
  console.error('stocks-server-error', error?.message || 'unknown');
  return response.status(500).json({ error: 'internal_error', message: '服务暂时不可用，请稍后重试。', retryable: true });
});
app.listen(port, '0.0.0.0', () => console.log(`Niannian Stocks serving on :${port}`));
