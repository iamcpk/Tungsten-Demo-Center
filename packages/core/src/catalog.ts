import type { BusinessLine, Video, VideoStatus } from './types.js';
import { cachedIndexer, matchDoc, parseQuery, rankDocs } from './search.js';

export interface CatalogQuery {
  q?: string;
  /** One status, several, or 'all'. */
  status?: VideoStatus | VideoStatus[] | 'all';
  businessLine?: BusinessLine;
  product?: string;
  vertical?: string;
  author?: string;
  language?: string;
  category?: string;
  sort?: 'newest' | 'oldest' | 'title' | 'relevance';
  offset?: number;
  limit?: number;
}

export type FacetKey = 'businessLines' | 'products' | 'verticals' | 'authors' | 'languages' | 'categories';
export type Facets = Record<FacetKey, { value: string; count: number }[]>;

export interface CatalogResult {
  total: number;
  items: Video[];
  facets: Facets;
  /** No video matched every word, so these are the closest matches. */
  relaxed?: boolean;
  /** How many of the results are archived. */
  archivedTotal?: number;
}

const FACETS: FacetKey[] = ['businessLines', 'products', 'verticals', 'authors', 'languages', 'categories'];
const BUSINESS_LINE_WORDS: Record<string, string> = { IA: 'Intelligent Automation', PA: 'Print Automation' };

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
}

/** Search index per video object. Catalogue snapshots are replaced, never mutated, so this stays correct. */
const indexVideo = cachedIndexer<Video>((v) => ({
  title: v.title,
  tags: [...v.products, ...v.keywords, ...v.authors, ...v.categories, ...v.verticals, ...v.businessLines.map((b) => BUSINESS_LINE_WORDS[b] ?? b)],
  body: `${v.shortDescription} ${stripTags(v.description)}`,
}));

/** Relevance score for one video. 0 = no match. Kept for callers that score a single video. */
export function scoreVideo(v: Video, query: string | string[]): number {
  const q = parseQuery(Array.isArray(query) ? query.join(' ') : query);
  if (!q.terms.length) return 1;
  const m = matchDoc(q, indexVideo(v));
  return m.matched === m.required ? m.score : 0;
}

function statusOk(v: Video, s: CatalogQuery['status']): boolean {
  if (!s || s === 'all') return true;
  return Array.isArray(s) ? s.includes(v.status) : v.status === s;
}

function matches(v: Video, q: CatalogQuery, skip?: FacetKey): boolean {
  const checks: [FacetKey, string | undefined][] = [
    ['businessLines', q.businessLine],
    ['products', q.product],
    ['verticals', q.vertical],
    ['authors', q.author],
    ['languages', q.language],
    ['categories', q.category],
  ];
  for (const [key, val] of checks) {
    if (!val || key === skip) continue;
    if (!(v[key] as string[]).includes(val)) return false;
  }
  return true;
}

/**
 * In-memory search over the catalogue. The whole catalogue is a few thousand documents
 * at most, so this is faster and cheaper than a search service.
 * Facet counts for a dimension ignore that dimension's own filter, so users can switch value.
 * When several statuses are searched, active videos come before archived ones.
 */
export function searchCatalog(all: Video[], q: CatalogQuery): CatalogResult {
  const pool = all.filter((v) => statusOk(v, q.status));
  const { hits, relaxed, hasQuery } = rankDocs(pool, q.q ?? '', indexVideo);
  const textMatched = pool.filter((v) => hits.has(v));

  const filtered = textMatched.filter((v) => matches(v, q));
  const sort = q.sort ?? (hasQuery ? 'relevance' : 'newest');
  const mixed = Array.isArray(q.status) && q.status.length > 1;
  const rank = (v: Video) => (v.status === 'archived' ? 1 : 0);
  filtered.sort((a, b) => {
    if (mixed && rank(a) !== rank(b)) return rank(a) - rank(b);
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'oldest') return a.publishedAt.localeCompare(b.publishedAt);
    if (sort === 'relevance') {
      const d = (hits.get(b) ?? 0) - (hits.get(a) ?? 0);
      if (d) return d;
    }
    return b.publishedAt.localeCompare(a.publishedAt);
  });

  const facets = {} as Facets;
  for (const key of FACETS) {
    const counts = new Map<string, number>();
    for (const v of textMatched) {
      if (!matches(v, q, key)) continue;
      for (const val of v[key] as string[]) counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    facets[key] = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(100, Math.max(1, q.limit ?? 24));
  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + limit),
    facets,
    relaxed: relaxed || undefined,
    archivedTotal: mixed ? filtered.filter((v) => v.status === 'archived').length : undefined,
  };
}

/** Videos sharing the most products/categories with the given one. */
export function relatedVideos(all: Video[], v: Video, n = 6): Video[] {
  const p = new Set(v.products);
  const c = new Set(v.categories);
  return all
    .filter((x) => x.id !== v.id && x.status === 'active')
    .map((x) => ({ x, s: x.products.filter((y) => p.has(y)).length * 3 + x.categories.filter((y) => c.has(y)).length }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || b.x.publishedAt.localeCompare(a.x.publishedAt))
    .slice(0, n)
    .map((r) => r.x);
}
