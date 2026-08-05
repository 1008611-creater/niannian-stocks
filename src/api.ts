import type { Snapshot } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) { super(message); }
}

export async function loadResearch(symbol: string, signal?: AbortSignal): Promise<Snapshot> {
  const timeoutController = new AbortController();
  const timer = window.setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const abortRequest = () => timeoutController.abort();
  signal?.addEventListener('abort', abortRequest, { once: true });
  let response: Response;
  try {
    response = await fetch(`/api/market/research?symbol=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' }, signal: timeoutController.signal, credentials: 'same-origin' });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeoutController.signal.aborted) throw new ApiError('timeout', '行情服务响应超时，请稍后重试。', true);
    throw new ApiError('network_error', '网络不可用。请检查连接后重试。', true);
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abortRequest);
  }
  const payload = await response.json().catch(() => ({})) as Partial<{ error: string; message: string; retryable: boolean }> & Snapshot;
  if (!response.ok) throw new ApiError(payload.error || 'request_failed', payload.message || '行情请求失败，请稍后再试。', Boolean(payload.retryable));
  return payload as Snapshot;
}
