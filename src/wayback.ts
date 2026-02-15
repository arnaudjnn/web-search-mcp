import { callMdTool } from './crawl4ai.js';

const CDX_API_URL = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_BASE_URL = 'https://web.archive.org/web';

export interface SnapshotInfo {
  timestamp: string;
  original: string;
  mimetype: string;
  statusCode: string;
  digest: string;
  length: string;
  archiveUrl: string;
  formattedDate: string;
}

function formatTimestamp(ts: string): string {
  if (ts.length !== 14) return ts;
  return `${ts.substring(0, 4)}-${ts.substring(4, 6)}-${ts.substring(6, 8)} ${ts.substring(8, 10)}:${ts.substring(10, 12)}:${ts.substring(12, 14)}`;
}

export async function getSnapshots(params: {
  url: string;
  from?: string;
  to?: string;
  limit?: number;
  matchType?: 'exact' | 'prefix' | 'host' | 'domain';
  filter?: string[];
}): Promise<SnapshotInfo[]> {
  const { url, from, to, limit = 100, matchType = 'exact', filter } = params;

  const qs = new URLSearchParams({
    url,
    output: 'json',
    fl: 'timestamp,original,mimetype,statuscode,digest,length',
    collapse: 'timestamp:8',
    limit: String(limit),
  });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (matchType !== 'exact') qs.set('matchType', matchType);
  if (filter) {
    for (const f of filter) qs.append('filter', f);
  }

  const res = await fetch(`${CDX_API_URL}?${qs}`);
  if (!res.ok) throw new Error(`Wayback CDX API error: ${res.status} ${res.statusText}`);

  const data: string[][] = await res.json();
  if (!data || data.length <= 1) return [];

  return data.slice(1).map((row) => {
    const timestamp = row[0] ?? '';
    const original = row[1] ?? '';
    const mimetype = row[2] ?? '';
    const statusCode = row[3] ?? '';
    const digest = row[4] ?? '';
    const length = row[5] ?? '';
    return {
      timestamp,
      original,
      mimetype,
      statusCode,
      digest,
      length,
      archiveUrl: `${WAYBACK_BASE_URL}/${timestamp}/${original}`,
      formattedDate: formatTimestamp(timestamp),
    };
  });
}

export async function getArchivedPage(params: {
  url: string;
  timestamp: string;
  original?: boolean;
}): Promise<{ waybackUrl: string; content: string }> {
  const { url, timestamp, original = false } = params;
  const prefix = original ? 'id_' : '';
  const waybackUrl = `${WAYBACK_BASE_URL}/${prefix}${timestamp}/${url}`;

  // Use Crawl4AI with a fresh browser context to avoid cookie/session issues
  // (e.g. Instagram sets cookies on first load that redirect subsequent requests)
  const result = await callMdTool({ url: waybackUrl, f: 'raw' });
  const content = (result as { content: { type: string; text: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  return { waybackUrl, content };
}
