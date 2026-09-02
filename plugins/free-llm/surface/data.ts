// This page talks ONLY to its own plugin's tools, over the invoke route.
const invoke = async <T,>(tool: string, input: Record<string, unknown> = {}): Promise<T> => {
  const r = await fetch(`/api/plugins/free-llm/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
};

export type ProviderStatus = { provider: string; label?: string; connected: boolean; active: boolean; model?: string | null };
export type Status = { providers: ProviderStatus[]; active: string | null; answering?: boolean; error?: string | null };
export type ConnectResult = { ok: boolean; provider?: string; model?: string; note?: string; error?: string };

export const readStatus = (check = false) => invoke<Status>('free_llm_status', { check });
export const connect = (provider: string, api_key: string, model?: string) =>
  invoke<ConnectResult>('connect_free_llm', { provider, api_key, ...(model ? { model } : {}) });
export const disconnect = (provider: string) => invoke<{ ok: boolean; note?: string }>('disconnect_free_llm', { provider });
export const setActive = (provider: string) => invoke<{ ok: boolean; active?: string; error?: string }>('set_active_free_llm', { provider });
