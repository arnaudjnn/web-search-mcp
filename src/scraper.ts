import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { generateObject } from 'ai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { LimitFunction } from 'p-limit';
import { z } from 'zod';

import { systemPrompt } from './prompt.js';

type BudgetState = {
  tokenBudget?: number;
  usedTokens: number;
  reached: boolean;
};

function recordUsage(budget: BudgetState | undefined, usage: any) {
  if (!budget || !usage) return;
  const total =
    (typeof usage.totalTokens === 'number' && usage.totalTokens) ||
    ((usage.inputTokens || 0) + (usage.outputTokens || 0));
  if (typeof total === 'number' && total > 0) {
    budget.usedTokens += total;
    if (
      typeof budget.tokenBudget === 'number' &&
      budget.tokenBudget > 0 &&
      budget.usedTokens >= budget.tokenBudget
    ) {
      budget.reached = true;
    }
  }
}


export async function filterSearchResults({
  searchResults,
  query,
  sourcePreferences,
  model,
  budget,
  limiter,
}: {
  searchResults: Array<{ url: string; title?: string; description?: string }>;
  query: string;
  sourcePreferences?: string;
  model: LanguageModelV2;
  budget?: BudgetState;
  limiter: LimitFunction;
}): Promise<string[]> {
  if (searchResults.length === 0) return [];

  const evaluations = await Promise.all(
    searchResults.map((result) =>
      limiter(async () => {
        if (!result.url) return null;
        const evaluation = await generateObject({
          model,
          system: systemPrompt(),
          prompt: `Should we scrape this URL for: "${query}"?

URL: ${result.url}
Domain: ${new URL(result.url).hostname}
Title: ${result.title || 'N/A'}
Description: ${result.description || 'N/A'}

${sourcePreferences ? `User preferences to avoid:\n${sourcePreferences}\n` : ''}

ONLY filter out obvious junk:
- SEO spam / clickbait listicles
- Ad-heavy aggregator sites
- Clearly irrelevant topics
- Violates user preferences

INCLUDE everything else - we'll evaluate properly after scraping.`,
          schema: z.object({
            shouldScrape: z.boolean(),
            reasoning: z.string(),
          }),
        });

        recordUsage(budget, (evaluation as any)?.usage);

        return evaluation.object.shouldScrape ? result.url : null;
      })
    )
  );

  return evaluations.filter((url): url is string => url !== null);
}


const REMOVE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'nav', 'header', 'footer',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.nav', '.navbar', '.menu', '.sidebar', '.ad', '.ads', '.advertisement',
  '.cookie-banner', '.popup', '.modal',
  '#cookie-consent', '#ad-container',
];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

async function scrapeUrl(
  url: string,
): Promise<{ url: string; title?: string; markdown?: string } | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DeepResearchBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove junk elements
    $(REMOVE_SELECTORS.join(', ')).remove();

    const title = $('title').first().text().trim() || undefined;

    // Get the main content area, or fall back to body
    const mainContent = $('main, article, [role="main"], .content, #content').first();
    const contentHtml = mainContent.length > 0 ? mainContent.html() : $('body').html();

    if (!contentHtml) return null;

    const markdown = turndown.turndown(contentHtml).trim();

    return { url, title, markdown: markdown || undefined };
  } catch {
    return null;
  }
}

export async function scrapeUrls(
  urls: string[],
): Promise<Array<{ url: string; title?: string; markdown?: string }>> {
  if (urls.length === 0) return [];

  const results = await Promise.all(urls.map(url => scrapeUrl(url)));

  return results.filter(
    (r): r is { url: string; title?: string; markdown?: string } => r !== null,
  );
}
