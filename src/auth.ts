type AuthConfig = { configured: boolean; url?: string; anonKey?: string };
type AuthUser = { id: string; email?: string | null };
type StoredSession = { access_token: string; refresh_token: string; expires_at?: number; user?: AuthUser };

const storageKey = 'niannian-stocks-supabase-session-v1';

function safeSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<StoredSession>;
  return typeof session.access_token === 'string' && typeof session.refresh_token === 'string' ? session as StoredSession : null;
}

function readStoredSession() {
  try { return safeSession(JSON.parse(localStorage.getItem(storageKey) || 'null')); } catch { return null; }
}

function writeStoredSession(session: StoredSession | null) {
  if (session) localStorage.setItem(storageKey, JSON.stringify(session));
  else localStorage.removeItem(storageKey);
}

function messageFrom(response: Response, payload: { msg?: string; message?: string; error_description?: string }) {
  if (response.status === 400) return payload.msg || payload.error_description || '邮箱或密码格式不正确。';
  if (response.status === 401) return '邮箱或密码不正确。';
  if (response.status === 429) return '请求过于频繁，请稍后再试。';
  return payload.msg || payload.error_description || payload.message || '认证服务暂时不可用，请稍后再试。';
}

export type SupabaseAuthClient = {
  session: StoredSession | null;
  user: AuthUser | null;
  addListener: (listener: () => void) => () => void;
  signUp: (email: string, password: string) => Promise<{ emailConfirmationRequired: boolean }>;
  resendEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

async function loadConfig(): Promise<AuthConfig> {
  const response = await fetch('/api/auth/config', { credentials: 'same-origin' });
  return response.ok ? await response.json() as AuthConfig : { configured: false };
}

function normalizeSession(payload: Record<string, unknown>): StoredSession | null {
  const source = (payload.session && typeof payload.session === 'object' ? payload.session : payload) as Record<string, unknown>;
  const accessToken = typeof source.access_token === 'string' ? source.access_token : '';
  const refreshToken = typeof source.refresh_token === 'string' ? source.refresh_token : '';
  if (!accessToken || !refreshToken) return null;
  const user = source.user && typeof source.user === 'object' ? source.user as Record<string, unknown> : null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Number.isFinite(Number(source.expires_at)) ? Number(source.expires_at) : Math.floor(Date.now() / 1000) + Number(source.expires_in || 3600),
    ...(user && typeof user.id === 'string' ? { user: { id: user.id, email: typeof user.email === 'string' ? user.email : null } } : {}),
  };
}

async function createClient(config: Required<Pick<AuthConfig, 'url' | 'anonKey'>>): Promise<SupabaseAuthClient> {
  const origin = config.url.replace(/\/$/, '');
  const listeners = new Set<() => void>();
  const client: SupabaseAuthClient = {
    session: null,
    user: null,
    addListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async signUp(email, password) {
      const result = await request('/auth/v1/signup', { email, password, data: {}, email_redirect_to: window.location.origin });
      const session = normalizeSession(result);
      if (session) await setSession(session);
      return { emailConfirmationRequired: !session };
    },
    async resendEmailCode(email) {
      await request('/auth/v1/resend', { type: 'signup', email });
    },
    async verifyEmailCode(email, code) {
      const result = await request('/auth/v1/verify', { email, token: code, type: 'signup' });
      const session = normalizeSession(result);
      if (!session) throw new Error('验证码验证未返回有效登录状态，请重新获取验证码。');
      await setSession(session);
    },
    async signInWithPassword(email, password) {
      const result = await request('/auth/v1/token?grant_type=password', { email, password });
      const session = normalizeSession(result);
      if (!session) throw new Error('登录未返回有效令牌，请重试。');
      await setSession(session);
    },
    async signOut() {
      if (client.session) await fetch(`${origin}/auth/v1/logout`, { method: 'POST', headers: { apikey: config.anonKey, authorization: `Bearer ${client.session.access_token}` } }).catch(() => undefined);
      client.session = null; client.user = null; writeStoredSession(null); notify();
    },
  };

  function notify() { listeners.forEach((listener) => listener()); }
  async function request(path: string, body?: Record<string, unknown>) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { apikey: config.anonKey, authorization: `Bearer ${config.anonKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(messageFrom(response, payload));
    return payload as Record<string, unknown>;
  }
  async function userFor(accessToken: string) {
    const response = await fetch(`${origin}/auth/v1/user`, { headers: { apikey: config.anonKey, authorization: `Bearer ${accessToken}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload?.id !== 'string') throw new Error('登录已过期，请重新登录。');
    return { id: payload.id, email: typeof payload.email === 'string' ? payload.email : null };
  }
  async function setSession(next: StoredSession) {
    const user = next.user || await userFor(next.access_token);
    client.session = { ...next, user }; client.user = user; writeStoredSession(client.session); notify();
  }
  async function restore() {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const fromLink = hash.get('access_token') && hash.get('refresh_token') ? normalizeSession({ access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token'), expires_in: hash.get('expires_in') }) : null;
    if (fromLink) {
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
      await setSession(fromLink);
      return;
    }
    const stored = readStoredSession();
    if (!stored) return;
    const expiresSoon = !stored.expires_at || stored.expires_at <= Math.floor(Date.now() / 1000) + 60;
    try {
      const refreshed = expiresSoon ? normalizeSession(await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: stored.refresh_token })) : stored;
      if (!refreshed) throw new Error('session_invalid');
      await setSession(refreshed);
    } catch { writeStoredSession(null); }
  }

  await restore();
  return client;
}

let clientPromise: Promise<SupabaseAuthClient | null> | null = null;
export async function loadSupabaseAuth() {
  if (clientPromise) return clientPromise;
  clientPromise = loadConfig().then((config) => config.configured && config.url && config.anonKey ? createClient({ url: config.url, anonKey: config.anonKey }) : null).catch(() => null);
  return clientPromise;
}

export async function authHeader(client: SupabaseAuthClient | null) {
  return client?.session?.access_token ? ({ Authorization: `Bearer ${client.session.access_token}` } as Record<string, string>) : {} as Record<string, string>;
}
