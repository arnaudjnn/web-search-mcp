import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { Config } from './config.js';
import { searchSearXNG } from './searxng.js';
import { callCrawlTool } from './crawl4ai.js';

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
  const server = new McpServer({
    name: 'web-search',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  // Web search tool — lightweight, no LLM needed
  server.tool(
    'web-search',
    'Search the web via SearXNG and return results. No LLM API key required.',
    {
      query: z.string().min(1).describe('The search query'),
      limit: z.number().min(1).max(20).optional().describe('Max number of results (default: 10)'),
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

  // Crawl tool — proxy to Crawl4AI MCP server
  server.tool(
    'crawl',
    'Crawl one or more URLs and extract their content using Crawl4AI',
    {
      urls: z.array(z.string().url()).min(1).describe('List of URLs to crawl'),
      browser_config: z.record(z.unknown()).optional().describe('Optional Crawl4AI browser configuration'),
      crawler_config: z.record(z.unknown()).optional().describe('Optional Crawl4AI crawler configuration'),
    },
    async (args) => {
      try {
        const result = await callCrawlTool(args);
        return result as { content: { type: "text"; text: string }[] };
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

  const apiKey = Config.apiKey;
  if (!apiKey) return next(); // no key configured = open access

  const provided =
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    (req.query.api_key as string);

  if (provided !== apiKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: invalid or missing API key' },
      id: null,
    });
    return;
  }

  next();
});

app.post('/mcp', async (req: Request, res: Response) => {
  const server = createServer();
  try {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
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
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

app.delete('/mcp', async (req: Request, res: Response) => {
  log('Received DELETE MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
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
