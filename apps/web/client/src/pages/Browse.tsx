import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SearchBox } from '../components/Layout';
import { CardGrid, SkeletonGrid } from '../components/VideoCard';
import { useJson, useTitle } from '../hooks';
import { BUSINESS_LINE_LABELS, getJson, type FacetKey, type SearchResult, type Video } from '../api';

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
  const [showFilters, setShowFilters] = useState(false);
  useTitle(status === 'archived' ? 'Archived videos' : 'Videos');

  const query = useMemo(() => {
    const p = new URLSearchParams(params);
    p.set('status', status);
    p.set('limit', String(PAGE));
    return p.toString();
  }, [params, status]);
  useEffect(() => setExtra([]), [query]);

  const { data, loading, error } = useJson<SearchResult>(`/api/videos?${query}`);
  const items = data ? [...data.items, ...extra] : [];

  const set = (param: string, value?: string) => {
    const p = new URLSearchParams(params);
    if (value) p.set(param, value); else p.delete(param);
    setParams(p, { replace: true });
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const p = new URLSearchParams(query);
      p.set('offset', String(items.length));
      const r = await getJson<SearchResult>(`/api/videos?${p}`);
      setExtra((e) => [...e, ...r.items]);
    } finally {
      setLoadingMore(false);
    }
  };

  const active = FILTERS.filter((f) => params.get(f.param));
  const q = params.get('q') ?? '';

  return (
    <div className="wrap browse">
      <div className="browse-head">
        <div>
          <h1>{status === 'archived' ? 'Archived videos' : 'All videos'}</h1>
          <p className="muted">
            {status === 'archived'
              ? 'Older content kept for reference. Some products or versions may no longer be current.'
              : <>Looking for older content? <Link to="/archive">Search the archive</Link>.</>}
          </p>
        </div>
        <SearchBox key={q} initial={q} />
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
        </aside>

        <section className="results" aria-live="polite">
          <div className="results-bar">
            <span className="muted">{data ? `${data.total} ${data.total === 1 ? 'result' : 'results'}` : ' '}</span>
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
          {loading && !data ? <SkeletonGrid /> : items.length ? <CardGrid items={items} /> : !loading && (
            <div className="empty">
              <h2>No videos match</h2>
              <p>Try fewer filters or a different search. You can also <Link to="/contact?type=suggest">suggest a video</Link>.</p>
            </div>
          )}
          {data && items.length < data.total && (
            <div className="more"><button className="btn btn-light" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading...' : 'Load more'}</button></div>
          )}
        </section>
      </div>
    </div>
  );
}
