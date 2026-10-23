# General web research

Kuro-chan can use the Brave Search LLM Context API as an optional read-only web research provider. It returns pre-extracted content snippets and source metadata that can be handed to specialist agents without Kuro-chan scraping arbitrary web pages.

Official documentation:

- [Brave LLM Context API](https://api-dashboard.search.brave.com/documentation/services/llm-context)
- [Authentication and API key handling](https://api-dashboard.search.brave.com/documentation/guides/authentication)

## Configure

Set these values in the server and dedicated worker environments:

```dotenv
BRAVE_SEARCH_API_KEY=your-own-Brave-Search-API-key
BRAVE_SEARCH_COUNTRY=BD
BRAVE_SEARCH_LANG=en
```

The sample key value is a placeholder, not a usable key. Create and manage the key in the Brave Search API dashboard. The provider has its own account, plan, quota, and pricing rules; Kuro-chan does not mint keys or promise unlimited free searches. Keep the real value out of frontend variables, prompts, logs, source control, and mobile storage.

Restart both API and worker processes after changing environment configuration. Check `GET /v1/research/status` or `GET /v1/worker/status` to see whether the general research tool is configured. A configured key indicates local configuration only. The first actual request is what proves that the provider accepted it.

## Agent safety and scope

The worker exposes `web.search` only when a server-side key is configured. The request is always sent to the fixed Brave API host, query arguments and result counts are bounded, only HTTP/HTTPS source links are retained, and returned snippets are capped. Search results are treated as untrusted evidence, not instructions. This runtime does not fetch caller-supplied URLs, write to external sites, or replace the separate read-only public GitHub tools.

The tool returns source URLs, titles, snippets, and evidence objects for the planner and specialist handoffs. Agents should cite the returned source URLs in their findings and should say so when searches return no relevant results or the provider is unavailable. Results may be incomplete or stale; independent sources and recency should be checked for material claims.
