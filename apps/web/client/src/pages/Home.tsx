import { Link } from 'react-router-dom';
import { SearchBox } from '../components/Layout';
import { CardGrid, SkeletonGrid } from '../components/VideoCard';
import { useJson, useTitle } from '../hooks';
import { BUSINESS_LINE_LABELS, type Video } from '../api';
import { useBranding } from '../branding';

interface HomeData {
  featured: Video[];
  latest: Video[];
  products: { name: string; count: number }[];
  total: number;
}

export default function Home() {
  useTitle('');
  const h = useBranding().home;
  const { data, loading, error } = useJson<HomeData>('/api/home');
  return (
    <>
      <section className="hero">
        <div className="wrap hero-inner">
          {h.eyebrow && <p className="eyebrow">{h.eyebrow}</p>}
          <h1>{h.heading}{h.headingAccent && <><br /><span className="accent">{h.headingAccent}</span></>}</h1>
          {h.lead && <p className="lead">{h.lead}</p>}
          <SearchBox large />
          {h.showBusinessLines && <div className="hero-lines">
            {(Object.keys(BUSINESS_LINE_LABELS) as (keyof typeof BUSINESS_LINE_LABELS)[]).map((k) => (
              <Link key={k} className="line-pill" to={`/videos?businessLine=${k}`}>
                <span className={`dot dot-${k}`} aria-hidden="true" />{BUSINESS_LINE_LABELS[k]}
              </Link>
            ))}
          </div>}
        </div>
      </section>

      {error && <div className="wrap"><p className="alert">We couldn't load the videos right now. Please refresh the page.</p></div>}

      {(loading || (data?.featured.length ?? 0) > 0) && (
        <section className="wrap section">
          <div className="section-head"><h2>{h.featuredHeading}</h2></div>
          {loading ? <SkeletonGrid n={4} /> : <CardGrid items={data!.featured.slice(0, 4)} />}
        </section>
      )}

      <section className="wrap section">
        <div className="section-head">
          <h2>{h.latestHeading}</h2>
          <Link to="/videos" className="link-arrow">{h.browseAllLabel}{data ? ` ${data.total}` : ''}</Link>
        </div>
        {loading ? <SkeletonGrid /> : data && <CardGrid items={data.latest} />}
      </section>

      {h.showProducts && data && data.products.length > 0 && (
        <section className="wrap section">
          <div className="section-head"><h2>{h.productsHeading}</h2></div>
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

      {h.showCta && (
        <section className="wrap section">
          <div className="cta-band">
            <div>
              {h.ctaHeading && <h2>{h.ctaHeading}</h2>}
              {h.ctaText && <p>{h.ctaText}</p>}
            </div>
            <div className="cta-actions">
              <Link to="/contact?type=suggest" className="btn btn-light">{h.ctaSuggestLabel}</Link>
              <Link to="/contact?type=demo" className="btn btn-primary">{h.ctaDemoLabel}</Link>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
