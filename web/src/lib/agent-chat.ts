// One isolated thread per plugin persona (agent), persisted per install like
// the planner thread but without the planner's new-day rollover. The Nyo
// drawer never reads these; a persona conversation never mixes into Nyo.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Msg } from './chat';

export type AgentChat = {
  messages: Msg[]; setMessages: Dispatch<SetStateAction<Msg[]>>;
  conversationId: string | null; setConversationId: Dispatch<SetStateAction<string | null>>;
  streaming: boolean; setStreaming: Dispatch<SetStateAction<boolean>>;
  clearAll: () => void;
  pendingSend: string | null; setPendingSend: Dispatch<SetStateAction<string | null>>;
  markSeen: () => void; bumpAssistantActivity: () => void;
};

export function useAgentChat(agent: string | null): AgentChat {
  const key = agent ? `nyyon.agent.${agent}.v1` : null;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!key) { hydrated.current = true; return; }
    try {
      const raw = localStorage.getItem(key);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p?.messages)) setMessages(p.messages); if (p?.conversationId) setConversationId(p.conversationId); }
    } catch { /* corrupt cache */ }
    hydrated.current = true;
  }, [key]);
  useEffect(() => {
    if (!key || !hydrated.current) return;
    try { localStorage.setItem(key, JSON.stringify({ conversationId, messages: messages.slice(-200) })); } catch { /* quota */ }
  }, [key, messages, conversationId]);
  const clearAll = () => { setMessages([]); setConversationId(null); if (key) { try { localStorage.removeItem(key); } catch { /* ignore */ } } };
  return { messages, setMessages, conversationId, setConversationId, streaming, setStreaming, clearAll, pendingSend, setPendingSend, markSeen: () => {}, bumpAssistantActivity: () => {} };
}
