# Web Search MCP

An [MCP](https://modelcontextprotocol.io/) server that provides two tools: a fast **web search** powered by [SearXNG](https://github.com/searxng/searxng), and an AI-driven **deep research** engine that iteratively searches, scrapes, evaluates sources, and produces comprehensive reports.

## Architecture

```mermaid
graph LR
    Client["MCP Client<br/>(Claude, Cursor, etc.)"] -->|web-search| Server["MCP Server"]
    Client -->|deep-research| Server
    Server --> SearXNG
    SearXNG --> Redis
    Server -.->|deep-research only| Scraper["Built-in Scraper<br/>fetch + cheerio + turndown"]
    Server -.->|deep-research only| LLM["LLM API<br/>(Anthropic, OpenAI, etc.)"]
```

The `web-search` tool only needs SearXNG. The `deep-research` tool additionally uses a built-in scraper ([cheerio](https://github.com/cheeriojs/cheerio) + [Turndown](https://github.com/mixmark-io/turndown)) and an LLM for reasoning.

The full stack deploys as **3 services**: Redis, SearXNG, and this MCP server.

### Inspired by Firecrawl

This project originally used [Firecrawl](https://github.com/mendableai/firecrawl) as middleware between SearXNG and the MCP server. Firecrawl is an excellent open-source web scraping platform, but its full stack (API server, workers, Playwright service, Redis, SearXNG) requires 5+ services to self-host.

We took inspiration from Firecrawl's approach to:

- **Search-then-scrape pipeline** — [Firecrawl's search controller](https://github.com/mendableai/firecrawl/blob/main/apps/api/src/controllers/v1/search.ts) first searches, then scrapes only relevant results
- **HTML-to-Markdown conversion** — Firecrawl converts raw HTML into clean Markdown for LLM consumption, a pattern we replicate with cheerio + Turndown
- **SearXNG as search backend** — Firecrawl's [self-hosted setup](https://github.com/mendableai/firecrawl/blob/main/SELF_HOST.md) uses SearXNG as a free, privacy-respecting search backend with no API key required

By integrating search and scraping directly into the MCP server, we eliminated the Firecrawl dependency while keeping the same patterns that made it effective.

## Tools

The server exposes two MCP tools:

### `web-search`

Lightweight web search via SearXNG. **No LLM API key required** — only needs SearXNG.

| Parameter | Type              | Description                                  |
| --------- | ----------------- | -------------------------------------------- |
| `query`   | string (required) | The search query                             |
| `limit`   | number (optional) | Max results to return (default: 10, max: 20) |

Returns a JSON array of `{ url, title, description }` results.

### `deep-research`

AI-powered iterative research that searches, scrapes, evaluates sources, and writes a comprehensive report. **Requires an LLM API key** (Anthropic, OpenAI, Google, or xAI) for reasoning.

| Parameter           | Type              | Description                          |
| ------------------- | ----------------- | ------------------------------------ |
| `query`             | string (required) | The research topic                   |
| `depth`             | 1-5               | How many levels deep to recurse      |
| `breadth`           | 1-5               | How many parallel queries per level  |
| `model`             | string (optional) | e.g. `"anthropic:claude-sonnet-4-5"` |
| `tokenBudget`       | number (optional) | Soft cap on research-phase tokens    |
| `sourcePreferences` | string (optional) | e.g. `"avoid SEO listicles, forums"` |

#### LLM Provider

The `deep-research` tool is **LLM-agnostic**. It uses the [Vercel AI SDK](https://sdk.vercel.ai/) and supports:

| Provider  | Env Var             | Default Model             |
| --------- | ------------------- | ------------------------- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-4-5`         |
| OpenAI    | `OPENAI_API_KEY`    | `gpt-5.2`                 |
| Google    | `GOOGLE_API_KEY`    | `gemini-3-pro-preview`    |
| xAI       | `XAI_API_KEY`       | `grok-4-1-fast-reasoning` |

The caller selects the model per request via the `model` parameter. You only need an API key for the provider you use. The LLM is used for:

- Generating targeted search queries from the research topic
- Filtering search results before scraping (removing junk/spam)
- Evaluating source reliability (scoring 0-1 with reasoning)
- Extracting structured learnings from scraped content
- Writing the final research report

### Connecting to the Server

All examples below assume your server is running at `https://your-server.up.railway.app/mcp` with an API key. Replace the URL and key with your own values.

#### Claude Code (CLI)

```bash
claude mcp add web-search \
  --transport http \
  https://your-server.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```

#### Project-level config (`.mcp.json`)

Add to `.mcp.json` at the root of any project to make the tool available to all collaborators:

```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "https://your-server.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "https://your-server.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### Replace Claude Code's Built-in Web Search (Optional)

By default, Claude Code uses its own `WebSearch` tool. You can replace it with this server's `web-search` tool for privacy-respecting, self-hosted search results.

**1. Add the MCP server globally:**

```bash
claude mcp add web-search --scope user \
  --transport http \
  https://your-server.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```

**2. Disable the built-in `WebSearch`** by editing `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

**3. Guide Claude via `~/.claude/CLAUDE.md`** so it uses your tool:

```markdown
## Search

- Use the web-search MCP tool for all web searches
- Do not attempt to use the built-in WebSearch tool
```

**4. Verify** by running `/mcp` inside Claude Code to check the server is connected, then ask Claude to search for something.

## How Deep Research Works

```mermaid
flowchart TB
    subgraph Input
        Q[User Query]
        B[Breadth Parameter]
        D[Depth Parameter]
    end

    subgraph Research[Deep Research Loop]
        direction TB
        SQ[Generate SERP Queries]
        SR[Search via SearXNG]
        FI[Filter Results]
        SC[Scrape URLs]
        RE[Evaluate Source Reliability]
        PR[Extract Learnings]
    end

    subgraph Results[Output]
        direction TB
        L((Learnings with
        Reliability Scores))
        ND((Follow-up
        Directions))
    end

    Q & B & D --> SQ
    SQ --> SR
    SR --> FI
    FI --> SC
    SC --> RE
    RE --> PR
    PR --> L
    PR --> ND

    L & ND --> DP{depth > 0?}
    DP -->|Yes| SQ
    DP -->|No| MR[Markdown Report]
```

At each depth level:

1. Generates targeted search queries using the LLM
2. Searches via SearXNG (deduplicates across engines)
3. Filters out junk URLs before scraping
4. Scrapes and converts pages to Markdown
5. Evaluates each source's reliability (0-1 score)
6. Extracts learnings weighted by source reliability
7. Generates follow-up questions for the next depth level

The final report includes all learnings and a sources section sorted by reliability score.

## Deployment (Railway)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/3PPfYo?referralCode=L7pPO5&utm_medium=integration&utm_source=template&utm_campaign=generic)

- Click **Deploy on Railway**: you'll see all 3 services listed (Redis, SearXNG, MCP Server)
- Click **Configure** on the **mcp-server** service and add your `ANTHROPIC_API_KEY` (or another LLM provider key)
- Click **Deploy**: Railway provisions everything and wires the services together automatically

## Quick Start (Local)

### 1. Clone and install

```bash
git clone https://github.com/arnaudjnn/web-search-mcp
cd web-search-mcp
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and add at least one LLM API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Start the local stack

```bash
docker compose up -d redis searxng
```

This starts Redis and SearXNG. Then run the MCP server:

```bash
SEARXNG_URL=http://localhost:8080 pnpm run start:http
```

The server is available at `http://localhost:3000/mcp`.

### 4. Or run everything in Docker

```bash
docker compose up
```

## Securing the MCP Endpoint

Set the `API_KEY` environment variable to require authentication on all requests (except `/health`). Clients provide the key as a `Bearer` token in the `Authorization` header (shown in the examples above) or as an `?api_key=` query parameter.

If `API_KEY` is not set, the server accepts all requests without authentication.

### Observability (Optional)

Track research flows with [Langfuse](https://langfuse.com/):

```bash
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
LANGFUSE_BASEURL=https://cloud.langfuse.com
```

## License

MIT
