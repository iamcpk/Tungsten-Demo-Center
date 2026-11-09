import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, BL, fmtDate } from '../api';
import { cachedIndexer, rankDocs } from '../../../../../packages/core/src/search';

interface Stats { views: number; plays: number; watchSeconds: number; q25: number; q50: number; q75: number; completes: number; avgWatchSeconds: number; completionRate: number; playRate: number }
interface Point { day: string; views: number; plays: number; watchSeconds: number; completes: number }
interface Row extends Stats {
  id: string; title: string; slug?: string; status: string; provider?: string; products: string[]; businessLines: ('IA' | 'PA')[];
  publishedAt?: string; featured: boolean; lifetimeViews: number; lifetimePlays: number;
}
interface Report {
  from: string; to: string; today: string; earliest: string; since?: string; retentionDays: number;
  total: Stats; previous?: { from: string; to: string; total: Stats; partial: boolean }; series: Point[]; rows: Row[];
}

type Preset = '7' | '30' | '90' | 'this-month' | 'last-month' | '365' | 'all' | 'custom';
type SortKey = 'title' | 'views' | 'plays' | 'watchSeconds' | 'avgWatchSeconds' | 'completionRate' | 'publishedAt';
type ChartMetric = 'plays' | 'views' | 'watchSeconds';

const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${fmtInt(h)}h ${m}m` : `${m}m ${s % 60}s`;
}
const METRIC_LABEL: Record<ChartMetric, string> = { plays: 'Plays', views: 'Page views', watchSeconds: 'Watch time' };
const SOURCE_LABEL: Record<string, string> = { vimeo: 'Vimeo', youtube: 'YouTube', azure: 'Uploaded' };

function rangeFor(p: Preset, today: string, earliest: string): { from: string; to: string } {
  const month = today.slice(0, 7);
  switch (p) {
    case '7': return { from: addDays(today, -6), to: today };
    case '90': return { from: addDays(today, -89), to: today };
    case '365': return { from: addDays(today, -364), to: today };
    case 'this-month': return { from: `${month}-01`, to: today };
    case 'last-month': { const end = addDays(`${month}-01`, -1); return { from: `${end.slice(0, 7)}-01`, to: end }; }
    case 'all': return { from: earliest, to: today };
    default: return { from: addDays(today, -29), to: today };
  }
}

function Change({ now, before }: { now: number; before?: number }) {
  if (before === undefined) return null;
  if (!before) return <span className="an-change muted">{now ? 'new' : 'no change'}</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const cls = pct > 0 ? 'an-up' : pct < 0 ? 'an-down' : 'muted';
  return <span className={`an-change ${cls}`}>{pct > 0 ? '▲' : pct < 0 ? '▼' : ''} {Math.abs(pct)}% vs previous period</span>;
}

/** Single-series daily column chart with a hover tooltip. */
function TrendChart({ series, metric, label }: { series: Point[]; metric: ChartMetric; label: string }) {
  const [hover, setHover] = useState<number>();
  const W = 900, H = 200, padL = 48, padB = 24, padT = 10;
  const vals = series.map((p) => p[metric]);
  const rawMax = Math.max(1, ...vals);
  const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = Math.ceil(rawMax / step) * step;
  const plotW = W - padL - 8, plotH = H - padB - padT;
  const bw = plotW / Math.max(1, series.length);
  const gap = bw > 6 ? 2 : 0;
  const fmt = (v: number) => (metric === 'watchSeconds' ? fmtDuration(v) : fmtInt(v));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(series.length / 8);
  const h = hover !== undefined ? series[hover] : undefined;
  return (
    <div className="an-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${METRIC_LABEL[metric]} per day`} onMouseLeave={() => setHover(undefined)}>
        {ticks.map((t) => {
          const y = padT + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={W - 8} y1={y} y2={y} className="an-grid" />
              <text x={padL - 6} y={y + 4} textAnchor="end" className="an-axis">{fmt(t)}</text>
            </g>
          );
        })}
        {series.map((p, i) => {
          const v = p[metric];
          const bh = (v / max) * plotH;
          const x = padL + i * bw;
          return (
            <g key={p.day} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={padT} width={bw} height={plotH} fill="transparent" />
              {v > 0 && <path className={`an-bar${hover === i ? ' on' : ''}`} d={barPath(x + gap / 2, padT + plotH, Math.max(1, bw - gap), Math.max(1.5, bh))} />}
              {i % labelEvery === 0 && <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="an-axis">{fmtDay(p.day).replace(/, \d{4}$/, '')}</text>}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="an-tip" style={{ left: `${((padL + (hover! + 0.5) * bw) / W) * 100}%` }} role="status">
          <strong>{fmtDay(h.day)}</strong>
          <span>{fmtInt(h.views)} views · {fmtInt(h.plays)} plays · {fmtDuration(h.watchSeconds)} watched</span>
        </div>
      )}
    </div>
  );
}

