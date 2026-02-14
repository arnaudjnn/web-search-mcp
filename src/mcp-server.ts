import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { z } from 'zod';

import { Config } from './config.js';
import { callCrawlTool, callMdTool, callScreenshotTool, callPdfTool, callExecuteJsTool } from './crawl4ai.js';
import { searchSearXNG } from './searxng.js';
import { getSnapshots, getArchivedPage } from './wayback.js';

// Helper function to log to stderr
const log = (...args: any[]) => {
  process.stderr.write(
    args
      .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ') + '\n',
  );
};

// Function to create and configure a new server instance for each request
function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'web-search',
      version: '1.0.0',
    },
    { capabilities: { logging: {} } },
  );

  // Web search tool — lightweight, no LLM needed
  server.tool(
    'web-search',
    'Search the web via SearXNG and return results.',
    {
      query: z.string().min(1).describe('The search query'),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe('Max number of results (default: 10)'),
    },
    async ({ query, limit }) => {
      try {
        const results = await searchSearXNG(query, { limit: limit ?? 10 });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results.data, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Web-fetch tool — proxy to Crawl4AI md tool
  server.tool(
    'web-fetch',
    'Fetch a URL and return its content as clean markdown via Crawl4AI',
    {
      url: z.string().url().describe('URL to fetch'),
      f: z
        .enum(['raw', 'fit', 'bm25', 'llm'])
        .optional()
        .describe('Content-filter strategy (default: fit)'),
      q: z.string().optional().describe('Query string for BM25/LLM filters'),
    },
    async args => {
      try {
        const result = await callMdTool(args);
        return result as { content: { type: 'text'; text: string }[] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Fetch error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Screenshot tool — proxy to Crawl4AI screenshot tool
  server.tool(
    'web-screenshot',
    'Capture a full-page PNG screenshot of a URL via Crawl4AI',
    {
      url: z.string().url().describe('URL to screenshot'),
      screenshot_wait_for: z.number().optional().describe('Seconds to wait before capture (default: 2)'),
    },
    async (args) => {
      try {
        const result = await callScreenshotTool(args);
        return result as { content: { type: "text"; text: string }[] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Screenshot error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // PDF tool — proxy to Crawl4AI pdf tool
  server.tool(
    'web-pdf',
    'Generate a PDF document of a URL via Crawl4AI',
    {
      url: z.string().url().describe('URL to convert to PDF'),
    },
    async (args) => {
      try {
        const result = await callPdfTool(args);
        return result as { content: { type: "text"; text: string }[] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `PDF error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Execute JS tool — proxy to Crawl4AI execute_js tool
  server.tool(
    'web-execute-js',
    'Execute JavaScript snippets on a URL via Crawl4AI and return the crawl result',
    {
      url: z.string().url().describe('URL to execute scripts on'),
      scripts: z.array(z.string()).min(1).describe('List of JavaScript snippets to execute in order'),
    },
    async (args) => {
      try {
        const result = await callExecuteJsTool(args);
        return result as { content: { type: "text"; text: string }[] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Execute JS error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Crawl tool — proxy to Crawl4AI MCP server
  server.tool(
    'web-crawl',
    'Crawl one or more URLs and extract their content using Crawl4AI',
    {
      urls: z.array(z.string().url()).min(1).describe('List of URLs to crawl'),
      browser_config: z
        .record(z.unknown())
        .optional()
        .describe('Optional Crawl4AI browser configuration'),
      crawler_config: z
        .record(z.unknown())
        .optional()
        .describe('Optional Crawl4AI crawler configuration'),
    },
    async args => {
      try {
        const result = await callCrawlTool(args);
        return result as { content: { type: 'text'; text: string }[] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Crawl error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Snapshots tool — Wayback Machine CDX API
  server.tool(
    'web-snapshots',
    'List Wayback Machine snapshots for a URL',
    {
      url: z.string().describe('URL to check for snapshots'),
      from: z.string().optional().describe('Start date in YYYYMMDD format'),
      to: z.string().optional().describe('End date in YYYYMMDD format'),
      limit: z.number().optional().describe('Max number of snapshots to return (default: 100)'),
      match_type: z.enum(['exact', 'prefix', 'host', 'domain']).optional().describe('URL matching strategy (default: exact)'),
    },
    async ({ url, from, to, limit, match_type }) => {
      try {
        const snapshots = await getSnapshots({ url, from, to, limit, matchType: match_type });
        if (snapshots.length === 0) {
          return { content: [{ type: 'text', text: `No snapshots found for URL: ${url}` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(snapshots, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Snapshots error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // Archive tool — Wayback Machine page retrieval
  server.tool(
    'web-archive',
    'Retrieve an archived page from the Wayback Machine',
    {
      url: z.string().describe('URL of the page to retrieve'),
      timestamp: z.string().describe('Timestamp in YYYYMMDDHHMMSS format'),
      original: z.boolean().optional().describe('Get original content without Wayback Machine banner (default: false)'),
    },
    async ({ url, timestamp, original }) => {
      try {
        const { waybackUrl, content } = await getArchivedPage({ url, timestamp, original });
        const MAX_LENGTH = 50000;
        const truncated = content.length > MAX_LENGTH;
        const text = `Wayback URL: ${waybackUrl}\nContent length: ${content.length} characters\n\n${truncated ? content.substring(0, MAX_LENGTH) + '\n\n[Content truncated]' : content}`;
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Archive error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// Log environment check
log('Environment check:', {
  searxngUrl: Config.searxng.url,
});

const app = express();
app.use(express.json());

// API key auth middleware — skips /health
app.use((req: Request, res: Response, next) => {
  if (req.path === '/health') return next();

  const provided =
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    (req.query.api_key as string);

  if (provided !== Config.apiKey) {
    res.status(403).json({
      error: 'forbidden',
      error_description: 'Invalid or missing API key',
    });
    return;
  }

  next();
});

app.post('/mcp', async (req: Request, res: Response) => {
  const server = createServer();
  try {
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('close', () => {
      log('Request closed');
      transport.close();
      server.close();
    });
  } catch (error) {
    log('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    }),
  );
});

app.delete('/mcp', async (req: Request, res: Response) => {
  log('Received DELETE MCP request');
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    }),
  );
});

// Start the server
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  log('Shutting down server...');
  process.exit(0);
});
