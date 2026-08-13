import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Config } from './config.js';

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const url = new URL('/mcp/sse', Config.crawl4ai.url);
    const headers: Record<string, string> = {};
    if (Config.crawl4ai.apiToken) {
      headers['Authorization'] = `Bearer ${Config.crawl4ai.apiToken}`;
    }

    const transport = new SSEClientTransport(url, {
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }) },
      requestInit: { headers },
    });

    const c = new Client({ name: 'web_tools_crawl4ai_proxy', version: '1.0.0' });

    transport.onerror = (err) => {
      process.stderr.write(`Crawl4AI transport error: ${err.message}\n`);
      client = null;
      connecting = null;
    };

    transport.onclose = () => {
      client = null;
      connecting = null;
    };

    await c.connect(transport);
    client = c;
    connecting = null;
    return c;
  })();

  return connecting;
}

/**
 * Crawl4AI's opaque 5xx envelope: `{"error": 500, "detail": "…correlation_id…"}`.
 *
 * This is the ONLY thing a client sees when a crawl fails server-side. Crawl4AI
 * deliberately withholds the cause and logs it on its own side, so the useful
 * detail (a dead pooled browser, or an anti-bot 403 it reports as a 500) never
 * reaches us.
 *
 * A previous version of this matched on "Target page, context or browser has been
 * closed" and could therefore never fire: that text only ever exists in
 * Crawl4AI's log. Detect the envelope instead, and treat it as "retry once,
 * after clearing the pool".
 *
 * Both underlying causes are worth one retry. A dead browser is fixed by eviction
 * (its pool caches browsers by config signature and never checks liveness, so it
 * will hand out a closed one indefinitely). A transient anti-bot 403 is fixed by
 * simply trying again, which was measured succeeding 4/4 after a single failure.
 */
function isOpaqueServerError(text: string): boolean {
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === 'number' && parsed.error >= 500;
  } catch {
    return false;
  }
}

let recovering: Promise<void> | null = null;

/**
 * Evict dead browsers from Crawl4AI's pool.
 *
 * This is NOT the old rotation module coming back. That one killed healthy
 * browsers hoping to land a new proxy exit IP, which stopped making sense the
 * moment Crawl4AI refused proxies — killing a browser cannot change an egress IP
 * it does not control. This kills a browser we have positive evidence is closed,
 * so the next call is forced to build a live one. Different signal, different
 * purpose.
 *
 * Debounced: concurrent failures share one recovery rather than each killing the
 * pool out from under the others.
 */
async function evictDeadBrowsers(): Promise<void> {
  if (recovering) return recovering;
  recovering = (async () => {
    const headers: Record<string, string> = {};
    if (Config.crawl4ai.apiToken) headers['Authorization'] = `Bearer ${Config.crawl4ai.apiToken}`;
    try {
      const listRes = await fetch(new URL('/monitor/browsers', Config.crawl4ai.url), {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!listRes.ok) return;
      const data = (await listRes.json()) as { browsers?: Array<{ sig: string; killable: boolean }> };
      const killable = (data.browsers ?? []).filter((b) => b.killable);
      for (const b of killable) {
        await fetch(new URL('/monitor/actions/kill_browser', Config.crawl4ai.url), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sig: b.sig }),
          signal: AbortSignal.timeout(15_000),
        }).catch(() => {});
      }
      if (killable.length) {
        process.stderr.write(
          `[crawl4ai] evicted ${killable.length} dead browser(s) from the pool; retrying\n`,
        );
      }
    } catch {
      // Recovery is best-effort: if the monitor endpoint is unreachable there is
      // nothing useful to do, and the original error is the one worth reporting.
    } finally {
      recovering = null;
    }
  })();
  return recovering;
}

async function call(name: string, args: Record<string, unknown>) {
  const invoke = async () => {
    const c = await getClient();
    try {
      return await c.callTool({ name, arguments: args });
    } catch (err) {
      client = null;
      connecting = null;
      throw err;
    }
  };

  const result = (await invoke()) as { content?: Array<{ text?: string }> };

  // A server-side failure arrives as a SUCCESSFUL tool call whose text is the
  // opaque envelope, so it has to be sniffed from the payload rather than caught.
  const text = result?.content?.[0]?.text ?? '';
  if (!isOpaqueServerError(text)) return result;

  process.stderr.write(`[crawl4ai] ${name}: server error, evicting pool and retrying once\n`);
  await evictDeadBrowsers();
  return invoke();
}

/**
 * Give a `raw://` document the origin it lost.
 *
 * Crawl4AI resolves relative hrefs against the URL it fetched, but a raw:// body
 * was not fetched from anywhere, so it has no base and every relative link is
 * emitted verbatim: `](/users/abc)` instead of
 * `](https://www.trustpilot.com/users/abc)`. That silently degrades every page we
 * fetch through Scrapling and render here — measured on a Trustpilot review page,
 * 24 author links came out relative and unusable, which read to the caller as a
 * page with no reviews on it at all.
 *
 * CrawlerRunConfig.base_url would be the direct fix, but it is one of the fields
 * Crawl4AI >= 0.9 forbids from a request body. A `<base href>` in the document
 * gets the same job done and travels with the HTML.
 */
function withBaseHref(html: string, sourceUrl?: string): string {
  if (!sourceUrl) return html;
  // Respect a base the page already declares — overriding it would break links
  // the site deliberately rebased.
  if (/<base\s[^>]*href=/i.test(html)) return html;

  let origin: string;
  try {
    origin = new URL(sourceUrl).origin + '/';
  } catch {
    return html;
  }

  const tag = `<base href="${origin}">`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/**
 * Render HTML to markdown via Crawl4AI's REST `/md` endpoint and its `raw://`
 * input scheme (no network I/O on its side).
 *
 * This deliberately does NOT go through the MCP client above. Pushing a large
 * document through the MCP SSE transport is pathologically slow — measured on a
 * 1.27MB Trustpilot page:
 *
 *   MCP `crawl` tool with raw://   ~100s
 *   REST /crawl     with raw://      3.7s
 *   REST /md        with raw://      0.8s
 *
 * so a two-hop fetch-then-render web_fetch took 110s over MCP and ~9s here. /md
 * also takes the `f` filter (raw/fit/bm25/llm) natively, which is exactly
 * web_fetch's contract.
 */
export async function renderMarkdown(
  html: string,
  filter: string,
  query?: string,
  sourceUrl?: string,
): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (Config.crawl4ai.apiToken) {
    headers['Authorization'] = `Bearer ${Config.crawl4ai.apiToken}`;
  }

  const response = await fetch(new URL('/md', Config.crawl4ai.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: `raw://${withBaseHref(html, sourceUrl)}`,
      f: filter,
      ...(query ? { q: query } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Crawl4AI /md HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as { markdown?: string; success?: boolean };
  return data.markdown || null;
}



export const callCrawlTool = (args: Record<string, unknown>) => call('crawl', args);
export const callMdTool = (args: Record<string, unknown>) => call('md', args);
export const callScreenshotTool = (args: Record<string, unknown>) => call('screenshot', args);
export const callPdfTool = (args: Record<string, unknown>) => call('pdf', args);
export const callExecuteJsTool = (args: Record<string, unknown>) => call('execute_js', args);
