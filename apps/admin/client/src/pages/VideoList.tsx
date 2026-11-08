import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, mediaUrl, STATUS_LABEL, type Video } from '../api';
import { useMe } from '../App';

type SortKey = 'published-desc' | 'published-asc' | 'updated-desc';

/** How many featured videos the public home page displays (apps/web/client/src/pages/Home.tsx). */
const HOME_FEATURED_SLOTS = 4;

const STATE_LABEL: Record<string, string> = { 'awaiting-upload': 'Needs upload', queued: 'Queued', encoding: 'Encoding', ready: 'Ready', failed: 'Encode failed' };

export default function VideoList() {
  const me = useMe();
  const [videos, setVideos] = useState<Video[]>();
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const [featured, setFeatured] = useState<'' | 'yes' | 'no'>('');
  const [sort, setSort] = useState<SortKey>('published-desc');

  useEffect(() => { api.get<Video[]>('/api/videos').then(setVideos).catch((e: Error) => setError(e.message)); }, []);

  // Mirrors the public home page: it shows the newest active featured videos, up to HOME_FEATURED_SLOTS.
  const onHome = useMemo(() => new Set((videos ?? [])
    .filter((v) => v.featured && v.status === 'active')
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, HOME_FEATURED_SLOTS)
    .map((v) => v.id)), [videos]);

  const featuredCount = useMemo(() => (videos ?? []).filter((v) => v.featured).length, [videos]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rows = (videos ?? []).filter((v) =>
      (!status || v.status === status) &&
      (!provider || v.source.provider === provider) &&
      (!featured || v.featured === (featured === 'yes')) &&
      (!t || [v.title, ...v.products, ...v.authors, v.slug].join(' ').toLowerCase().includes(t)));
    // ISO timestamps sort correctly as strings. Ties fall back to title so the order is stable.
    const by = (a: string, b: string) => a.localeCompare(b);
    return rows.sort((a, b) =>
      (sort === 'published-desc' ? by(b.publishedAt, a.publishedAt)
        : sort === 'published-asc' ? by(a.publishedAt, b.publishedAt)
          : by(b.updatedAt, a.updatedAt)) || a.title.localeCompare(b.title));
  }, [videos, q, status, provider, featured, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const v of videos ?? []) c[v.status] = (c[v.status] ?? 0) + 1;
    return c;
  }, [videos]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Videos</h1>
          <p className="muted">{videos ? `${videos.length} items · ${counts.active ?? 0} active · ${counts.archived ?? 0} archived · ${counts.pending ?? 0} awaiting approval · ${counts.draft ?? 0} drafts` : 'Loading...'}</p>
        </div>
        <Link to="/videos/new" className="btn btn-primary">Add video</Link>
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Search title, product, presenter..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="draft">Draft</option><option value="pending">Awaiting approval</option><option value="active">Active</option><option value="archived">Archived</option>
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All sources</option><option value="vimeo">Vimeo</option><option value="youtube">YouTube</option><option value="azure">Uploaded</option>
        </select>
        <select value={featured} onChange={(e) => setFeatured(e.target.value as '' | 'yes' | 'no')} aria-label="Home page feature">
          <option value="">Featured or not</option>
          <option value="yes">Featured on home page{videos ? ` (${featuredCount})` : ''}</option>
          <option value="no">Not featured</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          <option value="published-desc">Upload date, newest first</option>
          <option value="published-asc">Upload date, oldest first</option>
          <option value="updated-desc">Last updated</option>
        </select>
      </div>
      {error && <p className="alert">{error}</p>}
      {featured === 'yes' && videos && (
        <p className="muted small feat-note">
          The home page shows the {HOME_FEATURED_SLOTS} newest <strong>active</strong> featured videos. {onHome.size} {onHome.size === 1 ? 'is' : 'are'} showing now, marked <span className="tag tag-home">On home page</span>.
          {featuredCount > onHome.size && ' Other featured videos are waiting for a free slot, or are not active.'}
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th /><th>Title</th><th>Products</th><th>Source</th><th>Status</th><th>{sort === 'updated-desc' ? 'Updated' : 'Upload date'}</th></tr></thead>
          <tbody>
            {filtered.map((v) => {
              const thumb = v.thumbnailPath ? mediaUrl(me.mediaBaseUrl, v.thumbnailPath) : v.thumbnailUrl;
              return (
                <tr key={v.id}>
                  <td className="t-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="no-thumb" />}</td>
                  <td><Link to={`/videos/${v.id}`} className="t-title">{v.title}</Link>{v.featured && <span className="tag tag-feat">Featured</span>}{onHome.has(v.id) && <span className="tag tag-home">On home page</span>}<div className="muted small">{v.authors.join(', ')}</div></td>
                  <td className="small">{v.products.join(', ')}</td>
                  <td className="small">
                    {v.source.provider === 'azure' ? `Uploaded · ${STATE_LABEL[v.source.encodeState ?? 'awaiting-upload']}` : v.source.provider === 'vimeo' ? 'Vimeo' : 'YouTube'}
                  </td>
                  <td><span className={`tag tag-${v.status}`}>{STATUS_LABEL[v.status]}</span></td>
                  <td className="small muted" title={`Upload date ${fmtDate(v.publishedAt)} · last updated ${fmtDate(v.updatedAt)}`}>{fmtDate(sort === 'updated-desc' ? v.updatedAt : v.publishedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {videos && !filtered.length && <p className="muted pad">No videos match.</p>}
      </div>
    </>
  );
}
