import {
  callCrawlTool,
  callExecuteJsTool,
  callMdTool,
  callPdfTool,
  callScreenshotTool,
} from './crawl4ai.js';
import { searchSearXNG } from './searxng.js';
import { getStats, recordCall, type ToolName } from './stats.js';
import { getArchivedPage, getSnapshots } from './wayback.js';
import type { ToolResult } from './types.js';

// Upstream failure modes worth counting as errors in /stats even when
// Crawl4AI reports them as a 200 with the error JSON in the body: explicit
// anti-bot signals (429, CF challenge) and internal errors that trace back to
// a wedged browser context. Note Crawl4AI >= 0.9 also surfaces a plain
// anti-bot 403 as an opaque HTTP 500 + correlation id, so a 500 from it is not
// necessarily a server fault.
const BLOCK_RE =
  /HTTP 429|Too Many Requests|Cloudflare JS challenge|anti-bot protection|Just a moment\.\.\.|Unexpected error in _crawl_web|BrowserContext\.new_page|Navigation timeout|Connection closed while reading from the driver/i;

// Count a tool invocation: bytes = size of the text payload we hand back to
// the caller. There is deliberately no browser-rotation hook here any more.
// The old rotation module killed Crawl4AI's hot browser on N consecutive
// blocks so the next call would re-dial the residential proxy and land on a
// fresh exit IP. Crawl4AI >= 0.9 rejects proxy_config outright, so there is no
// proxy connection to re-dial: killing browsers could not change our egress IP,
// it only churned the pool on every LinkedIn 999.
function trace(tool: ToolName, result: ToolResult): ToolResult {
  const text = result.content?.[0]?.text ?? '';
  const blocked = BLOCK_RE.test(text);
  recordCall(tool, text.length, !!result.isError || blocked);
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

  // Only fields Crawl4AI >= 0.9 still accepts from a request body. The old
  // recipe here (proxy_config + session_id + page_timeout 120000) is gone:
  //  - proxy_config / session_id are UNTRUSTED_FORBIDDEN_FIELDS -> hard 400,
  //    which is why 100% of web_fetch calls were failing.
  //  - page_timeout is clamped to 60s server-side, so ask for 60s honestly.
  // Do NOT add user_agent_mode:'random' — see stripPoolHostileFields().
  const browserParams: Record<string, unknown> = { headless: true, enable_stealth: true };

  // Seconds to settle before extracting HTML. The old default was 15s, chosen
  // for a JS-challenge recipe that depended on the (now impossible) proxy and
  // session reuse; without those it was 15s of dead latency on every fetch.
  const delay =
    typeof params.delay === 'number' && Number.isFinite(params.delay) ? params.delay : 2;

  return proxyCrawl4AI('crawl', async () => {
    const resp = (await callCrawlTool({
      urls: [url],
      browser_config: { type: 'BrowserConfig', params: browserParams },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: {
          wait_until: 'load',
          page_timeout: 60000,
          delay_before_return_html: delay,
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

// Crawl4AI pools browsers by a SHA1 of the ENTIRE BrowserConfig
// (crawler_pool._sig), so any field that varies per request mints a brand new
// ~180MB Chromium that is never reused. `user_agent_mode: 'random'` does
// exactly that: measured 10 live browsers / 1890MB / reuse_rate_percent: 0,
// then `RuntimeError: can't start new thread` — after which the service 500s
// on EVERY request, not just the crawl that caused it. A caller asking for it
// would take down web_screenshot/web_pdf/web_crawl along with itself, so drop
// it here rather than trusting callers. A fixed `user_agent` string is fine:
// it is one stable signature, and was measured at 100% pool reuse.
function stripPoolHostileFields(bcParams: Record<string, unknown>): Record<string, unknown> {
  if (bcParams.user_agent_mode !== 'random') return bcParams;
  const { user_agent_mode: _dropped, ...rest } = bcParams;
  log(
    "web_crawl: dropped browser_config.user_agent_mode='random' — it defeats Crawl4AI's " +
      'browser pool (new Chromium per call) and exhausts the container.',
  );
  return rest;
}

export async function web_crawl(params: Record<string, unknown>): Promise<ToolResult> {
  // Default sensible browser config when the caller didn't set their own.
  // Keeps web_crawl symmetric with web_fetch. No proxy_config: Crawl4AI >= 0.9
  // rejects it outright (see config.ts).
  const bc = (params.browser_config as { params?: Record<string, unknown> } | undefined) ?? {};
  const bcParams = stripPoolHostileFields(bc.params ?? {});
  params = {
    ...params,
    browser_config: {
      type: 'BrowserConfig',
      params: {
        headless: true,
        enable_stealth: true,
        ...bcParams,
      },
    },
  };
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
