const symbolPattern = /^[A-Z.]{1,10}$/;

export class WorkspaceError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function validSymbol(value) { return typeof value === 'string' && symbolPattern.test(value.trim().toUpperCase()); }
function numberOrNull(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function nonEmptyName(value) { return typeof value === 'string' ? value.trim().slice(0, 40) : ''; }

export function createWorkspaceStore({ url, serviceRoleKey }) {
  const origin = String(url || '').replace(/\/$/, '');
  const enabled = Boolean(origin && serviceRoleKey);

  async function request(table, { method = 'GET', query = {}, body, prefer } = {}) {
    if (!enabled) throw new WorkspaceError('workspace_not_configured', 503, '云端组合服务尚未完成配置。');
    const endpoint = new URL(`/rest/v1/${table}`, origin);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) endpoint.searchParams.set(key, String(value));
    const response = await fetch(endpoint, {
      method,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(prefer ? { prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!response.ok) {
      console.error('supabase-workspace-error', response.status, data?.code || 'unknown');
      throw new WorkspaceError('workspace_unavailable', response.status >= 500 ? 503 : 502, '云端组合服务暂时不可用，请稍后重试。');
    }
    return data;
  }

  async function workspaceFor(userId) {
    const [portfolios, holdings, watchlist, entitlement] = await Promise.all([
      request('niannian_portfolios', { query: { select: 'id,name,is_default,created_at,updated_at', user_id: `eq.${userId}`, order: 'is_default.desc,created_at.asc' } }),
      request('niannian_holdings', { query: { select: 'id,portfolio_id,symbol,quantity,average_cost,updated_at', user_id: `eq.${userId}`, order: 'updated_at.desc' } }),
      request('niannian_watchlist_items', { query: { select: 'id,symbol,created_at', user_id: `eq.${userId}`, order: 'created_at.asc' } }),
      request('niannian_entitlements', { query: { select: 'plan_key,valid_until,features,updated_at', user_id: `eq.${userId}`, limit: 1 } }),
    ]);
    return {
      portfolios: portfolios || [],
      holdings: (holdings || []).map((item) => ({ ...item, quantity: Number(item.quantity), averageCost: Number(item.average_cost) })),
      watchlist: (watchlist || []).map((item) => item.symbol),
      entitlement: entitlement?.[0] || { plan_key: 'free', valid_until: null, features: { cloudSync: false, backgroundAlerts: false, earningsEvents: false, aiResearch: false, advancedScreener: false } },
    };
  }

  async function importFirstWorkspace(userId, payload) {
    const existing = await workspaceFor(userId);
    if (existing.portfolios.length || existing.holdings.length || existing.watchlist.length) throw new WorkspaceError('already_imported', 409, '这个账户已有云端数据，未覆盖本机草稿。');
    const name = nonEmptyName(payload?.portfolio?.name) || '默认组合';
    const insertedPortfolios = await request('niannian_portfolios', { method: 'POST', body: { user_id: userId, name, is_default: true }, prefer: 'return=representation' });
    const portfolio = insertedPortfolios?.[0];
    if (!portfolio?.id) throw new WorkspaceError('workspace_unavailable', 503, '云端组合创建未完成，请稍后重试。');
    const watchlist = [...new Set(Array.isArray(payload?.watchlist) ? payload.watchlist.map((item) => String(item).trim().toUpperCase()).filter(validSymbol) : [])].slice(0, 5);
    const holdings = Array.isArray(payload?.holdings) ? payload.holdings.map((item) => {
      const symbol = String(item?.symbol || '').trim().toUpperCase();
      const quantity = numberOrNull(item?.quantity);
      const averageCost = numberOrNull(item?.cost ?? item?.averageCost);
      return validSymbol(symbol) && quantity && quantity > 0 && averageCost && averageCost > 0 ? { user_id: userId, portfolio_id: portfolio.id, symbol, quantity, average_cost: averageCost } : null;
    }).filter(Boolean).slice(0, 100) : [];
    if (watchlist.length) await request('niannian_watchlist_items', { method: 'POST', body: watchlist.map((symbol) => ({ user_id: userId, symbol })), prefer: 'resolution=merge-duplicates' });
    if (holdings.length) await request('niannian_holdings', { method: 'POST', body: holdings, prefer: 'resolution=merge-duplicates' });
    await request('niannian_entitlements', { method: 'POST', body: { user_id: userId, plan_key: 'free' }, query: { on_conflict: 'user_id' }, prefer: 'resolution=ignore-duplicates' });
    return workspaceFor(userId);
  }

  return { enabled, workspaceFor, importFirstWorkspace };
}
