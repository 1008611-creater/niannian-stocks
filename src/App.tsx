import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, loadResearch } from './api';
import { authHeader, loadSupabaseAuth } from './auth';
import { EquityChart, PriceChart } from './chart';
import { legacyImportAvailable, localDefaultPortfolio, readHoldings, readPortfolios, readWatchlist, saveHoldings, savePortfolios, saveWatchlist, validSymbol } from './storage';
import type { AgentReport, Holding, Portfolio, Snapshot } from './types';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const percentage = new Intl.NumberFormat('zh-CN', { style: 'percent', signDisplay: 'always', maximumFractionDigits: 2 });
const defaultSnapshot = 'NVDA';
const pendingAgentResearchStorageKey = 'niannian.pending-agent-research';
const researchPrompts = [
  { label: '趋势与风险', question: '请解释当前趋势、关键风险与失效条件，并指出下一次日线应核查什么。' },
  { label: '回测复盘', question: '请比较研究策略与买入持有的表现，说明回撤和策略失效风险。' },
  { label: '事件关注', question: '请根据研究包中的事件，指出近期值得跟踪的时间点和仍缺失的事实。' },
] as const;

function signed(value: number) { return percentage.format(value / 100); }
function tone(value: number) { return value >= 0 ? 'positive' : 'negative'; }
type PortfolioRow = {
  holding: Holding;
  snapshot: Snapshot | null;
  marketValue: number | null;
  costBasis: number;
  pnl: number | null;
  pnlPct: number | null;
  weightPct: number | null;
  risk: '趋势偏弱' | '动量极端' | '观察';
};

function portfolioRowsFor(holdings: Holding[], snapshots: Record<string, Snapshot>): PortfolioRow[] {
  const rows = holdings.map((holding) => {
    const current = snapshots[holding.symbol] || null;
    const costBasis = holding.quantity * holding.cost;
    const marketValue = current ? holding.quantity * current.summary.price : null;
    const pnl = marketValue === null ? null : marketValue - costBasis;
    const pnlPct = pnl === null || costBasis <= 0 ? null : (pnl / costBasis) * 100;
    const risk: PortfolioRow['risk'] = current?.summary.trend === 'bearish' ? '趋势偏弱' : current?.summary.rsi14 !== null && current?.summary.rsi14 !== undefined && (current.summary.rsi14 >= 70 || current.summary.rsi14 <= 30) ? '动量极端' : '观察';
    return { holding, snapshot: current, marketValue, costBasis, pnl, pnlPct, weightPct: null, risk };
  });
  const totalValue = rows.reduce((sum, row) => sum + (row.marketValue || 0), 0);
  return rows.map((row) => ({ ...row, weightPct: row.marketValue === null || totalValue <= 0 ? null : (row.marketValue / totalValue) * 100 }));
}

function portfolioTotals(rows: PortfolioRow[]) {
  const totalCost = rows.reduce((sum, row) => sum + row.costBasis, 0);
  const knownRows = rows.filter((row) => row.marketValue !== null);
  const complete = knownRows.length === rows.length;
  const totalValue = complete ? knownRows.reduce((sum, row) => sum + (row.marketValue || 0), 0) : null;
  const totalPnl = totalValue === null ? null : totalValue - totalCost;
  const totalPnlPct = totalPnl === null || totalCost <= 0 ? null : (totalPnl / totalCost) * 100;
  const maxWeight = complete ? Math.max(0, ...rows.map((row) => row.weightPct || 0)) : 0;
  const riskCount = rows.filter((row) => row.risk !== '观察').length;
  return { totalCost, totalValue, totalPnl, totalPnlPct, maxWeight, riskCount, missingCount: rows.length - knownRows.length };
}

function ResearchState({ error, retry }: { error: ApiError | null; retry: () => void }) {
  if (!error) return <div class="loading" role="status">正在组合当前标的的同一份研究快照…</div>;
  return <div class="error-state" role="alert"><strong>行情没有载入</strong><span>{error.message}</span>{error.retryable && <button class="secondary" onClick={retry}>重新尝试</button>}</div>;
}

function signalLabel(snapshot: Snapshot) {
  const { summary, backtest } = snapshot;
  const evidence = [
    summary.trend === 'bullish' ? 'MA20 高于 MA50，短期趋势位于长期趋势之上' : 'MA20 低于 MA50，短期趋势弱于长期趋势',
    summary.rsi14 === null ? 'RSI 样本不足，暂不作超买超卖判断' : `RSI(14) 为 ${summary.rsi14}，仅作为动量观察项`,
    summary.volumeRatio === null ? '成交量样本不足，暂不作量能判断' : `最近成交量约为前五日均量的 ${summary.volumeRatio} 倍`,
    `回测区间 ${backtest.sample.start}–${backtest.sample.end}，策略收益与买入持有分别为 ${signed(backtest.metrics.cumulativeReturnPct)} 和 ${signed(backtest.metrics.buyHoldReturnPct)}`,
  ];
  return evidence;
}

