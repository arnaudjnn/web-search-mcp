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

    const c = new Client({ name: 'web_search_crawl4ai_proxy', version: '1.0.0' });

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

export async function callCrawlTool(args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name: 'crawl', arguments: args });
  } catch (err) {
    // Reset on failure so next call reconnects
    client = null;
    connecting = null;
    throw err;
  }
}

export async function callMdTool(args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name: 'md', arguments: args });
  } catch (err) {
    client = null;
    connecting = null;
    throw err;
  }
}

export async function callScreenshotTool(args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name: 'screenshot', arguments: args });
  } catch (err) {
    client = null;
    connecting = null;
    throw err;
  }
}

export async function callPdfTool(args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name: 'pdf', arguments: args });
  } catch (err) {
    client = null;
    connecting = null;
    throw err;
  }
}

export async function callExecuteJsTool(args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name: 'execute_js', arguments: args });
  } catch (err) {
    client = null;
    connecting = null;
    throw err;
  }
}
