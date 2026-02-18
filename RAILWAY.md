# Deploy and Host Web Search MCP on Railway

Web Search MCP is an open-source [MCP](https://modelcontextprotocol.io/) server that gives AI agents eight tools to search, fetch, screenshot, crawl, and archive the web. It consumes zero LLM tokens for web access, so your models spend their budget on reasoning, not searching. The web has always been free for humans, so why should AI agents have to pay per query?

## About Hosting Web Search MCP

This template deploys a complete self-hosted web toolkit as four services on Railway: **Redis**, **SearXNG** (privacy-respecting metasearch engine), **Crawl4AI** (headless browser for content extraction, screenshots, PDFs, and JS execution), and the **MCP Server** that ties them together. An API key is auto-generated at deploy time to secure your endpoint. Once deployed, any MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf, etc.) can connect over HTTP and use all eight tools. No per-query fees, no third-party API keys, no usage limits. You own the infrastructure and the data never leaves your stack.

## Common Use Cases

- **Replace paid search APIs**: Drop-in replacement for Firecrawl, Linkup, Tavily, Exa, or Bright Data. Get web search, page fetching, and content extraction without per-query costs
- **Supercharge AI coding agents**: Connect Claude Code or Cursor to self-hosted web search and page fetching. Replace their built-in WebSearch and WebFetch tools so every search is private and free
- **Web research and monitoring**: Search the web, fetch pages as clean markdown, take screenshots, generate PDFs, execute JavaScript on pages, and query the Wayback Machine for historical snapshots

## Dependencies for Web Search MCP Hosting

- **Redis** (7-alpine): In-memory cache used by SearXNG for rate limiting and result caching
- **SearXNG**: Privacy-respecting metasearch engine that aggregates results from Google, Brave, DuckDuckGo, and more
- **Crawl4AI**: Headless browser service for page fetching, content extraction, screenshots, PDFs, and JavaScript execution
- **MCP Server** (Node.js 22): The MCP endpoint that exposes all eight tools and proxies requests to SearXNG, Crawl4AI, and the Wayback Machine

### Deployment Dependencies

- [Web Search MCP GitHub Repository](https://github.com/arnaudjnn/web-search-mcp)
- [SearXNG Documentation](https://docs.searxng.org/)
- [Crawl4AI Documentation](https://docs.crawl4ai.com/)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)

### Implementation Details

The MCP Server exposes a Streamable HTTP endpoint at `/mcp` that any MCP client can connect to:

```json
{
  "mcpServers": {
    "web_search": {
      "type": "http",
      "url": "https://your-server.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

The eight tools available are: `web_search`, `web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_crawl`, `web_snapshots`, and `web_archive`.

## Why Deploy Web Search MCP on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Web Search MCP on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
