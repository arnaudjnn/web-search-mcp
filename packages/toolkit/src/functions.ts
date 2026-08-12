import { Config } from './config.js';
import {
  callCrawlTool,
  callExecuteJsTool,
  callMdTool,
  callPdfTool,
  callScreenshotTool,
} from './crawl4ai.js';
import { noteBlocked, noteSuccess } from './rotation.js';
import { searchSearXNG } from './searxng.js';
import { getStats, recordCall, type ToolName } from './stats.js';
import { getArchivedPage, getSnapshots } from './wayback.js';
import type { ToolResult } from './types.js';

// Regex matching upstream Crawl4AI failure modes that benefit from a
// browser rotation: explicit anti-bot signals (429, CF challenge) AND
// internal Crawl4AI errors that almost always trace back to a wedged
// browser context (BrowserContext closed, navigation timeout,
// "Unexpected error in _crawl_web"). When we see any of these we
// signal the rotation module to kill the hot browser — Crawl4AI
// spawns a fresh one with a fresh proxy connection on the next call.
const BLOCK_RE =
  /HTTP 429|Too Many Requests|Cloudflare JS challenge|anti-bot protection|Just a moment\.\.\.|Unexpected error in _crawl_web|BrowserContext\.new_page|Navigation timeout|Connection closed while reading from the driver/i;

// Count a tool invocation: bytes = size of the text payload we hand
// back to the caller. For Crawl4AI tools this is the rendered HTML or
// markdown, which closely tracks proxy bandwidth (what iProyal bills).
// Also feeds the rotation module: anti-bot signals in the returned
// payload count toward the consecutive-429 threshold that triggers a
// browser kill (and thus an upstream IP rotation).
function trace(tool: ToolName, result: ToolResult): ToolResult {
  const text = result.content?.[0]?.text ?? '';
  const blocked = BLOCK_RE.test(text);
  // Crawl4AI sometimes wraps upstream failures as 200-content with the
  // error JSON in the text and isError absent — count those as errors
  // too so /stats and the rotation counter see them.
  recordCall(tool, text.length, !!result.isError || blocked);
  if (blocked) noteBlocked();
  else if (text) noteSuccess();
  return result;
}
function traceJson(tool: ToolName, payload: unknown): void {
  recordCall(tool, JSON.stringify(payload).length, false);
}

const log = (...args: unknown[]) => {
  process.stderr.write(
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n',
  );
};

// ── Crawl4AI proxy wrapper ───────────────────────────────────────────

