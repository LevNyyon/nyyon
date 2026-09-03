# Web search (Brave)

One tool: `search_web(query, limit?)`. General web search with titles, links and one-line summaries.

Use it when the operator wants to look something up, find a specific page, or see what exists on a topic beyond the news. For fresh headlines prefer `search_news` when it is installed.

Setup, in conversation: the operator creates a free key at https://api-dashboard.search.brave.com/app/keys (register at https://api-dashboard.search.brave.com/register) and pastes it to Nyo; call `connect_brave_search` with it. The key is verified with a real query before it is stored. `brave_search_status` says whether it is connected; `disconnect_brave_search` forgets it. The Digest discovers this provider on its own.