function researchVerdict(snapshot: Snapshot) {
  const { summary, backtest, events } = snapshot;
  const strategyGap = backtest.metrics.cumulativeReturnPct - backtest.metrics.buyHoldReturnPct;
  const earnings = events.find((item) => item.kind === 'earnings');
  const stance = summary.trend === 'bullish' ? '观察偏多' : '观察偏空';
  const headline = summary.trend === 'bullish' ? '趋势暂时占优，重点确认能否延续。' : '趋势偏弱，重点确认能否止跌转强。';
  return {
    stance,
    headline,
    items: [
      { label: '趋势状态', value: summary.trend === 'bullish' ? 'MA20 高于 MA50' : 'MA20 低于 MA50' },
      { label: '动量', value: summary.rsi14 === null ? '样本不足' : `RSI ${summary.rsi14}` },
      { label: '策略差距', value: `${strategyGap >= 0 ? '+' : ''}${strategyGap.toFixed(2)}%` },
      { label: '近期事件', value: earnings ? `${earnings.date} 财报` : '暂无可用事件' },
    ],
  };
}

type DeepLinkListener = { remove?: () => void | Promise<void> };
type DeepLinkPlugin = { addListener?: (event: 'appUrlOpen', listener: (payload: { url?: string }) => void) => DeepLinkListener | Promise<DeepLinkListener> };
function getDeepLinkPlugin() {
  return (window as Window & { Capacitor?: { Plugins?: { DeepLink?: DeepLinkPlugin } } }).Capacitor?.Plugins?.DeepLink;
}

type CloudWorkspace = {
  portfolios: { id: string; name: string; is_default: boolean }[];
  holdings: { id: string; portfolio_id: string; symbol: string; quantity: number; averageCost: number }[];
  watchlist: string[];
  entitlement?: { plan_key?: string };
};
type AccountError = Error & { status?: number; code?: string };

function accountError(response: Response, payload: { error?: string; message?: string }) {
  const error = new Error(payload.message || '账户服务暂时不可用，请稍后重试。') as AccountError;
  error.status = response.status; error.code = payload.error;
  return error;
}

