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

// Deployments created from the Railway template before the Scrapling service
// existed have no such service, so SCRAPLING_URL resolves to nothing. Those
// stacks must keep working (degraded to Crawl4AI) rather than break, and they
// must not pay a connection timeout on every single web_fetch to find that out.
//
// So the first unreachable-at-the-transport-level failure trips a breaker and
// subsequent calls skip Scrapling entirely until the cooldown expires. Only
// transport failures trip it — an HTTP error means the service is there and
// answering, which is a different problem and shouldn't disable it.
const UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;
// Probing costs a round trip on a host that usually does not resolve at all, so
// keep it far below the fetch timeout.
const REACHABILITY_TIMEOUT_MS = 5_000;
let unavailableUntil = 0;

export function scraplingAvailable(): boolean {
  return Date.now() >= unavailableUntil;
}

function markUnavailable(reason: string): void {
  const firstTrip = scraplingAvailable();
  unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
  if (firstTrip) {
    process.stderr.write(
      `[scrapling] unreachable (${reason}); falling back to Crawl4AI for the next ` +
        `${UNAVAILABLE_COOLDOWN_MS / 60_000}min. This is expected if this deployment ` +
        `predates the Scrapling service.\n`,
    );
  }
}

export async function scraplingFetch(params: {
  url: string;
  mode?: ScraplingMode;
  timeoutMs?: number;
  networkIdle?: boolean;
}): Promise<ScraplingResult> {
  if (!Config.scrapling.url) {
    throw new ScraplingError('SCRAPLING_URL is not configured');
  }
  if (!scraplingAvailable()) {
    throw new ScraplingError('scrapling marked unavailable; skipping until cooldown expires');
  }

  const timeoutMs = params.timeoutMs ?? 60_000;
  const endpoint = new URL('/fetch', Config.scrapling.url);

  // Cheap liveness probe first. Without it, a stack with no Scrapling service
  // would block for the full fetch timeout before falling back — and on the
  // very first call of a cold process that is the caller's latency, not ours.
  try {
    await fetch(new URL('/healthz', Config.scrapling.url), {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    markUnavailable(reason);
    throw new ScraplingError(`scrapling /healthz unreachable: ${reason}`);
  }

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
    const reason = err instanceof Error ? err.message : String(err);
    markUnavailable(reason);
    throw new ScraplingError(`scrapling /fetch unreachable: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ScraplingError(`scrapling /fetch HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  return (await response.json()) as ScraplingResult;
}
