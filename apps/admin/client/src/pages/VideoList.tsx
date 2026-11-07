import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, mediaUrl, type Video } from '../api';
import { useMe } from '../App';

const STATE_LABEL: Record<string, string> = { 'awaiting-upload': 'Needs upload', queued: 'Queued', encoding: 'Encoding', ready: 'Ready', failed: 'Encode failed' };

export default function VideoList() {
  const me = useMe();
  const [videos, setVideos] = useState<Video[]>();
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => { api.get<Video[]>('/api/videos').then(setVideos).catch((e: Error) => setError(e.message)); }, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (videos ?? []).filter((v) =>
      (!status || v.status === status) &&
      (!provider || v.source.provider === provider) &&
      (!t || [v.title, ...v.products, ...v.authors, v.slug].join(' ').toLowerCase().includes(t)));
  }, [videos, q, status, provider]);

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
          <p className="muted">{videos ? `${videos.length} items · ${counts.active ?? 0} active · ${counts.archived ?? 0} archived · ${counts.draft ?? 0} drafts` : 'Loading...'}</p>
        </div>
        <Link to="/videos/new" className="btn btn-primary">Add video</Link>
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Search title, product, presenter..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="draft">Draft</option><option value="active">Active</option><option value="archived">Archived</option>
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All sources</option><option value="vimeo">Vimeo</option><option value="youtube">YouTube</option><option value="azure">Uploaded</option>
        </select>
      </div>
      {error && <p className="alert">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th /><th>Title</th><th>Products</th><th>Source</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {filtered.map((v) => {
              const thumb = v.thumbnailPath ? mediaUrl(me.mediaBaseUrl, v.thumbnailPath) : v.thumbnailUrl;
              return (
                <tr key={v.id}>
                  <td className="t-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="no-thumb" />}</td>
                  <td><Link to={`/videos/${v.id}`} className="t-title">{v.title}</Link>{v.featured && <span className="tag tag-feat">Featured</span>}<div className="muted small">{v.authors.join(', ')}</div></td>
                  <td className="small">{v.products.join(', ')}</td>
                  <td className="small">
                    {v.source.provider === 'azure' ? `Uploaded · ${STATE_LABEL[v.source.encodeState ?? 'awaiting-upload']}` : v.source.provider === 'vimeo' ? 'Vimeo' : 'YouTube'}
                  </td>
                  <td><span className={`tag tag-${v.status}`}>{v.status}</span></td>
                  <td className="small muted">{fmtDate(v.updatedAt)}</td>
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
