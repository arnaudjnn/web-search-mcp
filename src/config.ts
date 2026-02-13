import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { z } from 'zod';

// Get the directory name of the current module
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load environment variables from .env.local
config({ path: resolve(__dirname, '../.env.local') });

// Define and validate the environment schema
const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ENDPOINT: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  SEARXNG_URL: z.string().default('http://searxng.railway.internal:8080'),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),
  API_KEY: z.string().optional(),
  CONCURRENCY: z.string().transform(Number).default('2'),
  CRAWL4AI_URL: z.string().default('http://crawl4ai.railway.internal:11235'),
  CRAWL4AI_API_TOKEN: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
});

// Parse and validate environment variables
const env = envSchema.parse(process.env);

// Export the validated config
export const Config = {
  openai: {
    apiKey: env.OPENAI_API_KEY,
    endpoint: env.OPENAI_ENDPOINT,
  },
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY,
  },
  google: {
    apiKey: env.GOOGLE_API_KEY,
  },
  xai: {
    apiKey: env.XAI_API_KEY,
  },
  apiKey: env.API_KEY,
  searxng: {
    url: env.SEARXNG_URL,
    engines: env.SEARXNG_ENGINES,
    categories: env.SEARXNG_CATEGORIES,
  },
  concurrency: env.CONCURRENCY,
  crawl4ai: {
    url: env.CRAWL4AI_URL,
    apiToken: env.CRAWL4AI_API_TOKEN,
  },
  langfuse: {
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  },
} as const;

// Export individual configs for convenience
export const { openai, searxng, langfuse } = Config;
