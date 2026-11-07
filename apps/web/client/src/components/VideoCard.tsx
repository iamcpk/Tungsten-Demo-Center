import { Link } from 'react-router-dom';
import { formatDate, formatDuration, thumbOf, type Video } from '../api';
import { useSiteConfig } from '../hooks';

export function VideoCard({ v }: { v: Video }) {
  const cfg = useSiteConfig();
  const thumb = cfg ? thumbOf(v, cfg.mediaBaseUrl) : undefined;
  const dur = formatDuration(v.source.durationSec);
  return (
    <Link to={`/videos/${v.slug}`} className="card">
      <div className="thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <div className="thumb-fallback" aria-hidden="true">{v.products[0] ?? 'Tungsten'}</div>}
        <span className="play" aria-hidden="true" />
        {dur && <span className="duration">{dur}</span>}
        {v.status === 'archived' && <span className="badge-archived">Archived</span>}
      </div>
      <div className="card-body">
        <div className="chips">
          {v.products.slice(0, 2).map((p) => <span className="chip" key={p}>{p}</span>)}
          {v.products.length > 2 && <span className="chip chip-more">+{v.products.length - 2}</span>}
        </div>
        <h3>{v.title}</h3>
        <p className="muted small">{[formatDate(v.publishedAt), v.authors[0]].filter(Boolean).join(' · ')}</p>
      </div>
    </Link>
  );
}

export function CardGrid({ items }: { items: Video[] }) {
  return <div className="grid">{items.map((v) => <VideoCard key={v.id} v={v} />)}</div>;
}

export function SkeletonGrid({ n = 8 }: { n?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => <div key={i} className="card skeleton"><div className="thumb" /><div className="card-body"><div className="line" /><div className="line short" /></div></div>)}
    </div>
  );
}
