# Web Tools

A self-hosted web toolkit providing fourteen tools for search, content extraction, and archival. Available as an [MCP](https://modelcontextprotocol.io/) server, REST API, and CLI — powered by [SearXNG](https://github.com/searxng/searxng), [Crawl4AI](https://github.com/unclecode/crawl4ai), [Scrapling](https://github.com/D4Vinci/Scrapling), [Camoufox](https://github.com/daijro/camoufox), and the [Wayback Machine](https://web.archive.org/).

## Architecture

```mermaid
graph LR
    MCP["MCP Client<br/>(Claude, Cursor, etc.)"] -->|POST /mcp| Server["Web Tools Server"]
    API["REST Client"] -->|POST /api/v0/*| Server
    CLI["CLI"] -->|direct call| Toolkit["@web-tools/toolkit"]
    Server --> Toolkit
    Toolkit --> SearXNG
    SearXNG --> Redis
    Toolkit --> Scrapling
    Toolkit --> Camoufox
    Toolkit --> Crawl4AI
    Toolkit --> Wayback["Wayback Machine"]
```

### Why three fetchers

They are not redundant — each reaches pages the others cannot, and the split is
measured, not aesthetic:

| | Crawl4AI | Scrapling | Camoufox |
| --- | --- | --- | --- |
| Browser | Chromium | Patchright Chromium | **Firefox** |
| Egress | this host's IP only¹ | rotating **US** residential | rotating **Italian** residential |
| JS challenges | no | yes (`solve`) | n/a (coherent fingerprint) |
| LinkedIn profiles | decays to 0/6, HTTP 999 | 94% (34/36) | — |
| Trustpilot reviews | luck-of-the-IP | 2/2 via challenge solve | — |
| Italian bot-gated sites | blocked | wrong country | **the point** |
| Binary / PDF fetch | — | — | yes (`web_bytes`) |
| Anti-bot sensor sessions | — | — | yes (`web_spa_fetch`) |
| Ordinary pages | ~2-5s | ~0.7-1.9s (`fast`) | ~8-12s |

Camoufox is Firefox on purpose: stealth-patched headless *Chrome* was flagged by
Akamai even through an Italian residential IP, while Camoufox's fingerprint is
internally coherent — its locale and timezone are derived from the exit IP, so
`web_eval` on an Italian site reports `Europe/Rome`. Italian sources either
bot-gate datacenter IPs outright or score the exit country as part of a sensor
decision, and a US residential exit is not a milder version of the right answer.

¹ Crawl4AI >= 0.9 treats every HTTP request body as `Provenance.UNTRUSTED` and
lists `proxy_config` in `UNTRUSTED_FORBIDDEN_FIELDS`, so passing a proxy is a
hard 400. It also pins Chromium to its own localhost egress proxy, so a
server-side proxy is overwritten. There is no supported way to give Crawl4AI a
proxy, which is why residential egress lives in Scrapling.

### Fetch strategy

Callers never choose an engine. `web_fetch` and `web_html` take a URL; how to
reach it is decided internally, in three tiers:

| Tier | Egress | Chosen when |
| --- | --- | --- |
| `fast` | direct, no challenge solving | the default |
| `stealth` | rotating residential proxy | host is known to wall datacenter IPs (LinkedIn's HTTP 999) |
| `solve` | direct, solves the JS challenge | the `fast` response looks like a challenge page |

`fast` is the default rather than `solve` even though `solve` is functionally a
superset: solving roughly doubles latency on ordinary pages, and on a challenge
it *cannot* solve it blocks for the whole timeout instead of failing fast. So
solving is paid for only on evidence — a small body carrying a known
interstitial title with a 403/429/503 gets retried once in `solve`, and the
response reports `escalated: true`.

So: **Scrapling fetches, Crawl4AI renders and does the browser work.**
`web_fetch` and `web_html` fetch through Scrapling; `web_fetch` then renders
that HTML to markdown through Crawl4AI's markdown pipeline (via its `raw://`
input) so the `f` filter keeps working. `web_crawl`, `web_execute_js`,
`web_screenshot` and `web_pdf` stay on Crawl4AI. If Scrapling is unreachable,
`web_fetch` falls back to fetching through Crawl4AI directly.

The project is structured as a **monorepo** with three packages:

- **`packages/toolkit`** — Core business logic: Zod schemas, tool definitions, SearXNG/Crawl4AI/Wayback clients. Framework-agnostic.
- **`packages/api`** — Express HTTP server exposing MCP (`POST /mcp`) and REST (`POST /api/v0/{tool_name}`) endpoints.
- **`packages/cli`** — Commander.js CLI for terminal usage.

The full stack deploys as **6 services**: Redis, SearXNG, Crawl4AI, Scrapling, Camoufox, and the Web Tools server.

## Tools

The server exposes fourteen tools:

### `web_search`

Lightweight web search via SearXNG with parallel request strategy for reliability.

| Parameter | Type              | Description                                  |
| --------- | ----------------- | -------------------------------------------- |
| `query`   | string (required) | The search query                             |
| `limit`   | number (optional) | Max results to return (default: 10, max: 20) |
| `engines` | string (optional) | Comma-separated engines (e.g. "google,brave") |

Returns a JSON array of `{ url, title, description }` results.

### `web_fetch`

Fetch a single URL and return its content as clean markdown. Fetched via
Scrapling, rendered to markdown by Crawl4AI.

| Parameter | Type              | Description                                                              |
| --------- | ----------------- | ------------------------------------------------------------------------ |
| `url`     | string (required) | URL to fetch                                                             |
| `f`       | enum (optional)   | Content-filter strategy: `raw`, `fit`, `bm25`, or `llm` (default: `fit`) |
| `q`       | string (optional) | Query string for BM25/LLM filters                                        |
| `delay`   | number (optional) | Seconds to settle before extraction (default: 2)                         |

Returns the page content as markdown.

**There is no engine or mode parameter.** Which fetcher runs, whether it goes
out through the residential proxy, and whether it solves a JS challenge are all
decided under the hood — see [Fetch strategy](#fetch-strategy).

### `web_html`

Fetch a URL and return the raw HTML as served, plus the upstream status. Use
this rather than `web_fetch` when you need markup that markdown conversion
destroys — JSON-LD, meta tags, attributes.

| Parameter      | Type              | Description                                             |
| -------------- | ----------------- | ------------------------------------------------------- |
| `url`          | string (required) | URL to fetch                                            |
| `network_idle` | boolean (optional)| Wait for the network to go quiet (default: false)        |
| `timeout_ms`   | number (optional) | Upstream fetch timeout (default: 60000)                 |

Returns a JSON object: `{ status, url, mode, escalated, size, html }`. A
non-2xx upstream status is reported in `status` rather than raised as an error,
so callers can branch on 999 vs 404 themselves.

### `web_screenshot`

Capture a full-page PNG screenshot of a URL via Crawl4AI.

| Parameter             | Type              | Description                                 |
| --------------------- | ----------------- | ------------------------------------------- |
| `url`                 | string (required) | URL to screenshot                           |
| `screenshot_wait_for` | number (optional) | Seconds to wait before capture (default: 2) |

Returns a base64-encoded PNG image.

### `web_pdf`

Generate a PDF document of a URL via Crawl4AI.

| Parameter | Type              | Description           |
| --------- | ----------------- | --------------------- |
| `url`     | string (required) | URL to convert to PDF |

Returns a base64-encoded PDF.

### `web_execute_js`

Execute JavaScript snippets on a URL via Crawl4AI and return the full crawl result.

| Parameter | Type                | Description                                     |
| --------- | ------------------- | ----------------------------------------------- |
| `url`     | string (required)   | URL to execute scripts on                       |
| `scripts` | string[] (required) | List of JavaScript snippets to execute in order |

Returns the full CrawlResult JSON including markdown, links, media, and JS execution results.

### `web_crawl`

Crawl one or more URLs and extract their content using Crawl4AI.

| Parameter        | Type                | Description                    |
| ---------------- | ------------------- | ------------------------------ |
| `urls`           | string[] (required) | List of URLs to crawl          |
| `browser_config` | object (optional)   | Crawl4AI browser configuration |
| `crawler_config` | object (optional)   | Crawl4AI crawler configuration |

Returns the extracted content from each URL.

### `web_snapshots`

List Wayback Machine snapshots for a URL.

| Parameter    | Type                | Description                                                             |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| `url`        | string (required)   | URL to check for snapshots                                              |
| `from`       | string (optional)   | Start date in YYYYMMDD format                                           |
| `to`         | string (optional)   | End date in YYYYMMDD format                                             |
| `limit`      | number (optional)   | Max number of snapshots to return (default: 100)                        |
| `match_type` | enum (optional)     | URL matching: `exact`, `prefix`, `host`, or `domain` (default: `exact`) |
| `filter`     | string[] (optional) | CDX API filters (e.g. `["statuscode:200", "mimetype:text/html"]`)       |

Returns a JSON array of snapshots with timestamps, status codes, and archive URLs.

### `web_archive`

Retrieve an archived page from the Wayback Machine.

| Parameter   | Type               | Description                                                          |
| ----------- | ------------------ | -------------------------------------------------------------------- |
| `url`       | string (required)  | URL of the page to retrieve                                          |
| `timestamp` | string (required)  | Timestamp in YYYYMMDDHHMMSS format                                   |
| `original`  | boolean (optional) | Get original content without Wayback Machine banner (default: false) |

Returns the archived page content.

## Interfaces

### MCP

All MCP-compatible clients can connect via HTTP:

#### Claude Code (CLI)

```bash
claude mcp add web_tools \
  --transport http \
  https://your-server.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```

#### Project-level config (`.mcp.json`)

```json
{
  "mcpServers": {
    "web_tools": {
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
    "web_tools": {
      "type": "http",
      "url": "https://your-server.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### REST API

Every tool is also available as a REST endpoint:

```bash
# Discovery — list all tools
curl https://your-server.up.railway.app/api/v0 \
  -H "Authorization: Bearer your-api-key"

# Search
curl -X POST https://your-server.up.railway.app/api/v0/web_search \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"query": "railway deployment"}'

# Fetch
curl -X POST https://your-server.up.railway.app/api/v0/web_fetch \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### CLI

```bash
# Search
web-tools search "railway deployment" --limit 5

# Fetch page as markdown
web-tools fetch https://example.com

# Screenshot
web-tools screenshot https://example.com

# Crawl multiple URLs
web-tools crawl https://a.com https://b.com --magic

# Wayback Machine
web-tools snapshots https://example.com --from 20200101
web-tools archive https://example.com --timestamp 20200101120000
```

### Replace Claude Code's Built-in Web Search & Web Fetch (Optional)

**1. Add the MCP server globally:**

```bash
claude mcp add web_tools --scope user \
  --transport http \
  https://your-server.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```

**2. Disable the built-in tools** by editing `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["WebSearch", "WebFetch"]
  }
}
```

**3. Guide Claude via `~/.claude/CLAUDE.md`** so it uses your tools:

```markdown
## Search & Fetch

- Use the web_search MCP tool for all web searches
- Use the web_fetch MCP tool to fetch and read web pages
- Do not attempt to use the built-in WebSearch or WebFetch tools
```

## Deployment (Railway)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/web-tools?referralCode=zMTz_F&utm_medium=integration&utm_source=template&utm_campaign=generic)

- Click **Deploy on Railway**: you'll see all 4 services listed (Redis, SearXNG, Crawl4AI, Web Tools Server)
- Click **Deploy**: Railway provisions everything and wires the services together automatically
- An `API_KEY` is **auto-generated** during deployment. Find it in your Web Tools service's **Variables** tab and use it as your Bearer token

### Railway Configuration

The **Web Tools Server** service uses the root `Dockerfile` — no config changes needed.

The **SearXNG** and **Scrapling** services build from the repo instead of a Docker
image, and each one **must** have its Root Directory set:

| Service | Root Directory | Env |
| --- | --- | --- |
| SearXNG | `services/searxng` | `PROXY_URL` (optional) — proxy for outgoing search requests |
| Scrapling | `services/scrapling` | `PROXY_URL` (US-geo, for the residential path), `PORT=8000` |
| Camoufox | `services/camoufox` | `PROXY_URL` (**IT-geo**), `PORT=8000`, `WORKERS=1` |

> Camoufox keeps `WORKERS=1` — one warmed anti-bot session per container, which
> cannot be shared across processes. Scale it with **replicas**, not workers:
> `railway service scale --service camoufox eu-west=2`. Keep it in EU West; a US
> container reaches an Italian exit and an Italian target across the Atlantic
> twice. Note `scale` ADDS to existing regions, so pass `us-east=0` to move
> rather than spread.

> **Set Root Directory before connecting the repo.** Railway resolves a service's
> build config by walking up from its Root Directory, so a subfolder service
> without one inherits the repo root's `Dockerfile` — which is the Node server.
> The symptom is confusing: the build goes green, then the container crashes on
> `ZodError: API_KEY Required`, because it is running the API server instead of
> the sidecar. It also repeats on every push, so a service deployed correctly by
> hand will replace itself with the API server the next time the repo changes.
>
> `railway up` cannot fix this — it uploads the right files but leaves the stored
> config pointing at `/`. Root Directory is not exposed by the CLI either; set it
> in the dashboard, or via the public API:
>
> ```bash
> curl https://backboard.railway.com/graphql/v2 \
>   -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
>   -d '{"query":"mutation($s:String!,$e:String,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}",
>        "variables":{"s":"<serviceId>","e":"<environmentId>",
>        "i":{"rootDirectory":"/services/scrapling",
>             "dockerfilePath":"/services/scrapling/Dockerfile",
>             "watchPatterns":["/services/scrapling/**"]}}}'
> ```
>
> Do not pass `builder` — the `Builder` enum has no `DOCKERFILE` value (only
> HEROKU/NIXPACKS/PAKETO/RAILPACK) and the whole mutation fails with a generic
> "Problem processing request". Railway detects the Dockerfile from the path.
>
> The anchored `watchPatterns` is worth setting too: without it every push to the
> repo rebuilds the sidecar, including pushes that do not touch it.

Point the server at its siblings with **reference variables** rather than
hardcoded hostnames, so renaming or moving a service does not silently break
private networking:

```
CRAWL4AI_URL       = http://${{Crawl4AI.RAILWAY_PRIVATE_DOMAIN}}:${{Crawl4AI.PORT}}
CRAWL4AI_API_TOKEN = ${{Crawl4AI.CRAWL4AI_API_TOKEN}}
SCRAPLING_URL      = http://${{Scrapling.RAILWAY_PRIVATE_DOMAIN}}:${{Scrapling.PORT}}
CAMOUFOX_URL       = http://${{camoufox.RAILWAY_PRIVATE_DOMAIN}}:${{camoufox.PORT}}
SEARXNG_URL        = http://${{SearXNG.RAILWAY_PRIVATE_DOMAIN}}:8080
```

## Quick Start (Local)

### 1. Clone and install

```bash
git clone https://github.com/arnaudjnn/web-tools
cd web-tools
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

### 3. Point the server at the backing services

There is no local compose stack. The four backing services are heavy — two of them
bake a browser into their image, and the residential paths are useless without a
proxy credential — so running them locally costs a long build to reproduce
something the deployment already has. Run the server locally against the deployed
services instead:

```bash
API_KEY=any-local-value \
SEARXNG_URL=https://searxng-production-xxxx.up.railway.app \
CRAWL4AI_URL=https://crawl4ai-production-xxxx.up.railway.app \
CRAWL4AI_API_TOKEN=... \
SCRAPLING_URL=https://your-scrapling.up.railway.app \
CAMOUFOX_URL=https://your-camoufox.up.railway.app \
pnpm run start
```

The server is available at `http://localhost:3000`. `API_KEY` is required but is
whatever you want locally — it only guards your own endpoint.

Every URL is optional and degrades rather than fails: with `SEARXNG_URL` alone you
get `web_search`; with `CRAWL4AI_URL` you get `web_crawl` / `web_screenshot` /
`web_pdf` and markdown rendering. `web_fetch` and `web_html` fall back to Crawl4AI
when the stealth sidecars are unreachable, so a partial local setup still answers.

To run a single sidecar locally, build it directly — each is self-contained:

```bash
docker build -t scrapling services/scrapling && \
  docker run -p 8000:8000 -e PROXY_URL=... scrapling
```

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `API_KEY` | Yes | Bearer token for authentication (auto-generated on Railway) |
| `SEARXNG_URL` | No | SearXNG URL (default: `http://searxng.railway.internal:8080`) |
| `CRAWL4AI_URL` | No | Crawl4AI URL (default: `http://crawl4ai.railway.internal:11235`) |
| `CRAWL4AI_API_TOKEN` | No | API token for Crawl4AI authentication |
| `SCRAPLING_URL` | No | Scrapling URL (default: `http://scrapling.railway.internal:8000`) |
| `SEARXNG_ENGINES` | No | Default engines (e.g. `"brave,bing"`) |
| `PROXY_URL` | No | Rotating residential proxy. Set on the **SearXNG** and **Scrapling** services, not the server. Required for `mode=stealth`. |

## Authentication

The `API_KEY` environment variable is **required**.

On Railway, the key is auto-generated at deploy time (via `${{secret()}}`). For local development, set it in your `.env.local` file.

Clients provide the key as a `Bearer` token in the `Authorization` header or as an `?api_key=` query parameter. The `/health` endpoint is unauthenticated.

## License

MIT
