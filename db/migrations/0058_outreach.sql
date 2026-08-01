-- Outreach module — approach the prospects Prospecting surfaced. No new tables:
-- the conversation list is a DERIVED join between the WhatsApp cache
-- (wa_chats / wa_messages, migration 0007) and the GTM lead store (gtm_leads,
-- migration 0041), keyed by phone → `<digits>@c.us`. Thread badges reuse
-- outreach_threads (migration 0053). Only knowledge is seeded here.
--
-- The `outreach-reply-drafting` doc is ALSO lazy-seeded by
-- lib/outreach-wa.js loadDraftingRules() on first read, so the tab works
-- whether or not this migration has been applied. This file is what puts it in
-- the Knowledge tree under the module doc up front.

INSERT OR IGNORE INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at) VALUES
('module-outreach', 'Module · Outreach — approaching the prospects we picked', 'Where prospecting turns into conversation. Prospecting decides WHO is worth approaching; Outreach is where you actually talk to them, with everything you know about them on screen.

**WA** (default tab) — a WhatsApp inbox filtered to PROSPECTS: only 1:1 chats belonging to someone in the GTM lead store. Ordered newest-first with the conversations where THEY spoke last pinned to the top, because that is the real queue — people waiting on a reply. Open one and three things sit side by side:

- **the conversation** — the full history with that person, straight from the wa_messages cache the gateway syncs.
- **the prospect card** — name, title, company, ICP fit and the reasons behind it, LinkedIn (person and company), headcount, open roles, org-verification status. The context you would otherwise go dig for in GTM.
- **the suggested draft** — sits in the composer, always editable, never auto-sent. On a FIRST touch it is the top saved angle from GTM → Outreach verbatim, so a cold open is exactly the message you already approved. Once they have replied, it is a reply composed from that angle plus the recent messages, per the [[outreach-reply-drafting]] rules.

Sending goes through the normal outbox-audited WhatsApp path — the same send, logging, and audit trail as everywhere else. Nothing in this module can dispatch a message on its own.

The lead ↔ chat link is derived, never stored: a lead''s phone maps to its WhatsApp DM id. A prospect with no WhatsApp chat simply does not appear here; give them a first message from GTM → Outreach and the conversation shows up.

Nyo tools: outreach_wa_threads (the inbox), outreach_wa_thread (one conversation + the card), outreach_draft_reply (suggest the next message — never sends), outreach_wa_settings (the drafting rules + how much the tab loads). Sending: send_whatsapp. Gateways: the shared wa-gateway (read + send) and llm (drafting only).', 'global', NULL, 'knowledge-root', strftime('%s','now')*1000),

('outreach-reply-drafting', 'Outreach · WA reply drafting', 'Outreach · WA — how the suggested draft under the composer is written, and how much of the conversation the tab loads.

The draft is a SUGGESTION. It is never sent automatically: it lands in the composer for you to edit or delete. When you have not messaged the prospect yet, the tab shows the top saved GTM angle verbatim instead of writing anything new — so a cold first touch is always exactly the message you approved in GTM → Outreach.

Edit the rules below to change how replies are written. Edit the json block to change how much the tab loads. Both apply with no deploy.

```json
{
  "thread_limit": 60,
  "message_limit": 300,
  "draft_context_messages": 12,
  "draft_context_chars": 500
}
```

---
How to write the suggested reply to a prospect on WhatsApp:

- One message, not a sequence. Short — two or three sentences, the length a
  busy person actually reads on a phone.
- Answer what they actually said FIRST. Never restate the pitch at someone who
  has already replied to it.
- Keep the angle''s positioning, drop the angle''s phrasing. The saved angle is
  what we believe about them; it is not a script to paste at them.
- Plain human words. No em dashes, no "I hope this finds you well", no
  "circling back", no exclamation marks, no emoji unless they used one first.
- Match their language. If they wrote in Hebrew, reply in Hebrew.
- Never invent a fact — no names, numbers, dates, mutual contacts, or claims
  about their company that are not in the context you were given.
- If they declined, do not push. Acknowledge it, leave the door open in one
  short line, and stop.
- End with at most one question, and only when a question actually moves it
  forward.
', 'global', NULL, 'module-outreach', strftime('%s','now')*1000);
