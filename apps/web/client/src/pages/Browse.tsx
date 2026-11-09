import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SearchBox } from '../components/Layout';
import { CardGrid, SkeletonGrid } from '../components/VideoCard';
import { useJson, useTitle } from '../hooks';
import { BUSINESS_LINE_LABELS, getJson, type FacetKey, type SearchResult, type Video } from '../api';
import { useBranding } from '../branding';

const FILTERS: { key: FacetKey; param: string; label: string }[] = [
  { key: 'businessLines', param: 'businessLine', label: 'Business line' },
  { key: 'products', param: 'product', label: 'Product' },
  { key: 'categories', param: 'category', label: 'Category' },
  { key: 'verticals', param: 'vertical', label: 'Industry' },
  { key: 'languages', param: 'language', label: 'Language' },
  { key: 'authors', param: 'author', label: 'Presenter' },
];
const PAGE = 24;

function labelFor(key: FacetKey, value: string) {
  return key === 'businessLines' ? BUSINESS_LINE_LABELS[value as 'IA' | 'PA'] ?? value : value;
}

export default function Browse({ status }: { status: 'active' | 'archived' }) {
  const [params, setParams] = useSearchParams();
  const [extra, setExtra] = useState<Video[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const pages = useBranding().pages;
  const heading = status === 'archived' ? pages.archiveHeading : pages.videosHeading;
  useTitle(heading);

  const query = useMemo(() => {
    const p = new URLSearchParams(params);
    p.set('status', status);
    p.set('limit', String(PAGE));
    return p.toString();
  }, [params, status]);
  // The query that the current results belong to; a page that returns after the filters changed is dropped.
  const currentQuery = useRef(query);
  useEffect(() => { currentQuery.current = query; setExtra([]); setMoreError(false); }, [query]);

  const { data, loading, error } = useJson<SearchResult>(`/api/videos?${query}`);
  const items = data ? [...data.items, ...extra] : [];
  const hasMore = !!data && items.length < data.total;

  const set = (param: string, value?: string) => {
    const p = new URLSearchParams(params);
    if (value) p.set(param, value); else p.delete(param);
    setParams(p, { replace: true });
  };

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    setMoreError(false);
    const forQuery = query;
    try {
      const p = new URLSearchParams(query);
      p.set('offset', String(items.length));
      const r = await getJson<SearchResult>(`/api/videos?${p}`);
      if (currentQuery.current === forQuery) setExtra((e) => [...e, ...r.items]);
    } catch {
      if (currentQuery.current === forQuery) setMoreError(true);
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [query, items.length]);

  // Infinite scroll: load the next page when the marker below the grid comes within 600px of the viewport.
  // The observer is recreated after every page, so a tall screen that still shows the marker keeps loading.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading || moreError || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); }, { rootMargin: '0px 0px 600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, moreError, loadMore]);

  const active = FILTERS.filter((f) => params.get(f.param));
  const q = params.get('q') ?? '';
  // Searches on the Videos page include archived videos unless turned off. The API returns every
  // current video before any archived one, so splitting the loaded list keeps both in rank order.
  const archivedTotal = data?.archivedTotal ?? 0;
  const current = items.filter((v) => v.status !== 'archived');
  const fromArchive = status === 'active' ? items.filter((v) => v.status === 'archived') : [];
  const shownCurrent = status === 'active' ? current : items;
  // Remount the search box only when the query changes from outside it (header search, back button),
  // so typing in it doesn't lose focus each time the results update.
  const typed = useRef(q);
  const searchKeyRef = useRef(0);
  if (q !== typed.current) { typed.current = q; searchKeyRef.current++; }
  const searchKey = searchKeyRef.current;

  return (
    <div className="wrap browse">
      <div className="browse-head">
        <div>
          <h1>{heading}</h1>
          <p className="muted">
            {status === 'archived'
              ? 'Older content kept for reference. Some products or versions may no longer be current.'
              : <>Looking for older content? <Link to="/archive">Search the archive</Link>.</>}
          </p>
        </div>
        <SearchBox key={searchKey} initial={q} onSearch={(value) => {
          if (value === q) return;
          const p = new URLSearchParams(params);
          if (value) p.set('q', value); else p.delete('q');
          typed.current = value;
          setParams(p, { replace: true });
        }} />
      </div>

      <div className="browse-body">
        <aside className={`filters ${showFilters ? 'open' : ''}`} aria-label="Filters">
          <div className="filters-head">
            <strong>Filters</strong>
            {active.length > 0 && <button className="link" onClick={() => setParams(q ? { q } : {}, { replace: true })}>Clear all</button>}
          </div>
          {FILTERS.map((f) => {
            const opts = data?.facets[f.key] ?? [];
            const current = params.get(f.param) ?? '';
            if (!opts.length && !current) return null;
            return (
              <label key={f.key} className="filter">
                <span>{f.label}</span>
                <select value={current} onChange={(e) => set(f.param, e.target.value || undefined)}>
                  <option value="">All</option>
                  {current && !opts.some((o) => o.value === current) && <option value={current}>{labelFor(f.key, current)}</option>}
                  {opts.map((o) => <option key={o.value} value={o.value}>{labelFor(f.key, o.value)} ({o.count})</option>)}
                </select>
              </label>
            );
          })}
          <label className="filter">
            <span>Sort by</span>
            <select value={params.get('sort') ?? ''} onChange={(e) => set('sort', e.target.value || undefined)}>
              <option value="">{q ? 'Best match' : 'Newest first'}</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A-Z</option>
            </select>
          </label>
          {status === 'active' && q.trim() && (
            <label className="filter filter-check">
              <input type="checkbox" checked={params.get('archive') !== '0'} onChange={(e) => set('archive', e.target.checked ? undefined : '0')} />
              <span>Include archived videos</span>
            </label>
          )}
        </aside>

        <section className="results" aria-live="polite">
          <div className="results-bar">
            <span className="muted">
              {data ? `${data.total} ${data.total === 1 ? 'result' : 'results'}` : ' '}
              {data && archivedTotal > 0 && archivedTotal < data.total ? ` (${archivedTotal} from the archive)` : ''}
              {data && archivedTotal > 0 && archivedTotal === data.total ? ' (all from the archive)' : ''}
            </span>
            <div className="active-filters">
              {active.map((f) => (
                <button key={f.param} className="chip chip-x" onClick={() => set(f.param)} aria-label={`Remove filter ${labelFor(f.key, params.get(f.param)!)}`}>
                  {labelFor(f.key, params.get(f.param)!)} <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
            <button className="btn btn-light btn-sm show-filters" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>Filters</button>
          </div>
          {error && <p className="alert">Something went wrong loading results.</p>}
          {data?.relaxed && items.length > 0 && (
            <p className="search-note" role="status">No videos contain every word of &ldquo;{q}&rdquo;. Showing the closest matches.</p>
          )}
          {loading && !data ? <SkeletonGrid /> : items.length ? (
            <>
              {shownCurrent.length > 0 && <CardGrid items={shownCurrent} />}
              {fromArchive.length > 0 && (
                <section className={`archive-results${shownCurrent.length ? '' : ' only'}`} aria-label="From the archive">
                  <h2 className="archive-results-head">From the archive <span className="muted">({archivedTotal})</span></h2>
                  <p className="muted small">Older content kept for reference. Some products or versions may no longer be current.</p>
                  <CardGrid items={fromArchive} />
                </section>
              )}
            </>
          ) : !loading && (
            <div className="empty">
              <h2>No videos match</h2>
              <p>Try fewer filters or a different search. You can also <Link to="/contact?type=suggest">suggest a video</Link>.</p>
            </div>
          )}
          {hasMore && (
            <div ref={sentinel} className="more" aria-busy={loadingMore}>
              {moreError || typeof IntersectionObserver === 'undefined'
                ? <>{moreError && <p className="muted">Couldn't load more videos.</p>}<button className="btn btn-light" onClick={() => void loadMore()} disabled={loadingMore}>{moreError ? 'Try again' : 'Load more'}</button></>
                : <p className="muted loading-more" role="status">{loadingMore ? `Loading more videos... (${items.length} of ${data!.total})` : `Showing ${items.length} of ${data!.total}`}</p>}
            </div>
          )}
          {data && !hasMore && items.length > PAGE && <p className="muted end-of-list">That's all {data.total} videos.</p>}
        </section>
      </div>
    </div>
  );
}
