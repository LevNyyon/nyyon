const invoke = async <T,>(tool: string, input: Record<string, unknown> = {}): Promise<T> => {
  const r = await fetch(`/api/plugins/gemini-llm/invoke/${tool}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
};
export type Status = { connected: boolean; active?: boolean; model?: string | null; answering?: boolean; error?: string | null };
export const readStatus = (check = false) => invoke<Status>('gemini_status', { check });
export const connect = (api_key: string) => invoke<{ ok: boolean; model?: string; note?: string; error?: string }>('connect_gemini', { api_key });
export const disconnect = () => invoke<{ ok: boolean }>('disconnect_gemini');