export default function App() {
  const [symbol, setSymbol] = useState(defaultSnapshot);
  const [input, setInput] = useState(defaultSnapshot);
  const [watchlist, setWatchlist] = useState(readWatchlist);
  const [holdings, setHoldings] = useState<Holding[]>(readHoldings);
  const [portfolios, setPortfolios] = useState<Portfolio[]>(readPortfolios);
  const [activePortfolioId, setActivePortfolioId] = useState(() => readPortfolios()[0]?.id || localDefaultPortfolio.id);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [portfolioSnapshots, setPortfolioSnapshots] = useState<Record<string, Snapshot>>({});
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [watchInput, setWatchInput] = useState('');
  const [positionSymbol, setPositionSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [cost, setCost] = useState('');
  const [editingHoldingId, setEditingHoldingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [showImport, setShowImport] = useState(legacyImportAvailable);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof loadSupabaseAuth>>>(null);
  const [accountUser, setAccountUser] = useState<{ id: string; email: string } | null>(null);
  const [accountState, setAccountState] = useState<'loading' | 'signed_out' | 'syncing' | 'ready' | 'error' | 'unavailable'>('loading');
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [awaitingEmailCode, setAwaitingEmailCode] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [agentReport, setAgentReport] = useState<AgentReport | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentQuestion, setAgentQuestion] = useState<string>(researchPrompts[0].question);
  const requestRef = useRef<AbortController | null>(null);
  const importedAccountRef = useRef<string | null>(null);

  const fetchSnapshot = (target: string, preserveSnapshot = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null); if (!preserveSnapshot) setSnapshot(null);
    if (preserveSnapshot) setRefreshing(true);
    loadResearch(target, controller.signal).then((next) => { setSnapshot(next); setRefreshing(false); }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof ApiError ? reason : new ApiError('unknown', '研究数据载入失败，请稍后重试。', true)); setRefreshing(false);
    });
    return controller;
  };
  useEffect(() => {
    const controller = fetchSnapshot(symbol);
    return () => controller.abort();
  }, [symbol]);
  useEffect(() => {
    setAgentReport(null);
    setAgentQuestion(researchPrompts[0].question);
  }, [symbol]);
  useEffect(() => saveWatchlist(watchlist), [watchlist]);
  useEffect(() => saveHoldings(holdings), [holdings]);
  useEffect(() => savePortfolios(portfolios), [portfolios]);
  useEffect(() => {
    if (!resendCooldown) return;
    const timer = window.setInterval(() => setResendCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);
  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    return () => { window.removeEventListener('online', markOnline); window.removeEventListener('offline', markOffline); };
  }, []);

  const activePortfolio = portfolios.find((item) => item.id === activePortfolioId) || portfolios[0] || localDefaultPortfolio;
  const applyWorkspace = useCallback((next: CloudWorkspace) => {
    const nextPortfolios = Array.isArray(next.portfolios) ? next.portfolios.map((item) => ({ id: item.id, name: item.name, isDefault: Boolean(item.is_default) })) : [];
    const nextHoldings = Array.isArray(next.holdings) ? next.holdings.map((item) => ({ id: item.id, portfolioId: item.portfolio_id, symbol: item.symbol, quantity: Number(item.quantity), cost: Number(item.averageCost) })) : [];
    const nextWatchlist = Array.isArray(next.watchlist) ? next.watchlist.filter(validSymbol).slice(0, 50) : [];
    if (nextPortfolios.length) {
      setPortfolios(nextPortfolios);
      setActivePortfolioId((current) => nextPortfolios.some((item) => item.id === current) ? current : nextPortfolios[0].id);
    }
    setHoldings(nextHoldings); setWatchlist(nextWatchlist);
  }, []);

  const accountRequest = useCallback(async (path: string, options: RequestInit = {}) => {
    if (!auth) throw new Error('请先完成登录。');
    const headers = new Headers(await authHeader(auth));
    if (options.body) headers.set('content-type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw accountError(response, payload);
    return payload as CloudWorkspace;
  }, [auth]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const setIdentity = (client: NonNullable<Awaited<ReturnType<typeof loadSupabaseAuth>>>) => {
      const user = client.user;
      if (!active) return;
      setAccountUser(user ? { id: user.id, email: user.email || '已登录账户' } : null);
      setAccountState(user ? 'syncing' : 'signed_out');
    };
    void loadSupabaseAuth().then((client) => {
      if (!active) return;
      setAuth(client); if (!client) { setAccountState('unavailable'); return; }
      setIdentity(client); unsubscribe = client.addListener(() => setIdentity(client));
    });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!accountUser || !auth || importedAccountRef.current === accountUser.id) return;
    let active = true;
    const sync = async () => {
      try {
        const initial = await accountRequest('/api/account/workspace');
        const empty = !initial.portfolios.length && !initial.holdings.length && !initial.watchlist.length;
        const cloud = empty ? await accountRequest('/api/account/workspace/import', { method: 'POST', body: JSON.stringify({ portfolio: { name: activePortfolio.name }, watchlist, holdings }) }) : initial;
        if (!active) return;
        applyWorkspace(cloud); importedAccountRef.current = accountUser.id;
        setAccountState('ready'); setMessage(empty ? '本机自选与持仓已首次导入云端账户。' : '已加载云端组合，可在网页与手机端继续使用。');
      } catch (reason) {
        if (!active) return;
        const error = reason as AccountError;
        if (error.status === 401) { setAccountState('signed_out'); setAccountUser(null); return; }
        setAccountState('error'); setMessage(error.message || '云端资料暂未载入，本机数据未被覆盖。');
      }
    };
    void sync();
    return () => { active = false; };
  }, [accountRequest, accountUser, activePortfolio.name, applyWorkspace, auth, holdings, watchlist]);
  useEffect(() => {
    const plugin = getDeepLinkPlugin();
    let disposed = false;
    let listener: DeepLinkListener | undefined;
    const handleUrl = ({ url }: { url?: string }) => {
      if (!url) return;
      if (url.startsWith('fun.cauai.niannianstocks://auth/')) setMessage('已回到念念智股，请继续完成登录。');
      if (url.startsWith('fun.cauai.niannianstocks://payment/')) setMessage('已回到念念智股，套餐状态会在支付回调确认后同步。');
    };
    Promise.resolve(plugin?.addListener?.('appUrlOpen', handleUrl)).then((next) => {
      if (disposed) { void next?.remove?.(); return; }
      listener = next;
    }).catch(() => undefined);
    return () => { disposed = true; void listener?.remove?.(); };
  }, []);

  const portfolioHoldings = useMemo(() => holdings.filter((item) => item.portfolioId === activePortfolio.id), [holdings, activePortfolio.id]);
  const portfolioSymbolsKey = useMemo(() => [...new Set(portfolioHoldings.map((item) => item.symbol))].sort().join(','), [portfolioHoldings]);
  const resolvedPortfolioSnapshots = useMemo(() => snapshot ? { ...portfolioSnapshots, [snapshot.symbol]: snapshot } : portfolioSnapshots, [portfolioSnapshots, snapshot]);
  const portfolioRows = useMemo(() => portfolioRowsFor(portfolioHoldings, resolvedPortfolioSnapshots), [portfolioHoldings, resolvedPortfolioSnapshots]);
  const portfolioTotal = useMemo(() => portfolioTotals(portfolioRows), [portfolioRows]);
  const evidence = useMemo(() => snapshot ? signalLabel(snapshot) : [], [snapshot]);
  const verdict = useMemo(() => snapshot ? researchVerdict(snapshot) : null, [snapshot]);

  useEffect(() => {
    const symbols = portfolioSymbolsKey ? portfolioSymbolsKey.split(',') : [];
    if (!symbols.length) { setPortfolioLoading(false); return; }
    let active = true;
    setPortfolioLoading(true);
    Promise.all(symbols.map(async (item) => {
      if (item === snapshot?.symbol && snapshot) return [item, snapshot] as const;
      try { return [item, await loadResearch(item)] as const; } catch { return null; }
    })).then((entries) => {
      if (!active) return;
      const next = Object.fromEntries(entries.filter((entry): entry is readonly [string, Snapshot] => Boolean(entry)));
      setPortfolioSnapshots((current) => ({ ...current, ...next }));
      setPortfolioLoading(false);
    });
    return () => { active = false; };
  }, [portfolioSymbolsKey, snapshot]);

  function chooseSymbol(next: string) { const value = next.trim().toUpperCase(); if (!validSymbol(value)) { setMessage('请输入有效的美股代码。'); return; } setInput(value); setSymbol(value); setMessage(''); }
  async function addWatch(event: Event) { event.preventDefault(); const next = watchInput.trim().toUpperCase(); if (!validSymbol(next)) { setMessage('自选代码格式不正确。'); return; } if (watchlist.includes(next)) { setMessage(`${next} 已在自选中。`); return; } if (!accountUser && watchlist.length >= 5) { setMessage('免费层最多 5 只自选。登录并升级 Pro 后可扩展至 50 只。'); return; } try { if (accountUser) applyWorkspace(await accountRequest('/api/account/watchlist', { method: 'POST', body: JSON.stringify({ symbol: next }) })); else setWatchlist([...watchlist, next]); setWatchInput(''); setMessage(`${next} 已加入${accountUser ? '云端' : '本机'}自选。`); } catch (reason) { setMessage((reason as Error).message); } }
  function addPosition(event: Event) {
    event.preventDefault(); savePosition();
  }
  async function savePosition() {
    const next = positionSymbol.trim().toUpperCase(); const parsedQuantity = Number(quantity); const parsedCost = Number(cost);
    if (!validSymbol(next) || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || !Number.isFinite(parsedCost) || parsedCost <= 0) { setMessage('请填写有效代码、数量和平均成本。'); return; }
    if (editingHoldingId) {
      const current = holdings.find((item) => item.id === editingHoldingId);
      if (!current) { setEditingHoldingId(null); setMessage('要编辑的持仓不存在，请重新录入。'); return; }
      const matching = holdings.find((item) => item.id !== current.id && item.portfolioId === activePortfolio.id && item.symbol === next);
      const updated = matching ? holdings.filter((item) => item.id !== current.id).map((item) => item.id === matching.id ? { ...item, quantity: item.quantity + parsedQuantity, cost: (item.quantity * item.cost + parsedQuantity * parsedCost) / (item.quantity + parsedQuantity) } : item) : holdings.map((item) => item.id === current.id ? { ...item, symbol: next, quantity: parsedQuantity, cost: parsedCost } : item);
      try { if (accountUser) applyWorkspace(await accountRequest('/api/account/holdings', { method: 'POST', body: JSON.stringify({ id: current.id, portfolioId: activePortfolio.id, symbol: next, quantity: parsedQuantity, cost: parsedCost }) })); else setHoldings(updated); setMessage(`${next} 持仓已更新${accountUser ? '并同步到云端' : ''}。`); } catch (reason) { setMessage((reason as Error).message); return; }
    } else {
      const existing = holdings.find((item) => item.portfolioId === activePortfolio.id && item.symbol === next);
      const updated = existing ? holdings.map((item) => item.id === existing.id ? { ...item, quantity: item.quantity + parsedQuantity, cost: (item.quantity * item.cost + parsedQuantity * parsedCost) / (item.quantity + parsedQuantity) } : item) : [...holdings, { id: crypto.randomUUID(), portfolioId: activePortfolio.id, symbol: next, quantity: parsedQuantity, cost: parsedCost }];
      try { if (accountUser) applyWorkspace(await accountRequest('/api/account/holdings', { method: 'POST', body: JSON.stringify({ portfolioId: activePortfolio.id, symbol: next, quantity: parsedQuantity, cost: parsedCost }) })); else setHoldings(updated); setMessage(`${next} 已写入${activePortfolio.name}${accountUser ? '并同步到云端' : '；登录后将可云同步'}。`); } catch (reason) { setMessage((reason as Error).message); return; }
    }
    setPositionSymbol(''); setQuantity(''); setCost(''); setEditingHoldingId(null);
  }
  function editHolding(item: Holding) { setEditingHoldingId(item.id); setPositionSymbol(item.symbol); setQuantity(String(item.quantity)); setCost(String(item.cost)); setMessage(`正在编辑 ${item.symbol}。`); }
  function cancelEdit() { setEditingHoldingId(null); setPositionSymbol(''); setQuantity(''); setCost(''); setMessage('已取消编辑。'); }
  async function removeWatch(symbolToRemove: string) { try { if (accountUser) applyWorkspace(await accountRequest(`/api/account/watchlist/${encodeURIComponent(symbolToRemove)}`, { method: 'DELETE' })); else setWatchlist(watchlist.filter((value) => value !== symbolToRemove)); setMessage(`${symbolToRemove} 已从自选移除。`); } catch (reason) { setMessage((reason as Error).message); } }
  async function removePosition(id: string) { try { if (accountUser) applyWorkspace(await accountRequest(`/api/account/holdings/${encodeURIComponent(id)}`, { method: 'DELETE' })); else setHoldings(holdings.filter((holding) => holding.id !== id)); setMessage('持仓已移除。'); } catch (reason) { setMessage((reason as Error).message); } }
  async function requestNewPortfolio() { if (!accountUser) { setMessage('免费层最多 1 个组合。完成登录并获得 Pro 权益后，可在这里创建最多 5 个组合。'); return; } const name = window.prompt('请输入新组合名称（最多 40 个字）'); if (!name?.trim()) return; try { const next = await accountRequest('/api/account/portfolios', { method: 'POST', body: JSON.stringify({ name }) }); applyWorkspace(next); const created = next.portfolios.find((item) => item.name === name.trim()); if (created) setActivePortfolioId(created.id); setMessage('新组合已创建并同步到云端。'); } catch (reason) { setMessage((reason as Error).message); } }
  function importLegacy() { setShowImport(false); setMessage(accountUser ? '登录时会优先保留云端数据；当前本机草稿仅在云端为空时首次导入。' : '登录后，本机自选和持仓会一次性导入当前账户。'); }
  function startSignIn() { if (!auth) { setMessage('邮箱登录服务尚未完成配置，请先完成 Supabase SMTP 设置。'); return; } setAwaitingEmailCode(false); setVerificationCode(''); setResendCooldown(0); setShowAuth(true); }
  async function submitEmailAuth(event: Event) {
    event.preventDefault();
    if (!auth) { setMessage('邮箱登录服务尚未完成配置，请稍后再试。'); return; }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) { setMessage('请输入有效的邮箱地址。'); return; }
    if (password.length < 8) { setMessage('密码至少需要 8 位。'); return; }
    setAuthSubmitting(true); setMessage('');
    try {
      if (authMode === 'sign_up') {
        const result = await auth.signUp(normalizedEmail, password);
        if (result.emailConfirmationRequired) {
          setPassword(''); setVerificationCode(''); setResendCooldown(60); setAwaitingEmailCode(true);
          setMessage('验证邮件已发送，请输入邮件中的 8 位验证码。');
          return;
        }
        setMessage('账户已创建，正在同步云端资料。');
      } else {
        await auth.signInWithPassword(normalizedEmail, password);
        setMessage('登录成功，正在同步云端组合。');
      }
      setPassword(''); setShowAuth(false);
    } catch (reason) { setMessage((reason as Error).message || '邮箱登录暂时不可用，请稍后再试。'); }
    finally { setAuthSubmitting(false); }
  }
  async function submitEmailCode(event: Event) {
    event.preventDefault();
    if (!auth) { setMessage('邮箱登录服务尚未完成配置，请稍后再试。'); return; }
    const normalizedEmail = email.trim().toLowerCase();
    const code = verificationCode.trim();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) { setMessage('请先填写注册邮箱。'); return; }
    if (!/^\d{8}$/.test(code)) { setMessage('请输入 QQ 邮箱中的 8 位验证码。'); return; }
    setAuthSubmitting(true); setMessage('');
    try {
      await auth.verifyEmailCode(normalizedEmail, code);
      setVerificationCode(''); setAwaitingEmailCode(false); setShowAuth(false);
      setMessage('验证成功，正在同步云端组合。');
    } catch (reason) { setMessage((reason as Error).message || '验证码无效或已过期，请重新注册获取新验证码。'); }
    finally { setAuthSubmitting(false); }
  }
  async function resendEmailCode() {
    if (!auth) { setMessage('邮箱登录服务尚未完成配置，请稍后再试。'); return; }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) { setMessage('请先填写注册邮箱。'); return; }
    setAuthSubmitting(true); setMessage('');
    try {
      await auth.resendEmailCode(normalizedEmail);
      setResendCooldown(60);
      setMessage('验证邮件已重新发送，请检查邮箱收件箱和垃圾邮件。');
    } catch (reason) { setMessage((reason as Error).message || '验证码暂时无法重新发送，请稍后再试。'); }
    finally { setAuthSubmitting(false); }
  }
  async function signOut() { if (!auth) return; await auth.signOut(); importedAccountRef.current = null; setAccountUser(null); setAccountState('signed_out'); setShowAuth(false); setAwaitingEmailCode(false); setVerificationCode(''); setMessage('已退出账户，本机草稿仍保留在此设备。'); }
  async function runAgentResearch(nextQuestion: string = agentQuestion) {
    if (!snapshot) return;
    setAgentLoading(true); setMessage('');
    try {
      const headers = new Headers();
      headers.set('content-type', 'application/json');
      const response = await fetch('/api/agent/research', { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ symbol: snapshot.symbol, question: nextQuestion }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw accountError(response, payload);
      setAgentReport(payload as AgentReport);
    } catch (reason) { setMessage((reason as Error).message || '智能研究暂时不可用，请稍后再试。'); }
    finally { setAgentLoading(false); }
  }

  async function runPortfolioResearch() {
    const available = portfolioRows.filter((row) => row.snapshot);
    if (!available.length) { setMessage('组合还没有可用行情，先保存持仓并等待数据载入。'); return; }
    const question = '请综合当前组合的集中度、持仓趋势和动量风险，告诉我今天最值得先核查的两三件事，并说明哪些数据仍不足。不要输出买卖或调仓指令。';
    setAgentQuestion(question); setAgentLoading(true); setMessage('');
    try {
      const response = await fetch('/api/agent/research', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({
        symbol: available[0].holding.symbol,
        question,
        portfolio: {
          totalValue: portfolioTotal.totalValue,
          totalPnlPct: portfolioTotal.totalPnlPct,
          maxWeightPct: portfolioTotal.maxWeight,
          riskCount: portfolioTotal.riskCount,
          missingCount: portfolioTotal.missingCount,
          positions: available.map((row) => ({ symbol: row.holding.symbol, weightPct: row.weightPct, pnlPct: row.pnlPct, trend: row.snapshot?.summary.trend, rsi14: row.snapshot?.summary.rsi14, risk: row.risk })),
        },
      }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw accountError(response, payload);
      setAgentReport(payload as AgentReport);
    } catch (reason) { setMessage((reason as Error).message || '组合研究暂时不可用，请稍后再试。'); }
    finally { setAgentLoading(false); }
  }

  useEffect(() => {
    const pendingSymbol = window.sessionStorage.getItem(pendingAgentResearchStorageKey);
    if (!pendingSymbol || !accountUser || !auth || agentLoading) return;
    if (pendingSymbol !== symbol) {
      setInput(pendingSymbol);
      setSymbol(pendingSymbol);
      return;
    }
    if (!snapshot || snapshot.symbol !== pendingSymbol) return;
    window.sessionStorage.removeItem(pendingAgentResearchStorageKey);
    void runAgentResearch();
  }, [accountUser, auth, agentLoading, snapshot, symbol]);

  return <main>
    <header class="topbar">
      <div class="brand-lockup"><img class="brand-mark" src="/niannian-logo.svg" alt="念念智股" /><p class="brand">念念智股</p></div>
      <div class="account-status"><span class={online ? 'connection-status online' : 'connection-status'}>{online ? '在线' : '离线'}</span><span>{accountState === 'ready' && accountUser ? '已同步' : accountState === 'syncing' ? '同步中' : accountState === 'error' ? '同步未完成' : '免费层'}</span>{accountUser ? <><span class="account-email" title={accountUser.email}>{accountUser.email}</span><button class="quiet" onClick={() => void signOut()}>退出登录</button></> : <button class="quiet" onClick={startSignIn} disabled={accountState === 'loading'} aria-expanded={showAuth}>{accountState === 'loading' ? '准备登录…' : accountState === 'unavailable' ? '登录待配置' : '登录与同步'}</button>}</div>
    </header>
    {showAuth && <section class="auth-panel" aria-label="邮箱登录与注册">
      <div class="auth-heading"><strong>{awaitingEmailCode ? '输入验证码' : authMode === 'sign_in' ? '登录并同步' : '注册 QQ 邮箱'}</strong><button type="button" class="quiet" onClick={() => { setShowAuth(false); setPassword(''); setVerificationCode(''); setAwaitingEmailCode(false); }}>收起</button></div>
      {awaitingEmailCode ? <form class="auth-form verification-form" onSubmit={submitEmailCode}>
        <p class="verification-hint">请输入邮件中的 8 位验证码。</p>
        <label>验证码<input type="text" value={verificationCode} inputMode="numeric" autocomplete="one-time-code" placeholder="8 位验证码" maxlength={8} onInput={(event) => setVerificationCode((event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 8))} disabled={authSubmitting} required /></label>
        <button type="submit" disabled={authSubmitting}>{authSubmitting ? '正在验证…' : '验证并同步'}</button>
        <button type="button" class="secondary" onClick={resendEmailCode} disabled={authSubmitting || resendCooldown > 0}>{resendCooldown > 0 ? `${resendCooldown} 秒后重发` : '重新发送验证邮件'}</button>
        <button type="button" class="secondary" onClick={() => { setAwaitingEmailCode(false); setVerificationCode(''); setResendCooldown(0); setMessage(''); }} disabled={authSubmitting}>返回注册</button>
      </form> : <><div class="auth-tabs" role="tablist" aria-label="账户操作">
        <button type="button" role="tab" aria-selected={authMode === 'sign_in'} class={authMode === 'sign_in' ? 'active' : ''} onClick={() => { setAuthMode('sign_in'); setMessage(''); }}>邮箱登录</button>
        <button type="button" role="tab" aria-selected={authMode === 'sign_up'} class={authMode === 'sign_up' ? 'active' : ''} onClick={() => { setAuthMode('sign_up'); setMessage(''); }}>注册 QQ 邮箱</button>
      </div>
      <form class="auth-form" onSubmit={submitEmailAuth}>
        <label>邮箱<input type="email" value={email} inputMode="email" autocomplete="email" placeholder="name@qq.com" onInput={(event) => setEmail((event.target as HTMLInputElement).value)} disabled={authSubmitting} required /></label>
        <label>密码<input type="password" value={password} autocomplete={authMode === 'sign_up' ? 'new-password' : 'current-password'} placeholder="至少 8 位" minlength={8} onInput={(event) => setPassword((event.target as HTMLInputElement).value)} disabled={authSubmitting} required /></label>
        <button type="submit" disabled={authSubmitting}>{authSubmitting ? '正在处理…' : authMode === 'sign_in' ? '登录并同步' : '获取验证码'}</button>
      </form></>}
    </section>}
    {message && <p class="notice" role="status" aria-live="polite">{message}</p>}
    {showImport && <section class="migration" aria-label="旧试玩页数据"><div><strong>检测到旧试玩页数据</strong><span>可在后续登录时一次性导入你的账户。</span></div><button class="secondary" onClick={importLegacy}>准备导入</button></section>}

    <section class="decision-panel" aria-labelledby="today-title">
      <div class="decision-title"><div><h1 id="today-title">{snapshot ? `${snapshot.symbol} 研究结论` : '研究结论'}</h1>{verdict && <p>{verdict.headline}</p>}</div>{verdict && <span class={`decision-stance ${verdict.stance}`}>{verdict.stance}</span>}</div>
      <div class="decision-grid">
        {verdict ? verdict.items.map((item) => <div key={item.label}><span>{item.label}</span><strong class={item.label === '趋势状态' ? tone(snapshot!.summary.trend === 'bullish' ? 1 : -1) : item.label === '策略差距' ? tone(snapshot!.backtest.metrics.cumulativeReturnPct - snapshot!.backtest.metrics.buyHoldReturnPct) : ''}>{item.value}</strong></div>) : <><div><span>当前研究标的</span><strong>{symbol}</strong></div><div><span>趋势状态</span><strong>载入中</strong></div><div><span>动量</span><strong>载入中</strong></div><div><span>近期事件</span><strong>载入中</strong></div></>}
      </div>
    </section>

    <section class="workspace" aria-label="股票研究工作区">
      <div class="primary-column">
        <section class="surface symbol-control" aria-labelledby="research-title">
          <div><h2 id="research-title">单股研究</h2></div>
          <form onSubmit={(event) => { event.preventDefault(); chooseSymbol(input); }}><input aria-label="美股代码" value={input} maxlength={10} autoCapitalize="characters" spellcheck={false} required onInput={(event) => setInput((event.target as HTMLInputElement).value.toUpperCase())} /><button type="submit">查看</button></form>
        </section>
        <section class="surface chart-surface">
          {!snapshot ? <ResearchState error={error} retry={() => chooseSymbol(symbol)} /> : <>
            {error && <div class="inline-error" role="alert"><span>{error.message}</span>{error.retryable && <button class="quiet" onClick={() => fetchSnapshot(symbol, true)}>重试</button>}</div>}
            <div class="quote-row"><div><h2>{snapshot.symbol} 日线</h2></div><div class="quote"><strong>{currency.format(snapshot.summary.price)}</strong><span class={tone(snapshot.summary.change)}>{signed(snapshot.summary.changePct)} · {snapshot.summary.change >= 0 ? '+' : ''}{snapshot.summary.change.toFixed(2)}</span></div><button class="secondary refresh" onClick={() => fetchSnapshot(symbol, true)} disabled={refreshing} aria-label="刷新研究快照">{refreshing ? '刷新中…' : '刷新'}</button></div>
            <PriceChart candles={snapshot.candles} label={snapshot.symbol} />
          </>}
        </section>
        {snapshot && <section class="surface evidence" aria-labelledby="evidence-title"><div class="section-head"><h2 id="evidence-title">为什么出现这个信号</h2></div><ul>{evidence.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        {snapshot && <section class="surface agent-panel" aria-labelledby="agent-title"><div class="section-head"><h2 id="agent-title">智能研究</h2></div><div class="research-actions" aria-label="研究主题">{researchPrompts.map((item) => <button type="button" class={agentQuestion === item.question ? 'research-prompt active' : 'research-prompt'} onClick={() => { setAgentQuestion(item.question); void runAgentResearch(item.question); }} disabled={agentLoading}>{item.label}</button>)}</div><form class="research-question" onSubmit={(event) => { event.preventDefault(); void runAgentResearch(); }}><input aria-label="自定义研究问题" value={agentQuestion} maxlength={700} onInput={(event) => setAgentQuestion((event.target as HTMLInputElement).value)} /><button type="submit" class="secondary" disabled={agentLoading}>{agentLoading ? '研究中…' : agentReport ? '重新研究' : '生成研究报告'}</button></form>{agentReport && <div class="agent-report"><div class="agent-summary"><div class="agent-title-row"><strong>{agentReport.title}</strong><span class={`stance ${agentReport.stance}`}>{agentReport.stance}</span></div><p>{agentReport.summary}</p></div><div class="agent-columns"><div><h3>支持观察</h3><ul>{agentReport.opportunities.map((item, index) => <li key={`${item.claim}-${index}`}><strong>{item.claim}</strong><span>{item.why}</span></li>)}</ul></div><div><h3>风险与失效条件</h3><ul>{agentReport.risks.map((item, index) => <li key={`${item.claim}-${index}`}><strong>{item.claim}</strong><span>{item.why}</span></li>)}</ul></div></div><div class="agent-checks"><h3>下一步核查</h3><ul>{agentReport.nextChecks.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div><div class="agent-evidence"><h3>本次研究依据</h3><dl>{agentReport.evidence.map((item) => <div key={item.path}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></div></div>}</section>}
        {snapshot && <section class="surface backtest" aria-labelledby="backtest-title"><div class="section-head"><h2 id="backtest-title">策略研究回测</h2></div><div class="metric-grid"><div><span>策略收益</span><b class={tone(snapshot.backtest.metrics.cumulativeReturnPct)}>{signed(snapshot.backtest.metrics.cumulativeReturnPct)}</b></div><div><span>买入持有</span><b class={tone(snapshot.backtest.metrics.buyHoldReturnPct)}>{signed(snapshot.backtest.metrics.buyHoldReturnPct)}</b></div><div><span>最大回撤</span><b class="negative">{signed(snapshot.backtest.metrics.maxDrawdownPct)}</b></div><div><span>年化波动</span><b>{Math.abs(snapshot.backtest.metrics.annualizedVolatilityPct).toFixed(2)}%</b></div></div><EquityChart points={snapshot.backtest.equity} /></section>}
      </div>
      <aside class="secondary-column">
        <section class="surface"><div class="section-head"><h2>自选股</h2></div><form class="compact-form" onSubmit={addWatch}><input aria-label="添加自选美股代码" placeholder="例如 META" value={watchInput} maxlength={10} onInput={(event) => setWatchInput((event.target as HTMLInputElement).value.toUpperCase())} /><button type="submit">添加</button></form><ul class="symbol-list">{watchlist.map((item) => <li key={item}><button type="button" class={item === symbol ? 'active-symbol' : ''} onClick={() => chooseSymbol(item)}>{item}</button><button type="button" class="remove" aria-label={`删除 ${item}`} onClick={() => void removeWatch(item)}>移除</button></li>)}</ul></section>
        <section class="surface"><div class="section-head"><h2>技术摘要</h2></div>{snapshot && <dl class="facts"><div><dt>RSI(14)</dt><dd>{snapshot.summary.rsi14 ?? '样本不足'}</dd></div><div><dt>成交量比</dt><dd>{snapshot.summary.volumeRatio ? `${snapshot.summary.volumeRatio}×` : '样本不足'}</dd></div><div><dt>MA20 / MA50</dt><dd>{snapshot.summary.ma20} / {snapshot.summary.ma50}</dd></div><div><dt>20 日区间</dt><dd>{snapshot.summary.support20} 至 {snapshot.summary.resistance20}</dd></div></dl>}</section>
        <section class="surface events-panel"><div class="section-head"><h2>事件与提醒</h2></div>{snapshot?.events.length ? <ul class="event-list">{snapshot.events.map((event) => <li key={`${event.kind}-${event.date}-${event.title}`}><div><strong>{event.title}</strong><span>{event.detail}</span></div><time datetime={event.date}>{event.date} · {event.timing}</time></li>)}</ul> : <p class="muted">暂无可用事件</p>}<button type="button" class="secondary" onClick={() => setMessage('提醒设置将在账户同步开放后启用。')}>提醒设置</button></section>
      </aside>
    </section>

    <section class="surface portfolio" aria-labelledby="portfolio-title"><div class="section-head"><h2 id="portfolio-title">{accountUser ? '云端组合' : '组合草稿'}</h2><span>{portfolioHoldings.length ? `${portfolioHoldings.length} 个标的` : '空组合'}</span></div><div class="portfolio-switcher"><label>当前组合<select value={activePortfolio.id} onChange={(event) => setActivePortfolioId((event.target as HTMLSelectElement).value)}>{portfolios.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button type="button" class="secondary" onClick={requestNewPortfolio}>新建组合</button></div>{portfolioHoldings.length > 0 && <><div class="portfolio-metrics"><div><span>组合市值</span><strong>{portfolioTotal.totalValue ? currency.format(portfolioTotal.totalValue) : '等待行情'}</strong></div><div><span>浮盈亏</span><strong class={portfolioTotal.totalPnl === null ? '' : tone(portfolioTotal.totalPnl)}>{portfolioTotal.totalPnl === null ? '等待行情' : `${currency.format(portfolioTotal.totalPnl)} · ${signed(portfolioTotal.totalPnlPct || 0)}`}</strong></div><div><span>最大仓位</span><strong>{portfolioTotal.maxWeight ? `${portfolioTotal.maxWeight.toFixed(1)}%` : '等待行情'}</strong></div><div><span>风险观察</span><strong class={portfolioTotal.riskCount ? 'negative' : 'positive'}>{portfolioTotal.riskCount ? `${portfolioTotal.riskCount} 个需先看` : '暂无明显风险'}</strong></div></div><div class="portfolio-actions"><span>{portfolioLoading ? '正在同步组合内行情…' : portfolioTotal.missingCount ? `${portfolioTotal.missingCount} 个标的暂时没有可用行情` : '组合数据来自各标的最新研究快照'}</span><button type="button" class="secondary" onClick={() => void runPortfolioResearch()} disabled={agentLoading || portfolioLoading}>{agentLoading ? '研究中…' : '组合风险研究'}</button></div></>}<form class="position-form" onSubmit={addPosition}><input aria-label="持仓代码" placeholder="代码，例如 NVDA" value={positionSymbol} maxlength={10} onInput={(event) => setPositionSymbol((event.target as HTMLInputElement).value.toUpperCase())} /><input aria-label="持仓数量" placeholder="数量" inputMode="decimal" type="number" min="0.0001" step="0.0001" value={quantity} onInput={(event) => setQuantity((event.target as HTMLInputElement).value)} /><input aria-label="平均成本（美元）" placeholder="平均成本 USD" inputMode="decimal" type="number" min="0.0001" step="0.01" value={cost} onInput={(event) => setCost((event.target as HTMLInputElement).value)} /><button type="submit">{editingHoldingId ? '保存修改' : '保存持仓'}</button>{editingHoldingId && <button type="button" class="secondary cancel-edit" onClick={cancelEdit}>取消</button>}</form>{portfolioHoldings.length ? <div class="holding-list">{portfolioRows.map((row) => <div key={row.holding.id} class="holding-row"><button type="button" onClick={() => chooseSymbol(row.holding.symbol)}>{row.holding.symbol}</button><span>{row.marketValue === null ? '行情待更新' : `${currency.format(row.marketValue)} · ${row.weightPct?.toFixed(1)}%仓位`}<small>{row.pnlPct === null ? `成本 ${currency.format(row.holding.cost)}` : `${row.pnlPct >= 0 ? '+' : ''}${row.pnlPct.toFixed(2)}% · ${row.risk}`}</small></span><button type="button" class="quiet" aria-label={`编辑 ${row.holding.symbol} 持仓`} onClick={() => editHolding(row.holding)}>编辑</button><button type="button" class="remove" aria-label={`删除 ${row.holding.symbol} 持仓`} onClick={() => void removePosition(row.holding.id)}>删除</button></div>)}</div> : <p class="muted">暂无持仓</p>}</section>
  </main>;
}
