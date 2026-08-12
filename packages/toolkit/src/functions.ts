import {
  callCrawlTool,
  callExecuteJsTool,
  callMdTool,
  callPdfTool,
  callScreenshotTool,
} from './crawl4ai.js';
import { scraplingFetch } from './scrapling.js';
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

/** Pull markdown for the requested filter out of a Crawl4AI `crawl` result. */
function markdownFromCrawlResult(
  resp: ToolResult,
  filter: string,
): { md: string; success: boolean } | null {
  const text = resp?.content?.[0]?.text;
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const r = (parsed as { results?: Array<Record<string, unknown>> })?.results?.[0];
  if (!r) return null;

  const m = r.markdown as string | { raw_markdown?: string; fit_markdown?: string } | undefined;
  let md = '';
  if (typeof m === 'string') {
    md = m;
  } else if (m && typeof m === 'object') {
    md =
      (filter === 'raw' ? m.raw_markdown : m.fit_markdown) ||
      m.raw_markdown ||
      m.fit_markdown ||
      '';
  }
  if (!md) return null;
  return { md, success: r.success !== false };
}

/**
 * Render already-fetched HTML to markdown using Crawl4AI's own markdown
 * pipeline, via its `raw://` input scheme. This is what lets the fetch move to
 * Scrapling without changing web_fetch's output contract: the `f` filter
 * (raw/fit/bm25/llm) is implemented by Crawl4AI's markdown generator, so
 * reimplementing HTML->markdown here would silently change every caller's
 * output. Crawl4AI does no network I/O for a raw:// input.
 */
async function htmlToMarkdown(html: string, filter: string): Promise<string | null> {
  const resp = (await callCrawlTool({
    urls: [`raw://${html}`],
    crawler_config: { type: 'CrawlerRunConfig', params: { wait_until: 'load' } },
  })) as ToolResult;
  return markdownFromCrawlResult(resp, filter)?.md ?? null;
}

/** Fetch a URL through Crawl4AI directly. The fallback when Scrapling is down. */
async function crawl4aiFetch(url: string, filter: string, delay: number): Promise<ToolResult> {
  return proxyCrawl4AI('crawl', async () => {
    const resp = (await callCrawlTool({
      urls: [url],
      // Only fields Crawl4AI >= 0.9 accepts from a request body. No
      // proxy_config / session_id (forbidden -> hard 400) and no
      // user_agent_mode:'random' (see stripPoolHostileFields).
      browser_config: {
        type: 'BrowserConfig',
        params: { headless: true, enable_stealth: true },
      },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: {
          wait_until: 'load',
          // Clamped to 60s server-side anyway, so ask honestly.
          page_timeout: 60000,
          delay_before_return_html: delay,
        },
      },
    })) as ToolResult;

    const extracted = markdownFromCrawlResult(resp, filter);
    if (!extracted) return resp;
    return {
      content: [{ type: 'text', text: extracted.md }],
      isError: !extracted.success,
    };
  });
}

export async function web_fetch(params: Record<string, unknown>): Promise<ToolResult> {
  const url = params.url as string | undefined;
  if (!url) {
    return {
      content: [{ type: 'text', text: 'web_fetch error: missing required `url`' }],
      isError: true,
    };
  }
  const filter = ((params.f as string | undefined) ?? 'fit').toLowerCase();
  const delay =
    typeof params.delay === 'number' && Number.isFinite(params.delay) ? params.delay : 2;

  // Scrapling does the fetching. It is the only path with residential egress
  // and challenge solving, which Crawl4AI >= 0.9 cannot provide at all: on
  // LinkedIn, Crawl4AI's datacenter IP decayed to 0/6 (HTTP 999) while
  // Scrapling held 94%, and on Trustpilot Crawl4AI's success is luck-of-the-IP
  // while Scrapling escalates into a real challenge solve.
  let result: ToolResult;
  try {
    // No mode passed: the sidecar routes by host and escalates to a challenge
    // solve only on evidence. Engine choice is deliberately not a tool input.
    const page = await scraplingFetch({ url, timeoutMs: 60_000 });
    const md = page.html ? await htmlToMarkdown(page.html, filter) : null;

    if (md) {
      // A block/challenge page converts to markdown perfectly well, so the
      // HTTP status is the only honest signal here — not whether we got text.
      // Keep the body either way: callers can often still use it, and it makes
      // "which wall did we hit" diagnosable.
      const blocked = page.status >= 400;
      const provenance = `scrapling mode=${page.mode}${page.escalated ? ', escalated' : ''}`;
      result = blocked
        ? {
            content: [
              {
                type: 'text',
                text: `web_fetch: upstream returned HTTP ${page.status} (${provenance}). Body as markdown follows.\n\n${md}`,
              },
            ],
            isError: true,
          }
        : { content: [{ type: 'text', text: md }], isError: false };
    } else {
      result = {
        content: [
          {
            type: 'text',
            text: `web_fetch: scrapling returned HTTP ${page.status} with no extractable content (${page.size} bytes, mode=${page.mode}).`,
          },
        ],
        isError: true,
      };
    }
  } catch (err) {
    // Scrapling unreachable or erroring: fall back to Crawl4AI so a sidecar
    // outage degrades quality rather than failing the tool outright.
    log(
      `web_fetch: scrapling unavailable, falling back to Crawl4AI:`,
      err instanceof Error ? err.message : String(err),
    );
    result = await crawl4aiFetch(url, filter, delay);
  }

  return trace('web_fetch', result);
}

/**
 * Raw HTML, deliberately not markdown.
 *
 * web_fetch's markdown conversion destroys exactly the things structured
 * scrapers need: <script type="application/ld+json"> blocks, meta tags and
 * attributes. gtm-tools' LinkedIn enrichment parses the JSON-LD `Person` out of
 * the page, so it needs the document as served. Returns a JSON envelope so
 * callers can distinguish "fetched, but the origin said 999" from "fetched
 * fine" without guessing from the body.
 */
export async function web_html(params: Record<string, unknown>): Promise<ToolResult> {
  const url = params.url as string | undefined;
  if (!url) {
    return {
      content: [{ type: 'text', text: 'web_html error: missing required `url`' }],
      isError: true,
    };
  }
  const timeoutMs =
    typeof params.timeout_ms === 'number' && Number.isFinite(params.timeout_ms)
      ? params.timeout_ms
      : 60_000;

  try {
    const page = await scraplingFetch({
      url,
      timeoutMs,
      networkIdle: params.network_idle === true,
    });
    const result: ToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: page.status,
            url: page.url,
            mode: page.mode,
            escalated: page.escalated,
            size: page.size,
            html: page.html,
          }),
        },
      ],
      // A non-2xx is reported in `status` rather than as a tool error: callers
      // like the LinkedIn path branch on 999 vs 404 themselves, and losing the
      // body would take that decision away from them.
      isError: false,
    };
    return trace('web_html', result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('web_html failed:', msg);
    return trace('web_html', {
      content: [{ type: 'text', text: `web_html error: ${msg}` }],
      isError: true,
    });
  }
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
  web_html,
  web_screenshot,
  web_pdf,
  web_execute_js,
  web_crawl,
  web_snapshots,
  web_archive,
  web_usage_stats,
};
