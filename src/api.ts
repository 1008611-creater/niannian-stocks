import type { Snapshot } from './types';

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) { super(message); }
}

export async function loadResearch(symbol: string, signal?: AbortSignal): Promise<Snapshot> {
  let response: Response;
  try {
    response = await fetch(`/api/market/research?symbol=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' }, signal, credentials: 'same-origin' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('network_error', '网络不可用。请检查连接后重试。', true);
  }
  const payload = await response.json().catch(() => ({})) as Partial<{ error: string; message: string; retryable: boolean }> & Snapshot;
  if (!response.ok) throw new ApiError(payload.error || 'request_failed', payload.message || '行情请求失败，请稍后再试。', Boolean(payload.retryable));
  return payload as Snapshot;
}
