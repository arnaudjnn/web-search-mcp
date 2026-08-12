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

async function call(name: string, args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name, arguments: args });
  } catch (err) {
    client = null;
    connecting = null;
    throw err;
  }
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
): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (Config.crawl4ai.apiToken) {
    headers['Authorization'] = `Bearer ${Config.crawl4ai.apiToken}`;
  }

  const response = await fetch(new URL('/md', Config.crawl4ai.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: `raw://${html}`,
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
