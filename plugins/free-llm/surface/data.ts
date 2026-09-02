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

export type ProviderOption = { key: string; label: string; default_model: string; signup: string };
export type Status = {
  connected: boolean;
  provider?: string;
  label?: string;
  model?: string;
  answering?: boolean;
  error?: string | null;
  providers?: ProviderOption[];
};
export type ConnectResult = { ok: boolean; label?: string; model?: string; note?: string; error?: string };

export const readStatus  = (check = false) => invoke<Status>('free_llm_status', { check });
export const connect     = (input: Record<string, unknown>) => invoke<ConnectResult>('connect_free_llm', input);
export const disconnect  = () => invoke<{ ok: boolean; note?: string }>('disconnect_free_llm');
