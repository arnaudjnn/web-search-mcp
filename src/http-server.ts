import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { Config } from './config.js';
import { deepResearch, writeFinalReport } from './deep-research.js';
import { getModel } from './ai/providers.js';

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
    name: 'deep-research',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  // Define the deep research tool
  server.tool(
    'deep-research',
    'Perform deep research on a topic using AI-powered web search',
    {
      query: z.string().min(1).describe("The research query to investigate"),
      depth: z.number().min(1).max(5).describe("How deep to go in the research tree (1-5)"),
      breadth: z.number().min(1).max(5).describe("How broad to make each research level (1-5)"),
      model: z.string().optional().describe('Model specifier, e.g. "openai:gpt-5"'),
      tokenBudget: z.number().optional().describe('Optional soft cap for total research-phase tokens; final report not counted'),
      sourcePreferences: z.string().optional().describe('Natural-language preferences for sources to avoid (e.g., "avoid SEO top 10 listicles, forums, affiliate reviews")')
    },
      async ({ query, depth, breadth, model: modelSpec, tokenBudget, sourcePreferences }, { sendNotification }) => {
      try {
        let currentProgress = '';

        const model = getModel(modelSpec);
        const result = await deepResearch({
          query,
          depth,
          breadth,
          model,
          tokenBudget,
          sourcePreferences,
          onProgress: async progress => {
            const progressMsg = `Depth ${progress.currentDepth}/${progress.totalDepth}, Query ${progress.completedQueries}/${progress.totalQueries}: ${progress.currentQuery || ''}`;
            if (progressMsg !== currentProgress) {
              currentProgress = progressMsg;
              log(progressMsg);

              try {
                await sendNotification({
                  method: 'notifications/message',
                  params: {
                    level: 'info',
                    data: progressMsg,
                  },
                });
              } catch (error) {
                log('Error sending progress notification:', error);
              }
            }
          },
        });

        const report = await writeFinalReport({
          prompt: query,
          learnings: result.learnings,
          visitedUrls: result.visitedUrls,
          sourceMetadata: result.sourceMetadata,
          model
        });

        return {
          content: [
            {
              type: 'text',
              text: report,
            },
          ],
          metadata: {
            learnings: result.learnings,
            visitedUrls: result.visitedUrls,
            stats: {
              totalLearnings: result.learnings.length,
              totalSources: result.visitedUrls.length,
              averageReliability: result.weightedLearnings.length > 0
                ? result.weightedLearnings.reduce((acc, curr) => acc + curr.reliability, 0) / result.weightedLearnings.length
                : 0
            },
          },
        };
      } catch (error) {
        log(
          'Error in deep research:',
          error instanceof Error ? error.message : String(error),
        );
        return {
          content: [
            {
              type: 'text',
              text: `Error performing research: ${error instanceof Error ? error.message : String(error)}`,
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
  hasOpenAiKey: !!Config.openai.apiKey,
  searxngUrl: Config.searxng.url,
  concurrency: Config.concurrency,
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
  log(`Deep Research MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  log('Shutting down server...');
  process.exit(0);
}); 