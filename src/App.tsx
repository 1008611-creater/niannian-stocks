import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, loadResearch } from './api';
import { EquityChart, PriceChart } from './chart';
import { buildLegacyImport, legacyImportAvailable, readHoldings, readWatchlist, saveHoldings, saveWatchlist, validSymbol } from './storage';
import type { Holding, Snapshot } from './types';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const percentage = new Intl.NumberFormat('zh-CN', { style: 'percent', signDisplay: 'always', maximumFractionDigits: 2 });
const defaultSnapshot = 'NVDA';

function signed(value: number) { return percentage.format(value / 100); }
function tone(value: number) { return value >= 0 ? 'positive' : 'negative'; }
function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
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

function eventStatusLabel(snapshot: Snapshot) {
  if (snapshot.eventsStatus === 'available') return snapshot.events.length ? '未来 60 天' : '未来 60 天暂无事件';
  return snapshot.eventsStatus === 'unavailable' ? '数据源暂不可用' : '事件源待配置';
}

export default function App() {
  const [symbol, setSymbol] = useState(defaultSnapshot);
  const [input, setInput] = useState(defaultSnapshot);
  const [watchlist, setWatchlist] = useState(readWatchlist);
  const [holdings, setHoldings] = useState<Holding[]>(readHoldings);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [watchInput, setWatchInput] = useState('');
  const [positionSymbol, setPositionSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [cost, setCost] = useState('');
  const [message, setMessage] = useState('');
  const [showImport, setShowImport] = useState(legacyImportAvailable);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const requestRef = useRef<AbortController | null>(null);

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
  useEffect(() => saveWatchlist(watchlist), [watchlist]);
  useEffect(() => saveHoldings(holdings), [holdings]);
  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    return () => { window.removeEventListener('online', markOnline); window.removeEventListener('offline', markOffline); };
  }, []);

  const holdingSummary = useMemo(() => {
    if (!snapshot || !holdings.length) return null;
    const active = holdings.filter((item) => item.symbol === snapshot.symbol);
    const invested = active.reduce((total, item) => total + item.quantity * item.cost, 0);
    const value = active.reduce((total, item) => total + item.quantity * snapshot.summary.price, 0);
    return { invested, value, pnl: value - invested, activeCount: active.length };
  }, [holdings, snapshot]);
  const evidence = useMemo(() => snapshot ? signalLabel(snapshot) : [], [snapshot]);

  function chooseSymbol(next: string) { const value = next.trim().toUpperCase(); if (!validSymbol(value)) { setMessage('请输入有效的美股代码。'); return; } setInput(value); setSymbol(value); setMessage(''); }
  function addWatch(event: Event) { event.preventDefault(); const next = watchInput.trim().toUpperCase(); if (!validSymbol(next)) { setMessage('自选代码格式不正确。'); return; } if (watchlist.includes(next)) { setMessage(`${next} 已在自选中。`); return; } if (watchlist.length >= 5) { setMessage('免费层最多 5 只自选。登录并升级 Pro 后可扩展至 50 只。'); return; } setWatchlist([...watchlist, next]); setWatchInput(''); setMessage(`${next} 已加入自选。`); }
  function addPosition(event: Event) {
    event.preventDefault(); const next = positionSymbol.trim().toUpperCase(); const parsedQuantity = Number(quantity); const parsedCost = Number(cost);
    if (!validSymbol(next) || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || !Number.isFinite(parsedCost) || parsedCost <= 0) { setMessage('请填写有效代码、数量和平均成本。'); return; }
    const existing = holdings.find((item) => item.symbol === next); const updated = existing ? holdings.map((item) => item.symbol === next ? { ...item, quantity: item.quantity + parsedQuantity, cost: (item.quantity * item.cost + parsedQuantity * parsedCost) / (item.quantity + parsedQuantity) } : item) : [...holdings, { id: crypto.randomUUID(), symbol: next, quantity: parsedQuantity, cost: parsedCost }];
    setHoldings(updated); setPositionSymbol(''); setQuantity(''); setCost(''); setMessage(`${next} 已写入本机组合草稿；登录后将可云同步。`);
  }
  function importLegacy() { const payload = buildLegacyImport(); sessionStorage.setItem('niannian-stocks-pending-import', JSON.stringify(payload)); setShowImport(false); setMessage('旧试玩页数据已安全整理为待导入包；登录功能接入后会写入当前账户。'); }

  return <main>
    <header class="topbar">
      <div><p class="brand">念念智股</p><p class="service-label">美股组合决策助手 · 限额研究公测</p></div>
      <div class="account-status"><span class={online ? 'connection-status online' : 'connection-status'}>{online ? '在线' : '离线'}</span><span>免费层</span><button class="quiet" onClick={() => setMessage('当前为本机研究模式；登录、云同步和 Pro 权益待接入账户服务后启用。不会伪造付费状态。')}>登录与同步</button></div>
    </header>
    <p class="notice" role="status" aria-live="polite">{message || (!online ? '当前处于离线状态；已载入内容仍可查看，刷新行情需要网络。' : '研究用途，不构成投资建议；日线并非交易级实时行情。')}</p>
    {showImport && <section class="migration" aria-label="旧试玩页数据"><div><strong>检测到旧试玩页数据</strong><span>可在后续登录时一次性导入你的账户。</span></div><button class="secondary" onClick={importLegacy}>准备导入</button></section>}

    <section class="decision-panel" aria-labelledby="today-title">
      <div class="decision-title"><h1 id="today-title">今日决策面板</h1><span>{snapshot ? `${snapshot.symbol} · 快照 ${snapshot.snapshotId}` : '准备研究快照'}</span></div>
      <div class="decision-grid">
        <div><span>当前研究标的</span><strong>{snapshot?.symbol || symbol}</strong><small>{snapshot ? `${snapshot.source} · ${displayDate(snapshot.updatedAt)}` : '载入中'}</small></div>
        <div><span>趋势</span><strong class={snapshot?.summary.trend === 'bullish' ? 'positive' : 'negative'}>{snapshot?.summary.trend === 'bullish' ? 'MA20 高于 MA50' : snapshot ? 'MA20 低于 MA50' : '—'}</strong><small>研究信号，不是交易指令</small></div>
        <div><span>组合中的当前标的</span><strong>{holdingSummary ? currency.format(holdingSummary.value) : '未录入'}</strong><small>{holdingSummary ? `${holdingSummary.activeCount} 笔成本合并显示` : '可在下方录入持仓'}</small></div>
        <div><span>下一步</span><strong>{snapshot?.eventsStatus === 'not_configured' ? '事件层待接入' : '查看事件'}</strong><small>财报与后台提醒属于 Pro 能力</small></div>
      </div>
    </section>

    <section class="workspace" aria-label="股票研究工作区">
      <div class="primary-column">
        <section class="surface symbol-control" aria-labelledby="research-title">
          <div><h2 id="research-title">单股研究</h2><p>图表、技术摘要、回测与持仓估值来自同一个研究快照。</p></div>
          <form onSubmit={(event) => { event.preventDefault(); chooseSymbol(input); }}><input aria-label="美股代码" value={input} maxlength={10} autoCapitalize="characters" spellcheck={false} required onInput={(event) => setInput((event.target as HTMLInputElement).value.toUpperCase())} /><button type="submit">查看</button></form>
        </section>
        <section class="surface chart-surface">
          {!snapshot ? <ResearchState error={error} retry={() => chooseSymbol(symbol)} /> : <>
            {error && <div class="inline-error" role="alert"><span>{error.message}</span>{error.retryable && <button class="quiet" onClick={() => fetchSnapshot(symbol, true)}>重试</button>}</div>}
            <div class="quote-row"><div><h2>{snapshot.symbol} 日线</h2><p>{snapshot.source} · {snapshot.marketStatus === 'market_closed' ? '休市' : '收盘或延迟数据'}</p></div><div class="quote"><strong>{currency.format(snapshot.summary.price)}</strong><span class={tone(snapshot.summary.change)}>{signed(snapshot.summary.changePct)} · {snapshot.summary.change >= 0 ? '+' : ''}{snapshot.summary.change.toFixed(2)}</span></div><button class="secondary refresh" onClick={() => fetchSnapshot(symbol, true)} disabled={refreshing} aria-label="刷新研究快照">{refreshing ? '刷新中…' : '刷新'}</button></div>
            <PriceChart candles={snapshot.candles} label={snapshot.symbol} />
            <p class="data-footnote">{snapshot.delayLabel} 更新时间：{displayDate(snapshot.updatedAt)}。来源：{snapshot.source}。</p>
          </>}
        </section>
        {snapshot && <section class="surface evidence" aria-labelledby="evidence-title"><div class="section-head"><div><h2 id="evidence-title">为什么出现这个信号</h2><p>只展示当前快照可追溯的证据，不生成买卖指令。</p></div><span class="research-tag">同一快照</span></div><ul>{evidence.map((item) => <li key={item}>{item}</li>)}</ul><p class="data-footnote">策略结果包含滑点和交易成本，不能代表未来表现。</p></section>}
        {snapshot && <section class="surface backtest" aria-labelledby="backtest-title"><div class="section-head"><div><h2 id="backtest-title">策略研究回测</h2><p>{snapshot.backtest.strategy.name} · {snapshot.backtest.strategy.version}</p></div><span class="research-tag">可复核研究</span></div><div class="metric-grid"><div><span>策略收益</span><b class={tone(snapshot.backtest.metrics.cumulativeReturnPct)}>{signed(snapshot.backtest.metrics.cumulativeReturnPct)}</b></div><div><span>买入持有</span><b class={tone(snapshot.backtest.metrics.buyHoldReturnPct)}>{signed(snapshot.backtest.metrics.buyHoldReturnPct)}</b></div><div><span>最大回撤</span><b class="negative">{signed(snapshot.backtest.metrics.maxDrawdownPct)}</b></div><div><span>年化波动</span><b>{Math.abs(snapshot.backtest.metrics.annualizedVolatilityPct).toFixed(2)}%</b></div></div><EquityChart points={snapshot.backtest.equity} /><p class="data-footnote">样本：{snapshot.backtest.sample.start} 至 {snapshot.backtest.sample.end}，{snapshot.backtest.sample.candleCount} 根日线。{snapshot.backtest.strategy.assumptions}</p></section>}
      </div>
      <aside class="secondary-column">
        <section class="surface"><div class="section-head"><div><h2>自选股</h2><p>免费层 0–5 / Pro 0–50</p></div></div><form class="compact-form" onSubmit={addWatch}><input aria-label="添加自选美股代码" placeholder="例如 META" value={watchInput} maxlength={10} onInput={(event) => setWatchInput((event.target as HTMLInputElement).value.toUpperCase())} /><button type="submit">添加</button></form><ul class="symbol-list">{watchlist.map((item) => <li key={item}><button type="button" class={item === symbol ? 'active-symbol' : ''} onClick={() => chooseSymbol(item)}>{item}</button><button type="button" class="remove" aria-label={`删除 ${item}`} onClick={() => setWatchlist(watchlist.filter((value) => value !== item))}>移除</button></li>)}</ul></section>
        <section class="surface"><div class="section-head"><div><h2>技术摘要</h2><p>{snapshot ? '同一快照计算' : '等待行情'}</p></div></div>{snapshot ? <dl class="facts"><div><dt>RSI(14)</dt><dd>{snapshot.summary.rsi14 ?? '样本不足'}</dd></div><div><dt>成交量比</dt><dd>{snapshot.summary.volumeRatio ? `${snapshot.summary.volumeRatio}×` : '—'}</dd></div><div><dt>MA20 / MA50</dt><dd>{snapshot.summary.ma20} / {snapshot.summary.ma50}</dd></div><div><dt>20 日区间</dt><dd>{snapshot.summary.support20} – {snapshot.summary.resistance20}</dd></div></dl> : <p class="muted">载入后显示指标。</p>}</section>
        <section class="surface events-panel"><div class="section-head"><div><h2>事件与提醒</h2><p>{snapshot ? eventStatusLabel(snapshot) : '等待行情'}</p></div><span class="pro-tag">Pro</span></div>{snapshot?.events.length ? <ul class="event-list">{snapshot.events.map((event) => <li key={`${event.kind}-${event.date}-${event.title}`}><div><strong>{event.title}</strong><span>{event.detail}</span></div><time datetime={event.date}>{event.date} · {event.timing}</time></li>)}</ul> : <p class="muted">{snapshot?.eventsStatus === 'unavailable' ? '事件数据暂时不可用，行情仍可继续研究。' : '财报、分红与后台提醒会在数据源和账户权益完成后显示。'}</p>}<button type="button" class="secondary" onClick={() => setMessage('提醒设置会在账户同步和 Pro 权益接入后开放；当前不弹出升级窗口。')}>提醒设置</button></section>
      </aside>
    </section>

    <section class="surface portfolio" aria-labelledby="portfolio-title"><div class="section-head"><div><h2 id="portfolio-title">组合草稿</h2><p>当前保存在本机；登录后会一次性迁移至你的云端账户。</p></div><span>{holdings.length ? `${holdings.length} 个标的` : '空组合'}</span></div><form class="position-form" onSubmit={addPosition}><input aria-label="持仓代码" placeholder="代码，例如 NVDA" value={positionSymbol} maxlength={10} onInput={(event) => setPositionSymbol((event.target as HTMLInputElement).value.toUpperCase())} /><input aria-label="持仓数量" placeholder="数量" inputMode="decimal" type="number" min="0.0001" step="0.0001" value={quantity} onInput={(event) => setQuantity((event.target as HTMLInputElement).value)} /><input aria-label="平均成本（美元）" placeholder="平均成本 USD" inputMode="decimal" type="number" min="0.0001" step="0.01" value={cost} onInput={(event) => setCost((event.target as HTMLInputElement).value)} /><button type="submit">保存持仓</button></form>{holdings.length ? <div class="holding-list">{holdings.map((item) => <div key={item.id}><button type="button" onClick={() => chooseSymbol(item.symbol)}>{item.symbol}</button><span>{item.quantity} 股 · 成本 {currency.format(item.cost)}</span><button type="button" class="remove" aria-label={`删除 ${item.symbol} 持仓`} onClick={() => setHoldings(holdings.filter((holding) => holding.id !== item.id))}>删除</button></div>)}</div> : <p class="muted">录入第一笔持仓后，会基于当前研究快照显示对应标的估值。</p>}</section>
    <footer>念念智股只提供可追溯研究信息，不提供个性化投资建议或券商交易服务。</footer>
  </main>;
}