async function proxyCrawl4AI(
  toolName: string,
  fn: () => Promise<unknown>,
): Promise<ToolResult> {
  try {
    const resolved = (await fn()) as ToolResult;

    if (resolved?.isError) {
      const text =
        resolved.content?.[0]?.text ||
        JSON.stringify(resolved.content) ||
        '(no details returned)';
      log(`Crawl4AI ${toolName} error response:`, text);
      return {
        content: [{ type: 'text', text: `Crawl4AI ${toolName} error: ${text}` }],
        isError: true,
      };
    }

    if (
      !resolved?.content ||
      resolved.content.length === 0 ||
      resolved.content.every((c) => !c.text)
    ) {
      log(`Crawl4AI ${toolName} returned empty content`);
      return {
        content: [
          {
            type: 'text',
            text: `Crawl4AI ${toolName} returned empty content. The page may have no extractable text or the crawl may have timed out.`,
          },
        ],
        isError: true,
      };
    }

    return resolved;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Crawl4AI ${toolName} threw:`, msg);
    return {
      content: [{ type: 'text', text: `Crawl4AI ${toolName} error: ${msg}` }],
      isError: true,
    };
  }
}

// ── Tool handler functions ───────────────────────────────────────────

export async function web_search(params: {
  query: string;
  limit?: number;
  engines?: string;
}) {
  const results = await searchSearXNG(params.query, {
    limit: params.limit ?? 10,
    engines: params.engines,
  });
  traceJson('web_search', results.data);
  return results.data;
}

export async function web_fetch(params: Record<string, unknown>): Promise<ToolResult> {
  // The upstream Crawl4AI `md` MCP tool is unstable on this version
  // (BrowserContext.new_page: Connection closed while reading from the driver).
  // Route through the working `crawl` tool and extract markdown ourselves.
  const url = params.url as string | undefined;
  if (!url) {
    return {
      content: [{ type: 'text', text: 'web_fetch error: missing required `url`' }],
      isError: true,
    };
  }
  const filter = ((params.f as string | undefined) ?? 'fit').toLowerCase();

  // Recipe verified 5/5 against ufficiocamerale.it (Cloudflare-protected):
  // enable_stealth + wait_until:"load" + delay 15s + Italian residential proxy.
  // We deliberately do NOT enable magic/simulate_user/override_navigator —
  // those trigger Crawl4AI's pre-emptive CF detection and fingerprint as bot.
  const browserParams: Record<string, unknown> = { headless: true, enable_stealth: true };
  if (Config.proxy) {
    browserParams.proxy_config = {
      type: 'ProxyConfig',
      params: {
        server: Config.proxy.server,
        username: Config.proxy.username,
        password: Config.proxy.password,
      },
    };
  }

  // Optional Crawl4AI session_id — when callers pass the same id across
  // calls, Crawl4AI reuses the browser context, so the cf_clearance
  // cookie set on the first call carries over and subsequent calls skip
  // the JS challenge (~25s → ~3s).
  const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
  // Override delay_before_return_html — useful for "warm" calls in an
  // existing session where CF is already cleared.
  const delay =
    typeof params.delay === 'number' && Number.isFinite(params.delay) ? params.delay : 15;

  return proxyCrawl4AI('crawl', async () => {
    const resp = (await callCrawlTool({
      urls: [url],
      browser_config: { type: 'BrowserConfig', params: browserParams },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: {
          wait_until: 'load',
          page_timeout: 120000,
          delay_before_return_html: delay,
          ...(sessionId ? { session_id: sessionId } : {}),
        },
      },
    })) as ToolResult;

    const text = resp?.content?.[0]?.text;
    if (!text) return resp;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return resp;
    }
    const r = (parsed as { results?: Array<Record<string, unknown>> })?.results?.[0];
    if (!r) return resp;

    let md = '';
    const m = r.markdown as string | { raw_markdown?: string; fit_markdown?: string } | undefined;
    if (typeof m === 'string') {
      md = m;
    } else if (m && typeof m === 'object') {
      md =
        (filter === 'raw' ? m.raw_markdown : m.fit_markdown) || m.raw_markdown || m.fit_markdown || '';
    }
    if (!md) return resp;

    return {
      content: [{ type: 'text', text: md }],
      isError: !r.success,
    };
  }).then((r) => trace('web_fetch', r));
}

export async function web_screenshot(params: Record<string, unknown>): Promise<ToolResult> {
  return proxyCrawl4AI('screenshot', () => callScreenshotTool(params)).then((r) =>
    trace('web_screenshot', r),
  );
}

export async function web_pdf(params: Record<string, unknown>): Promise<ToolResult> {
  return proxyCrawl4AI('pdf', () => callPdfTool(params)).then((r) => trace('web_pdf', r));
}

export async function web_execute_js(params: Record<string, unknown>): Promise<ToolResult> {
  return proxyCrawl4AI('execute_js', () => callExecuteJsTool(params)).then((r) =>
    trace('web_execute_js', r),
  );
}

export async function web_crawl(params: Record<string, unknown>): Promise<ToolResult> {
  // Default sensible browser config (enable_stealth + residential proxy) when
  // the caller didn't set their own. Keeps web_crawl symmetric with web_fetch.
  const bc = (params.browser_config as { params?: Record<string, unknown> } | undefined) ?? {};
  const bcParams = bc.params ?? {};
  const needProxy = Config.proxy && !bcParams.proxy_config;
  const needStealth = bcParams.enable_stealth === undefined;
  if (needProxy || needStealth) {
    params = {
      ...params,
      browser_config: {
        type: 'BrowserConfig',
        params: {
          headless: true,
          enable_stealth: true,
          ...bcParams,
          ...(needProxy
            ? {
                proxy_config: {
                  type: 'ProxyConfig',
                  params: {
                    server: Config.proxy!.server,
                    username: Config.proxy!.username,
                    password: Config.proxy!.password,
                  },
                },
              }
            : {}),
        },
      },
    };
  }
  return proxyCrawl4AI('crawl', () => callCrawlTool(params)).then((r) =>
    trace('web_crawl', r),
  );
}

export async function web_snapshots(params: {
  url: string;
  from?: string;
  to?: string;
  limit?: number;
  match_type?: 'exact' | 'prefix' | 'host' | 'domain';
  filter?: string[];
}) {
  const snapshots = await getSnapshots({
    url: params.url,
    from: params.from,
    to: params.to,
    limit: params.limit,
    matchType: params.match_type,
    filter: params.filter,
  });
  traceJson('web_snapshots', snapshots);
  return snapshots;
}

export async function web_archive(params: {
  url: string;
  timestamp: string;
  original?: boolean;
}) {
  const { waybackUrl, content } = await getArchivedPage(params);
  const MAX_LENGTH = 50000;
  const truncated = content.length > MAX_LENGTH;
  const out = {
    waybackUrl,
    contentLength: content.length,
    content: truncated
      ? content.substring(0, MAX_LENGTH) + '\n\n[Content truncated]'
      : content,
  };
  traceJson('web_archive', out);
  return out;
}

// Process-local cost/usage counters. See stats.ts.
export async function web_usage_stats(_params: Record<string, unknown>) {
  return getStats();
}

// ── Function map ─────────────────────────────────────────────────────

export const functionMap: Record<string, (params: any) => Promise<any>> = {
  web_search,
  web_fetch,
  web_screenshot,
  web_pdf,
  web_execute_js,
  web_crawl,
  web_snapshots,
  web_archive,
  web_usage_stats,
};
