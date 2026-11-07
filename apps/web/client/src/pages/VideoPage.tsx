import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Player } from '../components/Player';
import { CardGrid } from '../components/VideoCard';
import { useJson, useSiteConfig, useTitle } from '../hooks';
import { BUSINESS_LINE_LABELS, formatBytes, formatDate, mediaUrl, type Video } from '../api';
import NotFound from './NotFound';

export default function VideoPage() {
  const { slug } = useParams();
  const cfg = useSiteConfig();
  const { data, loading, error } = useJson<{ video: Video; related: Video[] }>(`/api/videos/${encodeURIComponent(slug ?? '')}`);
  const [copied, setCopied] = useState(false);
  useTitle(data?.video.pageTitle || data?.video.title || '');

  if (error === 'not-found') return <NotFound />;
  if (error) return <div className="wrap section"><p className="alert">We couldn't load this video.</p></div>;
  if (loading || !data) return <div className="wrap section"><div className="player skeleton" /></div>;

  const v = data.video;
  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  };
  const meta: [string, string[]][] = [
    ['Products', v.products],
    ['Business line', v.businessLines.map((b) => BUSINESS_LINE_LABELS[b] ?? b)],
    ['Industry', v.verticals],
    ['Language', v.languages],
    ['Presenter', v.authors],
  ];

  return (
    <article className="wrap video-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={v.status === 'archived' ? '/archive' : '/videos'}>{v.status === 'archived' ? 'Archive' : 'Videos'}</Link>
        {v.products[0] && <> <span aria-hidden="true">/</span> <Link to={`/videos?product=${encodeURIComponent(v.products[0])}`}>{v.products[0]}</Link></>}
      </nav>

      <div className="video-layout">
        <div>
          <Player v={v} />
          <h1 className="video-title">{v.title}</h1>
          <div className="video-sub">
            <span className="muted">{formatDate(v.publishedAt)}</span>
            {v.status === 'archived' && <span className="badge-archived inline">Archived</span>}
            <button className="btn btn-light btn-sm" onClick={share}>{copied ? 'Link copied' : 'Copy link'}</button>
          </div>
          {v.shortDescription && <p className="lead-sm">{v.shortDescription}</p>}
          {v.description && <div className="prose" dangerouslySetInnerHTML={{ __html: v.description }} />}

          {v.attachments.length > 0 && cfg && (
            <section className="attachments">
              <h2>Downloads</h2>
              <ul>
                {v.attachments.map((a) => {
                  const href = a.path ? mediaUrl(cfg.mediaBaseUrl, a.path) : a.url;
                  return href ? (
                    <li key={a.id}>
                      <a href={href} target="_blank" rel="noopener noreferrer" download>
                        <span className="file-icon" aria-hidden="true">{(a.path ?? a.url ?? '').split('.').pop()?.slice(0, 4).toUpperCase()}</span>
                        <span>
                          <strong>{a.name}</strong>
                          {(a.description || a.sizeBytes) && <span className="muted small">{[a.description !== a.name ? a.description : '', formatBytes(a.sizeBytes)].filter(Boolean).join(' · ')}</span>}
                        </span>
                      </a>
                    </li>
                  ) : null;
                })}
              </ul>
            </section>
          )}
        </div>

        <aside className="video-meta">
          <dl>
            {meta.filter(([, vals]) => vals.length).map(([k, vals]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{vals.map((x) => <span className="chip" key={x}>{x}</span>)}</dd>
              </div>
            ))}
          </dl>
          <div className="meta-cta">
            <p>Want to see this live?</p>
            <Link to={`/contact?type=demo&product=${encodeURIComponent(v.products[0] ?? '')}`} className="btn btn-primary">Request a demo</Link>
          </div>
        </aside>
      </div>

      {data.related.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Related videos</h2></div>
          <CardGrid items={data.related} />
        </section>
      )}
    </article>
  );
}
