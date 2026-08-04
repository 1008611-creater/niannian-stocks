import type { Holding } from './types';

const WATCHLIST = 'niannian-stocks-watchlist-v1';
const HOLDINGS = 'niannian-stocks-holdings-v1';
const symbolPattern = /^[A-Z.]{1,10}$/;
export const defaultWatchlist = ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMZN'];

export function validSymbol(input: string) { return symbolPattern.test(input.trim().toUpperCase()); }
export function readWatchlist(): string[] {
  try { const saved = JSON.parse(localStorage.getItem(WATCHLIST) || 'null'); if (Array.isArray(saved)) return [...new Set(saved.map(String).map((value) => value.trim().toUpperCase()).filter(validSymbol))].slice(0, 50); } catch { /* Ignore corrupted local data. */ }
  return defaultWatchlist;
}
export function saveWatchlist(items: string[]) { localStorage.setItem(WATCHLIST, JSON.stringify(items)); }
export function readHoldings(): Holding[] {
  try { const saved = JSON.parse(localStorage.getItem(HOLDINGS) || 'null'); if (Array.isArray(saved)) return saved.filter((item): item is Holding => validSymbol(String(item?.symbol || '')) && Number(item?.quantity) > 0 && Number(item?.cost) > 0).slice(0, 100); } catch { /* Ignore corrupted local data. */ }
  return [];
}
export function saveHoldings(items: Holding[]) { localStorage.setItem(HOLDINGS, JSON.stringify(items)); }
export function legacyImportAvailable() {
  return ['stock-research-watchlist-v1', 'stock-research-portfolio-v1', 'stock-research-alert-config-v1'].some((key) => localStorage.getItem(key));
}
export function buildLegacyImport() {
  const read = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  return { schemaVersion: 1, importedAt: new Date().toISOString(), watchlist: read('stock-research-watchlist-v1'), holdings: read('stock-research-portfolio-v1'), alerts: read('stock-research-alert-config-v1') };
}