/** A column with a 4px rounded top, anchored to the baseline. */
function barPath(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  const top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

const indexRow = cachedIndexer<Row>((r) => ({ title: r.title, tags: [...r.products, r.slug ?? ''], body: '' }));

export default function Analytics() {
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [preset, setPreset] = useState<Preset>('30');
  const [custom, setCustom] = useState<{ from: string; to: string }>();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [product, setProduct] = useState('');
  const [line, setLine] = useState('');
  const [provider, setProvider] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'plays', desc: true });
  const [metric, setMetric] = useState<ChartMetric>('plays');
  const [focus, setFocus] = useState<Row>();
  const [focusSeries, setFocusSeries] = useState<Point[]>();

  const range = useMemo(() => {
    if (!report) return undefined;
    return preset === 'custom' && custom ? custom : rangeFor(preset, report.today, report.earliest);
  }, [preset, custom, report?.today, report?.earliest]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = (r?: { from: string; to: string }) => {
    setLoading(true);
    setError('');
    api.get<Report>(`/api/analytics${r ? `?from=${r.from}&to=${r.to}` : ''}`)
      .then((d) => { setReport(d); if (!custom) setCustom({ from: d.from, to: d.to }); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (report && range && (range.from !== report.from || range.to !== report.to)) load(range);
  }, [range?.from, range?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focus || !report) { setFocusSeries(undefined); return; }
    let live = true;
    api.get<{ series: Point[] }>(`/api/analytics/videos/${focus.id}?from=${report.from}&to=${report.to}`)
      .then((d) => { if (live) setFocusSeries(d.series); })
      .catch((e: Error) => setError(e.message));
    return () => { live = false; };
  }, [focus?.id, report?.from, report?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const products = useMemo(() => [...new Set((report?.rows ?? []).flatMap((r) => r.products))].sort(), [report]);

  const rows = useMemo(() => {
    const all = report?.rows ?? [];
    const search = rankDocs(all, q, indexRow);
    const list = all.filter((r) =>
      (!search.hasQuery || search.hits.has(r)) &&
      (!status || r.status === status) &&
      (!product || r.products.includes(product)) &&
      (!line || r.businessLines.includes(line as 'IA' | 'PA')) &&
      (!provider || r.provider === provider) &&
      (!activeOnly || r.views > 0 || r.plays > 0));
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      let c: number;
      if (sort.key === 'title') c = a.title.localeCompare(b.title);
      else if (sort.key === 'publishedAt') c = (a.publishedAt ?? '').localeCompare(b.publishedAt ?? '');
      else c = a[sort.key] - b[sort.key];
      return c * dir || b.watchSeconds - a.watchSeconds || a.title.localeCompare(b.title);
    });
  }, [report, q, status, product, line, provider, activeOnly, sort]);

  const th = (key: SortKey, label: string, num = true) => {
    const on = sort.key === key;
    return (
      <th className={num ? 'num' : undefined} aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
        <button type="button" className="an-sort" onClick={() => setSort({ key, desc: on ? !sort.desc : key !== 'title' })}>
          {label}{on ? (sort.desc ? ' ▼' : ' ▲') : ''}
        </button>
      </th>
    );
  };

  const exportCsv = () => {
    const esc = (v: string | number) => { const s = String(v); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
    const head = ['Title', 'Status', 'Products', 'Page views', 'Plays', 'Watch time (seconds)', 'Average watch (seconds)', 'Completion rate', 'Reached 25%', 'Reached 50%', 'Reached 75%', 'Completed', 'Lifetime views', 'Lifetime plays'];
    const lines = rows.map((r) => [r.title, r.status, r.products.join('; '), r.views, r.plays, r.watchSeconds, r.avgWatchSeconds, fmtPct(r.completionRate), r.q25, r.q50, r.q75, r.completes, r.lifetimeViews, r.lifetimePlays].map(esc).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `demo-center-analytics-${report!.from}-to-${report!.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const t = report?.total;
  const p = report?.previous?.total;
  const chartSeries = focus ? focusSeries : report?.series;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="muted">
            {report ? `${fmtDay(report.from)} to ${fmtDay(report.to)}` : 'Loading...'}
            {report?.since && ` · Tracking started ${fmtDay(report.since)}`}
            {loading && report && ' · Updating...'}
          </p>
        </div>
        {report && <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>}
      </div>

      <div className="toolbar">
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Date range">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="this-month">This month</option>
          <option value="last-month">Last month</option>
          <option value="365">Last 12 months</option>
          <option value="all">All available data</option>
          <option value="custom">Custom range</option>
        </select>
        {preset === 'custom' && report && custom && (
          <>
            <input type="date" aria-label="From" value={custom.from} min={report.earliest} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
            <input type="date" aria-label="To" value={custom.to} min={custom.from} max={report.today} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
          </>
        )}
      </div>

      {error && <p className="alert">{error}</p>}

      {t && (
        <div className="an-tiles">
          <div className="panel an-tile"><span className="an-label">Page views</span><strong>{fmtInt(t.views)}</strong><Change now={t.views} before={p?.views} /></div>
          <div className="panel an-tile"><span className="an-label">Plays</span><strong>{fmtInt(t.plays)}</strong><Change now={t.plays} before={p?.plays} /></div>
          <div className="panel an-tile"><span className="an-label">Watch time</span><strong>{fmtDuration(t.watchSeconds)}</strong><Change now={t.watchSeconds} before={p?.watchSeconds} /></div>
          <div className="panel an-tile"><span className="an-label">Average watch per play</span><strong>{fmtDuration(t.avgWatchSeconds)}</strong><Change now={t.avgWatchSeconds} before={p?.avgWatchSeconds} /></div>
          <div className="panel an-tile"><span className="an-label">Watched to the end</span><strong>{fmtPct(t.completionRate)}</strong><span className="an-change muted">of plays</span></div>
        </div>
      )}
      {report?.previous?.partial && <p className="muted small">The comparison period is shorter because tracking started on {fmtDay(report.since ?? report.earliest)}.</p>}

      {report && (
        <div className="panel an-trend">
          <div className="an-trend-head">
            <h2>{focus ? focus.title : 'All videos'}</h2>
            <div className="an-seg" role="group" aria-label="Chart measure">
              {(['plays', 'views', 'watchSeconds'] as ChartMetric[]).map((m) => (
                <button key={m} type="button" className={metric === m ? 'on' : ''} aria-pressed={metric === m} onClick={() => setMetric(m)}>{METRIC_LABEL[m]}</button>
              ))}
            </div>
            {focus && <button type="button" className="btn btn-sm" onClick={() => setFocus(undefined)}>Show all videos</button>}
          </div>
          {chartSeries ? <TrendChart series={chartSeries} metric={metric} label={focus?.title ?? 'All videos'} /> : <p className="muted">Loading...</p>}
        </div>
      )}

      {report && (
        <div className="toolbar">
          <input type="search" placeholder="Search title or product..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search videos" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option><option value="active">Active</option><option value="archived">Archived</option><option value="deleted">Deleted</option>
          </select>
          <select value={product} onChange={(e) => setProduct(e.target.value)} aria-label="Product">
            <option value="">All products</option>{products.map((x) => <option key={x}>{x}</option>)}
          </select>
          <select value={line} onChange={(e) => setLine(e.target.value)} aria-label="Business line">
            <option value="">All business lines</option><option value="IA">{BL.IA}</option><option value="PA">{BL.PA}</option>
          </select>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Source">
            <option value="">All sources</option><option value="vimeo">Vimeo</option><option value="youtube">YouTube</option><option value="azure">Uploaded</option>
          </select>
          <label className="an-check"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Only videos with views</label>
        </div>
      )}

      {report && (
        <div className="table-wrap">
          <table className="table an-table">
            <thead>
              <tr>
                {th('title', 'Video', false)}
                {th('views', 'Page views')}
                {th('plays', 'Plays')}
                {th('watchSeconds', 'Watch time')}
                {th('avgWatchSeconds', 'Avg watch')}
                {th('completionRate', 'Completed')}
                {th('publishedAt', 'Upload date')}
                <th><span className="sr-only">Trend</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={focus?.id === r.id ? 'an-focus' : undefined}>
                  <td>
                    {r.status === 'deleted' ? <span className="muted">Deleted video</span> : <Link to={`/videos/${r.id}`} className="t-title">{r.title}</Link>}
                    {r.status === 'archived' && <span className="tag tag-archived">Archived</span>}
                    <div className="muted small">{[r.products.join(', '), r.provider && SOURCE_LABEL[r.provider]].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="num">{fmtInt(r.views)}</td>
                  <td className="num">{fmtInt(r.plays)}<div className="muted small">{r.views ? `${fmtPct(r.playRate)} of views` : ''}</div></td>
                  <td className="num">{fmtDuration(r.watchSeconds)}</td>
                  <td className="num">{r.plays ? fmtDuration(r.avgWatchSeconds) : '-'}</td>
                  <td className="num" title={`Reached 25%: ${r.q25} · 50%: ${r.q50} · 75%: ${r.q75} · end: ${r.completes}`}>{r.plays ? fmtPct(r.completionRate) : '-'}</td>
                  <td className="small muted">{fmtDate(r.publishedAt)}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => { setFocus(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }} aria-label={`Show daily trend for ${r.title}`}>Trend</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="muted pad">{activeOnly ? 'No videos were viewed in this period with these filters.' : 'No videos match.'}</p>}
        </div>
      )}

      {report && (
        <p className="muted small an-note">
          Analytics are anonymous: no cookies, IP addresses or other personal data are collected or stored, and known bots are ignored.
          Days are in UTC and counts update about once a minute. Daily figures are kept for {Math.round(report.retentionDays / 30.5)} months
          (from {fmtDay(report.earliest)}); lifetime totals per video are kept (see the CSV export). A play counts when
          playback starts; watch time counts only the time actually played. Completed means the viewer reached 95% of the video or the end.
        </p>
      )}
    </>
  );
}
