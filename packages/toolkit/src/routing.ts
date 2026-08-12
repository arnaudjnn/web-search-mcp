// Which backend serves a URL. Decided here, never asked of the caller.
//
// There are three fetchers and they are not interchangeable:
//
//   crawl4ai   headless Chromium on this host's own IP. Fast, no proxy possible.
//   scrapling  Patchright Chromium: US residential exit, or challenge-solving.
//   camoufox   Firefox on an ITALIAN residential exit, geoip-coherent.
//
// A caller asking for a URL should not have to know any of that, so the choice
// is made from the host. The rule that matters: an Italian authority site wants
// an Italian visitor. Those sources bot-gate datacenter IPs (Radware/hCaptcha on
// Consob) or score the exit IP's country as part of a sensor decision (Akamai on
// the tributario SPA), and a US residential exit is no better than a datacenter
// one for them — it is the wrong country with extra latency.

export type Backend = 'crawl4ai' | 'scrapling' | 'camoufox';

/**
 * Hosts that the plain datacenter browser serves BETTER than either stealth path.
 *
 * Counter-intuitive but measured. Trustpilot accepts Crawl4AI's datacenter IP
 * (~4s, full page) while refusing the residential exit, and its wall is now a
 * *managed* Cloudflare Turnstile that Scrapling's solver cannot clear — it loops
 * "captcha is still present, solving again" until the 90s cap and then we fall
 * back to Crawl4AI anyway. Sending it straight there turns a 90s timeout into a
 * 4s success.
 *
 * A residential exit is not a strictly stronger option; for some origins it is
 * the suspicious one.
 */
const CRAWL4AI_HOSTS = ['trustpilot.com'];

/**
 * Hosts that must be fetched as an Italian residential visitor.
 *
 * `.it` covers the bulk of them, and is deliberately broad: for an Italian
 * source the Italian exit is never the *wrong* answer, only sometimes an
 * unnecessarily expensive one. Non-`.it` Italian sources are listed explicitly.
 */
const ITALIAN_SUFFIXES = [
  '.it', // consob.it, ivass.it, giustiziatributaria.gov.it, fiscooggi.it, …
];

const ITALIAN_HOSTS: string[] = [
  // Italian sources that do NOT live under .it, which the suffix rule would
  // therefore miss. This list is the whole reason the suffix rule is not enough:
  // altalex.com is an Italian legal-commentary source behind Cloudflare/SSO, and
  // routing it to a US exit sends the wrong visitor to a site that is gated on
  // being the right one. Add here rather than widening the suffix list, so the
  // blast radius of a new entry is one host.
  'altalex.com',
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesHost(host: string, patterns: string[]): boolean {
  return patterns.some((p) => host === p || host.endsWith('.' + p));
}

export function isItalianSource(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (ITALIAN_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return matchesHost(host, ITALIAN_HOSTS);
}

/**
 * The fetcher for a URL.
 *
 * Note what is NOT decided here: whether Scrapling uses its proxy or solves a
 * challenge. That is the sidecar's own call (it routes by host and escalates on
 * evidence), and duplicating it here would give us two routing tables to keep in
 * agreement. This function only picks the *service*.
 */
export function pickBackend(url: string): Backend {
  if (isItalianSource(url)) return 'camoufox';
  const host = hostOf(url);
  if (host && matchesHost(host, CRAWL4AI_HOSTS)) return 'crawl4ai';
  return 'scrapling';
}

/** True when the plain datacenter browser is the right tool for this host. */
export function prefersCrawl4ai(url: string): boolean {
  const host = hostOf(url);
  return !!host && matchesHost(host, CRAWL4AI_HOSTS);
}
