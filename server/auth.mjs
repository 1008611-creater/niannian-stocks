export class AuthError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createSupabaseAuthVerifier({ url, anonKey }) {
  const origin = String(url || '').replace(/\/$/, '');
  const configured = Boolean(origin && anonKey);

  return async function verifySupabaseRequest(request) {
    if (!configured) throw new AuthError('auth_not_configured', 503, '邮箱登录服务尚未完成配置。');
    const authorization = request.get('authorization') || '';
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new AuthError('sign_in_required', 401, '请先登录后再使用云端数据。');
    let response;
    try {
      response = await fetch(`${origin}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new AuthError('auth_unavailable', 503, '邮箱登录服务暂时不可用，请稍后重试。');
    }
    if (response.status === 401 || response.status === 403) throw new AuthError('expired_token', 401, '登录已过期，请重新登录。');
    if (!response.ok) throw new AuthError('auth_unavailable', 503, '邮箱登录服务暂时不可用，请稍后重试。');
    const user = await response.json().catch(() => null);
    if (!user || typeof user.id !== 'string' || !user.id) throw new AuthError('invalid_token', 401, '登录令牌无效，请重新登录。');
    return { userId: user.id };
  };
}
