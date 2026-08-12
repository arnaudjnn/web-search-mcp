// Client for the Scrapling sidecar (services/scrapling).
//
// Scrapling owns the residential egress and the JS-challenge solving that
// Crawl4AI >= 0.9 structurally cannot do (it refuses proxy_config from a
// request body and pins Chromium to its own localhost egress proxy). See
// services/scrapling/app.py for the measurements behind the two modes.

import { Config } from './config.js';

export type ScraplingMode = 'fast' | 'stealth' | 'solve';

export type ScraplingResult = {
  status: number;
  url: string;
  html: string;
  size: number;
  /** The mode that actually served the response, which may not be the one asked for. */
  mode: ScraplingMode;
  /** True when the sidecar auto-retried in `solve` after detecting a challenge. */
  escalated: boolean;
};

export class ScraplingError extends Error {}

export async function scraplingFetch(params: {
  url: string;
  mode?: ScraplingMode;
  timeoutMs?: number;
  networkIdle?: boolean;
}): Promise<ScraplingResult> {
  if (!Config.scrapling.url) {
    throw new ScraplingError('SCRAPLING_URL is not configured');
  }

  const timeoutMs = params.timeoutMs ?? 60_000;
  const endpoint = new URL('/fetch', Config.scrapling.url);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: params.url,
        ...(params.mode ? { mode: params.mode } : {}),
        network_idle: params.networkIdle ?? false,
        timeout_ms: timeoutMs,
      }),
      // The sidecar's own deadline is timeoutMs; leave slack for its queue
      // (one single-slot executor per mode) plus transport.
      signal: AbortSignal.timeout(timeoutMs + 25_000),
    });
  } catch (err) {
    throw new ScraplingError(
      `scrapling /fetch unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ScraplingError(`scrapling /fetch HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  return (await response.json()) as ScraplingResult;
}
