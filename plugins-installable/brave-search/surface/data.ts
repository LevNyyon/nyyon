const invoke = async <T,>(tool: string, input: Record<string, unknown> = {}): Promise<T> => {
  const r = await fetch(`/api/plugins/brave-search/invoke/${tool}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
};
export type Status = { connected: boolean; label?: string; note?: string | null; answering?: boolean; error?: string | null };
export const readStatus = (check = false) => invoke<Status>('brave_search_status', { check });
export const connect = (api_key: string) => invoke<{ ok: boolean; note?: string; error?: string }>('connect_brave_search', { api_key });
export const disconnect = () => invoke<{ ok: boolean }>('disconnect_brave_search');
