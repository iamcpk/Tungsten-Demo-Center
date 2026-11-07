import type { BusinessLine, Video, VideoStatus } from './types.js';

export interface CatalogQuery {
  q?: string;
  status?: VideoStatus | 'all';
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
}

const FACETS: FacetKey[] = ['businessLines', 'products', 'verticals', 'authors', 'languages', 'categories'];

function norm(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

/** Relevance score: title hits weigh most, then tags, then descriptions. 0 = no match. */
export function scoreVideo(v: Video, terms: string[]): number {
  if (!terms.length) return 1;
  const title = norm(v.title);
  const tags = norm([...v.products, ...v.keywords, ...v.authors, ...v.categories, ...v.verticals].join(' '));
  const body = norm(`${v.shortDescription} ${stripTags(v.description)}`);
  let score = 0;
  for (const t of terms) {
    const s = (title.includes(t) ? 10 : 0) + (tags.includes(t) ? 4 : 0) + (body.includes(t) ? 1 : 0);
    if (s === 0) return 0; // every term must match somewhere
    score += s;
  }
  return score;
}

function matches(v: Video, q: CatalogQuery, skip?: FacetKey): boolean {
  if (q.status && q.status !== 'all' && v.status !== q.status) return false;
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
 */
export function searchCatalog(all: Video[], q: CatalogQuery): CatalogResult {
  const terms = norm(q.q ?? '').split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  const scored = new Map<string, number>();
  const textMatched = all.filter((v) => {
    const s = scoreVideo(v, terms);
    if (s > 0) scored.set(v.id, s);
    return s > 0;
  });

  const filtered = textMatched.filter((v) => matches(v, q));
  const sort = q.sort ?? (terms.length ? 'relevance' : 'newest');
  filtered.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'oldest') return a.publishedAt.localeCompare(b.publishedAt);
    if (sort === 'relevance') {
      const d = (scored.get(b.id) ?? 0) - (scored.get(a.id) ?? 0);
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
  return { total: filtered.length, items: filtered.slice(offset, offset + limit), facets };
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
