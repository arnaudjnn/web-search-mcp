import { z } from 'zod';

const envSchema = z.object({
  SEARXNG_URL: z.string().default('http://searxng.railway.internal:8080'),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),
  API_KEY: z.string().min(1, 'API_KEY is required'),
  CRAWL4AI_URL: z.string().default('http://crawl4ai.railway.internal:11235'),
  CRAWL4AI_API_TOKEN: z.string().optional(),
  SCRAPLING_URL: z.string().default('http://scrapling.railway.internal:8000'),
});
// No PROXY_* here on purpose. Crawl4AI >= 0.9 refuses `proxy_config` (and
// `extra_args`, `session_id`, `magic`, …) from any request body: every HTTP
// body is Provenance.UNTRUSTED and those fields are in
// UNTRUSTED_FORBIDDEN_FIELDS, which is a hard 400, not a silent drop. There is
// no token/header/config.yml route around it, and 0.9 additionally pins
// Chromium to its own localhost egress proxy, so a server-side proxy gets
// overwritten too. Residential egress lives in the Scrapling service instead.

const env = envSchema.parse(process.env);

export const Config = {
  apiKey: env.API_KEY,
  searxng: {
    url: env.SEARXNG_URL,
    engines: env.SEARXNG_ENGINES,
    categories: env.SEARXNG_CATEGORIES,
  },
  crawl4ai: {
    url: env.CRAWL4AI_URL,
    apiToken: env.CRAWL4AI_API_TOKEN,
  },
  // Owns residential egress + JS-challenge solving. See services/scrapling.
  scrapling: {
    url: env.SCRAPLING_URL,
  },
  // One request, not three. The three parallel attempts were identical
  // queries hitting the same upstream engines through the same SearXNG, so
  // they could not produce a different answer — they only tripled load and
  // helped burn Brave's rate limit ("too many requests").
  parallelRequests: 1,
  // Must stay comfortably ABOVE SearXNG's own `outgoing.request_timeout`
  // (15s in services/searxng/settings.yml). At 15 it raced SearXNG exactly:
  // responses landed at ~15.13s, the client aborted at 15.00s, and every
  // web_search returned []. Keep this above SearXNG's `max_request_timeout`.
  requestTimeout: 25,
} as const;
