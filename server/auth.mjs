import { createPublicKey, verify as verifySignature } from 'node:crypto';

export class AuthError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function base64UrlJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('invalid_token', 401, '登录令牌无效，请重新登录。');
  }
}

function normalizedIssuer(value) {
  if (!value) return null;
  const url = new URL(value.startsWith('http') ? value : `https://${value}`);
  return url.toString().replace(/\/$/, '');
}

export function createClerkVerifier({ issuerDomain }) {
  const issuer = normalizedIssuer(issuerDomain);
  let keys = new Map();
  let refreshedAt = 0;

  async function refreshKeys() {
    if (!issuer) throw new AuthError('auth_not_configured', 503, '账户服务尚未完成配置。');
    const response = await fetch(`${issuer}/.well-known/jwks.json`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new AuthError('auth_unavailable', 503, '账户服务暂时不可用，请稍后重试。');
    const body = await response.json();
    keys = new Map((Array.isArray(body?.keys) ? body.keys : []).filter((key) => key?.kid).map((key) => [key.kid, key]));
    refreshedAt = Date.now();
  }

  return async function verifyClerkRequest(request) {
    if (!issuer) throw new AuthError('auth_not_configured', 503, '账户服务尚未完成配置。');
    const authorization = request.get('authorization') || '';
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new AuthError('sign_in_required', 401, '请先登录后再使用云端数据。');
    const pieces = token.split('.');
    if (pieces.length !== 3) throw new AuthError('invalid_token', 401, '登录令牌无效，请重新登录。');
    const header = base64UrlJson(pieces[0]);
    const claims = base64UrlJson(pieces[1]);
    if (header.alg !== 'RS256' || !header.kid) throw new AuthError('invalid_token', 401, '登录令牌格式不受支持，请重新登录。');
    if (claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('invalid_token', 401, '登录令牌验证失败，请重新登录。');
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(claims.exp) || claims.exp <= now || (Number.isFinite(claims.nbf) && claims.nbf > now + 30)) throw new AuthError('expired_token', 401, '登录已过期，请重新登录。');
    if (!keys.has(header.kid) || Date.now() - refreshedAt > 5 * 60_000) await refreshKeys();
    const jwk = keys.get(header.kid);
    if (!jwk) {
      await refreshKeys();
      if (!keys.has(header.kid)) throw new AuthError('invalid_token', 401, '登录令牌验证失败，请重新登录。');
    }
    const signingInput = Buffer.from(`${pieces[0]}.${pieces[1]}`);
    const signature = Buffer.from(pieces[2], 'base64url');
    const valid = verifySignature('RSA-SHA256', signingInput, createPublicKey({ key: keys.get(header.kid), format: 'jwk' }), signature);
    if (!valid) throw new AuthError('invalid_token', 401, '登录令牌验证失败，请重新登录。');
    return { userId: claims.sub };
  };
}
