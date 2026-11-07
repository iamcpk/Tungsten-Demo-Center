import { Link } from 'react-router-dom';
import { SearchBox } from '../components/Layout';
import { CardGrid, SkeletonGrid } from '../components/VideoCard';
import { useJson, useTitle } from '../hooks';
import { BUSINESS_LINE_LABELS, type Video } from '../api';

interface HomeData {
  featured: Video[];
  latest: Video[];
  products: { name: string; count: number }[];
  total: number;
}

export default function Home() {
  useTitle('');
  const { data, loading, error } = useJson<HomeData>('/api/home');
  return (
    <>
      <section className="hero">
        <div className="wrap hero-inner">
          <p className="eyebrow">Solutions Consulting</p>
          <h1>See intelligent automation<br /><span className="accent">in action</span></h1>
          <p className="lead">Technical demonstrations, product walk-throughs and solution videos across the Tungsten Automation portfolio.</p>
          <SearchBox large />
          <div className="hero-lines">
            {(Object.keys(BUSINESS_LINE_LABELS) as (keyof typeof BUSINESS_LINE_LABELS)[]).map((k) => (
              <Link key={k} className="line-pill" to={`/videos?businessLine=${k}`}>
                <span className={`dot dot-${k}`} aria-hidden="true" />{BUSINESS_LINE_LABELS[k]}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {error && <div className="wrap"><p className="alert">We couldn't load the videos right now. Please refresh the page.</p></div>}

      {(loading || (data?.featured.length ?? 0) > 0) && (
        <section className="wrap section">
          <div className="section-head"><h2>Featured</h2></div>
          {loading ? <SkeletonGrid n={4} /> : <CardGrid items={data!.featured.slice(0, 4)} />}
        </section>
      )}

      <section className="wrap section">
        <div className="section-head">
          <h2>Latest videos</h2>
          <Link to="/videos" className="link-arrow">Browse all{data ? ` ${data.total}` : ''}</Link>
        </div>
        {loading ? <SkeletonGrid /> : data && <CardGrid items={data.latest} />}
      </section>

      {data && data.products.length > 0 && (
        <section className="wrap section">
          <div className="section-head"><h2>Browse by product</h2></div>
          <div className="product-tiles">
            {data.products.map((p) => (
              <Link key={p.name} to={`/videos?product=${encodeURIComponent(p.name)}`} className="product-tile">
                <span>{p.name}</span>
                <span className="count">{p.count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="wrap section">
        <div className="cta-band">
          <div>
            <h2>Can't find what you need?</h2>
            <p>Search the archive, suggest a new video or ask the team for a live demo.</p>
          </div>
          <div className="cta-actions">
            <Link to="/contact?type=suggest" className="btn btn-light">Suggest a video</Link>
            <Link to="/contact?type=demo" className="btn btn-primary">Request a demo</Link>
          </div>
        </div>
      </section>
    </>
  );
}
