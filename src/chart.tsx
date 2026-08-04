import { useEffect, useRef } from 'preact/hooks';
import { AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries } from 'lightweight-charts';
import type { Candle } from './types';

export function PriceChart({ candles, label }: { candles: Candle[]; label: string }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = node.current;
    if (!container) return;
    const chart = createChart(container, { width: container.clientWidth, height: 330, layout: { background: { type: ColorType.Solid, color: '#0b1725' }, textColor: '#91a5bd' }, grid: { vertLines: { color: '#17283a' }, horzLines: { color: '#17283a' } }, rightPriceScale: { borderColor: '#1c3045' }, timeScale: { borderColor: '#1c3045' } });
    const price = chart.addSeries(CandlestickSeries, { upColor: '#4ad29a', downColor: '#ff8491', borderVisible: false, wickUpColor: '#4ad29a', wickDownColor: '#ff8491' });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    price.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volume.setData(candles.map(({ time, open, close, volume: value }) => ({ time, value, color: close >= open ? 'rgba(74,210,154,.38)' : 'rgba(255,132,145,.38)' })));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [candles]);
  return <div class="chart" ref={node} role="img" aria-label={`${label} 日线 K 线图`} />;
}

export function EquityChart({ points }: { points: { time: string; value: number }[] }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = node.current;
    if (!container) return;
    const chart = createChart(container, { width: container.clientWidth, height: 175, layout: { background: { type: ColorType.Solid, color: '#0b1725' }, textColor: '#91a5bd' }, grid: { vertLines: { color: '#17283a' }, horzLines: { color: '#17283a' } }, rightPriceScale: { borderColor: '#1c3045' }, timeScale: { borderColor: '#1c3045' }, handleScale: false, handleScroll: false });
    const series = chart.addSeries(AreaSeries, { lineColor: '#5ea9ff', topColor: 'rgba(94,169,255,.28)', bottomColor: 'rgba(94,169,255,0)', lineWidth: 2 });
    series.setData(points); chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth })); observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [points]);
  return <div class="equity-chart" ref={node} role="img" aria-label="研究策略净值曲线" />;
}
